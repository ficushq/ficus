import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import {
  getHomeDir,
  HOME_DATA_MARKER,
  HOME_DIR_NAME,
  LEGACY_HOME_DIR_NAME,
  createHomeDirGetter,
  resolveHomeDir,
} from './home'

describe('getHomeDir', () => {
  const original = process.env.HOME_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = original
  })

  it('expands a leading ~ in HOME_DIR', () => {
    // The reported bug: `HOME_DIR=~/.host-test-ficus` in a .env reached this
    // function verbatim, and the core created a directory literally named `~`
    // under its own working directory.
    process.env.HOME_DIR = '~/.host-test-ficus'
    expect(getHomeDir()).toBe(join(homedir(), '.host-test-ficus'))
  })

  it('expands a bare ~ in HOME_DIR', () => {
    process.env.HOME_DIR = '~'
    expect(getHomeDir()).toBe(homedir())
  })

  it('leaves an absolute HOME_DIR untouched', () => {
    process.env.HOME_DIR = '/var/lib/ficus'
    expect(getHomeDir()).toBe('/var/lib/ficus')
  })

  it('leaves ~user untouched (another account’s home is not ours to guess)', () => {
    process.env.HOME_DIR = '~someoneelse/.ficus'
    expect(getHomeDir()).toBe('~someoneelse/.ficus')
  })
})

describe('resolveHomeDir default (no HOME_DIR): always canonical', () => {
  const home = '/srv/home/svc'
  const ficus = join(home, HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  const resolve = (
    fs: { links?: Record<string, string>; data?: string[] },
    env: Record<string, string | undefined> = {}
  ) => {
    const probed: string[] = []
    const warnings: string[] = []
    const result = resolveHomeDir({
      env,
      homedir: () => home,
      isSymlink: (path) => {
        probed.push(path)
        return path in (fs.links ?? {})
      },
      realpath: (path) => fs.links?.[path] ?? path,
      hasData: (path) => {
        probed.push(path)
        return (fs.data ?? []).includes(fs.links?.[path] ?? path)
      },
      warn: (message) => warnings.push(message),
    })
    return { result, probed, warnings }
  }

  it('is ~/.ficus when no dir holds data (a fresh install)', () => {
    expect(resolve({}).result).toBe(ficus)
    expect(ficus).toBe('/srv/home/svc/.ficus')
  })

  it('is ~/.ficus when the legacy dir is a symlink to it (a migrated host or install)', () => {
    const r = resolve({ links: { [legacy]: ficus } })
    expect(r.result).toBe(ficus)
    expect(r.warnings).toEqual([])
  })

  it('ignores a retired home even when it alone holds data', () => {
    expect(resolve({ data: [legacy] }).result).toBe(ficus)
  })

  it('uses the canonical home beside retired data', () => {
    const r = resolve({ data: [legacy] })
    expect(r.result).toBe(ficus)
    expect(r.warnings).toEqual([])
  })

  it('stays ~/.ficus when it holds data and a CLI-only legacy dir appears (no data there)', () => {
    const r = resolve({ data: [ficus] })
    expect(r.result).toBe(ficus)
    expect(r.warnings).toEqual([])
  })

  it('is canonical without probing retired data', () => {
    const r = resolve({ data: [ficus, legacy] })
    expect(r.result).toBe(ficus)
    expect(r.warnings).toEqual([])
  })

  it('lets HOME_DIR win without probing either dir', () => {
    const { result, probed } = resolve({ data: [ficus, legacy] }, { HOME_DIR: '/data/elsewhere' })
    expect(result).toBe('/data/elsewhere')
    expect(probed).toEqual([])
    expect(resolve({ data: [legacy] }, { HOME_DIR: '~/custom' }).result).toBe('/srv/home/svc/custom')
  })

  it('treats an empty HOME_DIR as unset', () => {
    expect(resolve({ data: [legacy] }, { HOME_DIR: '' }).result).toBe(ficus)
  })
})

describe('the HOME default on a real filesystem', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'home-dir-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))
  const resolveIn = () => resolveHomeDir({ env: {}, homedir: () => home, warn: () => {} })
  const data = (dir: string) => mkdirSync(join(home, dir, HOME_DATA_MARKER), { recursive: true })

  it('follows the migration: legacy data → ~/.ficus with the legacy name as its link', () => {
    data(LEGACY_HOME_DIR_NAME)
    expect(resolveIn()).toBe(join(home, HOME_DIR_NAME))
    renameSync(join(home, LEGACY_HOME_DIR_NAME), join(home, HOME_DIR_NAME))
    symlinkSync(join(home, HOME_DIR_NAME), join(home, LEGACY_HOME_DIR_NAME))
    expect(resolveIn()).toBe(join(home, HOME_DIR_NAME))
  })

  it('a fresh ~/.ficus with data stays put when the CLI later creates a real legacy dir (cli/ only)', () => {
    data(HOME_DIR_NAME)
    mkdirSync(join(home, LEGACY_HOME_DIR_NAME, 'cli'), { recursive: true })
    expect(resolveIn()).toBe(join(home, HOME_DIR_NAME))
  })

  it('retired data does not change the canonical default', () => {
    data(LEGACY_HOME_DIR_NAME)
    mkdirSync(join(home, HOME_DIR_NAME))
    expect(resolveIn()).toBe(join(home, HOME_DIR_NAME))
  })

  it('decides once per process: data appearing later does not move it', () => {
    const getter = createHomeDirGetter({ env: {}, homedir: () => home, warn: () => {} })
    const first = getter.get()
    expect(first).toBe(join(home, HOME_DIR_NAME)) // nothing yet: a fresh install
    data(LEGACY_HOME_DIR_NAME) // something writes a legacy data dir mid-process
    expect(getter.get()).toBe(first)
    getter.reset()
    expect(getter.get()).toBe(join(home, HOME_DIR_NAME)) // the next process would see it
  })
})
