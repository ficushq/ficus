import { afterEach, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MAX_SQUAD_ENV_BYTES } from '../security/squad-env-detection-repository'
import { readSettingsEnvFile, SquadEnvSettingsReadError } from './env-settings-read'

let dir: string
let path: string
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'env-settings-read-'))
  path = join(dir, 'env.user')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

test('missing and empty files differ, and UTF8 at the exact byte cap is complete', () => {
  expect(readSettingsEnvFile(path)).toBeNull()
  fs.writeFileSync(path, '')
  expect(readSettingsEnvFile(path)).toBe('')
  const content = 'é'.repeat(MAX_SQUAD_ENV_BYTES / 2)
  fs.writeFileSync(path, content)
  expect(readSettingsEnvFile(path)).toBe(content)
  expect(fs.readFileSync(path, 'utf8')).toBe(content)
})

for (const growAfterStat of [false, true]) {
  test(`oversized read is capped at cap+1 actual bytes and closes its descriptor (growth=${growAfterStat})`, () => {
    fs.writeFileSync(path, growAfterStat ? 'A=1' : 'x'.repeat(MAX_SQUAD_ENV_BYTES + 1))
    let fd = -1
    let bytes = 0
    let grew = false
    expect(() =>
      readSettingsEnvFile(path, {
        ...fs,
        openSync: (name, flags) => {
          fd = fs.openSync(name, flags)
          return fd
        },
        fstatSync: (descriptor) => {
          const stat = fs.fstatSync(descriptor)
          if (growAfterStat && !grew) {
            grew = true
            fs.appendFileSync(path, 'x'.repeat(MAX_SQUAD_ENV_BYTES + 1))
          }
          return stat
        },
        readSync: (descriptor, buffer, offset, length, position) => {
          const read = fs.readSync(descriptor, buffer, offset, length, position)
          bytes += read
          return read
        },
      })
    ).toThrow(SquadEnvSettingsReadError)
    expect(bytes).toBe(growAfterStat ? MAX_SQUAD_ENV_BYTES + 1 : 0)
    expect(() => fs.fstatSync(fd)).toThrow()
    expect(fs.statSync(path).size).toBeGreaterThan(MAX_SQUAD_ENV_BYTES)
  })
}

test('growth at EOF is detected before returning an editable prefix', () => {
  fs.writeFileSync(path, 'A=1')
  let fd = -1
  expect(() =>
    readSettingsEnvFile(path, {
      ...fs,
      openSync: (name, flags) => {
        fd = fs.openSync(name, flags)
        return fd
      },
      readSync: (descriptor, buffer, offset, length, position) => {
        const read = fs.readSync(descriptor, buffer, offset, length, position)
        if (!read) fs.appendFileSync(path, 'x'.repeat(MAX_SQUAD_ENV_BYTES))
        return read
      },
    })
  ).toThrow(SquadEnvSettingsReadError)
  expect(() => fs.fstatSync(fd)).toThrow()
  expect(fs.statSync(path).size).toBe(MAX_SQUAD_ENV_BYTES + 3)
})

test('an opened descriptor cannot switch to a larger replacement path', () => {
  fs.writeFileSync(path, 'ORIGINAL=kept')
  let replaced = false
  expect(
    readSettingsEnvFile(path, {
      ...fs,
      fstatSync: (fd) => {
        const stat = fs.fstatSync(fd)
        if (!replaced) {
          replaced = true
          fs.renameSync(path, path + '.original')
          fs.writeFileSync(path, 'x'.repeat(MAX_SQUAD_ENV_BYTES + 1))
        }
        return stat
      },
    })
  ).toBe('ORIGINAL=kept')
  expect(fs.statSync(path).size).toBe(MAX_SQUAD_ENV_BYTES + 1)
  expect(fs.readFileSync(path + '.original', 'utf8')).toBe('ORIGINAL=kept')
})

test('read failure is value/path-free, closes the file and never modifies it', () => {
  fs.writeFileSync(path, 'SYNTHETIC=kept')
  let fd = -1
  try {
    readSettingsEnvFile(path, {
      ...fs,
      openSync: (name, flags) => {
        fd = fs.openSync(name, flags)
        return fd
      },
      readSync: () => {
        throw new Error('synthetic-private-error')
      },
    })
    throw new Error('expected read error')
  } catch (error) {
    expect(error).toBeInstanceOf(SquadEnvSettingsReadError)
    expect((error as SquadEnvSettingsReadError).code).toBe('squad_env_unreadable')
    expect((error as Error).message).not.toContain(path)
    expect((error as Error).message).not.toContain('synthetic-private-error')
  }
  expect(() => fs.fstatSync(fd)).toThrow()
  expect(fs.readFileSync(path, 'utf8')).toBe('SYNTHETIC=kept')
})

test('symlinks and nonregular files are not treated as missing or followed', () => {
  fs.writeFileSync(path + '.target', 'SYNTHETIC=untouched')
  fs.symlinkSync(path + '.target', path)
  expect(() => readSettingsEnvFile(path)).toThrow(SquadEnvSettingsReadError)
  fs.unlinkSync(path)
  fs.mkdirSync(path)
  expect(() => readSettingsEnvFile(path)).toThrow(SquadEnvSettingsReadError)
  expect(fs.readFileSync(path + '.target', 'utf8')).toBe('SYNTHETIC=untouched')
})
