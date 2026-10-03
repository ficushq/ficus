#!/usr/bin/env bun
/**
 * Dev docker garbage collection — reclaims the disk that accumulates from
 * day-to-day Ficus development and has twice filled the host disk far enough
 * to make the OrbStack VM self-stop (killing every sandbox).
 *
 * What it cleans, and why each thing grows:
 *  1. Orphaned test-DB compose projects (ficus-test-*): each worktree that runs
 *     `bun test` leaves its postgres running for reuse; deleting the worktree
 *     orphans the project forever (test-db-sweep.ts, shared with test-setup).
 *  2. Exited ficus-test containers: OrbStack restarts previously-running
 *     containers on VM boot, but crash-exited ones linger holding volumes.
 *     The harness recreates its DB on demand, so removing these is free.
 *  3. Local registry (ficus-registry) untagged blobs: every `bun run k3d:import`
 *     re-tags `latest`, orphaning the previous image's manifest+blobs. The
 *     registry never GCs itself — this was 14 GB (2 live images ≈ 1.4 GB)
 *     when first cleaned on 2026-07-10.
 *  4. Dangling host images + build cache from repeated sandbox image builds.
 *  5. Stale sandbox layers inside the k3d node's containerd (also pruned by
 *     k3d:import, but only when an import happens).
 *
 * Safe by construction: never touches running containers of live worktrees,
 * tagged images, named volumes of other projects, or anything outside this
 * project's test-DB/registry/buildx/k3d-node resources
 * plus docker's own dangling-only prunes.
 *
 * Run manually: bun run docker:gc
 * Install daily launchd job: bun run docker:gc -- --install
 */
import { join } from 'path'
import { writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { sweepOrphanTestDbs } from '../apps/core/src/test-db-sweep'

const repoRoot = join(import.meta.dir, '..')
const composeFile = join(repoRoot, 'docker-compose.test.yml')

const TEST_CONTAINER_PREFIXES = ['ficus-test-']
const REGISTRY_CONTAINERS = ['ficus-registry']
const BUILDX_BUILDERS = ['ficusbuilder']
const K3D_NODES = ['k3d-ficus-dev-server-0']

function run(cmd: string[], timeoutMs = 120_000): { ok: boolean; out: string } {
  try {
    const res = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
    return { ok: res.exitCode === 0, out: res.stdout.toString() + res.stderr.toString() }
  } catch (err) {
    return { ok: false, out: String(err) }
  }
}

function log(msg: string) {
  console.log(`[docker-gc ${new Date().toISOString()}] ${msg}`)
}

// --- --install: write + load a daily launchd agent, then exit ---
if (process.argv.includes('--install')) {
  const bunPath = process.execPath
  const plistPath = join(homedir(), 'Library/LaunchAgents/dev.ficus.docker-gc.plist')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.ficus.docker-gc</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${join(repoRoot, 'scripts/docker-gc.ts')}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/ficus-docker-gc.log</string>
  <key>StandardErrorPath</key><string>/tmp/ficus-docker-gc.log</string>
</dict>
</plist>
`
  mkdirSync(join(homedir(), 'Library/LaunchAgents'), { recursive: true })
  writeFileSync(plistPath, plist)
  run(['launchctl', 'bootout', `gui/${process.getuid!()}`, plistPath]) // idempotent reinstall
  const load = run(['launchctl', 'bootstrap', `gui/${process.getuid!()}`, plistPath])
  log(load.ok ? `installed launchd agent (daily 13:00): ${plistPath}` : `launchctl bootstrap failed: ${load.out}`)
  process.exit(load.ok ? 0 : 1)
}

// --- 0. docker reachable? ---
if (!run(['docker', 'info', '--format', '{{.ServerVersion}}'], 20_000).ok) {
  log('docker daemon not reachable — nothing to do')
  process.exit(0)
}

// --- 1. orphaned test-DB projects ---
const reaped = sweepOrphanTestDbs({ composeFile, currentRepoRoot: repoRoot, deps: { log } })
log(`orphaned test-DB projects reaped: ${reaped.length ? reaped.join(', ') : 'none'}`)

// --- 2. exited test-DB containers (harness recreates on demand) ---
for (const prefix of TEST_CONTAINER_PREFIXES) {
  const exited = run([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=${prefix}`,
    '--filter',
    'status=exited',
    '--format',
    '{{.Names}}',
  ])
  const exitedNames = exited.out.split('\n').filter(Boolean)
  if (exitedNames.length) {
    run(['docker', 'rm', '-v', ...exitedNames])
    log(`removed exited ${prefix}* containers: ${exitedNames.join(', ')}`)
  }
}

// --- 3. registry GC (untagged blobs from re-pushed :latest images) ---
const registryVolumeSize = () =>
  run(['docker', 'system', 'df', '-v']).out.match(/_registry-data\s+\d+\s+(\S+)/)?.[1] ?? '?'
const registries = REGISTRY_CONTAINERS.filter((name) => run(['docker', 'inspect', name], 20_000).ok)
for (const registry of registries) {
  const before = registryVolumeSize()
  const gc = run(
    [
      'docker',
      'exec',
      registry,
      'registry',
      'garbage-collect',
      '/etc/docker/registry/config.yml',
      '--delete-untagged=true',
    ],
    300_000
  )
  if (gc.ok) {
    run(['docker', 'restart', registry]) // clear the registry's blob-descriptor cache
    log(`registry GC (${registry}): ${before} -> ${registryVolumeSize()}`)
  } else {
    log(`registry GC failed for ${registry} (skipping): ${gc.out.slice(0, 200)}`)
  }
}
if (!registries.length) log('no local registry present — skipping registry GC')

// --- 4. dangling images + build cache (host docker) ---
run(['docker', 'image', 'prune', '-f'])
run(['docker', 'builder', 'prune', '-f', '--keep-storage=2GB'], 300_000)
log('pruned dangling images + build cache (kept 2GB)')

// --- 4b. buildx builder cache — grows unbounded across sandbox
// image builds (hit 6.5 GB before first being pruned on 2026-07-18); cap it
// like the classic builder cache. Builder may not exist on a fresh machine.
for (const builder of BUILDX_BUILDERS) {
  if (!run(['docker', 'buildx', 'inspect', builder], 20_000).ok) continue
  const prune = run(['docker', 'buildx', 'prune', '--builder', builder, '-f', '--max-used-space=2GB'], 300_000)
  log(
    prune.ok
      ? `pruned ${builder} buildx cache (kept 2GB)`
      : `${builder} prune failed (skipping): ${prune.out.slice(0, 200)}`
  )
}

// --- 4c. unused networks — test compose networks accumulate (containers
// are removed above but their networks linger) until docker's address pools
// are fully subnetted and every new test DB fails with "all predefined
// address pools have been fully subnetted". Prune only touches networks with
// no attached containers, so live projects are safe.
run(['docker', 'network', 'prune', '-f'])
log('pruned unused networks')

// --- 5. stale sandbox layers inside the k3d node ---
for (const node of K3D_NODES) {
  if (!run(['docker', 'inspect', node], 20_000).ok) continue
  const prune = run(['docker', 'exec', node, 'crictl', 'rmi', '--prune'], 120_000)
  log(prune.ok ? `pruned unused images inside k3d node ${node}` : 'k3d node prune skipped (crictl unavailable)')
}

// --- summary ---
const df = run(['docker', 'system', 'df']).out.trim()
log(`docker usage now:\n${df}`)
