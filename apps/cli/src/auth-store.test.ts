import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { getAuthStorePath } from './auth-store'
import { LEGACY_HOME_DIR_NAME } from '@ficus/shared/node'

describe('getAuthStorePath', () => {
  const original = process.env.FICUS_AUTH_STORE

  afterEach(() => {
    if (original === undefined) delete process.env.FICUS_AUTH_STORE
    else process.env.FICUS_AUTH_STORE = original
  })

  it('defaults to <cli home>/cli/auth.json: ~/.ficus, or a legacy home that has not moved yet', () => {
    delete process.env.FICUS_AUTH_STORE
    const originalHome = process.env.HOME
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ficus-auth-home-')))
    try {
      process.env.HOME = home
      expect(getAuthStorePath()).toBe(join(home, '.ficus', 'cli', 'auth.json'))
      mkdirSync(join(home, LEGACY_HOME_DIR_NAME))
      expect(getAuthStorePath()).toBe(join(home, LEGACY_HOME_DIR_NAME, 'cli', 'auth.json'))
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('expands a leading ~ in FICUS_AUTH_STORE', () => {
    // Set in a .env or a systemd unit, `~` reaches us verbatim and the store
    // would be written to a directory literally named `~`, silently losing
    // every backend the user had logged into.
    process.env.FICUS_AUTH_STORE = '~/creds/ficus.json'
    expect(getAuthStorePath()).toBe(join(homedir(), 'creds/ficus.json'))
  })

  it('leaves an absolute FICUS_AUTH_STORE untouched', () => {
    process.env.FICUS_AUTH_STORE = '/etc/tau/auth.json'
    expect(getAuthStorePath()).toBe('/etc/tau/auth.json')
  })
})
