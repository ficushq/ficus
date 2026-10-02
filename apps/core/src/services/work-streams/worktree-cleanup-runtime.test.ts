import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, rename, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { testDbProjectName } from '@ficus/shared/testDbPort'
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
  await writeFile(join(repo, '.gitignore'), 'evidence/\nnode_modules/\ndist/\n*.tsbuildinfo\n.test-db-port\n')
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
    { repository: repo, branch: 'feature', baseBranch: 'main', baseSource: 'local' },
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

const archiveRef = (oid: string) => `refs/ficus-archive/${basename(ownership.worktree)}/${oid}`
const archiveRefs = async () =>
  (await exec(['git', '-C', repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/ficus-archive/']))
    .trim()
    .split('\n')
    .filter(Boolean)

/** The commit outlives the worktree, its reflog and an aggressive prune, and no branch was added. */
async function expectPreserved(...oids: string[]) {
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  await exec(['git', '-C', repo, 'reflog', 'expire', '--expire=now', '--all'])
  await exec(['git', '-C', repo, 'gc', '--prune=now', '--quiet'])
  const archived = await archiveRefs()
  for (const oid of oids) {
    expect(
      archived.some((line) => {
        const [ref] = line.split(' ')
        return Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', oid, ref!]).exitCode === 0
      })
    ).toBe(true)
    expect((await exec(['git', '-C', repo, 'cat-file', '-t', oid])).trim()).toBe('commit')
  }
  expect((await exec(['git', '-C', repo, 'branch', '--format=%(refname:short)'])).trim().split('\n').sort()).toEqual([
    'feature',
    'main',
  ])
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

test('removes a worktree whose only leftovers are files Git ignores', async () => {
  await mkdir(join(ownership.worktree, 'node_modules/pkg'), { recursive: true })
  await writeFile(join(ownership.worktree, 'node_modules/pkg/index.js'), 'module.exports = 1\n')
  await mkdir(join(ownership.worktree, 'dist'))
  await writeFile(join(ownership.worktree, 'dist/app.js'), 'built\n')
  await writeFile(join(ownership.worktree, 'tsconfig.tsbuildinfo'), '{}')
  await mkdir(join(ownership.worktree, 'evidence'))
  await writeFile(join(ownership.worktree, 'evidence/log'), 'regenerable')
  expect(await remove()).toMatchObject({ status: 'succeeded' })
  expect(await Bun.file(join(ownership.worktree, 'node_modules/pkg/index.js')).exists()).toBe(false)
  expect((await exec(['git', '-C', repo, 'rev-parse', 'feature'])).trim()).toBe(head)
})

for (const kind of ['tracked', 'staged', 'untracked'] as const) {
  test(`retains uncommitted ${kind} changes even alongside ignored files`, async () => {
    await mkdir(join(ownership.worktree, 'node_modules'))
    await writeFile(join(ownership.worktree, 'node_modules/dep'), 'ignored')
    if (kind === 'tracked') await writeFile(join(ownership.worktree, 'README'), 'changed')
    if (kind === 'staged') {
      await writeFile(join(ownership.worktree, 'added'), 'staged work')
      await exec(['git', '-C', ownership.worktree, 'add', 'added'])
    }
    if (kind === 'untracked') await writeFile(join(ownership.worktree, 'notes'), 'evidence')
    expect(await remove()).toMatchObject({
      status: 'retained',
      reason: 'Uncommitted changes: modified, staged or untracked (not ignored) files',
    })
    expect(await Bun.file(join(ownership.worktree, 'node_modules/dep')).exists()).toBe(true)
  })
}

for (const kind of ['lock', 'head'] as const) {
  test(`retains ${kind} identity changes`, async () => {
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
    expect(await remove()).toMatchObject({
      status: 'retained',
      reason: 'Uncommitted changes may be hidden by assume-unchanged or skip-worktree index flags',
    })
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

test('archives an unpublished detached commit protected only by this worktree HEAD reflog, then removes', async () => {
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
  expect(await remove()).toMatchObject({ status: 'succeeded', archivedRefs: [archiveRef(unpublished)] })
  await expectPreserved(unpublished)
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

for (const file of ['COMMIT_EDITMSG', 'FETCH_HEAD', 'AUTO_MERGE']) {
  test(`leftover ${file} scratch does not block removal`, async () => {
    await commitFeature()
    await writeFile(join(ownership.gitDirectory, file), 'draft notes\n')
    expect(await remove()).toMatchObject({ status: 'succeeded' })
  })
}

async function commit(message: string) {
  await writeFile(join(ownership.worktree, 'README'), `${message}\n`)
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
    message,
  ])
  return (await exec(['git', '-C', ownership.worktree, 'rev-parse', 'HEAD'])).trim()
}

test('archives an unpushed commit discarded from the branch and kept only by ORIG_HEAD and the reflog', async () => {
  const unpushed = await commit('unpushed')
  await exec(['git', '-C', ownership.worktree, 'reset', '--hard', head])
  expect(await exec(['git', '-C', ownership.worktree, 'status', '--porcelain'])).toBe('')
  expect(await remove()).toMatchObject({ status: 'succeeded', archivedRefs: [archiveRef(unpushed)] })
  await expectPreserved(unpushed)
})

test('archives an unpushed commit recorded only by a leftover REBASE_HEAD', async () => {
  const unpushed = await commit('rebased away')
  await exec(['git', '-C', ownership.worktree, 'reset', '--hard', head])
  await rm(join(ownership.gitDirectory, 'ORIG_HEAD'), { force: true })
  await writeFile(join(ownership.gitDirectory, 'logs/HEAD'), '')
  await writeFile(join(ownership.gitDirectory, 'REBASE_HEAD'), `${unpushed}\n`)
  expect(await remove()).toMatchObject({ status: 'succeeded', archivedRefs: [archiveRef(unpushed)] })
  await expectPreserved(unpushed)
})

for (const via of ['pushed', 'merged'] as const) {
  test(`removes a worktree whose discarded commit was ${via}`, async () => {
    const published = await commit(via)
    if (via === 'pushed') await exec(['git', '-C', repo, 'update-ref', 'refs/remotes/origin/published', published])
    else await exec(['git', '-C', repo, 'update-ref', 'refs/heads/main', published])
    await exec(['git', '-C', ownership.worktree, 'reset', '--hard', head])
    expect(await remove()).toMatchObject({ status: 'succeeded' })
  })
}

describe('project-scoped test database', () => {
  let bin: string
  let state: string
  let calls: string
  let project: string
  // A fake docker CLI: the state file holds the repo-root label of this
  // project's running container; `compose down` clears it unless told to fail.
  beforeEach(async () => {
    bin = join(root, 'docker-bin')
    state = join(root, 'docker-state')
    calls = join(root, 'docker-calls')
    project = testDbProjectName(ownership.worktree)
    await mkdir(bin)
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh
echo "$*" >> "${calls}"
[ -f "${root}/docker-broken" ] && exit 1
case "$1" in
  ps) [ "$4" = "label=com.docker.compose.project=${project}" ] && [ -f "${state}" ] && cat "${state}"; exit 0 ;;
  compose) [ -f "${root}/docker-stuck" ] && exit 1; rm -f "${state}"; exit 0 ;;
esac
exit 2
`,
      { mode: 0o755 }
    )
  })
  const removeWithDocker = () =>
    runtime.removeOwnedWorktree((args) => exec(['env', `PATH=${bin}:${process.env.PATH}`, ...args]), {
      ownership,
      head,
      operationId: crypto.randomUUID(),
    })
  const dockerCalls = async () => ((await Bun.file(calls).exists()) ? await readFile(calls, 'utf8') : '')

  test('tears down only this worktree’s running test database before removal', async () => {
    await writeFile(join(ownership.worktree, '.test-db-port'), '55432')
    await writeFile(state, `${ownership.worktree}\n`)
    expect(await removeWithDocker()).toMatchObject({ status: 'succeeded' })
    expect(await dockerCalls()).toContain(`compose -p ${project} down --volumes`)
    expect(await Bun.file(state).exists()).toBe(false)
  })

  test('removes without touching Docker resources when no test database is running', async () => {
    await writeFile(join(ownership.worktree, '.test-db-port'), '55432')
    expect(await removeWithDocker()).toMatchObject({ status: 'succeeded' })
    expect(await dockerCalls()).not.toContain('compose -p')
  })

  test('never stops a project labelled with another worktree', async () => {
    await writeFile(state, `${root}/other-worktree\n`)
    expect(await removeWithDocker()).toMatchObject({
      status: 'retained',
      reason: expect.stringContaining('not labelled with this worktree'),
    })
    expect(await dockerCalls()).not.toContain('compose -p')
    expect(await Bun.file(state).exists()).toBe(true)
  })

  test('defers when the recorded test database cannot be verified or stopped', async () => {
    await writeFile(join(ownership.worktree, '.test-db-port'), '55432')
    await writeFile(join(root, 'docker-broken'), '')
    expect(await removeWithDocker()).toMatchObject({
      status: 'retained',
      reason: expect.stringContaining('Could not verify'),
    })
    await rm(join(root, 'docker-broken'))
    await writeFile(join(root, 'docker-stuck'), '')
    await writeFile(state, `${ownership.worktree}\n`)
    expect(await removeWithDocker()).toMatchObject({
      status: 'retained',
      reason: expect.stringContaining('Could not stop'),
    })
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })

  test('does not tear down the test database when uncommitted changes block removal', async () => {
    await writeFile(state, `${ownership.worktree}\n`)
    await writeFile(join(ownership.worktree, 'notes'), 'uncommitted')
    expect(await removeWithDocker()).toMatchObject({ status: 'retained' })
    expect(await dockerCalls()).not.toContain('compose -p')
  })
})

test('accepts the empty private refs directory created by newer Git without discarding private refs', async () => {
  const refs = join(ownership.gitDirectory, 'refs')
  await mkdir(refs, { recursive: true })
  expect(await remove()).toMatchObject({ status: 'succeeded' })
})

describe('rewritten or abandoned history', () => {
  let remote: string
  let rewritten: string[]
  // A delivered branch that was pushed, rebased onto a moved main, force-pushed,
  // squash-merged and then deleted on the remote: the pre-rebase commits now
  // live only in this worktree's HEAD reflog and ORIG_HEAD.
  beforeEach(async () => {
    remote = join(root, 'remote.git')
    await exec(['git', 'init', '--bare', '-b', 'main', remote])
    await exec(['git', '-C', repo, 'remote', 'set-url', 'origin', remote])
    await exec(['git', '-C', repo, 'push', 'origin', 'main'])
    rewritten = [await commit('first draft'), await commit('second draft')]
    await exec(['git', '-C', ownership.worktree, 'push', '-u', 'origin', 'feature'])
    await writeFile(join(repo, 'OTHER'), 'moved main\n')
    await exec(['git', '-C', repo, 'add', 'OTHER'])
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
      'main moved',
    ])
    await exec(['git', '-C', repo, 'push', 'origin', 'main'])
    await exec(['git', '-C', ownership.worktree, 'fetch', 'origin'])
    await exec(['git', '-C', ownership.worktree, 'reset', '--hard', 'origin/main'])
    head = await commit('rebased feature')
    await exec(['git', '-C', ownership.worktree, 'push', '--force', 'origin', 'feature'])
    await exec(['git', '-C', repo, 'merge', '--squash', 'feature'])
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
      'squash',
    ])
    await exec(['git', '-C', repo, 'push', 'origin', 'main', ':feature'])
    await exec(['git', '-C', repo, 'fetch', '--prune', 'origin'])
    expect(await exec(['git', '-C', ownership.worktree, 'status', '--porcelain'])).toBe('')
  })

  test('archives reflog-only pre-rebase commits under one shared ref, removes, and keeps them reachable', async () => {
    const receipt = await remove()
    expect(receipt).toMatchObject({
      status: 'succeeded',
      reason: expect.stringContaining(`archived under refs/ficus-archive/${basename(ownership.worktree)}/`),
      archivedRefs: [archiveRef(rewritten[1]!)],
    })
    await expectPreserved(...rewritten)
    expect(await archiveRefs()).toEqual([`${archiveRef(rewritten[1]!)} ${rewritten[1]}`])
    expect((await exec(['git', '-C', repo, 'rev-parse', 'feature'])).trim()).toBe(head)
  })

  test('a repeated cleanup reuses matching archive refs without duplicating them', async () => {
    await exec(['git', '-C', repo, 'update-ref', archiveRef(rewritten[1]!), rewritten[1]!])
    const before = await archiveRefs()
    expect(await remove()).toMatchObject({ status: 'succeeded', archivedRefs: [archiveRef(rewritten[1]!)] })
    expect(await archiveRefs()).toEqual(before)
  })

  test('never clobbers an archive ref that points elsewhere', async () => {
    await exec(['git', '-C', repo, 'update-ref', archiveRef(rewritten[1]!), head])
    expect(await remove()).toMatchObject({ status: 'retained', reason: expect.stringContaining('does not match') })
    expect(await archiveRefs()).toEqual([`${archiveRef(rewritten[1]!)} ${head}`])
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })

  test('keeps today’s deferral when the archive ref cannot be written', async () => {
    const bin = join(root, 'bin')
    await mkdir(bin)
    const git = Bun.which('git')!
    await writeFile(
      join(bin, 'git'),
      `#!/bin/sh\ncase " $* " in\n  *" update-ref "*) exit 1 ;;\n  *) exec "${git}" "$@" ;;\nesac\n`,
      { mode: 0o755 }
    )
    const failingWrites = (args: string[]) => exec(['env', `PATH=${bin}:${process.env.PATH}`, ...args])
    expect(
      await runtime.removeOwnedWorktree(failingWrites, { ownership, head, operationId: crypto.randomUUID() })
    ).toMatchObject({ status: 'retained', reason: expect.stringContaining('could not archive') })
    expect(await archiveRefs()).toEqual([])
    expect(await readFile(join(ownership.gitDirectory, 'logs/HEAD'), 'utf8')).toContain(rewritten[1]!)
  })

  test('keeps today’s deferral when a conflicting ref blocks the archive namespace', async () => {
    await exec(['git', '-C', repo, 'update-ref', `refs/ficus-archive/${basename(ownership.worktree)}`, head])
    expect(await remove()).toMatchObject({ status: 'retained', reason: expect.stringContaining('could not archive') })
    expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(true)
  })

  test('a dirty tree still defers and writes no archive ref', async () => {
    await writeFile(join(ownership.worktree, 'notes'), 'uncommitted')
    expect(await remove()).toMatchObject({
      status: 'retained',
      reason: 'Uncommitted changes: modified, staged or untracked (not ignored) files',
    })
    expect(await archiveRefs()).toEqual([])
  })
})

test('archives under a stable hashed scope when the worktree name is not a valid refname component', async () => {
  await prepareRepository(
    exec,
    root,
    { repository: repo, branch: 'odd', baseBranch: 'main', baseSource: 'local', worktree: 'worktrees/fix..thing' },
    'odd',
    {},
    (value) => {
      ownership = value
    }
  )
  expect(basename(ownership.worktree)).toBe('fix..thing')
  const abandoned = await commit('abandoned')
  await exec(['git', '-C', ownership.worktree, 'reset', '--hard', head])
  const scope = createHash('sha256').update(ownership.worktree).digest('hex').slice(0, 16)
  const ref = `refs/ficus-archive/${scope}/${abandoned}`
  expect(await remove()).toMatchObject({ status: 'succeeded', archivedRefs: [ref] })
  expect(await Bun.file(join(ownership.worktree, 'README')).exists()).toBe(false)
  expect(await archiveRefs()).toEqual([`${ref} ${abandoned}`])
})
