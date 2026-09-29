import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { mkdtemp, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import type { MachineArtifact } from './machine-artifacts'
import { CLI_BUNDLE_FILE, SANDBOX_CLI_PATH } from '../sandbox/cli-path'
import { readPrebuiltMachineFile } from './machine-prebuilt'
import { memoizeBuild, resolveRepoRoot } from './server-bundle'

/**
 * ficus CLI bundle pipeline.
 *
 * The CLI is bundled from its source entry (`apps/cli/src/index.ts`) to a single
 * file and pushed to every machine at {@link CLI_REMOTE_PATH}, plus a tiny
 * static wrapper at {@link CLI_WRAPPER_PATH} so `ficus …` works in every box's
 * shell. Delivery goes through the generic machine-artifact pipeline
 * ({@link cliArtifact} + `ensureArtifact`), version-stamped under
 * `machines.artifact_versions['cli']` — a CLI rebuild with real code changes
 * re-pushes to every machine; an identical rebuild is a no-op.
 *
 * Determinism vs. an informative `ficus --version`: the CLI's normal package
 * build (`apps/cli/package.json`) generates `src/build-info.generated.ts`
 * from FICUS_CLI_BUILD_DATE — WALL-CLOCK content that `bun build` INLINES into
 * the bundle whenever the file exists (`--external './build-info.generated'`
 * does NOT prevent the inlining — verified), which would change the bundle
 * hash on every build of unchanged code and re-push forever. This pipeline
 * therefore writes its OWN generated file with values that are a pure
 * function of the checked-out commit — `git rev-parse --short HEAD` plus the
 * COMMIT's own date (`git show -s --format=%cI HEAD`, never the wall clock) —
 * so `ficus --version` on every machine reports the real commit + commit-date
 * while the output hash still moves only on real code changes. Any LEFTOVER
 * generated file (e.g. a dev/tenant-zero host where someone ran the CLI
 * package build) is saved aside for the duration of the bundle and restored
 * after. If the host is not a git checkout (dist deploy), the stamp degrades
 * to build-info.ts's stable 'dev' defaults — a missing git never fails the
 * build.
 */

/** Entry module bun-bundled into the machine CLI. */
const CLI_ENTRY = 'apps/cli/src/index.ts'
/** The CLI package build's generated module (gitignored). Overwritten with a
 *  commit-stable stamp while `bun build` runs — see the determinism note
 *  above — and restored (or removed) after. */
const CLI_GENERATED_BUILD_INFO = 'apps/cli/src/build-info.generated.ts'
/** Deterministic single-file output name inside the scratch dir. */
const CLI_OUTPUT_NAME = CLI_BUNDLE_FILE
/** Where the bundle lands on the machine (dir created by bootstrap.sh's
 *  make_dirs; ensureArtifact's `install -D` also creates it). */
export const CLI_REMOTE_PATH = '/opt/tau/cli/ficus.js'
/** The PATH-visible entrypoint every box shell resolves `ficus` to — the only
 *  CLI name a box gets (the same path docker and k8s sandboxes mount). */
export const CLI_WRAPPER_PATH = SANDBOX_CLI_PATH
/** Static wrapper script: exec the machine's bun against the pushed bundle.
 *  Pushed as an artifact file AND folded into the version hash, so editing
 *  this string re-stamps + re-pushes the artifact. */
export const CLI_WRAPPER_BYTES = new TextEncoder().encode(
  '#!/bin/sh\nexec /opt/tau/bin/bun /opt/tau/cli/ficus.js "$@"\n'
)

const repoRoot = resolveRepoRoot()

export interface CliBundle {
  /** The bundled `ficus.js` bytes. */
  js: Uint8Array
  /** sha256 over `ficus.js` AND the wrapper bytes — a change to EITHER re-stamps
   *  the version so both files re-push to every machine. */
  version: string
}

export interface BuildCliBundleDeps {
  /** Injected to observe/stub the build spawn in tests. Defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn
  /** fs ops for the build-info.generated save/stamp/restore — injected to
   *  observe/stub in tests without touching the real tree. Defaults to the
   *  real fs. */
  fs?: {
    existsSync: (path: string) => boolean
    rename: (oldPath: string, newPath: string) => Promise<void>
    writeFile: (path: string, content: string) => Promise<void>
    rm: (path: string) => Promise<void>
  }
  /** Runs `git <args>` at the repo root, resolving trimmed stdout and
   *  rejecting on any failure — injected so tests never shell out to real
   *  git. Defaults to {@link runGitAtRepoRoot}. A rejection is NOT fatal:
   *  the stamp degrades to 'dev' values (dist deploys have no checkout). */
  git?: (args: string[]) => Promise<string>
  /** Cross-process mutex the ENTIRE save → stamp → build → restore section
   *  runs inside — injected to observe/stub in tests. Defaults to
   *  {@link withCliBuildAdvisoryLock} (a Postgres session advisory lock). */
  lock?: <T>(section: () => Promise<T>) => Promise<T>
  /**
   * Directory the prebuilt machine CLI bundle is read from when present.
   * Explicitly set (tests / the artifact BUILDER pointing at a fixture dir): a
   * missing prebuilt file falls back to the source build below. Omitted: an
   * artifact deployment (an `artifact.json` at the repo root — see
   * {@link readPrebuiltMachineFile}) reads `<MONOREPO_ROOT>/machine`, where a
   * missing/empty file is fatal; a git checkout never reads prebuilt files and
   * always source-builds. In a shipped core artifact `ficus.js` is prebuilt (the
   * artifact never carries `apps/cli/src`), so runtime reads it from disk
   * instead of running `bun build` — skipping the git-stamp / advisory lock
   * machinery entirely.
   */
  prebuiltDir?: string
}

/** File name of the prebuilt CLI bundle under the prebuilt dir. */
const PREBUILT_CLI_NAME = CLI_BUNDLE_FILE

/**
 * Read the prebuilt CLI bundle via the shared artifact-gated reader
 * ({@link readPrebuiltMachineFile}), hashing it with the EXACT same
 * `sha256(ficus.js || wrapper)` contract as {@link buildCliBundle}'s source
 * path — so `machines.artifact_versions['cli']` drift detection is identical
 * whether the bytes were prebuilt or built here. Returns null when no
 * prebuilt `ficus.js` exists (caller falls back to the source build; in an
 * artifact deployment with no explicit `prebuiltDir` the reader itself throws
 * before that null is ever seen).
 */
async function readPrebuiltCliBundle(prebuiltDir: string | undefined): Promise<CliBundle | null> {
  const js = readPrebuiltMachineFile(PREBUILT_CLI_NAME, { dir: prebuiltDir })
  if (js === null) return null
  const version = createHash('sha256').update(js).update(CLI_WRAPPER_BYTES).digest('hex')
  return { js, version }
}

/**
 * Advisory-lock key for the CLI-bundle build's cross-process critical section.
 * Stable constant, unique among Ficus's pg advisory locks (42 = db migrations,
 * 424242 = first-user admin bootstrap, hashtext keys elsewhere).
 */
export const CLI_BUILD_LOCK_KEY = 421_001

/**
 * Cross-process mutex around the build-info save/stamp/restore critical
 * section, as a Postgres SESSION advisory lock on a short-lived DEDICATED
 * connection.
 *
 * Why it exists: the stamping mutates the SHARED repo file
 * `apps/cli/src/build-info.generated.ts`, and core runs as TWO processes
 * (api + worker) whose first CLI builds can race — `memoizeBuild` is
 * single-flight only WITHIN a process. Unserialized, one process's rename
 * fails ENOENT (the other already moved/restored the file), or a restore
 * lands mid-build of the other process and a stale stamp gets inlined into
 * that bundle — the two processes then cache DIFFERENT versions and re-push
 * ping-pong on every ensure.
 *
 * Why THIS mechanism: a session advisory lock is auto-released when the
 * holding connection dies (no stale-lockfile deadlock a crashed holder would
 * leave behind). The build spans seconds, so it must NOT hold a pooled
 * connection/txn hostage — hence the dedicated single connection, ended in the
 * outer finally (which alone releases the lock even if the explicit unlock is
 * lost to a dropped connection). Contention is at most once per process per
 * deploy: `memoizeBuild` caches the result per process.
 */
async function withCliBuildAdvisoryLock<T>(section: () => Promise<T>): Promise<T> {
  const sql = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
  try {
    await sql`SELECT pg_advisory_lock(${CLI_BUILD_LOCK_KEY})`
    try {
      return await section()
    } finally {
      // Best-effort: if the connection died the server already released the
      // session lock, and the end() below closes it regardless.
      await sql`SELECT pg_advisory_unlock(${CLI_BUILD_LOCK_KEY})`.catch(() => {})
    }
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {})
  }
}

