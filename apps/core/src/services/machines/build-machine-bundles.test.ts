import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildMachineBundles } from '../../../../../scripts/artifact/build-machine-bundles'
import type { CliBundle } from './cli-bundle'
import { resolveRepoRoot } from './server-bundle'
import type { ServerBundle } from './server-bundle'

const REPO_ROOT = resolveRepoRoot()
const BOOTSTRAP_SOURCE = join(REPO_ROOT, 'scripts/machine/bootstrap.sh')
const BOX_PROVISION_SOURCE = join(REPO_ROOT, 'scripts/machine/box-provision.sh')

const SERVER_CONTENT = new TextEncoder().encode('sentinel server.js bytes')
const SERVER_LIB = new TextEncoder().encode('sentinel librust_pty.so bytes')
const CLI_JS = new TextEncoder().encode('sentinel ficus.js bytes')

/** Fake buildServerBundle/buildCliBundle pair that records the prebuiltDir
 *  each was called with (so the test can assert it exists and is empty) and
 *  whether the cli's `lock` dep was invoked, and returns fixed sentinel bytes
 *  (or overrides, for the zero-byte test). */
async function makeFakes(overrides: { server?: Partial<ServerBundle>; cli?: Partial<CliBundle> } = {}) {
  const calls: {
    serverPrebuiltDir?: string
    cliPrebuiltDir?: string
    serverPrebuiltDirWasEmpty?: boolean
    cliPrebuiltDirWasEmpty?: boolean
    lockCalled: boolean
  } = {
    lockCalled: false,
  }
  const buildServer = async (deps: { prebuiltDir?: string } = {}): Promise<ServerBundle> => {
    calls.serverPrebuiltDir = deps.prebuiltDir
    // Check emptiness NOW, while the dir still exists — buildMachineBundles
    // cleans it up in its `finally` before this fn's caller gets control back.
    calls.serverPrebuiltDirWasEmpty = deps.prebuiltDir ? (await readdir(deps.prebuiltDir)).length === 0 : undefined
    return {
      content: SERVER_CONTENT,
      lib: SERVER_LIB,
      version: 'v-server',
      ...overrides.server,
    }
  }
  const buildCli = async (
    deps: { prebuiltDir?: string; lock?: <T>(section: () => Promise<T>) => Promise<T> } = {}
  ): Promise<CliBundle> => {
    calls.cliPrebuiltDir = deps.prebuiltDir
    calls.cliPrebuiltDirWasEmpty = deps.prebuiltDir ? (await readdir(deps.prebuiltDir)).length === 0 : undefined
    if (deps.lock) {
      // Exercise the injected lock exactly like buildCliBundle's real body
      // would: the whole build runs INSIDE it. Verifies it's a pure
      // pass-through (just runs the fn) rather than something that needs
      // Postgres.
      calls.lockCalled = true
      return deps.lock(async () => ({ js: CLI_JS, version: 'v-cli', ...overrides.cli }))
    }
    return { js: CLI_JS, version: 'v-cli', ...overrides.cli }
  }
  return { buildServer, buildCli, calls }
}

describe('buildMachineBundles', () => {
  it('writes exactly the five expected files with the built/copied bytes', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'tau-build-machine-bundles-test-'))
    try {
      const { buildServer, buildCli, calls } = await makeFakes()

      await buildMachineBundles(outDir, { buildServer, buildCli })

      const entries = (await readdir(outDir)).sort()
      expect(entries).toEqual(['bootstrap.sh', 'box-provision.sh', 'librust_pty.so', 'server.js', 'ficus.js'].sort())

      expect(await readFile(join(outDir, 'server.js'))).toEqual(Buffer.from(SERVER_CONTENT))
      expect(await readFile(join(outDir, 'librust_pty.so'))).toEqual(Buffer.from(SERVER_LIB))
      expect(await readFile(join(outDir, 'ficus.js'))).toEqual(Buffer.from(CLI_JS))

      expect(await readFile(join(outDir, 'bootstrap.sh'))).toEqual(readFileSync(BOOTSTRAP_SOURCE))
      expect(await readFile(join(outDir, 'box-provision.sh'))).toEqual(readFileSync(BOX_PROVISION_SOURCE))

      // The prebuiltDir passed to each build fn must exist and be EMPTY — that
      // is what forces the source build (a missing prebuilt file -> null ->
      // fall through to `bun build`) rather than an artifact-deployment read.
      expect(calls.serverPrebuiltDir).toBeDefined()
      expect(calls.cliPrebuiltDir).toBeDefined()
      expect(calls.serverPrebuiltDirWasEmpty).toBe(true)
      expect(calls.cliPrebuiltDirWasEmpty).toBe(true)

      // The prebuiltDirs are cleaned up afterward (finally block).
      await expect(readdir(calls.serverPrebuiltDir as string)).rejects.toThrow()
      await expect(readdir(calls.cliPrebuiltDir as string)).rejects.toThrow()

      // cli got a pass-through lock: it was invoked and its section ran.
      expect(calls.lockCalled).toBe(true)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('clears a stale pre-existing file from outDir before writing (does not leak into the signed manifest)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'tau-build-machine-bundles-test-'))
    try {
      // Simulate a prior partial/stray run: outDir already exists and
      // contains an unrelated file before buildMachineBundles ever runs.
      await mkdir(join(outDir, 'nested'), { recursive: true })
      await writeFile(join(outDir, 'STALE.txt'), 'leftover from a previous run')
      await writeFile(join(outDir, 'nested', 'also-stale.txt'), 'nested leftover')

      const { buildServer, buildCli } = await makeFakes()

      await buildMachineBundles(outDir, { buildServer, buildCli })

      const entries = (await readdir(outDir)).sort()
      expect(entries).toEqual(['bootstrap.sh', 'box-provision.sh', 'librust_pty.so', 'server.js', 'ficus.js'].sort())
      expect(entries).not.toContain('STALE.txt')
      expect(entries).not.toContain('nested')
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('throws naming the file when a build fn returns a zero-byte field', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'tau-build-machine-bundles-test-'))
    try {
      const { buildServer, buildCli } = await makeFakes({ server: { lib: new Uint8Array(0) } })

      await expect(buildMachineBundles(outDir, { buildServer, buildCli })).rejects.toThrow(/librust_pty\.so/)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
