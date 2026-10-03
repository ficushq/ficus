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
 * Orphan detection:
 * - Labeled containers carry a `dev.ficus.test-db.repo-root` label (set via
 *   TEST_REPO_ROOT at `up` time): orphan iff that path no longer exists.
 * - Unlabeled containers can't be reversed from the hash: orphan iff
 *   the hash matches none of this repo's live worktree paths (`git worktree
 *   list` covers the main checkout and every linked worktree).
 *
 * Used by test-setup.ts (throttled, every `bun test` boot) and
 * scripts/docker-gc.ts (forced, periodic).
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'

export const TEST_DB_LABEL = 'dev.ficus.test-db'
export const TEST_DB_REPO_ROOT_LABEL = 'dev.ficus.test-db.repo-root'
const PROJECT_PREFIX = 'ficus-test-'

export interface TestDbContainer {
  /** compose project name, e.g. ficus-test-2ff43b29 */
  project: string
  /** value of dev.ficus.test-db.repo-root, '' when unlabeled */
  repoRoot: string
}

export function projectNameForPath(repoRoot: string): string {
  return `${PROJECT_PREFIX}${createHash('sha256').update(repoRoot).digest('hex').slice(0, 8)}`
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
  const liveProjects = new Set(args.liveWorktreePaths.map(projectNameForPath))
  const orphans = new Set<string>()

  for (const c of args.containers) {
    if (!c.project.startsWith(PROJECT_PREFIX)) continue
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

/** List all ficus-test containers (any state) with their repo-root labels. */
export function listTestDbContainers(exec: SweepDeps['exec']): TestDbContainer[] {
  const out = exec([
    'docker',
    'ps',
    '-a',
    '--filter',
    `name=${PROJECT_PREFIX}`,
    '--format',
    `{{.Label "com.docker.compose.project"}}\t{{.Label "${TEST_DB_REPO_ROOT_LABEL}"}}`,
  ])
  const seen = new Map<string, TestDbContainer>()
  for (const line of out.split('\n')) {
    const [project, repoRoot = ''] = line.trim().split('\t')
    if (project?.startsWith(PROJECT_PREFIX) && !seen.has(project)) {
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
