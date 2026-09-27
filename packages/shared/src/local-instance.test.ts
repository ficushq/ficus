import { describe, expect, it } from 'bun:test'
import { localProcessNames, normalizeLocalInstanceLabel, parseLaunchdJobIdentity } from './local-instance'

describe('localProcessNames', () => {
  it('keeps the established default process names', () => {
    expect(localProcessNames('tau')).toEqual({ label: 'tau', api: 'tau-api', worker: 'tau-worker' })
  })

  it('normalizes a labeled instance and derives both process names', () => {
    expect(localProcessNames(' Smoke ')).toEqual({
      label: 'smoke',
      api: 'tau-smoke-api',
      worker: 'tau-smoke-worker',
    })
  })
})

describe('parseLaunchdJobIdentity', () => {
  // Captured shape of real `launchctl print` output: the binary on its own
  // `program =` line, argv in a separate `arguments = { ... }` block, then the
  // working directory and stderr path lines this guard keys on.
  const REAL_PRINT = `\n\tprogram = /Users/me/My Bun/bin/bun\n\targuments = {\n\t\t/Users/me/My Bun/bin/bun\n\t\trun\n\t\tapps/core/dist/worker.js\n\t}\n\tworking directory = /Users/me/Ficus repo\n\tstderr path = /Users/me/.tau/logs/tau-api.log\n\n`

  it('resolves the binary from real launchctl print output', () => {
    expect(parseLaunchdJobIdentity(REAL_PRINT)).toEqual({
      program: '/Users/me/My Bun/bin/bun',
      workingDirectory: '/Users/me/Ficus repo',
      stderrPath: '/Users/me/.tau/logs/tau-api.log',
    })
  })

  it('still accepts the combined program-arguments spelling and leaves absent fields unknown', () => {
    expect(
      parseLaunchdJobIdentity(
        'program arguments = {\n  /Users/me/My Bun/bin/bun\n}\nworking directory = /Users/me/Ficus repo\nstderr path = /Users/me/.tau/logs/tau-api.log\n'
      )
    ).toEqual({
      program: '/Users/me/My Bun/bin/bun',
      workingDirectory: '/Users/me/Ficus repo',
      stderrPath: '/Users/me/.tau/logs/tau-api.log',
    })
    expect(parseLaunchdJobIdentity('state = running\npid = 42\n')).toEqual({
      program: undefined,
      workingDirectory: undefined,
      stderrPath: undefined,
    })
  })
})

describe('normalizeLocalInstanceLabel', () => {
  it('accepts only normalized-safe label boundaries', () => {
    expect(normalizeLocalInstanceLabel('a')).toBe('a')
    expect(normalizeLocalInstanceLabel('a'.repeat(31))).toBe('a'.repeat(31))
    for (const invalid of ['', '-lead', 'trail-', 'bad label', 'a'.repeat(32), '../api']) {
      expect(() => normalizeLocalInstanceLabel(invalid)).toThrow(/invalid local instance/i)
    }
  })
})
