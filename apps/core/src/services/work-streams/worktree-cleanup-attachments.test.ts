import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWorktreeAttachments } from './worktree-cleanup-attachments'
let root: string
const exec = async (args: string[]) => {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw Error(err || out)
  return out
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ficus-attachment-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('resolves declared worktree and source repository aliases without changing metadata', async () => {
  await mkdir(join(root, 'owned'))
  await symlink(join(root, 'owned'), join(root, 'alias'))
  const metadata = { git: { worktree: 'alias', repository: join(root, 'alias') } }
  expect(await resolveWorktreeAttachments(exec, root, [{ id: 'other', metadata }])).toEqual([
    { id: 'other', raw: metadata.git, canonical: { worktree: join(root, 'owned'), repository: join(root, 'owned') } },
  ])
  expect(metadata.git.worktree).toBe('alias')
})

test('resolves missing suffixes under a canonical ancestor and rejects dangling aliases', async () => {
  await mkdir(join(root, 'owned'))
  await symlink(join(root, 'owned'), join(root, 'alias'))
  const resolved = await resolveWorktreeAttachments(exec, root, [
    { id: 'other', metadata: { git: { worktree: 'alias/not-created/yet' } } },
  ])
  expect(resolved[0]).toHaveProperty('canonical.worktree', join(root, 'owned/not-created/yet'))
  await symlink(join(root, 'missing'), join(root, 'dangling'))
  await expect(
    resolveWorktreeAttachments(exec, root, [{ id: 'other', metadata: { git: { worktree: 'dangling' } } }])
  ).rejects.toThrow()
})

test('no-path streams need no runtime access', async () => {
  expect(
    await resolveWorktreeAttachments(
      async () => {
        throw Error('must not dispatch')
      },
      root,
      [{ id: 'other', metadata: {} }]
    )
  ).toEqual([{ id: 'other', raw: {}, canonical: {} }])
})

for (const metadata of [null, [], 'invalid', { git: [] }, { git: 'invalid' }]) {
  test(`rejects malformed registered attachment JSON: ${JSON.stringify(metadata)}`, async () => {
    await expect(resolveWorktreeAttachments(exec, root, [{ id: 'other', metadata }])).rejects.toThrow(
      'Unrecognized registered'
    )
  })
}
