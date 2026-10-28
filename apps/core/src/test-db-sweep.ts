/**
 * Test DB inventory helpers and the maintenance entry point. Inventory/path
 * absence is NOT deletion authority: only the recorded lifecycle sweep may
 * remove a project (dead owner, same clone/host, 2h old, matching token labels).
 */
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { sweepStaleTestDbs } from '@ficus/shared/testDbLifecycle'

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
  sweep?: (root: string) => string[]
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
      killSignal: 'SIGKILL',
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
 * Compatibility maintenance entry point; never deletes from inventory alone.
 * Returns only projects whose owned teardown actually succeeded.
 */
export function sweepOrphanTestDbs(args: {
  composeFile: string
  currentRepoRoot: string
  deps?: Partial<SweepDeps>
}): string[] {
  try {
    return (args.deps?.sweep ?? sweepStaleTestDbs)(args.currentRepoRoot)
  } catch (error) {
    args.deps?.log?.(`Test DB sweep failed: ${String(error).slice(-2000)}`)
    return []
  }
}
