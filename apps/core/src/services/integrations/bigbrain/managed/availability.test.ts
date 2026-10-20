import { afterEach, expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import {
  MANAGED_BIGBRAIN_CAPABILITY_TTL_MS,
  bigbrainDeploymentAvailability,
  clearManagedBigbrainCapabilities,
  currentManagedBigbrainCapabilities,
  managedBigbrainAvailability,
  recordManagedBigbrainCapabilities,
} from './availability'

const previous = { ...process.env }
afterEach(() => {
  process.env = { ...previous }
  clearManagedBigbrainCapabilities()
})
const NOW = Date.parse('2026-10-20T12:00:00Z')
const capabilities = (patch: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  tenantId: '11111111-1111-4111-8111-111111111111',
  physicalHostBinding: '77777777-7777-4777-8777-777777777777',
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  sharedProtocol: 1,
  hostState: 'active',
  hostEpoch: 1,
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: '2026-10-20T12:00:00.000Z',
  ...patch,
})
function cloud() {
  process.env.FICUS_MANAGED = '1'
}

test('managed mode is unavailable without a confirmed report: no flag alone implies capability', () => {
  cloud()
  expect(managedBigbrainAvailability(NOW).available).toBe(false)
  expect(bigbrainDeploymentAvailability(NOW).available).toBe(false)
  expect(currentManagedBigbrainCapabilities(NOW)).toBeNull()
})

test('a fresh report for an installed active pinned host makes managed mode available on Cloud only', () => {
  cloud()
  recordManagedBigbrainCapabilities(capabilities(), NOW)
  expect(managedBigbrainAvailability(NOW)).toEqual({ available: true })
  expect(bigbrainDeploymentAvailability(NOW)).toEqual({ available: true })
  expect(currentManagedBigbrainCapabilities(NOW)?.tenantId).toBe('11111111-1111-4111-8111-111111111111')
  delete process.env.FICUS_MANAGED
  expect(managedBigbrainAvailability(NOW).available).toBe(false)
})

test('stale, refused, suspended, uninstalled or malformed reports are unavailable', () => {
  cloud()
  recordManagedBigbrainCapabilities(capabilities(), NOW)
  expect(managedBigbrainAvailability(NOW + MANAGED_BIGBRAIN_CAPABILITY_TTL_MS + 1).available).toBe(false)
  expect(managedBigbrainAvailability(NOW - 120_000).available).toBe(false)
  const refused = [
    capabilities({
      available: false,
      reasonCode: 'not_installed',
      installed: false,
      physicalHostBinding: null,
      artifactDigest: null,
    }),
    capabilities({ available: false, reasonCode: 'maintenance', hostState: 'suspended' }),
    capabilities({ available: false, reasonCode: 'capability_stale' }),
  ]
  for (const report of refused) {
    recordManagedBigbrainCapabilities(report, NOW)
    expect(managedBigbrainAvailability(NOW).available).toBe(false)
  }
  for (const malformed of [
    capabilities({ upstreamCommit: 'f'.repeat(40) }),
    capabilities({ tenantId: 'not-a-uuid' }),
    capabilities({ hostState: 'suspended' }),
    { ...capabilities(), extra: true },
  ]) {
    recordManagedBigbrainCapabilities(capabilities(), NOW)
    recordManagedBigbrainCapabilities(malformed, NOW)
    expect(managedBigbrainAvailability(NOW).available).toBe(false)
  }
})

test('off Cloud the deployment uses the local host rules, never a managed report', () => {
  delete process.env.FICUS_MANAGED
  process.env.FICUS_SANDBOX_RUNTIME = 'host'
  recordManagedBigbrainCapabilities(capabilities(), NOW)
  expect(bigbrainDeploymentAvailability(NOW)).toEqual({ available: true })
  delete process.env.FICUS_SANDBOX_RUNTIME
  expect(bigbrainDeploymentAvailability(NOW).available).toBe(false)
})
