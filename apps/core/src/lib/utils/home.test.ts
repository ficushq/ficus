import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { getHomeDir } from './home'

describe('getHomeDir', () => {
  const original = process.env.HOME_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.HOME_DIR
    else process.env.HOME_DIR = original
  })

  it('defaults to ~/.tau when HOME_DIR is unset', () => {
    delete process.env.HOME_DIR
    expect(getHomeDir()).toBe(join(homedir(), '.tau'))
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
    process.env.HOME_DIR = '/var/lib/tau'
    expect(getHomeDir()).toBe('/var/lib/tau')
  })

  it('leaves ~user untouched (another account’s home is not ours to guess)', () => {
    process.env.HOME_DIR = '~someoneelse/.tau'
    expect(getHomeDir()).toBe('~someoneelse/.tau')
  })
})
