import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FICUS_LAUNCHD_PREFIX,
  hostSystemdUnits,
  launchdLabel,
  sandboxPasswordPath,
  systemdUserUnit,
} from './service-names'

describe('canonical service names', () => {
  test('uses ficus units even when no unit exists yet', () => {
    expect(hostSystemdUnits()).toEqual({ api: 'ficus-api', worker: 'ficus-worker' })
  })

  test('does not select a retired launchd plist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'service-names-test-'))
    try {
      writeFileSync(join(dir, 'ai.hiretau.tau-api.plist'), '')
      expect(launchdLabel({ legacy: 'tau-api', new: 'ficus-api' }, { launchAgentsDir: dir })).toBe(
        `${FICUS_LAUNCHD_PREFIX}.ficus-api`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('does not select a retired user unit', () => {
    expect(systemdUserUnit({ legacy: 'tau-worker', new: 'ficus-worker' })).toBe('ficus-worker.service')
  })

  test('uses the canonical sandbox secret path', () => {
    expect(sandboxPasswordPath({ exists: (path) => path === '/etc/tau/password' })).toBe('/etc/ficus/password')
  })
})
