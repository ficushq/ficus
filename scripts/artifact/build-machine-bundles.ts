#!/usr/bin/env bun
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
// `import type` only: the runtime modules are dynamically imported inside
// buildMachineBundles below (see the deps default comment) rather than
// statically here, so that a bare `bun scripts/artifact/build-machine-bundles.ts`
// with a missing outDir arg can print usage + exit 1 WITHOUT first pulling in
// server-bundle.ts's transitive chain to apps/core/src/db, which throws at
// module-evaluation time when DATABASE_URL is unset (unrelated to this
// script's own logic — a real build does need it set, but the usage check
// should not).
import type { buildCliBundle } from '../../apps/core/src/services/machines/cli-bundle'
import type { buildServerBundle } from '../../apps/core/src/services/machines/server-bundle'

/**
 * The `machine/` directory contract this script fills for a core release
 * artifact (spec §4.1): five files a shipped core reads at runtime instead of
 * running `bun build` — see `readPrebuiltMachineFile` in
 * `apps/core/src/services/machines/machine-prebuilt.ts`.
 */
const REPO_ROOT = join(import.meta.dir, '../..')
const MACHINE_SCRIPTS_DIR = join(REPO_ROOT, 'scripts/machine')

export interface BuildMachineBundlesDeps {
  /** Injected to observe/stub the sandbox-server build in tests. Defaults to
   *  the real {@link buildServerBundle}, dynamically imported on first use. */
  buildServer?: typeof buildServerBundle
  /** Injected to observe/stub the CLI build in tests. Defaults to the real
   *  {@link buildCliBundle}, dynamically imported on first use. */
  buildCli?: typeof buildCliBundle
}

/**
 * Build the `machine/` directory of a core release artifact: the sandbox-server
 * bundle (`server.js` + `librust_pty.so`), the ficus CLI bundle (`ficus.js`), and
 * the two machine shell scripts (`bootstrap.sh`, `box-provision.sh`), all
 * written into `outDir`.
 *
 * `buildServerBundle`/`buildCliBundle` are each called with a FRESH, EMPTY
 * `mkdtemp` dir as their explicit `prebuiltDir`: per those functions'
 * post-hardening contract, an explicit dir with a missing prebuilt file
 * returns null and falls back to a real source build (`bun build` against
 * `packages/sandbox-server/src/server.ts` / `apps/cli/src/index.ts`) — exactly
 * what the artifact builder needs, since it is producing the prebuilt files,
 * not consuming them. `buildCliBundle`'s `lock` is a pass-through (`(f) =>
 * f()`) so the CLI build's git-stamp critical section runs without a Postgres
 * advisory lock — the artifact builder is a one-shot CLI process with no
 * concurrent core process to race.
 */
export async function buildMachineBundles(outDir: string, deps: BuildMachineBundlesDeps = {}): Promise<void> {
  const buildServer =
    deps.buildServer ?? (await import('../../apps/core/src/services/machines/server-bundle')).buildServerBundle
  const buildCli = deps.buildCli ?? (await import('../../apps/core/src/services/machines/cli-bundle')).buildCliBundle

  // The function OWNS outDir's contents: a stale leftover file (a prior
  // partial run, or anything else already sitting there) would otherwise
  // survive into a successful build and get folded into the manifest's
  // signed digest (Task 1's computeFilesMap hashes every file it finds under
  // the artifact tree, unconditionally). Clearing before rebuilding also means
  // a failed run's partial output does not leak into the next run's input.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  const serverPrebuiltDir = await mkdtemp(join(tmpdir(), 'ficus-artifact-server-'))
  const cliPrebuiltDir = await mkdtemp(join(tmpdir(), 'ficus-artifact-cli-'))
  try {
    const server = await buildServer({ prebuiltDir: serverPrebuiltDir })
    const cli = await buildCli({ prebuiltDir: cliPrebuiltDir, lock: (section) => section() })

    writeFileSync(join(outDir, 'server.js'), server.content)
    writeFileSync(join(outDir, 'librust_pty.so'), server.lib)
    writeFileSync(join(outDir, 'ficus.js'), cli.js)

    // Byte-for-byte copy: read + write the raw Buffer, no text decode/encode
    // round-trip that could normalize line endings or otherwise mutate the
    // script contents.
    for (const script of ['bootstrap.sh', 'box-provision.sh']) {
      writeFileSync(join(outDir, script), readFileSync(join(MACHINE_SCRIPTS_DIR, script)))
    }

    for (const name of ['server.js', 'librust_pty.so', 'ficus.js', 'bootstrap.sh', 'box-provision.sh']) {
      const path = join(outDir, name)
      if (!existsSync(path) || statSync(path).size === 0) {
        throw new Error(`machine bundle output ${name} is empty at ${path}`)
      }
    }
  } finally {
    await rm(serverPrebuiltDir, { recursive: true, force: true })
    await rm(cliPrebuiltDir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const outDir = process.argv[2]
  if (!outDir) {
    console.error('usage: bun scripts/artifact/build-machine-bundles.ts <outDir>')
    process.exit(1)
  }
  await buildMachineBundles(outDir)
}
