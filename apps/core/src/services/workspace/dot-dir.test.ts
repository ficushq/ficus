import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureWorkspaceDotDir,
  prepareWorkspaceDotDir,
  workspaceDotPath,
  WorkspaceDotDirConflictError,
} from './dot-dir'
let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-workspace-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})
test('creates canonical settings without changing unrelated workspace data', () => {
  writeFileSync(join(root, 'private-key'), 'preserved')
  expect(ensureWorkspaceDotDir(root)).toBe(join(root, '.ficus'))
  const file = workspaceDotPath(root, 'identity.pem')
  writeFileSync(file, 'identity', { mode: 0o600 })
  const before = lstatSync(file)
  ensureWorkspaceDotDir(root)
  expect(readFileSync(file, 'utf8')).toBe('identity')
  expect(lstatSync(file).ino).toBe(before.ino)
  expect(lstatSync(file).mode).toBe(before.mode)
  expect(readFileSync(join(root, 'private-key'), 'utf8')).toBe('preserved')
})
test('refuses canonical settings symlinks without touching their target', () => {
  mkdirSync(join(root, 'target'))
  writeFileSync(join(root, 'target', 'identity.pem'), 'private')
  symlinkSync('target', join(root, '.ficus'))
  expect(() => ensureWorkspaceDotDir(root)).toThrow(WorkspaceDotDirConflictError)
  expect(readFileSync(join(root, 'target', 'identity.pem'), 'utf8')).toBe('private')
})
test('refuses a canonical settings file with a path-safe conflict', () => {
  writeFileSync(join(root, '.ficus'), 'keep')
  try {
    prepareWorkspaceDotDir(root)
    throw new Error('expected refusal')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceDotDirConflictError)
    expect((error as Error).message).not.toContain(root)
  }
  expect(readFileSync(join(root, '.ficus'), 'utf8')).toBe('keep')
})
