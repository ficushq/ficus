import { afterEach, expect, test } from 'bun:test'
import { MANAGED_BIGBRAIN_DEFAULT_LIMITS, MANAGED_BIGBRAIN_UPSTREAM_COMMIT } from '@ficus/shared/managed-bigbrain'
import {
  MANAGED_BIGBRAIN_CAPABILITY_TTL_MS,
  bigbrainDeploymentAvailability,
  clearManagedBigbrainCapabilities,
  currentManagedBigbrainCapabilities,
  currentManagedBigbrainHost,
  managedBigbrainAvailability,
  noteManagedBigbrainCapabilityFailure,
  recordManagedBigbrainSupport,
} from './availability'

const previous = { ...process.env }
afterEach(() => {
  process.env = { ...previous }
  clearManagedBigbrainCapabilities()
})
const NOW = Date.parse('2026-10-20T12:00:00Z')
const TENANT = '11111111-1111-4111-8111-111111111111'
const BINDING = '77777777-7777-4777-8777-777777777777'
const DIGEST = `sha256:${'a'.repeat(64)}`
const capabilities = (patch: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  tenantId: TENANT,
  physicalHostBinding: BINDING,
  available: true,
  reasonCode: null,
  installed: true,
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: DIGEST,
  sharedProtocol: 1,
  hostState: 'active',
  hostEpoch: 1,
  zone: 'vaults.example.com',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  observedAt: '2026-10-20T12:00:00.000Z',
  ...patch,
})
const host = (patch: Record<string, unknown> = {}) => ({
  contractVersion: 1,
  tenantId: TENANT,
  physicalHostBinding: BINDING,
  hostEpoch: 1,
  hostState: 'active',
  upstreamCommit: MANAGED_BIGBRAIN_UPSTREAM_COMMIT,
  artifactDigest: DIGEST,
  zone: 'vaults.example.com',
  limits: MANAGED_BIGBRAIN_DEFAULT_LIMITS,
  effect: null,
  ...patch,
})
const agreeing = () => ({ local: capabilities(), platform: capabilities(), host: host() })
function cloud() {
  process.env.FICUS_MANAGED = '1'
}

test('managed mode is unavailable without a confirmed refresh: no flag alone implies capability', () => {
  cloud()
  expect(managedBigbrainAvailability(NOW)).toEqual({
    available: false,
    reason: expect.stringContaining('not been confirmed'),
  })
  expect(bigbrainDeploymentAvailability(NOW).available).toBe(false)
  expect(currentManagedBigbrainCapabilities(NOW)).toBeNull()
  expect(currentManagedBigbrainHost(NOW)).toBeNull()
})

test('local probe, Platform report and installed host record that agree make it available on Cloud only', () => {
  cloud()
  recordManagedBigbrainSupport(agreeing(), NOW)
  expect(managedBigbrainAvailability(NOW)).toEqual({ available: true })
  expect(bigbrainDeploymentAvailability(NOW)).toEqual({ available: true })
  expect(currentManagedBigbrainCapabilities(NOW)?.tenantId).toBe(TENANT)
  expect(currentManagedBigbrainHost(NOW)?.zone).toBe('vaults.example.com')
  delete process.env.FICUS_MANAGED
  expect(managedBigbrainAvailability(NOW).available).toBe(false)
})

test('a tenant label all three observations agree on is the one Core uses for new vault origins', () => {
  cloud()
  recordManagedBigbrainSupport(
    {
      local: capabilities({ tenantLabel: 'acme' }),
      platform: capabilities({ tenantLabel: 'acme' }),
      host: host({ tenantLabel: 'acme' }),
    },
    NOW
  )
  expect(currentManagedBigbrainHost(NOW)?.tenantLabel).toBe('acme')
  recordManagedBigbrainSupport(agreeing(), NOW)
  expect(currentManagedBigbrainHost(NOW)?.tenantLabel).toBeNull()
})

test('disagreement on binding, epoch, zone, tenant label, tenant or artifact is unavailable', () => {
  cloud()
  for (const bad of [
    { ...agreeing(), platform: capabilities({ tenantLabel: 'acme' }) },
    { ...agreeing(), host: host({ tenantLabel: 'acme' }) },
    {
      local: capabilities({ tenantLabel: 'acme' }),
      platform: capabilities({ tenantLabel: 'other' }),
      host: host({ tenantLabel: 'acme' }),
    },
    { ...agreeing(), platform: capabilities({ physicalHostBinding: TENANT }) },
    { ...agreeing(), local: capabilities({ hostEpoch: 2 }) },
    { ...agreeing(), platform: capabilities({ zone: 'other.example.com' }) },
    { ...agreeing(), host: host({ tenantId: BINDING }) },
    { ...agreeing(), local: capabilities({ artifactDigest: `sha256:${'b'.repeat(64)}` }) },
  ]) {
    recordManagedBigbrainSupport(agreeing(), NOW)
    recordManagedBigbrainSupport(bad, NOW)
    expect(managedBigbrainAvailability(NOW)).toEqual({
      available: false,
      reason: expect.stringContaining('identity_mismatch'),
    })
  }
})

test('stale, refused, suspended, uninstalled or malformed observations are unavailable', () => {
  cloud()
  recordManagedBigbrainSupport(agreeing(), NOW)
  expect(managedBigbrainAvailability(NOW + MANAGED_BIGBRAIN_CAPABILITY_TTL_MS + 1).available).toBe(false)
  expect(managedBigbrainAvailability(NOW - 120_000).available).toBe(false)
  for (const bad of [
    {
      ...agreeing(),
      local: capabilities({
        available: false,
        reasonCode: 'not_installed',
        installed: false,
        physicalHostBinding: null,
        artifactDigest: null,
        zone: null,
      }),
    },
    { ...agreeing(), platform: capabilities({ available: false, reasonCode: 'tls_unavailable' }) },
    { ...agreeing(), local: capabilities({ available: false, reasonCode: 'maintenance', hostState: 'suspended' }) },
    { ...agreeing(), platform: { ...capabilities(), extra: true } },
    { ...agreeing(), host: host({ token: 'x' }) },
  ]) {
    recordManagedBigbrainSupport(agreeing(), NOW)
    recordManagedBigbrainSupport(bad, NOW)
    expect(managedBigbrainAvailability(NOW).available).toBe(false)
  }
})

test('a transient failure (busy helper) keeps the last snapshot until its TTL; a definite refusal clears it', () => {
  cloud()
  recordManagedBigbrainSupport(agreeing(), NOW)
  noteManagedBigbrainCapabilityFailure({ code: 'busy', retryable: true })
  expect(managedBigbrainAvailability(NOW).available).toBe(true)
  noteManagedBigbrainCapabilityFailure({ code: 'unauthorized', retryable: false })
  expect(managedBigbrainAvailability(NOW)).toEqual({
    available: false,
    reason: expect.stringContaining('unauthorized'),
  })
  recordManagedBigbrainSupport(agreeing(), NOW)
  noteManagedBigbrainCapabilityFailure(new Error('unexpected'))
  expect(managedBigbrainAvailability(NOW).available).toBe(false)
})

test('off Cloud the deployment uses the local host rules, never a managed report', () => {
  delete process.env.FICUS_MANAGED
  process.env.FICUS_SANDBOX_RUNTIME = 'host'
  recordManagedBigbrainSupport(agreeing(), NOW)
  expect(bigbrainDeploymentAvailability(NOW)).toEqual({ available: true })
  delete process.env.FICUS_SANDBOX_RUNTIME
  expect(bigbrainDeploymentAvailability(NOW).available).toBe(false)
})
