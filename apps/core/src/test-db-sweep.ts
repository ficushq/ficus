/**
 * Orphaned test-DB sweeper.
 *
 * Every checkout (repo root or worktree) that runs `bun test` gets its own
 * compose project named `ficus-test-<sha256(repoRoot)[0:8]>` whose postgres is
 * deliberately left running between runs for reuse speed. Nothing tears the
 * project down when a worktree is deleted, and OrbStack resurrects running
 * containers on VM boot — so orphans used to run forever (RAM via tmpfs +
 * disk via container/volumes). This module reaps them.
 *
 * Orphan detection, two generations:
 * - New containers carry a `dev.ficus.test-db.repo-root` label (set via
 *   TEST_REPO_ROOT at `up` time): orphan iff that path no longer exists.
 * - Legacy containers (no label) can't be reversed from the hash: orphan iff
 *   the hash matches none of this repo's live worktree paths (`git worktree
 *   list` covers the main checkout and every linked worktree).
 *
 * A container made under the pre-rename project-name prefix is still
 * recognized by both checks (`RECOGNIZED_PROJECT_PREFIXES`), so one left
 * running for a still-live worktree isn't reaped as foreign, and one left
 * from a deleted worktree is still found and torn down rather than becoming
 * permanently invisible.
 *
 * Used by test-setup.ts (throttled, every `bun test` boot) and
 * scripts/docker-gc.ts (forced, periodic).
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'

export const TEST_DB_LABEL = 'dev.ficus.test-db'
export const TEST_DB_REPO_ROOT_LABEL = 'dev.ficus.test-db.repo-root'
const PROJECT_PREFIX = 'ficus-test-'
/**
 * Still recognized so a container made before this prefix changed doesn't go
 * invisible to the sweep and run forever — the exact disk-filling failure
 * mode this module exists to prevent (see the module doc comment).
 */
const LEGACY_PROJECT_PREFIX = 'tau-test-' // ficus-p5-bridge
const RECOGNIZED_PROJECT_PREFIXES = [PROJECT_PREFIX, LEGACY_PROJECT_PREFIX]

export interface TestDbContainer {
  /** compose project name, e.g. ficus-test-2ff43b29 */
  project: string
  /** value of dev.ficus.test-db.repo-root, '' when unlabeled (legacy) */
  repoRoot: string
}

export function projectNameForPath(repoRoot: string): string {
  return `${PROJECT_PREFIX}${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
}

/**
 * The project name this same path hashed to under the pre-rename prefix.
 * Only used to recognize a legacy container as belonging to a still-live
 * path (so it is kept, not reaped as a stranger) — a fresh project is always
 * created under `projectNameForPath`'s current prefix, never this one.
 */
export function legacyProjectNameForPath(repoRoot: string): string {
  return `${LEGACY_PROJECT_PREFIX}${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}` // ficus-p5-bridge
}

/**
 * Pure decision: which projects are orphans?
 * - The current checkout's own project is never an orphan.
 * - Labeled: orphan iff the labeled path is gone.
 * - Unlabeled: orphan iff no live worktree path hashes to the project name.
 */
export function findOrphanProjects(args: {
  containers: TestDbContainer[]
  liveWorktreePaths: string[]
  currentProject: string
  pathExists?: (p: string) => boolean
}): string[] {
  const pathExists = args.pathExists ?? existsSync
  const liveProjects = new Set(
    args.liveWorktreePaths.flatMap((p) => [projectNameForPath(p), legacyProjectNameForPath(p)])
  )
  const orphans = new Set<string>()

  for (const c of args.containers) {
    if (!RECOGNIZED_PROJECT_PREFIXES.some((prefix) => c.project.startsWith(prefix))) continue
    if (c.project === args.currentProject) continue
    if (c.repoRoot) {
      if (!pathExists(c.repoRoot)) orphans.add(c.project)
    } else if (!liveProjects.has(c.project)) {
      orphans.add(c.project)
    }
  }

  return [...orphans].sort()
}

export interface SweepDeps {
  /** Run a command, return stdout ('' on any failure). Injectable for tests. */
  exec: (cmd: string[], opts?: { timeoutMs?: number }) => string
  log?: (msg: string) => void
}

export function defaultExec(cmd: string[], opts?: { timeoutMs?: number }): string {
  try {
    const res = Bun.spawnSync(cmd, {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: opts?.timeoutMs ?? 15000,
    })
    if (res.exitCode !== 0) return ''
    return res.stdout.toString()
  } catch {
    return ''
  }
}

/** List all ficus-test (and legacy tau-test) containers (any state) with their repo-root labels. */
export function listTestDbContainers(exec: SweepDeps['exec']): TestDbContainer[] {
  const out = exec([
    'docker',
    'ps',
    '-a',
    // Multiple `--filter name=` values are OR'd by docker, not AND'd.
    ...RECOGNIZED_PROJECT_PREFIXES.flatMap((prefix) => ['--filter', `name=${prefix}`]),
    '--format',
    `{{.Label "com.docker.compose.project"}}\t{{.Label "${TEST_DB_REPO_ROOT_LABEL}"}}`,
  ])
  const seen = new Map<string, TestDbContainer>()
  for (const line of out.split('\n')) {
    const [project, repoRoot = ''] = line.trim().split('\t')
    if (project && RECOGNIZED_PROJECT_PREFIXES.some((prefix) => project.startsWith(prefix)) && !seen.has(project)) {
      seen.set(project, { project, repoRoot })
    }
  }
  return [...seen.values()]
}

/** Live paths of this repo's main checkout + every linked worktree. */
export function listLiveWorktreePaths(exec: SweepDeps['exec'], cwd: string): string[] {
  const out = exec(['git', '-C', cwd, 'worktree', 'list', '--porcelain'])
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter(Boolean)
}

/**
 * Find and tear down orphaned test-DB projects. Never throws; safe to call
 * from the test preload. Returns the projects it removed.
 */
export function sweepOrphanTestDbs(args: {
  composeFile: string
  currentRepoRoot: string
  deps?: Partial<SweepDeps>
}): string[] {
  const exec = args.deps?.exec ?? defaultExec
  const log = args.deps?.log ?? (() => {})
  try {
    const containers = listTestDbContainers(exec)
    if (containers.length === 0) return []
    const orphans = findOrphanProjects({
      containers,
      liveWorktreePaths: listLiveWorktreePaths(exec, args.currentRepoRoot),
      currentProject: projectNameForPath(args.currentRepoRoot),
    })
    for (const project of orphans) {
      log(`Reaping orphaned test DB project ${project} (worktree gone)`)
      exec(['docker', 'compose', '-p', project, '-f', args.composeFile, 'down', '--volumes'], { timeoutMs: 30000 })
    }
    return orphans
  } catch {
    return []
  }
}
