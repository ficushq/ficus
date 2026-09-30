import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { getHomeDir, HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, resolveHomeDir } from './home'

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

describe('resolveHomeDir default (no HOME_DIR)', () => {
  const home = '/srv/home/svc'
  const ficus = join(home, HOME_DIR_NAME)
  const legacy = join(home, LEGACY_HOME_DIR_NAME)
  const resolve = (present: string[], env: Record<string, string | undefined> = {}) => {
    const probed: string[] = []
    const result = resolveHomeDir({
      env,
      homedir: () => home,
      exists: (path) => {
        probed.push(path)
        return present.includes(path)
      },
    })
    return { result, probed }
  }

  it('is ~/.ficus when neither dir exists (a fresh install)', () => {
    expect(resolve([]).result).toBe(ficus)
    expect(ficus).toBe('/srv/home/svc/.ficus')
  })

  it('is the legacy dir when only the legacy dir exists (a host that has not moved)', () => {
    expect(resolve([legacy]).result).toBe(legacy)
  })

  it('is ~/.ficus when both exist (a moved host, whose legacy path is the compat link)', () => {
    expect(resolve([ficus, legacy]).result).toBe(ficus)
  })

  it('is ~/.ficus when only ~/.ficus exists (a moved host after finalize)', () => {
    expect(resolve([ficus]).result).toBe(ficus)
  })

  it('lets HOME_DIR win without probing either dir', () => {
    const { result, probed } = resolve([ficus, legacy], { HOME_DIR: '/data/elsewhere' })
    expect(result).toBe('/data/elsewhere')
    expect(probed).toEqual([])
    expect(resolve([legacy], { HOME_DIR: '~/custom' }).result).toBe('/srv/home/svc/custom')
  })

  it('treats an empty HOME_DIR as unset', () => {
    expect(resolve([legacy], { HOME_DIR: '' }).result).toBe(legacy)
  })
})
