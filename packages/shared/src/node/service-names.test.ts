import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { localProcessNames } from '../local-instance'
import {
  FICUS_LAUNCHD_PREFIX,
  hostSystemdUnits,
  launchdLabel,
  LEGACY_LAUNCHD_PREFIX,
  LEGACY_LOCAL_INSTANCE,
  LEGACY_SANDBOX_PASSWORD,
  LEGACY_UNITS,
  legacyLocalProcessNames,
  renamedLocalInstanceLabel,
  sandboxPasswordPath,
  systemdUserUnit,
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

  test('canonical units even when no canonical unit exists', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'service-names-test-empty-'))
    try {
      expect(hostSystemdUnits({ unitDir: emptyDir })).toEqual({ api: 'ficus-api', worker: 'ficus-worker' })
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})

describe('launchdLabel', () => {
  test('canonical label even when only a retired plist exists', () => {
    expect(launchdLabel({ legacy: LEGACY_UNITS.api, new: 'ficus-api' }, { launchAgentsDir: dir })).toBe(
      'sh.ficus.ficus-api'
    )

    const agents = mkdtempSync(join(tmpdir(), 'service-names-test-agents-'))
    try {
      writeFileSync(join(agents, `${LEGACY_LAUNCHD_PREFIX}.${LEGACY_UNITS.api}.plist`), '')
      expect(launchdLabel({ legacy: LEGACY_UNITS.api, new: 'ficus-api' }, { launchAgentsDir: agents })).toBe(
        'sh.ficus.ficus-api'
      )
    } finally {
      rmSync(agents, { recursive: true, force: true })
    }
  })

  // A labeled local instance's legacy and new names differ by more than the prefix, so the
  // two must be threaded through separately rather than assumed to be the same string under
  // both prefixes.
  test('ignores retired plists when resolving a labeled instance', () => {
    const legacy = legacyLocalProcessNames('smoke').worker
    const updated = localProcessNames(renamedLocalInstanceLabel('smoke')).worker
    expect(updated).toBe('ficus-smoke-worker')

    const agents = mkdtempSync(join(tmpdir(), 'service-names-test-agents-'))
    try {
      // No legacy plist installed under this name yet: the new label wins.
      expect(launchdLabel({ legacy, new: updated }, { launchAgentsDir: agents })).toBe(
        `${FICUS_LAUNCHD_PREFIX}.ficus-smoke-worker`
      )

      writeFileSync(join(agents, `${LEGACY_LAUNCHD_PREFIX}.${legacy}.plist`), '')
      expect(launchdLabel({ legacy, new: updated }, { launchAgentsDir: agents })).toBe(
        `${FICUS_LAUNCHD_PREFIX}.${updated}`
      )
    } finally {
      rmSync(agents, { recursive: true, force: true })
    }
  })
})

describe('legacyLocalProcessNames', () => {
  test('the legacy default label keeps the legacy pair; any other label is <legacy>-<label>-*', () => {
    expect(legacyLocalProcessNames(LEGACY_LOCAL_INSTANCE)).toEqual({ label: LEGACY_LOCAL_INSTANCE, ...LEGACY_UNITS })
    expect(legacyLocalProcessNames(' Smoke ')).toEqual({
      label: 'smoke',
      api: `${LEGACY_LOCAL_INSTANCE}-smoke-api`,
      worker: `${LEGACY_LOCAL_INSTANCE}-smoke-worker`,
    })
  })
})

describe('renamedLocalInstanceLabel', () => {
  test('the legacy default label becomes ficus; every other label is kept', () => {
    expect(renamedLocalInstanceLabel(LEGACY_LOCAL_INSTANCE)).toBe('ficus')
    expect(renamedLocalInstanceLabel('smoke')).toBe('smoke')
    expect(renamedLocalInstanceLabel('ficus')).toBe('ficus')
  })
})

describe('systemdUserUnit', () => {
  test('the canonical unit even when only a retired unit exists', () => {
    const names = { legacy: LEGACY_UNITS.worker, new: 'ficus-worker' }
    expect(systemdUserUnit(names, { unitDir: dir })).toBe('ficus-worker.service')
    writeFileSync(join(dir, `${LEGACY_UNITS.worker}.service`), '')
    expect(systemdUserUnit(names, { unitDir: dir })).toBe('ficus-worker.service')
  })
})

describe('sandboxPasswordPath', () => {
  test('ficus path first', () => {
    expect(sandboxPasswordPath({ exists: (p) => p === '/etc/ficus/password' })).toBe('/etc/ficus/password')
    expect(sandboxPasswordPath({ exists: (p) => p === LEGACY_SANDBOX_PASSWORD })).toBe('/etc/ficus/password')
  })
})
