import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRepository, type WorktreeOwnership } from './repository-setup'
import * as runtime from './worktree-cleanup-runtime'

let root: string
let repo: string
let ownership: WorktreeOwnership
let head: string
const exec = async (args: string[]) => {
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
  if (code !== 0) throw new Error(`Child exit ${code} signal ${child.signalCode}: ${err || out}`)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-cleanup-')))
  repo = join(root, 'repo')
  await mkdir(repo)
  await exec(['git', 'init', '-b', 'main', repo])
  await writeFile(join(repo, '.gitignore'), 'evidence/\n')
  await writeFile(join(repo, 'README'), 'recoverable\n')
  await exec(['git', '-C', repo, 'add', '.'])
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
  head = (await exec(['git', '-C', repo, 'rev-parse', 'HEAD'])).trim()
  await exec(['git', '-C', repo, 'remote', 'add', 'origin', 'git@github.com:example/repo.git'])
  await prepareRepository(
    exec,
    root,
    { repository: repo, branch: 'feature', baseBranch: 'main' },
    'owned',
    {},
    (value) => {
      ownership = value
    }
  )
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function remove(operationId = crypto.randomUUID()) {
  expect(runtime.removeOwnedWorktree).toBeDefined()
  return runtime.removeOwnedWorktree(exec, { ownership, head, operationId })
}

test('removes only the clean owned directory and preserves the branch and source checkout', async () => {
  expect(await remove()).toMatchObject({ status: 'succeeded' })
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  expect(await readFile(join(repo, 'README'), 'utf8')).toBe('recoverable\n')
  expect((await exec(['git', '-C', repo, 'rev-parse', 'feature'])).trim()).toBe(head)
})

test('replays the exact terminal receipt without deleting a replacement directory', async () => {
  const operationId = crypto.randomUUID()
  const first = await remove(operationId)
  await mkdir(ownership.worktree)
  await writeFile(join(ownership.worktree, 'evidence'), 'new data')
  expect(await remove(operationId)).toEqual(first)
  expect(await readFile(join(ownership.worktree, 'evidence'), 'utf8')).toBe('new data')
})

for (const kind of ['tracked', 'untracked', 'ignored', 'lock', 'head'] as const) {
  test(`retains ${kind} evidence or identity changes`, async () => {
    if (kind === 'tracked') await writeFile(join(ownership.worktree, 'README'), 'changed')
    if (kind === 'untracked') await writeFile(join(ownership.worktree, 'notes'), 'evidence')
    if (kind === 'ignored') {
      await mkdir(join(ownership.worktree, 'evidence'))
      await writeFile(join(ownership.worktree, 'evidence/secret'), 'retain')
    }
    if (kind === 'lock') await exec(['git', '-C', repo, 'worktree', 'lock', ownership.worktree])
    if (kind === 'head') head = 'a'.repeat(40)
    expect(await remove()).toMatchObject({ status: 'retained' })
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })
}

test('recovery only reads a terminal receipt and never starts an undispatched operation', async () => {
  expect(runtime.readWorktreeRemovalReceipt).toBeDefined()
  const input = { ownership, head, operationId: crypto.randomUUID() }
  await expect(runtime.readWorktreeRemovalReceipt(exec, input)).rejects.toThrow()
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  const result = await runtime.removeOwnedWorktree(exec, input)
  expect(await runtime.readWorktreeRemovalReceipt(exec, input)).toEqual(result)
})

test('recovers a lost response through the same exact terminal receipt', async () => {
  expect(runtime.readWorktreeRemovalReceipt).toBeDefined()
  const input = { ownership, head, operationId: crypto.randomUUID() }
  await expect(
    runtime.removeOwnedWorktree(async (args) => {
      await exec(args)
      throw new Error('lost response')
    }, input)
  ).rejects.toThrow('lost response')
  expect(await runtime.readWorktreeRemovalReceipt(exec, input)).toMatchObject({
    status: 'succeeded',
    operationId: input.operationId,
  })
})

test('receipt identity survives database JSON object key reordering', async () => {
  const input = { ownership, head, operationId: crypto.randomUUID() }
  const first = await runtime.removeOwnedWorktree(exec, input)
  const restored = {
    operationId: input.operationId,
    head,
    ownership: Object.fromEntries(Object.entries(ownership).reverse()) as unknown as WorktreeOwnership,
  }
  expect(await runtime.readWorktreeRemovalReceipt(exec, restored)).toEqual(first)
})

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`retains tracked evidence hidden by ${flag}`, async () => {
    await exec(['git', '-C', ownership.worktree, 'update-index', flag, 'README'])
    await writeFile(join(ownership.worktree, 'README'), 'hidden evidence')
    expect(await remove()).toMatchObject({ status: 'retained', reason: 'Hidden index flags require manual retention' })
    expect(await readFile(join(ownership.worktree, 'README'), 'utf8')).toBe('hidden evidence')
  })
}

