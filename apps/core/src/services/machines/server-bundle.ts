import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { expandTilde } from '@ficus/shared/node'
import { ensureArtifact } from './machine-artifacts'
import type { EnsureArtifactDeps, MachineArtifact } from './machine-artifacts'
import { readPrebuiltMachineFile } from './machine-prebuilt'
import type { Machine } from './queries'

/**
 * Sandbox-server bundle pipeline.
 *
 * The per-box sandbox-server is the k8s `packages/k8s-sandbox` server, bundled
 * to a single file with `bun build ... --target bun` (the package's own build
 * script shape) and pushed to each machine at `/opt/tau/server/server.js`, where
 * box-provision's systemd unit runs it per box. Delivery goes through the
 * generic machine-artifact pipeline ({@link serverArtifact} +
 * `ensureArtifact`): the push is version-stamped by content sha256 under
 * `machines.artifact_versions['server']` so re-pushes are skipped when the
 * machine already carries the current bundle.
 *
 * Note on the build output: `bun build` emits `server.js` (the entry point, with
 * all `services/` modules inlined) into the scratch outdir. Chokidar 5 uses
 * native fs.watch without an optional fsevents binary. We capture the
 * `server.js` entry only; the separate PTY native library is handled below.
 *
 * Note on cross-platform builds: the bundle's version is a content hash, and
 * `bun build` output is not byte-identical across host platforms (darwin vs.
 * linux), so a darwin-built core and a linux-built core would each believe the
 * other's pushed bundle is stale and keep re-pushing their own version to every
 * machine — a push fight. This is acceptable because production runs a single
 * core host/platform; it only matters if core itself is ever run redundantly
 * across mixed-platform hosts sharing one machines table.
 */

/** Entry module bun-bundled into the box server. */
const SERVER_ENTRY = 'packages/k8s-sandbox/src/server.ts'
/** Deterministic entry-point output name for `bun build <server.ts>`. */
const SERVER_OUTPUT_NAME = 'server.js'
/** Where the bundle lands on the machine (dir created by bootstrap.sh). */
const SERVER_REMOTE_PATH = '/opt/tau/server/server.js'

/**
 * The native library the bundled server's shell/PTY path (bun-pty) `dlopen`s at
 * module-load. `bun build` inlines bun-pty's JS but NOT its native `.so`, so the
 * box must carry the arch-matched (linux-x64) lib alongside `server.js` or the
 * server crashes on startup before `/healthz` ever comes up.
 *
 * bun-pty publishes EVERY prebuild (linux x64/arm64, darwin, windows) in its one
 * npm package's `rust-pty/target/release/`, so the linux-x64 `librust_pty.so` is
 * present in node_modules even on a darwin build host — no per-arch subpackage or
 * extra optional dependency is needed. Production boxes are Ubuntu 24.04 x64
 * (bootstrap.sh's only supported target), so linux-x64 is the sole arch shipped.
 */
const SERVER_LIB_SOURCE = 'node_modules/bun-pty/rust-pty/target/release/librust_pty.so'
/** Where the native lib lands on the machine; the box env's `BUN_PTY_LIB`
 *  (box-manager `derivedBoxEnv`) points the server's loader here. */
export const SERVER_LIB_REMOTE_PATH = '/opt/tau/server/librust_pty.so'

/**
 * Repo root, resolved by walking UP from this module's location until a directory
 * that actually contains {@link SERVER_ENTRY} is found. This is robust to BOTH
 * layouts, which sit at different depths:
 *   - source run:  import.meta.dir = …/apps/core/src/services/machines
 *   - bundled dist: import.meta.dir = …/apps/core/dist   (production `bun build`)
 * A hardcoded `../../../../../` assumed the SOURCE depth; run from the dist it
 * overshot the repo root and resolved to `/`, so the entry became the
 * filesystem-absolute `/packages/k8s-sandbox/src/server.ts` — a FileNotFound
 * that only surfaced in a production dist deployment, never in a source run.
 * `FICUS_REPO_ROOT` overrides for non-standard deployments (e.g. dist and source
 * trees separated). The optional `home` threads through to expandTilde so
 * callers that must not touch the real home (tests) can supply their own.
 */
export function resolveRepoRoot(
  startDir: string = import.meta.dir,
  override: string | undefined = process.env.FICUS_REPO_ROOT,
  home?: string
): string {
  const expandedOverride = override ? expandTilde(override, home) : override
  if (expandedOverride && existsSync(join(expandedOverride, SERVER_ENTRY))) return expandedOverride
  let dir = startDir
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, SERVER_ENTRY))) return dir
    const parent = dirname(dir)
    if (parent === dir) break // reached the filesystem root
    dir = parent
  }
  // Legacy fallback (source layout: five levels up) if the marker isn't found.
  return join(startDir, '../../../../../')
}
const repoRoot = resolveRepoRoot()

