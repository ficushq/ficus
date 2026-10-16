import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Machine } from '../machines/queries'
import {
  chunkInput,
  isScanPath,
  LIST_COMMAND,
  measureCommand,
  parseChunkOutput,
  parseDuRecords,
  parseListRecords,
} from './chunk'
import { localRunner } from './scan.test-helper'

const HOME = '/home/box_aaaaaaaaaaaa'
const HOSTILE = [
  'we ird$(touch pwned)',
  'quote\'"`touch pwned2`',
  'new\nline',
  'tab\tname',
  '-rf --max-depth=99',
  '#0',
  ';touch pwned3;',
]

describe('chunk protocol', () => {
  test('commands are fixed templates: paths only ever travel on stdin', () => {
    expect(measureCommand(3)).toContain(
      'sudo -n timeout -k 5s 20s nice -n 19 ionice -c 3 xargs -0 -r -n 1 sh -c \'du -x -B1 --null --max-depth=3 -- "$1"'
    )
    expect(LIST_COMMAND).toContain('find "$1" -maxdepth 1 -printf')
    expect(() => measureCommand(-1)).toThrow()
    expect(() => measureCommand(1.5)).toThrow()
    expect(chunkInput([HOME, `${HOME}/${HOSTILE[0]}`])).toBe(`${HOME}\0${HOME}/${HOSTILE[0]}\0`)
    for (const path of ['/etc', '/home', '/home/box_a', `${HOME}/../x`, `${HOME}/./x`, `${HOME}//x`, `${HOME}/`])
      expect(() => chunkInput([path])).toThrow()
    expect(isScanPath(`${HOME}/${HOSTILE[2]}`)).toBe(true)
  })

  test('markers attribute output to paths in order and drop a truncated tail', () => {
    const output = parseChunkOutput(
      'Used 1B-blocks\n10 20\n\0' +
        `5\t${HOME}/a\0` +
        `9\t${HOME}\0#0\0` +
        `3\t/home/box_bbbbbbbbbbbb/x\0` +
        '7\t/home/bo',
      3
    )
    expect(output.disk).toEqual({ usedBytes: 10, totalBytes: 20 })
    expect(output.paths.map((path) => [path.complete, path.exitCode, path.records.length])).toEqual([
      [true, 0, 2],
      [false, null, 1],
      [false, null, 0],
    ])
    expect(parseChunkOutput('', 1).paths[0]!.complete).toBe(false)
  })

  test('du records outside the measured path, malformed, or escaping are ignored', () => {
    const entries = parseDuRecords(
      [
        `12\t${HOME}/project with\ttab\nand newline`,
        `0\t${HOME}/empty`,
        `-1\t${HOME}/negative`,
        `99999999999999999999999\t${HOME}/overflow`,
        '10\t/etc/secret',
        `1\t${HOME}/../outside`,
        `5\t${HOME}x/neighbour`,
        `20\t${HOME}`,
      ],
      HOME
    )
    expect([...entries]).toEqual([
      [`${HOME}/project with\ttab\nand newline`, 12],
      [`${HOME}/empty`, 0],
      [HOME, 20],
    ])
  })

  test('listings keep same-filesystem subdirectories and count hardlinked files once', () => {
    const listing = parseListRecords(
      [
        '1\td\t10\t5\t8\t',
        '1\td\t11\t2\t8\tsub dir\nx',
        '2\td\t12\t2\t8\tmounted',
        '1\tf\t13\t2\t16\thardlink',
        '1\tf\t13\t2\t16\thardlink-again',
        '1\tl\t14\t1\t0\tlink',
        '1\tf\t15\t1\t2\tname\twith\ttabs',
      ],
      HOME
    )
    expect(listing).toEqual({ directBytes: (8 + 16 + 0 + 2) * 512, subdirectories: [`${HOME}/sub dir\nx`] })
    expect(parseListRecords(['1\tf\t13\t1\t16\tfile'], HOME)).toBeNull()
  })
})

describe('real command templates on a local tree', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'storage-chunk-'))
    const home = join(root, HOME)
    mkdirSync(join(home, 'a/b/c'), { recursive: true })
    for (const name of HOSTILE) mkdirSync(join(home, name, 'inner'), { recursive: true })
    writeFileSync(join(home, 'a/data'), Buffer.alloc(64 * 1024, 1))
    linkSync(join(home, 'a/data'), join(home, 'a/b/hardlink'))
    writeFileSync(join(home, 'top-file'), Buffer.alloc(16 * 1024, 1))
    symlinkSync('/', join(home, 'root-link'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('du and find handle hostile names without running them, following symlinks, or double counting', async () => {
    const runner = localRunner(root)
    const machine = {} as Machine
    const measured = await runner.run(machine, measureCommand(2), { stdin: chunkInput([HOME, `${HOME}/missing`]) })
    const output = parseChunkOutput(measured.stdout, 2)
    expect(output.paths[0]!.complete).toBe(true)
    expect(output.paths[1]).toMatchObject({ complete: true, exitCode: 1 })
    const entries = parseDuRecords(output.paths[0]!.records, HOME)
    for (const name of HOSTILE) expect(entries.has(`${HOME}/${name}/inner`)).toBe(true)
    // The hardlink is counted once; the symlink to / is not followed.
    const a = entries.get(`${HOME}/a`)!
    expect(a).toBeGreaterThanOrEqual(64 * 1024)
    expect(a).toBeLessThan(2 * 64 * 1024)
    expect(entries.get(HOME)!).toBeLessThan(1024 * 1024)

    const hostile = HOSTILE.map((name) => `${HOME}/${name}`)
    const listed = await runner.run(machine, LIST_COMMAND, { stdin: chunkInput([HOME, ...hostile]) })
    const listing = parseChunkOutput(listed.stdout, hostile.length + 1)
    const top = parseListRecords(listing.paths[0]!.records, HOME)!
    expect(top.subdirectories).toEqual([...hostile, `${HOME}/a`].sort())
    expect(top.directBytes).toBeGreaterThanOrEqual(16 * 1024)
    for (const [index, path] of hostile.entries())
      expect(parseListRecords(listing.paths[index + 1]!.records, path)!.subdirectories).toEqual([`${path}/inner`])

    for (const command of runner.commands) for (const name of HOSTILE) expect(command).not.toContain(name)
    for (const file of ['pwned', 'pwned2', 'pwned3'])
      expect(existsSync(join(root, file)) || existsSync(join(process.cwd(), file))).toBe(false)
  })
})
