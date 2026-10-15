import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConfinedFsError,
  listConfinedDir,
  readConfinedFile,
  splitConfinedPath,
  writeConfinedFile,
  type ConfinedFsErrorCode,
} from './confined-fs'

let base: string
let root: string
let outside: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'confined-fs-'))
  root = join(base, 'private')
  outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'outside secret')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function expectCode(promise: Promise<unknown>, code: ConfinedFsErrorCode) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(ConfinedFsError)
  expect((error as ConfinedFsError).code).toBe(code)
}

describe('splitConfinedPath', () => {
  test('accepts nested relative paths and drops empty and dot segments', () => {
    expect(splitConfinedPath('')).toEqual([])
    expect(splitConfinedPath('.')).toEqual([])
    expect(splitConfinedPath('a//b/./c.txt')).toEqual(['a', 'b', 'c.txt'])
  })

  test.each(['/etc/passwd', '../x', 'a/../../x', 'a/..', 'a\0b', 'a\\..\\b', `${'x'.repeat(256)}`])(
    'rejects %p',
    (path) => {
      expect(() => splitConfinedPath(path)).toThrow(ConfinedFsError)
    }
  )
})

describe('readConfinedFile', () => {
  test('reads a regular file and reports truncation', async () => {
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes', 'a.txt'), 'hello world')
    const full = await readConfinedFile(root, 'notes/a.txt', { maxBytes: 1024 })
    expect(full.content.toString()).toBe('hello world')
    expect(full.truncated).toBe(false)
    const partial = await readConfinedFile(root, 'notes/a.txt', { maxBytes: 5 })
    expect(partial.content.toString()).toBe('hello')
    expect(partial.size).toBe(11)
    expect(partial.truncated).toBe(true)
  })

  test('refuses traversal and absolute paths', async () => {
    await expectCode(readConfinedFile(root, '../outside/secret.txt', { maxBytes: 100 }), 'invalid-path')
    await expectCode(readConfinedFile(root, join(outside, 'secret.txt'), { maxBytes: 100 }), 'invalid-path')
  })

  test('refuses a symlinked file', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    await expectCode(readConfinedFile(root, 'link.txt', { maxBytes: 100 }), 'symlink')
  })

  test('refuses to walk through a symlinked directory', async () => {
    await symlink(outside, join(root, 'escape'))
    await expectCode(readConfinedFile(root, 'escape/secret.txt', { maxBytes: 100 }), 'symlink')
  })

  test('refuses a root that is itself a symlink', async () => {
    const linkedRoot = join(base, 'linked-root')
    await symlink(outside, linkedRoot)
    await expectCode(readConfinedFile(linkedRoot, 'secret.txt', { maxBytes: 100 }), 'symlink')
  })

  test('reports missing files and directories', async () => {
    await expectCode(readConfinedFile(root, 'missing.txt', { maxBytes: 100 }), 'not-found')
    await mkdir(join(root, 'dir'))
    await expectCode(readConfinedFile(root, 'dir', { maxBytes: 100 }), 'not-a-file')
  })

  test('refuses a FIFO without blocking', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')])
    await expectCode(readConfinedFile(root, 'pipe', { maxBytes: 100 }), 'not-a-file')
  })
})

describe('listConfinedDir', () => {
  test('lists entries with their types and never follows symlinks', async () => {
    await mkdir(join(root, 'dir'))
    await writeFile(join(root, 'file.txt'), 'abc')
    await symlink(outside, join(root, 'escape'))
    const entries = await listConfinedDir(root, '')
    const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]))
    expect(byName.dir?.type).toBe('directory')
    expect(byName['file.txt']).toMatchObject({ type: 'file', size: 3 })
    expect(byName.escape?.type).toBe('symlink')
    await expectCode(listConfinedDir(root, 'escape'), 'symlink')
  })

  test('refuses traversal', async () => {
    await expectCode(listConfinedDir(root, '..'), 'invalid-path')
  })
})

describe('writeConfinedFile', () => {
  test('creates files with private permissions and missing directories on request', async () => {
    expect(await writeConfinedFile(root, 'a/b/token.txt', Buffer.from('t0k3n'), { createDirs: true })).toBe('created')
    expect(await readFile(join(root, 'a', 'b', 'token.txt'), 'utf8')).toBe('t0k3n')
    expect((await stat(join(root, 'a', 'b', 'token.txt'))).mode & 0o777).toBe(0o600)
    await expectCode(writeConfinedFile(root, 'missing/x.txt', Buffer.from('x')), 'not-found')
  })

  test('skips existing entries unless overwriting, and overwrites atomically', async () => {
    await writeFile(join(root, 'f.txt'), 'old')
    expect(await writeConfinedFile(root, 'f.txt', Buffer.from('new'))).toBe('skipped')
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('old')
    expect(await writeConfinedFile(root, 'f.txt', Buffer.from('new'), { overwrite: true })).toBe('overwritten')
    expect(await readFile(join(root, 'f.txt'), 'utf8')).toBe('new')
    expect((await readdir(root)).filter((name) => name.startsWith('.ficus-upload-'))).toEqual([])
  })

  test('never writes through a symlinked file', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    expect(await writeConfinedFile(root, 'link.txt', Buffer.from('pwned'))).toBe('skipped')
    await expectCode(writeConfinedFile(root, 'link.txt', Buffer.from('pwned'), { overwrite: true }), 'symlink')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
  })

  test('never writes into a symlinked directory, even when creating directories', async () => {
    await symlink(outside, join(root, 'escape'))
    await expectCode(writeConfinedFile(root, 'escape/new.txt', Buffer.from('pwned'), { createDirs: true }), 'symlink')
    expect(await readdir(outside)).toEqual(['secret.txt'])
  })

  test('replaces a hard-linked file without modifying the other link', async () => {
    await link(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    expect(await writeConfinedFile(root, 'hard.txt', Buffer.from('replaced'), { overwrite: true })).toBe('overwritten')
    expect(await readFile(join(root, 'hard.txt'), 'utf8')).toBe('replaced')
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside secret')
  })

  test('refuses to replace a directory', async () => {
    await mkdir(join(root, 'dir'))
    await expectCode(writeConfinedFile(root, 'dir', Buffer.from('x'), { overwrite: true }), 'not-a-file')
  })
})
