import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProvisionedWorktree } from './create-rollback'
import { prepareRepository, type RepositoryExec, type WorktreeOwnership } from './repository-setup'

const exec: RepositoryExec = async (args, options) => {
  const child = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options?.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`exit ${code}: ${err || out}`)
  return out
}

let root: string
let repo: string
const git = (...args: string[]) => exec(['git', '-C', repo, ...args]).then((out) => out.trim())
const branchExists = (branch: string) =>
  git('show-ref', '--verify', `refs/heads/${branch}`).then(
    () => true,
    () => false
  )

async function provision(key: string, branch?: string): Promise<WorktreeOwnership> {
  let receipt: WorktreeOwnership | undefined
  await prepareRepository(
    exec,
    root,
    { repository: 'repo', branch, baseBranch: 'main', baseSource: 'local' },
    key,
    {},
    (value) => {
      receipt = value
    }
  )
  return receipt!
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-create-rollback-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'base\n')
  await git('add', '.')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')
  await git('remote', 'add', 'origin', 'git@github.com:example/repo.git')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('removeProvisionedWorktree', () => {
  test('removes the worktree and the branch the create made, so the same explicit branch can be provisioned again', async () => {
    const ownership = await provision('first', 'feature/retry')
    expect(ownership.baseCommit).toBeDefined()
    // Without the rollback, the retry fails: the branch is still checked out in the first worktree.
    await expect(provision('blocked', 'feature/retry')).rejects.toThrow()

    expect(await removeProvisionedWorktree(exec, ownership)).toMatchObject({ worktree: 'removed', branch: 'deleted' })
    expect(existsSync(ownership.worktree)).toBe(false)
    expect(await branchExists('feature/retry')).toBe(false)

    const retried = await provision('second', 'feature/retry')
    expect(existsSync(retried.worktree)).toBe(true)
    expect(await branchExists('feature/retry')).toBe(true)
  })

  test('never deletes a branch that existed before the create', async () => {
    await git('branch', 'existing')
    const tip = await git('rev-parse', 'existing')
    const ownership = await provision('reuse', 'existing')
    expect(ownership.baseCommit).toBeUndefined()

    expect(await removeProvisionedWorktree(exec, ownership)).toMatchObject({
      worktree: 'removed',
      branch: 'pre-existing',
    })
    expect(existsSync(ownership.worktree)).toBe(false)
    expect(await git('rev-parse', 'existing')).toBe(tip)
    // A retry can reuse it again.
    expect(existsSync((await provision('reuse-again', 'existing')).worktree)).toBe(true)
  })

  test('keeps the worktree and branch when the worktree has uncommitted work', async () => {
    const ownership = await provision('dirty')
    await writeFile(join(ownership.worktree, 'notes.txt'), 'keep me\n')

    expect(await removeProvisionedWorktree(exec, ownership)).toMatchObject({ worktree: 'retained', branch: 'retained' })
    expect(existsSync(join(ownership.worktree, 'notes.txt'))).toBe(true)
    expect(await branchExists(ownership.branch)).toBe(true)
  })

  test('keeps a created branch that moved since provisioning', async () => {
    const ownership = await provision('moved')
    await exec([
      'git',
      '-C',
      ownership.worktree,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'new work',
    ])

    expect(await removeProvisionedWorktree(exec, ownership)).toMatchObject({ worktree: 'retained', branch: 'retained' })
    expect(existsSync(ownership.worktree)).toBe(true)
    expect(await branchExists(ownership.branch)).toBe(true)
  })

  test('touches only the worktree its receipt names', async () => {
    const other = await provision('other-stream')
    const ownership = await provision('rolled-back')

    expect(await removeProvisionedWorktree(exec, ownership)).toMatchObject({ worktree: 'removed', branch: 'deleted' })
    expect(existsSync(other.worktree)).toBe(true)
    expect(await branchExists(other.branch)).toBe(true)
  })
})
