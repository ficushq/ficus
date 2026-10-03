import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { getHomeDir, HOME_DIR_NAME, createHomeDirGetter, resolveHomeDir } from './home'

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

describe('canonical HOME resolution', () => {
  const home = '/srv/home/svc'
  it('defaults to the canonical directory without filesystem discovery', () => {
    expect(resolveHomeDir({ env: {}, homedir: () => home })).toBe(join(home, HOME_DIR_NAME))
    expect(resolveHomeDir({ env: { HOME_DIR: '' }, homedir: () => home })).toBe(join(home, HOME_DIR_NAME))
  })
  it('honors an explicit HOME_DIR and expands tilde', () => {
    expect(resolveHomeDir({ env: { HOME_DIR: '/data/elsewhere' }, homedir: () => home })).toBe('/data/elsewhere')
    expect(resolveHomeDir({ env: { HOME_DIR: '~/custom' }, homedir: () => home })).toBe('/srv/home/svc/custom')
  })
  it('keeps the default stable while reading explicit overrides on each call', () => {
    const env: Record<string, string | undefined> = {}
    const getter = createHomeDirGetter({ env, homedir: () => home })
    expect(getter.get()).toBe(join(home, HOME_DIR_NAME))
    env.HOME_DIR = '/data/custom'
    expect(getter.get()).toBe('/data/custom')
    delete env.HOME_DIR
    expect(getter.get()).toBe(join(home, HOME_DIR_NAME))
    getter.reset()
    expect(getter.get()).toBe(join(home, HOME_DIR_NAME))
  })
  it('keys the cached default by the service user home', () => {
    let current = home
    const getter = createHomeDirGetter({ env: {}, homedir: () => current })
    expect(getter.get()).toBe(join(home, HOME_DIR_NAME))
    current = '/srv/home/other'
    expect(getter.get()).toBe(join(current, HOME_DIR_NAME))
  })
})