/**
 * Build the ficus CLI into a single-file bundle via
 * `bun build apps/cli/src/index.ts --outfile <scratch>/ficus.js --target bun`,
 * captured from a throwaway scratch dir. Returns the bundle bytes and the
 * combined sha256 hex over bundle + wrapper (the version stamp). Throws
 * (surfacing bun's stderr) if the build fails or the output is missing/empty.
 */
export async function buildCliBundle(deps: BuildCliBundleDeps = {}): Promise<CliBundle> {
  // A shipped core artifact carries a prebuilt ficus.js and no apps/cli/src to
  // build from: read it from disk and skip the git-stamp / advisory-lock
  // machinery entirely. Absent (dev / artifact builder), fall through to the
  // source build below.
  const prebuilt = await readPrebuiltCliBundle(deps.prebuiltDir)
  if (prebuilt) return prebuilt
  // The whole save → stamp → build → restore section is a critical section on
  // the SHARED repo file build-info.generated.ts, serialized across the api +
  // worker processes — see withCliBuildAdvisoryLock. The existsSync probes must
  // also run inside the lock: even a process with "nothing to save" would
  // otherwise build while the other process's restore can land mid-build.
  const lock = deps.lock ?? withCliBuildAdvisoryLock
  return lock(() => buildCliBundleLocked(deps))
}

