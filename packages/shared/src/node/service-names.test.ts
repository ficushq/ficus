import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ficusProcessName,
  hostSystemdUnits,
  launchdLabel,
  LEGACY_LAUNCHD_PREFIX,
  LEGACY_SANDBOX_PASSWORD,
  LEGACY_UNITS,
  sandboxPasswordPath,
} from './service-names'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'service-names-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('hostSystemdUnits', () => {
  test('ficus units when the ficus unit file exists', () => {
    writeFileSync(join(dir, 'ficus-api.service'), '')
    expect(hostSystemdUnits({ unitDir: dir })).toEqual({ api: 'ficus-api', worker: 'ficus-worker' })
  })

  test('legacy units otherwise', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'service-names-test-empty-'))
    try {
      expect(hostSystemdUnits({ unitDir: emptyDir })).toEqual({ api: LEGACY_UNITS.api, worker: LEGACY_UNITS.worker })
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('launchdLabel', () => {
  test('new label unless only the legacy plist exists', () => {
    expect(launchdLabel({ legacy: LEGACY_UNITS.api, new: 'ficus-api' }, { launchAgentsDir: dir })).toBe(
      'sh.ficus.ficus-api'
    )

    const agents = mkdtempSync(join(tmpdir(), 'service-names-test-agents-'))
    try {
      writeFileSync(join(agents, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}.plist`), '')
      expect(launchdLabel({ legacy: LEGACY_UNITS.api, new: 'ficus-api' }, { launchAgentsDir: agents })).toBe(
        `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`
      )
    } finally {
      rmSync(agents, { recursive: true, force: true })
    }
  })

  // A labeled local instance's legacy and new names differ by more than the prefix
  // (tau-smoke-worker -> ficus-smoke-worker), so the two must be threaded through
  // separately rather than assumed to be the same string under both prefixes.
  test('falls back from a missing new plist to the legacy one, using the two different names', () => {
    const legacy = 'tau-smoke-worker' // ficus-p5-bridge — a per-instance legacy name, not LEGACY_UNITS
    const updated = ficusProcessName(legacy)
    expect(updated).toBe('ficus-smoke-worker')

    const agents = mkdtempSync(join(tmpdir(), 'service-names-test-agents-'))
    try {
      // No legacy plist installed under this name yet: the new label wins.
      expect(launchdLabel({ legacy, new: updated }, { launchAgentsDir: agents })).toBe('sh.ficus.ficus-smoke-worker')

      writeFileSync(join(agents, `${LEGACY_LAUNCHD_PREFIX}.${legacy}.plist`), '') // ficus-p5-bridge
      expect(launchdLabel({ legacy, new: updated }, { launchAgentsDir: agents })).toBe(
        `${LEGACY_LAUNCHD_PREFIX}.${legacy}` // ficus-p5-bridge
      )
    } finally {
      rmSync(agents, { recursive: true, force: true })
    }
  })
})

describe('ficusProcessName', () => {
  test('replaces only the leading legacy prefix', () => {
    expect(ficusProcessName(LEGACY_UNITS.api)).toBe('ficus-api')
    expect(ficusProcessName(LEGACY_UNITS.worker)).toBe('ficus-worker')
    expect(ficusProcessName('tau-smoke-worker')).toBe('ficus-smoke-worker') // ficus-p5-bridge
  })
})

describe('sandboxPasswordPath', () => {
  test('ficus path first', () => {
    expect(sandboxPasswordPath({ exists: (p) => p === '/etc/ficus/password' })).toBe('/etc/ficus/password')
    expect(sandboxPasswordPath({ exists: (p) => p === LEGACY_SANDBOX_PASSWORD })).toBe(LEGACY_SANDBOX_PASSWORD)
  })
})
