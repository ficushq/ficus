import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeHostFromRemote, prepareRepository, type RepositoryExec } from './repository-setup'

let root: string
let repo: string
const exec: RepositoryExec = async (args) => {
  const child = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(err)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-repository-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, 'README'), 'test\n')
  await exec(['git', '-C', repo, 'add', 'README'])
  await exec([
    'git',
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'initial',
  ])
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('provisions a real isolated worktree and detects code host before returning metadata', async () => {
  const metadata = await prepareRepository(
    exec,
    root,
    { repository: 'repo', branch: 'feature/test', baseBranch: 'main' },
    'stream',
    { sources: [] }
  )
  expect(metadata).toEqual({
    sources: [],
    codeHost: { integration: 'github', repository: 'example/repo' },
    git: {
      repository: repo,
      worktree: join(root, 'worktrees/stream'),
      branch: 'feature/test',
      baseBranch: 'main',
      remote: 'origin',
    },
  })
  expect((await exec(['git', '-C', join(root, 'worktrees/stream'), 'branch', '--show-current'])).trim()).toBe(
    'feature/test'
  )
  expect((await exec(['git', '-C', repo, 'branch', '--show-current'])).trim()).toBe('main')
  expect(
    await prepareRepository(
      exec,
      root,
      { repository: 'repo', branch: 'feature/test', baseBranch: 'main' },
      'stream',
      metadata
    )
  ).toEqual(metadata)
})

test('detects default base from the selected remote and retains explicit account metadata', async () => {
  await exec(['git', '-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
  await exec(['git', '-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const codeHost = { integration: 'github', repository: 'example/repo', connectionId: crypto.randomUUID() }
  const result = await prepareRepository(exec, root, { repository: 'repo' }, 'stream', { codeHost })
  expect(result.codeHost).toEqual(codeHost)
  expect(result.git).toMatchObject({ baseBranch: 'main', branch: 'work/stream' })
})

test('rejects an existing worktree on another branch without switching it', async () => {
  await prepareRepository(exec, root, { repository: 'repo', branch: 'feature/one', baseBranch: 'main' }, 'stream', {})
  await expect(
    prepareRepository(exec, root, { repository: 'repo', branch: 'feature/two', baseBranch: 'main' }, 'stream', {})
  ).rejects.toThrow('Existing worktree')
  expect((await exec(['git', '-C', join(root, 'worktrees/stream'), 'branch', '--show-current'])).trim()).toBe(
    'feature/one'
  )
})

test('rejects missing base, resource mismatches, and path escapes', async () => {
  await expect(prepareRepository(exec, root, { repository: 'repo' }, 'stream', {})).rejects.toThrow(
    'default branch is unknown'
  )
  await expect(
    prepareRepository(exec, root, { repository: 'repo', baseBranch: 'main' }, 'stream', {
      codeHost: { integration: 'github', repository: 'other/repo' },
    })
  ).rejects.toThrow('does not match')
  await expect(prepareRepository(exec, root, { repository: '../elsewhere' }, 'stream', {})).rejects.toThrow('inside')
  await symlink(tmpdir(), join(root, 'escape'))
  await expect(
    prepareRepository(exec, root, { repository: 'repo', baseBranch: 'main', worktree: 'escape/target' }, 'stream', {})
  ).rejects.toThrow('outside')
})

test('does not infer unsupported hosts or credential-bearing URLs', () => {
  expect(codeHostFromRemote('https://github.com/example/repo.git')).toEqual({
    integration: 'github',
    repository: 'example/repo',
  })
  expect(codeHostFromRemote('https://token@github.com/example/repo.git')).toBeUndefined()
  expect(codeHostFromRemote('https://github.com.evil.test/example/repo.git')).toBeUndefined()
  expect(codeHostFromRemote('https://gitlab.com/example/repo.git')).toBeUndefined()
})

test('rejects ambiguous fetch/push repositories and unignored nested worktrees', async () => {
  await exec(['git', '-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:other/repo.git'])
  await expect(prepareRepository(exec, root, { repository: 'repo', baseBranch: 'main' }, 'stream', {})).rejects.toThrow(
    'fetch and push'
  )
  await exec(['git', '-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:example/repo.git'])
  await expect(
    prepareRepository(exec, root, { repository: 'repo', baseBranch: 'main', worktree: 'repo/nested' }, 'stream', {})
  ).rejects.toThrow('Git-ignored')
})

test('creates missing parent directories and preserves an existing feature branch', async () => {
  await exec(['git', '-C', repo, 'branch', 'existing-feature'])
  const metadata = await prepareRepository(
    exec,
    root,
    { repository: 'repo', branch: 'existing-feature', baseBranch: 'main', worktree: 'nested/trees/feature' },
    'stream',
    {}
  )
  expect(metadata.git).toMatchObject({ worktree: join(root, 'nested/trees/feature'), branch: 'existing-feature' })
})

test('only newly platform-created worktrees produce an ownership receipt', async () => {
  const receipts: unknown[] = []
  const input = { repository: 'repo', branch: 'feature/owned', baseBranch: 'main' }
  const metadata = await prepareRepository(exec, root, input, 'owned', {}, (receipt) => receipts.push(receipt))
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toEqual(
    expect.objectContaining({
      workspace: root,
      repository: repo,
      commonDirectory: join(repo, '.git'),
      worktree: join(root, 'worktrees/owned'),
      branch: 'feature/owned',
    })
  )
  expect(receipts[0]).toHaveProperty('directoryIdentity', expect.stringMatching(/^\d+:\d+$/))
  expect(receipts[0]).toHaveProperty('gitDirectory', expect.stringContaining('/.git/worktrees/'))
  expect(metadata).not.toHaveProperty('ownership')
  await prepareRepository(exec, root, input, 'owned', { ...metadata, ownership: receipts[0] }, (receipt) =>
    receipts.push(receipt)
  )
  expect(receipts).toHaveLength(1)
})

test('canonical target admission runs before creating directories or worktrees', async () => {
  const targets: string[] = []
  await expect(
    prepareRepository(
      exec,
      root,
      { repository: repo, baseBranch: 'main', worktree: 'new-parent/owned' },
      'blocked',
      {},
      undefined,
      (target) => {
        targets.push(target)
        throw new Error('target reserved by another work stream')
      }
    )
  ).rejects.toThrow('target reserved')
  expect(targets).toEqual([join(root, 'new-parent/owned')])
  expect(await exec(['sh', '-c', 'if [ -e "$1" ]; then printf exists; fi', 'fixture', join(root, 'new-parent')])).toBe(
    ''
  )
})