/** Default `git` dep: run git at the repo root, resolve trimmed stdout,
 *  reject on any failure (missing binary, not a checkout, bad ref). */
async function runGitAtRepoRoot(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
  }
  return stdout.trim()
}

/**
 * The build-info values stamped into the bundle: a pure function of the
 * checked-out COMMIT (short hash + the commit's own %cI date — never the wall
 * clock, which was the re-push-churn culprit), so rebuilds of the same code
 * hash identically. `version` stays at the CLI's stable 'dev' default (there
 * is no commit-stable version source; a wall-clock one is exactly what this
 * pipeline exists to avoid). Best-effort: on ANY git failure (the core host
 * may be a dist deploy with no checkout) it degrades to all-'dev' — the same
 * stable values build-info.ts falls back to — and never fails the build.
 */
async function resolveStableBuildInfo(
  git: (args: string[]) => Promise<string>
): Promise<{ version: string; commit: string; buildDate: string }> {
  try {
    const commit = await git(['rev-parse', '--short', 'HEAD'])
    const buildDate = await git(['show', '-s', '--format=%cI', 'HEAD'])
    return { version: 'dev', commit, buildDate }
  } catch {
    return { version: 'dev', commit: 'dev', buildDate: 'dev' }
  }
}

/** The body of {@link buildCliBundle}; runs entirely inside the build lock. */
async function buildCliBundleLocked(deps: BuildCliBundleDeps): Promise<CliBundle> {
  const spawn = deps.spawn ?? Bun.spawn
  const fs = deps.fs ?? {
    existsSync,
    rename,
    writeFile: (path: string, content: string) => writeFile(path, content),
    rm: (path: string) => rm(path, { force: true }),
  }
  const git = deps.git ?? runGitAtRepoRoot
  const entry = join(repoRoot, CLI_ENTRY)

  // Stamp a commit-stable build-info.generated.ts for the build, so `bun
  // build` inlines an informative-but-deterministic `ficus --version` (see
  // resolveStableBuildInfo). Any leftover file (a dev/tenant-zero host that
  // ran the CLI package build) carries a WALL-CLOCK stamp that would churn
  // the version hash on every rebuild of unchanged code, re-pushing the CLI
  // to every machine on every deploy — it is saved aside first and ALWAYS
  // restored (the rename overwrites our stamp); if nothing pre-existed, our
  // stamp is deleted so the tree stays clean. Do NOT "simplify" the stamping
  // away with `--external './build-info.generated'` — that does not prevent
  // the inlining (verified). If a bak already exists, it holds the dev's
  // original from a crashed prior run and genPath (if present) is that run's
  // leftover stamp — never rename genPath over the bak (that would clobber
  // the original with a stamp); the bak wins the restore.
  const generated = `export const generatedBuildInfo = ${JSON.stringify(await resolveStableBuildInfo(git), null, 2)} as const\n`
  const genPath = join(repoRoot, CLI_GENERATED_BUILD_INFO)
  const bakPath = `${genPath}.artifactbuild.bak`
  const bakExists = fs.existsSync(bakPath)
  const genExists = fs.existsSync(genPath)
  if (genExists && !bakExists) await fs.rename(genPath, bakPath)
  const restore = bakExists || genExists
  await fs.writeFile(genPath, generated)
  try {
    const outdir = await mkdtemp(join(tmpdir(), 'ficus-cli-bundle-'))
    try {
      const outPath = join(outdir, CLI_OUTPUT_NAME)
      const proc = spawn(['bun', 'build', entry, '--outfile', outPath, '--target', 'bun'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      if (exitCode !== 0) {
        throw new Error(`bun build of ${CLI_ENTRY} failed (exit ${exitCode}): ${stderr.trim()}`)
      }

      const file = Bun.file(outPath)
      if (!(await file.exists())) {
        throw new Error(`bun build did not produce ${CLI_OUTPUT_NAME} in ${outdir}`)
      }
      const js = new Uint8Array(await file.arrayBuffer())
      if (js.length === 0) {
        throw new Error(`bun build produced an empty ${CLI_OUTPUT_NAME}`)
      }

      // Version folds in BOTH pushed files so a wrapper edit (or a CLI change)
      // re-pushes to every machine.
      const version = createHash('sha256').update(js).update(CLI_WRAPPER_BYTES).digest('hex')
      return { js, version }
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  } finally {
    // Restore INSIDE the lock: rename replaces our stamped file with the
    // dev's original; if none pre-existed, delete the stamp we wrote.
    if (restore) await fs.rename(bakPath, genPath)
    else await fs.rm(genPath)
  }
}

/**
 * Memoized {@link buildCliBundle} — the CLI is built at most once per core
 * process; every machine ensure reuses the same bytes/version. A failed build
 * does not poison the cache (`memoizeBuild` clears it on rejection).
 */
export const currentCliBundleCached: () => Promise<CliBundle> = memoizeBuild(buildCliBundle)

/**
 * The ficus CLI as a machine artifact: the bundle at {@link CLI_REMOTE_PATH} plus
 * the static wrapper at {@link CLI_WRAPPER_PATH}, both 0755, versioned by the
 * combined sha256 over both files' bytes. `build` reuses
 * {@link currentCliBundleCached}, so ensuring N machines shares ONE `bun build`.
 */
export const cliArtifact: MachineArtifact = {
  name: 'cli',
  build: async () => {
    const { js, version } = await currentCliBundleCached()
    return {
      files: [
        { remotePath: CLI_REMOTE_PATH, bytes: js, mode: '0755' },
        { remotePath: CLI_WRAPPER_PATH, bytes: CLI_WRAPPER_BYTES, mode: '0755' },
      ],
      version,
    }
  },
}
