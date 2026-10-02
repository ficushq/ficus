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
  const upstream = join(root, 'upstream.git')
  await exec(['git', 'clone', '--bare', repo, upstream])
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', upstream])
  await exec(['git', '-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:example/repo.git'])
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
      baseSource: 'remote',
      baseCommit: await oid(repo),
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
  await exec(['git', '-C', repo, 'remote', 'set-url', 'origin', 'git@github.com:example/repo.git'])
  await exec(['git', '-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:other/repo.git'])
  await expect(prepareRepository(exec, root, { repository: 'repo', baseBranch: 'main' }, 'stream', {})).rejects.toThrow(
    'fetch and push'
  )
  await exec(['git', '-C', repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:example/repo.git'])
  await exec(['git', '-C', repo, 'remote', 'set-url', 'origin', join(root, 'upstream.git')])
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

const oid = async (checkout: string, ref = 'HEAD') => (await exec(['git', '-C', checkout, 'rev-parse', ref])).trim()

async function advanceRemote(branch = 'main') {
  const author = join(root, 'author')
  await exec(['git', 'clone', join(root, 'upstream.git'), author])
  await exec(['git', '-C', author, 'checkout', '-B', branch])
  await writeFile(join(author, 'README'), 'advanced upstream\n')
  await exec(['git', '-C', author, 'add', 'README'])
  await exec([
    'git',
    '-C',
    author,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'advance',
  ])
  await exec(['git', '-C', author, 'push', 'origin', branch])
  return oid(author)
}

for (const cached of [false, true]) {
  test(`fresh remote OID wins over stale local main${cached ? ' and cached remote ref' : ''}`, async () => {
    const stale = await oid(repo)
    if (cached) await exec(['git', '-C', repo, 'fetch', 'origin'])
    const fetchHeadBefore = cached ? await Bun.file(join(repo, '.git/FETCH_HEAD')).text() : undefined
    const fresh = await advanceRemote()
    await writeFile(join(repo, 'README'), 'dirty source\n')
    const before = await exec(['git', '-C', repo, 'status', '--porcelain'])
    const receipts: unknown[] = []
    const metadata = await prepareRepository(
      exec,
      root,
      { repository: 'repo', baseBranch: 'main' },
      'fresh',
      {},
      (receipt) => receipts.push(receipt)
    )
    expect(await oid(join(root, 'worktrees/fresh'))).toBe(fresh)
    expect(metadata.git).toMatchObject({ baseCommit: fresh, baseSource: 'remote' })
    expect(receipts[0]).toMatchObject({ baseCommit: fresh, baseSource: 'remote' })
    expect(await oid(repo)).toBe(stale)
    if (cached) {
      if (fetchHeadBefore === undefined) throw new Error('Cached fixture must capture FETCH_HEAD before provisioning')
      expect(await oid(repo, 'refs/remotes/origin/main')).toBe(stale)
      expect(await Bun.file(join(repo, '.git/FETCH_HEAD')).text()).toBe(fetchHeadBefore)
    } else {
      expect(await exec(['git', '-C', repo, 'for-each-ref', 'refs/remotes/origin/main'])).toBe('')
      expect(await Bun.file(join(repo, '.git/FETCH_HEAD')).exists()).toBe(false)
    }
    expect(await exec(['git', '-C', repo, 'status', '--porcelain'])).toBe(before)
    expect(await exec(['git', '-C', repo, 'for-each-ref', 'refs/ficus/provisioning/'])).toBe('')
  })
}

test('uses the selected custom remote and actual base, not origin/main', async () => {
  const fresh = await advanceRemote('release')
  await exec(['git', '-C', repo, 'remote', 'rename', 'origin', 'upstream'])
  await exec(['git', '-C', repo, 'symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/release'])
  const metadata = await prepareRepository(exec, root, { repository: 'repo', gitRemote: 'upstream' }, 'custom', {})
  expect(await oid(join(root, 'worktrees/custom'))).toBe(fresh)
  expect(metadata.git).toMatchObject({ remote: 'upstream', baseBranch: 'release', baseCommit: fresh })
})

test('pins the fetched OID even if mutable refs move before worktree add', async () => {
  const stale = await oid(repo)
  const fresh = await advanceRemote()
  const racingExec: RepositoryExec = async (args) => {
    if (args.includes('worktree') && args.includes('add')) {
      await exec(['git', '-C', repo, 'update-ref', 'refs/remotes/origin/main', stale])
      await writeFile(join(repo, '.git/FETCH_HEAD'), `${stale}\n`)
      expect(args.at(-1)).toBe(fresh)
    }
    return exec(args)
  }
  await prepareRepository(racingExec, root, { repository: 'repo', baseBranch: 'main' }, 'race', {})
  expect(await oid(join(root, 'worktrees/race'))).toBe(fresh)
})

test('fetch failure never falls back to a cached or local base or leaks credentials', async () => {
  await exec(['git', '-C', repo, 'fetch', 'origin'])
  const failingExec: RepositoryExec = (args) => {
    if (args.includes('fetch')) throw new Error('auth denied https://secret@github.com/example/repo')
    return exec(args)
  }
  const error = await prepareRepository(
    failingExec,
    root,
    { repository: 'repo', baseBranch: 'main' },
    'failed',
    {}
  ).catch((error) => error as Error)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('Could not refresh Git base')
  expect(error.message).not.toContain('secret')
  expect(await exec(['git', '-C', repo, 'branch', '--list', 'work/failed'])).toBe('')
  expect(await exec(['git', '-C', repo, 'for-each-ref', 'refs/ficus/provisioning/'])).toBe('')
  expect(await exec(['sh', '-c', 'test ! -e "$1"', 'fixture', join(root, 'worktrees/failed')])).toBe('')
})

test('missing remote branch fails rather than silently using a same-named local branch', async () => {
  await exec(['git', '-C', repo, 'branch', 'initiative'])
  await expect(
    prepareRepository(exec, root, { repository: 'repo', baseBranch: 'initiative' }, 'missing', {})
  ).rejects.toThrow('Could not refresh Git base')
})

test('explicit local initiative base is pinned without contacting a remote', async () => {
  await exec(['git', '-C', repo, 'branch', 'initiative'])
  const local = await oid(repo, 'initiative')
  const offlineExec: RepositoryExec = (args) => {
    if (args.includes('fetch')) throw new Error('should not fetch a deliberate local base')
    return exec(args)
  }
  const metadata = await prepareRepository(
    offlineExec,
    root,
    { repository: 'repo', baseBranch: 'initiative', baseSource: 'local' },
    'local',
    {}
  )
  expect(await oid(join(root, 'worktrees/local'))).toBe(local)
  expect(metadata.git).toMatchObject({ baseCommit: local, baseSource: 'local', baseBranch: 'initiative' })
  await expect(
    prepareRepository(offlineExec, root, { repository: 'repo', baseSource: 'local' }, 'ambiguous', {})
  ).rejects.toThrow('Local base requires')
})

test('existing dirty branch/worktree attachments do not fetch, resolve a missing base, or reset', async () => {
  await exec(['git', '-C', repo, 'branch', 'existing'])
  const offlineExec: RepositoryExec = (args) => {
    if (args.includes('fetch')) throw new Error('offline')
    return exec(args)
  }
  const input = { repository: 'repo', branch: 'existing', baseBranch: 'missing' }
  const metadata = await prepareRepository(offlineExec, root, input, 'existing', {})
  const target = join(root, 'worktrees/existing')
  await writeFile(join(target, 'README'), 'dirty feature\n')
  const before = await exec(['git', '-C', target, 'status', '--porcelain'])
  expect(await prepareRepository(offlineExec, root, input, 'existing', metadata)).toEqual(metadata)
  expect(await exec(['git', '-C', target, 'status', '--porcelain'])).toBe(before)
  expect(await oid(target)).toBe(await oid(repo))
  expect(metadata.git).not.toHaveProperty('baseCommit')
})

test('an add failure cleans its fetch ref, records no receipt, and can be retried', async () => {
  const receipts: unknown[] = []
  const failingExec: RepositoryExec = (args) => {
    if (args.includes('worktree') && args.includes('add')) throw new Error('fixture add failure')
    return exec(args)
  }
  const input = { repository: 'repo', baseBranch: 'main' }
  await expect(
    prepareRepository(failingExec, root, input, 'retry', {}, (receipt) => receipts.push(receipt))
  ).rejects.toThrow('fixture add failure')
  expect(receipts).toEqual([])
  expect(await exec(['git', '-C', repo, 'for-each-ref', 'refs/ficus/provisioning/'])).toBe('')
  const metadata = await prepareRepository(exec, root, input, 'retry', {}, (receipt) => receipts.push(receipt))
  expect(receipts).toHaveLength(1)
  await expect(
    prepareRepository(exec, root, input, 'retry', metadata, (receipt) => receipts.push(receipt))
  ).resolves.toEqual(metadata)
  expect(receipts).toHaveLength(1)
})

test('a pre-existing branch checked out in a dirty source checkout is never moved', async () => {
  await exec(['git', '-C', repo, 'checkout', '-b', 'existing'])
  await writeFile(join(repo, 'README'), 'dirty source\n')
  const before = await exec(['git', '-C', repo, 'status', '--porcelain'])
  await expect(
    prepareRepository(exec, root, { repository: 'repo', branch: 'existing', baseBranch: 'missing' }, 'busy', {})
  ).rejects.toThrow(/already (checked out|used by worktree)/)
  expect(await exec(['git', '-C', repo, 'status', '--porcelain'])).toBe(before)
  expect((await exec(['git', '-C', repo, 'branch', '--show-current'])).trim()).toBe('existing')
})
