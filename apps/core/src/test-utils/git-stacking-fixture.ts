import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepositoryExec } from '../services/work-streams/repository-setup'

/**
 * An owned Git fixture for stacking tests: a bare upstream, the squad's
 * checkout with the dependent's worktree on `work/dependent`, and a separate
 * clone that plays the dependency's author. Everything lives in one unique
 * temporary directory that `cleanup` removes.
 */
export const gitFixtureExec: RepositoryExec = async (args, options) => {
  const child = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...options?.env },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(err)
  return out
}

export const fixtureGit = (dir: string, ...args: string[]) =>
  gitFixtureExec(['git', '-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]).then((out) =>
    out.trim()
  )

export async function fixtureCommit(dir: string, file: string, message: string): Promise<string> {
  await writeFile(join(dir, file), `${message}\n`)
  await fixtureGit(dir, 'add', file)
  await fixtureGit(dir, 'commit', '-m', message)
  return fixtureGit(dir, 'rev-parse', 'HEAD')
}

export interface StackingFixture {
  root: string
  upstream: string
  repo: string
  author: string
  worktree: string
  /** The commit `work/dependent` was provisioned from. */
  baseCommit: string
  /** Push a dependency branch with one commit, from `from` (default: upstream main). */
  pushDependencyBranch(branch: string, file: string, from?: string): Promise<string>
  cleanup(): Promise<void>
}

export async function createStackingFixture(): Promise<StackingFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-stacking-')))
  const upstream = join(root, 'upstream.git')
  const repo = join(root, 'repo')
  const author = join(root, 'author')
  const worktree = join(root, 'worktrees', 'dependent')
  const seed = join(root, 'seed')
  await gitFixtureExec(['git', 'init', '-b', 'main', seed])
  await fixtureCommit(seed, 'README', 'initial')
  await gitFixtureExec(['git', 'clone', '--bare', seed, upstream])
  await gitFixtureExec(['git', 'clone', upstream, repo])
  await gitFixtureExec(['git', 'clone', upstream, author])
  const baseCommit = await fixtureGit(repo, 'rev-parse', 'origin/main')
  await fixtureGit(repo, 'worktree', 'add', '-b', 'work/dependent', worktree, baseCommit)
  return {
    root,
    upstream,
    repo,
    author,
    worktree,
    baseCommit,
    async pushDependencyBranch(branch, file, from = 'origin/main') {
      await fixtureGit(author, 'fetch', 'origin')
      await fixtureGit(author, 'checkout', '-B', branch, from)
      const head = await fixtureCommit(author, file, `${branch} work`)
      await fixtureGit(author, 'push', 'origin', `${branch}:${branch}`)
      return head
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}