export interface ServerBundle {
  /** The bundled `server.js` bytes. */
  content: Uint8Array
  /** The linux-x64 bun-pty native lib the server `dlopen`s at boot. */
  lib: Uint8Array
  /** sha256 over `server.js` AND the native lib — a change to EITHER re-stamps
   *  the version so both files re-push to every machine. */
  version: string
}

export interface BuildServerBundleDeps {
  /** Injected to observe/stub the build spawn in tests. Defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn
  /**
   * Directory the prebuilt machine-host bundle is read from when present.
   * Explicitly set (tests / the artifact BUILDER pointing at a fixture dir):
   * a missing prebuilt file falls back to the source build below. Omitted: an
   * artifact deployment (an `artifact.json` at the repo root — see
   * {@link readPrebuiltMachineFile}) reads `<MONOREPO_ROOT>/machine`, where a
   * missing/empty file is fatal; a git checkout never reads prebuilt files and
   * always source-builds. In a shipped core artifact the sandbox-server is
   * prebuilt (the artifact never carries `packages/k8s-sandbox/src`), so
   * runtime reads `server.js` + `librust_pty.so` from disk instead of running
   * `bun build`.
   */
  prebuiltDir?: string
}

/** File names of the prebuilt sandbox-server bundle under the prebuilt dir. */
const PREBUILT_SERVER_NAME = 'server.js'
const PREBUILT_SERVER_LIB_NAME = 'librust_pty.so'

/**
 * Read the prebuilt sandbox-server bundle (`server.js` + `librust_pty.so`) via
 * the shared artifact-gated reader ({@link readPrebuiltMachineFile}), hashing
 * it with the EXACT same `sha256(server.js || lib)` contract as
 * {@link buildServerBundle}'s source path — so
 * `machines.artifact_versions['server']` drift detection is identical whether
 * the bytes were prebuilt or built here. Returns null when no prebuilt
 * `server.js` exists (caller falls back to the source build; in an artifact
 * deployment with no explicit `prebuiltDir` the reader itself throws before
 * that null is ever seen — see the reader's doc comment). A prebuilt
 * `server.js` present WITHOUT its native lib is fatal here — same posture as
 * the source path, where a missing lib is an error rather than a silent boot
 * crash; this local check is the one place that outcome differs from the
 * reader's own (missing-lib-with-no-dir) fatal path, so it stays even though
 * the reader already throws for that case.
 */
async function readPrebuiltServerBundle(prebuiltDir: string | undefined): Promise<ServerBundle | null> {
  const content = readPrebuiltMachineFile(PREBUILT_SERVER_NAME, { dir: prebuiltDir })
  if (content === null) return null
  const lib = readPrebuiltMachineFile(PREBUILT_SERVER_LIB_NAME, { dir: prebuiltDir })
  if (lib === null) {
    throw new Error(
      `prebuilt ${PREBUILT_SERVER_NAME} present but ${PREBUILT_SERVER_LIB_NAME} missing under ` +
        `${prebuiltDir ?? 'the artifact machine dir'}; the box server cannot boot without it`
    )
  }
  const version = createHash('sha256').update(content).update(lib).digest('hex')
  return { content, lib, version }
}

/**
 * Build the sandbox-server into a single-file bundle via the real
 * `bun build packages/k8s-sandbox/src/server.ts --target bun`, captured from a
 * throwaway scratch outdir, and collect the linux-x64 bun-pty native lib the
 * bundled server dlopens at boot. Returns the entry bundle bytes, the lib bytes,
 * and their combined sha256 hex (the version stamp). Throws (surfacing bun's
 * stderr) if the build fails, the entry output is missing/empty, or the native
 * lib is missing/empty.
 *
 * When a prebuilt bundle exists under {@link BuildServerBundleDeps.prebuiltDir}
 * (a shipped core artifact) it is read from disk instead — see
 * {@link readPrebuiltServerBundle}.
 */
