import { chmod, copyFile, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  MANAGED_BIGBRAIN_CONTRACT_VERSION,
  MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  managedBigbrainHostConfigSchema,
} from '@ficus/shared/managed-bigbrain'
import { verifyBigbrainArtifact } from './artifact'
import { verifyHostBun } from './host-bun'
import { installHostAssets } from './host-assets'
import { publishIngress } from './ingress'
import { installedHostSchema, type InstalledHost } from './control-input'
import { ensureOwnedDirectory, readPrivateJson, writePrivateJson } from './secure-files'
import { initializeStorageNamespace } from './volume-image'

export const BIGBRAIN_ETC = '/etc/ficus/bigbrain'
export const BIGBRAIN_OPT = '/opt/ficus-bigbrain'

export interface InstallOptions {
  config: unknown
  /** Verified artifact directory shipped inside the Core release. */
  artifactRoot: string
  /** Fixture-only roots; the installed helper always uses the fixed defaults. */
  etc?: string
  opt?: string
  state?: string
  uid?: number
  /** Linux x64/systemd/cgroup-v2/ext4-loop support. Throws unsupported_host; runs before any write. */
  probeHost: () => Promise<void>
  /** Interpreter check against the artifact's recorded Bun version (default: verifyHostBun). */
  hostBun?: (version: string) => Promise<void>
  /** Launcher/slice/gateway installation and initial ingress (defaults: the real installers). */
  hostAssets?: (artifactDigest: string) => Promise<void>
  ingress?: () => Promise<unknown>
}
export type InstallResult =
  | { installed: false }
  | {
      installed: true
      created: boolean
      artifactDigest: string
      hostEpoch: number
      hostState: InstalledHost['hostState']
    }

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw new Error('storage_unavailable')
  }
}

async function ensureParentDirectory(path: string, uid: number): Promise<void> {
  if (path === '/' || (await present(path)) === false) {
    if (path !== '/') await ensureOwnedDirectory(path, 0o755, { uid })
    return
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022) !== 0) throw new Error('storage_unavailable')
}

/** An installed release is immutable: re-verify content AND that only the installer can write it. */
async function verifyRelease(path: string, uid: number, digest: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o777) !== 0o755) throw new Error('identity_mismatch')
  for (const name of await readdir(path)) {
    const file = await lstat(join(path, name))
    const mode = 0o644 // bundles run under the verified host Bun; nothing here is executable
    if (!file.isFile() || file.uid !== uid || file.nlink !== 1 || (file.mode & 0o777) !== mode)
      throw new Error('identity_mismatch')
  }
  let provenance
  try {
    provenance = await verifyBigbrainArtifact(path)
  } catch {
    throw new Error('identity_mismatch')
  }
  if (provenance.digest !== digest) throw new Error('identity_mismatch')
}

async function installRelease(artifactRoot: string, releases: string, uid: number): Promise<string> {
  let provenance
  try {
    provenance = await verifyBigbrainArtifact(artifactRoot)
  } catch {
    throw new Error('artifact_invalid')
  }
  if (provenance.upstreamCommit !== MANAGED_BIGBRAIN_UPSTREAM_COMMIT) throw new Error('pin_mismatch')
  const target = join(releases, provenance.digest.slice(7))
  if (await present(target)) {
    await verifyRelease(target, uid, provenance.digest)
    return provenance.digest
  }
  // Root-private staging beside the target; verified AFTER copying, so a source swapped
  // during the copy cannot be published. The rename is the only publication step.
  const staging = await mkdtemp(join(releases, '.staging-'))
  try {
    await chmod(staging, 0o700)
    for (const name of await readdir(artifactRoot)) {
      await copyFile(join(artifactRoot, name), join(staging, name))
      await chmod(join(staging, name), 0o644)
    }
    await chmod(staging, 0o755)
    await verifyRelease(staging, uid, provenance.digest)
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error instanceof Error && error.message === 'identity_mismatch' ? new Error('artifact_invalid') : error
  }
  return provenance.digest
}

/** Opt-in, idempotent setup/upgrade step. Caller (setup toolkit) MUST hold the host lifecycle
 * flock. Default off. An ABSENT host record is created only here, seeded from the
 * Platform-persisted binding/epoch; an existing record keeps its authoritative epoch, state
 * and pending effect. A different tenant/binding is never adopted (replacement is a new host).
 * Installed releases are never removed here: vault units may still reference them.
 */
