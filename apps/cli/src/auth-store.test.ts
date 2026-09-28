import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { getAuthStorePath } from './auth-store'

describe('getAuthStorePath', () => {
  const original = process.env.FICUS_AUTH_STORE

  afterEach(() => {
    if (original === undefined) delete process.env.FICUS_AUTH_STORE
    else process.env.FICUS_AUTH_STORE = original
  })

  it('defaults to ~/.tau/cli/auth.json', () => {
    delete process.env.FICUS_AUTH_STORE
    expect(getAuthStorePath()).toBe(join(homedir(), '.tau', 'cli', 'auth.json'))
  })

  it('expands a leading ~ in FICUS_AUTH_STORE', () => {
    // Set in a .env or a systemd unit, `~` reaches us verbatim and the store
    // would be written to a directory literally named `~`, silently losing
    // every backend the user had logged into.
    process.env.FICUS_AUTH_STORE = '~/creds/tau.json'
    expect(getAuthStorePath()).toBe(join(homedir(), 'creds/tau.json'))
  })

  it('leaves an absolute FICUS_AUTH_STORE untouched', () => {
    process.env.FICUS_AUTH_STORE = '/etc/tau/auth.json'
    expect(getAuthStorePath()).toBe('/etc/tau/auth.json')
  })
})
