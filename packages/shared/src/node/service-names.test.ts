import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
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
    expect(launchdLabel('ficus-api', { launchAgentsDir: dir })).toBe('sh.ficus.ficus-api')

    const agents = mkdtempSync(join(tmpdir(), 'service-names-test-agents-'))
    try {
      writeFileSync(join(agents, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}.plist`), '')
      expect(launchdLabel(LEGACY_UNITS.api, { launchAgentsDir: agents })).toBe(
        `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}`
      )
    } finally {
      rmSync(agents, { recursive: true, force: true })
    }
  })
})

describe('sandboxPasswordPath', () => {
  test('ficus path first', () => {
    expect(sandboxPasswordPath({ exists: (p) => p === '/etc/ficus/password' })).toBe('/etc/ficus/password')
    expect(sandboxPasswordPath({ exists: (p) => p === LEGACY_SANDBOX_PASSWORD })).toBe(LEGACY_SANDBOX_PASSWORD)
  })
})