test('never follows a replacement symlink or treats the primary checkout as removable', async () => {
  const retained = join(root, 'retained')
  await rename(ownership.worktree, retained)
  await symlink(retained, ownership.worktree)
  expect(await remove()).toMatchObject({ status: 'retained' })
  expect(await readFile(join(retained, 'README'), 'utf8')).toBe('recoverable\n')
  await expect(
    runtime.removeOwnedWorktree(exec, {
      ownership: { ...ownership, worktree: repo },
      head,
      operationId: crypto.randomUUID(),
    })
  ).rejects.toThrow()
  expect(await Bun.file(join(repo, 'README')).exists()).toBe(true)
})

test('rejects cross-repository ownership and retains an already-missing worktree without claiming removal', async () => {
  const other = join(root, 'other')
  await exec(['git', 'init', '-b', 'main', other])
  await expect(
    runtime.removeOwnedWorktree(exec, {
      ownership: { ...ownership, repository: other },
      head,
      operationId: crypto.randomUUID(),
    })
  ).rejects.toThrow()
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  await exec(['git', '-C', repo, 'worktree', 'remove', '--', ownership.worktree])
  expect(await remove()).toMatchObject({ status: 'retained' })
})

test('partial removal yields an immutable failed receipt and never retries deletion against residual evidence', async () => {
  const bin = join(root, 'bin')
  await mkdir(bin)
  const git = Bun.which('git')!
  await writeFile(
    join(bin, 'git'),
    `#!/bin/sh
case " $* " in
  *" worktree remove "*) "${git}" "$@" || exit $?; mkdir "$FIXTURE_REMOVAL_TARGET" ;;
  *) exec "${git}" "$@" ;;
esac
`,
    { mode: 0o755 }
  )
  const withResidual = (args: string[]) =>
    exec(['env', `PATH=${bin}:${process.env.PATH}`, `FIXTURE_REMOVAL_TARGET=${ownership.worktree}`, ...args])
  const input = { ownership, head, operationId: crypto.randomUUID() }
  expect(await runtime.removeOwnedWorktree(withResidual, input)).toMatchObject({ status: 'failed' })
  await writeFile(join(ownership.worktree, 'evidence'), 'preserve residual data')
  expect(await runtime.removeOwnedWorktree(exec, input)).toMatchObject({ status: 'failed' })
  expect(await readFile(join(ownership.worktree, 'evidence'), 'utf8')).toBe('preserve residual data')
})

test('retains Git index locks and committed submodule registrations', async () => {
  const lock = join(ownership.gitDirectory, 'index.lock')
  await writeFile(lock, 'owned by another Git operation')
  expect(await remove()).toMatchObject({ status: 'retained', reason: 'Git lock present' })
  await rm(lock)
  await exec(['git', '-C', ownership.worktree, 'update-index', '--add', '--cacheinfo', `160000,${head},module`])
  await mkdir(join(ownership.worktree, 'module'))
  await exec([
    'git',
    '-C',
    ownership.worktree,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'register submodule',
  ])
  head = (await exec(['git', '-C', ownership.worktree, 'rev-parse', 'HEAD'])).trim()
  expect(await remove()).toMatchObject({ status: 'retained', reason: 'Submodule worktrees require manual retention' })
})

