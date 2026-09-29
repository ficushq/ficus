import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cleanupPreparedHostWorkspacePath,
  ensureHostWorkspacePath,
  HostWorkspacePathError,
  normalizeHostWorkspacePath,
} from './workspace-path'

describe('host workspace path preparation', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'ficus-host-workspace-path-'))
    roots.push(root)
    return root
  }

  test('normalizes redundant separators, dot segments, and trailing separators', () => {
    expect(normalizeHostWorkspacePath('/srv//repo/./src/')).toBe('/srv/repo/src')
  })

  test('creates missing directories and reports only those it created', async () => {
    const existingParent = makeRoot()
    const workspace = join(existingParent, 'one', 'two')
    const prepared = await ensureHostWorkspacePath(workspace)

    expect(prepared).toEqual({
      path: workspace,
      createdDirectories: [join(existingParent, 'one'), workspace],
    })
    expect(statSync(workspace).isDirectory()).toBe(true)
  })

  test('rejects an existing file as the workspace', async () => {
    const file = join(makeRoot(), 'file')
    writeFileSync(file, 'not a directory')

    expect(ensureHostWorkspacePath(file)).rejects.toThrow(
      new HostWorkspacePathError('Host workspace path is not a directory')
    )
  })

  test('reports ENOTDIR when a parent is a file without creating anything', async () => {
    const root = makeRoot()
    const file = join(root, 'file')
    writeFileSync(file, 'not a directory')

    expect(ensureHostWorkspacePath(join(file, 'child'))).rejects.toThrow(
      'Host workspace directory cannot be created or accessed'
    )
    expect(existsSync(join(file, 'child'))).toBe(false)
  })

  test('cleanup removes created empty directories and preserves the existing parent', async () => {
    const existingParent = makeRoot()
    const workspace = join(existingParent, 'one', 'two')
    const prepared = await ensureHostWorkspacePath(workspace)

    await cleanupPreparedHostWorkspacePath(prepared)

    expect(existsSync(workspace)).toBe(false)
    expect(existsSync(join(existingParent, 'one'))).toBe(false)
    expect(existsSync(existingParent)).toBe(true)
  })
})