export async function buildServerBundle(deps: BuildServerBundleDeps = {}): Promise<ServerBundle> {
  const prebuilt = await readPrebuiltServerBundle(deps.prebuiltDir)
  if (prebuilt) return prebuilt

  const spawn = deps.spawn ?? Bun.spawn
  const entry = join(repoRoot, SERVER_ENTRY)
  const outdir = await mkdtemp(join(tmpdir(), 'tau-server-bundle-'))
  try {
    const proc = spawn(['bun', 'build', entry, '--outdir', outdir, '--target', 'bun'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (exitCode !== 0) {
      throw new Error(`bun build of ${SERVER_ENTRY} failed (exit ${exitCode}): ${stderr.trim()}`)
    }

    const outPath = join(outdir, SERVER_OUTPUT_NAME)
    const file = Bun.file(outPath)
    if (!(await file.exists())) {
      throw new Error(`bun build did not produce ${SERVER_OUTPUT_NAME} in ${outdir}`)
    }
    const content = new Uint8Array(await file.arrayBuffer())
    if (content.length === 0) {
      throw new Error(`bun build produced an empty ${SERVER_OUTPUT_NAME}`)
    }

    // Capture the linux-x64 native lib the bundled server loads at boot (see
    // SERVER_LIB_SOURCE). It is shipped alongside server.js; a missing/empty lib
    // is fatal here rather than a silent server crash on the box later.
    const libFile = Bun.file(join(repoRoot, SERVER_LIB_SOURCE))
    if (!(await libFile.exists())) {
      throw new Error(
        `bun-pty native lib not found at ${SERVER_LIB_SOURCE}; the box server cannot boot without it ` +
          `(bun-pty ships this prebuild in node_modules — check the dependency is installed)`
      )
    }
    const lib = new Uint8Array(await libFile.arrayBuffer())
    if (lib.length === 0) {
      throw new Error(`bun-pty native lib at ${SERVER_LIB_SOURCE} is empty`)
    }

    // Version folds in BOTH artifacts so a lib bump (or a server.js change)
    // re-pushes to every machine.
    const version = createHash('sha256').update(content).update(lib).digest('hex')
    return { content, lib, version }
  } finally {
    await rm(outdir, { recursive: true, force: true })
  }
}

/**
 * Wrap a zero-arg async builder with single-flight memoization: the first call
 * kicks off `build()` and caches its promise so concurrent/repeat calls reuse
 * it, but a rejected build clears the cache before the rejection propagates —
 * so a failed build is never "stuck" as the cached outcome, and the next call
 * retries with a fresh `build()`. Pure construction (no module-level state of
 * its own), so tests can call it directly with a fail-then-succeed stub build
 * to exercise the retry path without needing a reset seam.
 */
export function memoizeBuild<T>(build: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null
  return () => {
    if (!cached) {
      cached = build().catch((err) => {
        cached = null
        throw err
      })
    }
    return cached
  }
}

/**
 * Memoized {@link buildServerBundle} — the sandbox-server is built at most once
 * per core process. Every machine ensure reuses the same bytes/version. A
 * failed build does not poison the cache: `memoizeBuild` clears it on
 * rejection, so the next `ensureServerBundle` call retries the build instead of
 * every machine ensure failing until core restarts.
 */
export const currentBundleVersionCached: () => Promise<ServerBundle> = memoizeBuild(buildServerBundle)

/**
 * The sandbox-server as a machine artifact: `server.js` + the bun-pty native
 * lib, both 0755 in root-owned `/opt/tau/server`, versioned by the combined
 * sha256 (same stamp the pre-artifact pipeline wrote, so machines that carried
 * a current bundle before the conversion are not re-pushed). `build` reuses
 * {@link currentBundleVersionCached}, so ensuring N machines — and any other
 * reader of the per-process bundle — shares ONE `bun build`.
 */
export const serverArtifact: MachineArtifact = {
  name: 'server',
  build: async () => {
    const { content, lib, version } = await currentBundleVersionCached()
    return {
      files: [
        { remotePath: SERVER_REMOTE_PATH, bytes: content, mode: '0755' },
        // The native lib the bundled server dlopens at boot lands next to
        // server.js. The version hash folds in the lib bytes, so a lib change
        // re-pushes both.
        { remotePath: SERVER_LIB_REMOTE_PATH, bytes: lib, mode: '0755' },
      ],
      version,
    }
  },
}

/**
 * Ensure the machine carries the current sandbox-server bundle at
 * `/opt/tau/server/server.js`. Thin wrapper over the generic
 * {@link ensureArtifact} with {@link serverArtifact}: no-op when
 * `machine.artifactVersions['server']` already matches the current build;
 * otherwise streams both files over SSH via `sudo install` and stamps the new
 * version — only after BOTH pushes succeed, so a failed push leaves the
 * recorded version unchanged (next ensure retries both files).
 */
export async function ensureServerBundle(machine: Machine, deps: EnsureArtifactDeps = {}): Promise<void> {
  return ensureArtifact(machine, serverArtifact, deps)
}