test('preserves an unpublished detached commit protected only by this worktree HEAD reflog', async () => {
  await exec(['git', '-C', ownership.worktree, 'checkout', '--detach', head])
  await writeFile(join(ownership.worktree, 'README'), 'unpublished detached work')
  await exec(['git', '-C', ownership.worktree, 'add', 'README'])
  await exec([
    'git',
    '-C',
    ownership.worktree,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'unpublished',
  ])
  const unpublished = (await exec(['git', '-C', ownership.worktree, 'rev-parse', 'HEAD'])).trim()
  await exec(['git', '-C', ownership.worktree, 'checkout', 'feature'])
  expect(await exec(['git', '-C', ownership.worktree, 'status', '--porcelain'])).toBe('')
  expect(await remove()).toMatchObject({
    status: 'retained',
    reason: expect.stringContaining('without surviving shared refs'),
  })
  expect(await readFile(join(ownership.gitDirectory, 'logs/HEAD'), 'utf8')).toContain(unpublished)
  expect(await exec(['git', '-C', repo, 'fsck', '--unreachable'])).not.toContain(unpublished)
})

for (const state of ['local-ref', 'in-progress']) {
  test(`preserves worktree-only Git recovery state: ${state}`, async () => {
    if (state === 'local-ref')
      await exec(['git', '-C', ownership.worktree, 'update-ref', 'refs/worktree/recovery', head])
    else await writeFile(join(ownership.gitDirectory, 'MERGE_HEAD'), `${head}\n`)
    expect(await remove()).toMatchObject({ status: 'retained' })
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })
}

async function commitFeature() {
  await writeFile(join(ownership.worktree, 'README'), 'delivered feature\n')
  await exec(['git', '-C', ownership.worktree, 'add', 'README'])
  await exec([
    'git',
    '-C',
    ownership.worktree,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'Delivered feature',
  ])
  head = (await exec(['git', '-C', ownership.worktree, 'rev-parse', 'HEAD'])).trim()
}

for (const operation of ['commit', 'fetch', 'tag-fetch']) {
  test(`removes a clean delivered worktree after actual feature commits: ${operation}`, async () => {
    await commitFeature()
    if (operation !== 'commit') {
      await exec(['git', '-C', repo, 'remote', 'set-url', 'origin', repo])
      if (operation === 'tag-fetch') await exec(['git', '-C', repo, 'tag', 'v1'])
      await exec([
        'git',
        '-C',
        ownership.worktree,
        'fetch',
        'origin',
        ...(operation === 'tag-fetch' ? ['tag', 'v1'] : []),
      ])
    }
    expect(await exec(['git', '-C', ownership.worktree, 'status', '--porcelain'])).toBe('')
    expect(await remove()).toMatchObject({ status: 'succeeded' })
    expect(await exec(['git', '-C', repo, 'show', `${head}:README`])).toBe('delivered feature\n')
  })
}

for (const file of ['COMMIT_EDITMSG', 'FETCH_HEAD']) {
  test(`retains edited or unknown ${file} evidence`, async () => {
    await commitFeature()
    await writeFile(join(ownership.gitDirectory, file), 'uncommitted investigation notes\n')
    expect(await remove()).toMatchObject({ status: 'retained' })
    expect(await readFile(join(ownership.gitDirectory, file), 'utf8')).toBe('uncommitted investigation notes\n')
  })
}

test('retains valid fetch records after their tracking proof disappears', async () => {
  await exec(['git', '-C', repo, 'remote', 'set-url', 'origin', repo])
  await exec(['git', '-C', ownership.worktree, 'fetch', 'origin'])
  await exec(['git', '-C', repo, 'update-ref', '-d', 'refs/remotes/origin/main'])
  expect(await remove()).toMatchObject({
    status: 'retained',
    reason: expect.stringContaining('exact surviving tracking reference'),
  })
})

test('accepts the empty private refs directory created by newer Git without discarding private refs', async () => {
  const refs = join(ownership.gitDirectory, 'refs')
  await mkdir(refs, { recursive: true })
  expect(await remove()).toMatchObject({ status: 'succeeded' })
})