export async function installManagedHost(options: InstallOptions): Promise<InstallResult> {
  const parsed = managedBigbrainHostConfigSchema.safeParse(options.config)
  if (!parsed.success) throw new Error('invalid_request')
  const config = parsed.data
  const uid = options.uid ?? 0
  const etc = options.etc ?? BIGBRAIN_ETC
  const opt = options.opt ?? BIGBRAIN_OPT
  const fs = { uid }
  const hostPresent = await present(join(etc, 'host.json'))
  if (!config.enabled) {
    // Turning the feature off never silently orphans vault data; destroy-tenant is explicit.
    if (hostPresent) throw new Error('forbidden')
    return { installed: false }
  }
  const existing = hostPresent ? await readPrivateJson(etc, 'host.json', installedHostSchema, fs) : null
  if (existing) {
    if (existing.tenantId !== config.tenantId || existing.physicalHostBinding !== config.physicalHostBinding)
      throw new Error('identity_mismatch')
    if (existing.hostState === 'deleted' || existing.hostState === 'terminated') throw new Error('forbidden')
  }
  await options.probeHost()
  let provenance
  try {
    provenance = await verifyBigbrainArtifact(options.artifactRoot)
  } catch {
    throw new Error('artifact_invalid')
  }
  // Before any write: the bundles run only under the exact Bun they were built and tested with.
  await (options.hostBun ?? ((version) => verifyHostBun(version, { uid })))(provenance.bunVersion)
  // Shared parents (/etc/ficus) may already exist with any safe mode; create only if absent.
  await ensureParentDirectory(dirname(etc), uid)
  for (const [path, mode] of [
    [opt, 0o755],
    [join(opt, 'releases'), 0o755],
    [etc, 0o700],
    [join(etc, 'public'), 0o755],
    [join(etc, 'caddy'), 0o755],
  ] as const)
    await ensureOwnedDirectory(path, mode, fs)
  await initializeStorageNamespace({ root: options.state, uid })
  const artifactDigest = await installRelease(options.artifactRoot, join(opt, 'releases'), uid)
  const host: InstalledHost = installedHostSchema.parse(
    existing
      ? {
          ...existing,
          artifactDigest,
          zone: config.zone,
          // Applies to vaults created from now on; existing vaults keep their recorded origin.
          tenantLabel: config.tenantLabel ?? null,
          limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS },
        }
      : {
          contractVersion: MANAGED_BIGBRAIN_CONTRACT_VERSION,
          tenantId: config.tenantId,
          physicalHostBinding: config.physicalHostBinding,
          hostEpoch: config.hostEpoch,
          hostState: 'active',
          upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
          artifactDigest,
          zone: config.zone,
          tenantLabel: config.tenantLabel ?? null,
          limits: { ...MANAGED_BIGBRAIN_DEFAULT_LIMITS },
          effect: null,
        }
  )
  await writePrivateJson(etc, 'host.json', host, installedHostSchema, fs)
  // Credential-free routes/sites first (empty for a new host), then the release-bound launcher,
  // units and gateway. A refusal leaves the recorded host but no new helper/gateway.
  await (options.ingress ?? (() => publishIngress({ root: options.state, etc, uid })))()
  await (options.hostAssets ?? ((digest) => installHostAssets(digest, { etc, uid })))(artifactDigest)
  return { installed: true, created: !existing, artifactDigest, hostEpoch: host.hostEpoch, hostState: host.hostState }
}

/** Real support probe: Linux x64, systemd, unified cgroup-v2 with the enforced controllers and
 * the fixed loop/ext4 tools. Necessary, not sufficient: the Linux acceptance lane proves enforcement.
 */
export async function probeSupportedHost(): Promise<void> {
  const { readFile, access } = await import('node:fs/promises')
  try {
    if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error()
    const controllers = (await readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8')).trim().split(/\s+/)
    if (!['cpu', 'memory', 'pids'].every((c) => controllers.includes(c))) throw new Error()
    for (const tool of [
      '/usr/bin/systemctl',
      '/usr/bin/systemd-run',
      '/usr/sbin/losetup',
      '/usr/sbin/mkfs.ext4',
      '/usr/bin/setpriv',
      '/usr/bin/nsenter',
      '/usr/bin/flock',
    ])
      await access(tool)
  } catch {
    throw new Error('unsupported_host')
  }
}

/** `ficus-bigbrain-host install`. The bundle's directory IS the verified artifact root. No
 * argv/environment policy: the setup toolkit pipes the validated `bigbrain:` config as JSON.
 */
export async function installMain(args: string[]): Promise<void> {
  const { dirname } = await import('node:path')
  const { readBoundedControlBytes } = await import('./control-input')
  try {
    if (process.getuid?.() !== 0 || args.length !== 0) throw new Error('invalid_request')
    const bytes = await readBoundedControlBytes(Bun.stdin.stream())
    const config: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    const result = await installManagedHost({
      config,
      // The bundle's own directory is the verified artifact root (run as `bun <root>/ficus-bigbrain-host.js`).
      artifactRoot: dirname(Bun.main),
      probeHost: probeSupportedHost,
    })
    console.log(JSON.stringify({ ok: true, ...result }))
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'operation_failed'
    console.log(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  }
}
