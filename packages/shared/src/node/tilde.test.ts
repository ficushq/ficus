import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { expandTilde } from './tilde'

// Every test passes an explicit home: expandTilde's job is pure string
// expansion against a HOME value, and reading the process's real home here
// would make the assertions platform- and machine-dependent (and tempt
// fixture-writers to mkdtemp inside the real $HOME).
const HOME = '/home/fixture-user'

describe('expandTilde', () => {
  test('a bare ~ becomes the home directory', () => {
    expect(expandTilde('~', HOME)).toBe(HOME)
  })

  test('~/rest joins onto the home directory', () => {
    expect(expandTilde('~/.host-test-ficus', HOME)).toBe(join(HOME, '.host-test-ficus'))
    expect(expandTilde('~/a/b/c', HOME)).toBe(join(HOME, 'a/b/c'))
  })

  test('~user/... is left alone — resolving another user’s home is not our job', () => {
    expect(expandTilde('~root/keys', HOME)).toBe('~root/keys')
    expect(expandTilde('~root', HOME)).toBe('~root')
  })

  test('an absolute path is unchanged', () => {
    expect(expandTilde('/var/lib/tau', HOME)).toBe('/var/lib/tau')
  })

  test('a relative path is unchanged — this expands ~ only, it does not resolve', () => {
    expect(expandTilde('relative/path', HOME)).toBe('relative/path')
    expect(expandTilde('./x', HOME)).toBe('./x')
  })

  test('an empty string is unchanged', () => {
    expect(expandTilde('', HOME)).toBe('')
  })

  test('a ~ that is not leading is unchanged', () => {
    expect(expandTilde('/opt/~/x', HOME)).toBe('/opt/~/x')
  })

  test('$VAR is not expanded', () => {
    expect(expandTilde('$HOME/x', HOME)).toBe('$HOME/x')
  })

  test('the home defaults to os.homedir() when omitted (production callers)', async () => {
    // The production default is the only place the process's real home is
    // consulted — asserted against homedir() itself, not a planted fixture.
    const { homedir } = await import('node:os')
    expect(expandTilde('~')).toBe(homedir())
    expect(expandTilde('~/x')).toBe(join(homedir(), 'x'))
  })
})
