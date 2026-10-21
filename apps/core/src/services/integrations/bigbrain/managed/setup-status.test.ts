import { expect, test } from 'bun:test'
import { MANAGED_SETUP_ISSUES as ISSUE, managedBigbrainSetupStatus } from './setup-status'

const reading = { state: 'ready', readAccess: 'active', connectionEnabled: true, squadCount: 1 }

test('no live vault asks for a shared vault (deleted vaults and their disabled connections do not count)', () => {
  expect(managedBigbrainSetupStatus([])).toEqual({ state: 'needs_setup', issues: [ISSUE.create] })
  expect(
    managedBigbrainSetupStatus([
      { ...reading, state: 'deleted', connectionEnabled: false },
      { ...reading, state: 'deleting', connectionEnabled: false },
    ])
  ).toEqual({ state: 'needs_setup', issues: [ISSUE.create] })
})

test('a ready, readable vault attached to no squad says to attach it, never to enable an account', () => {
  const status = managedBigbrainSetupStatus([{ ...reading, squadCount: 0 }])
  expect(status).toEqual({ state: 'needs_attention', issues: [ISSUE.attach] })
  expect(status.issues.join(' ')).not.toContain('Enable at least one connected account')
})

test('a ready, readable, attached vault is configured, also beside a vault still being set up', () => {
  expect(managedBigbrainSetupStatus([reading])).toEqual({ state: 'configured', issues: [] })
  expect(managedBigbrainSetupStatus([{ ...reading, state: 'degraded' }])).toEqual({ state: 'configured', issues: [] })
  expect(
    managedBigbrainSetupStatus([reading, { ...reading, state: 'provisioning', connectionEnabled: null, squadCount: 0 }])
  ).toEqual({ state: 'configured', issues: [] })
})

test('vault lifecycle problems name the concrete next step', () => {
  expect(managedBigbrainSetupStatus([{ ...reading, state: 'provisioning', connectionEnabled: null }])).toEqual({
    state: 'needs_setup',
    issues: [ISSUE.provisioning],
  })
  expect(managedBigbrainSetupStatus([{ ...reading, state: 'requested', connectionEnabled: null }]).state).toBe(
    'needs_setup'
  )
  expect(managedBigbrainSetupStatus([{ ...reading, state: 'failed', connectionEnabled: null }])).toEqual({
    state: 'needs_attention',
    issues: [ISSUE.failed],
  })
  expect(managedBigbrainSetupStatus([{ ...reading, readAccess: 'pending', connectionEnabled: null }])).toEqual({
    state: 'needs_setup',
    issues: [ISSUE.readPending],
  })
  // Ready with read access granted on the host but not imported into Ficus yet.
  expect(managedBigbrainSetupStatus([{ ...reading, connectionEnabled: null }])).toEqual({
    state: 'needs_setup',
    issues: [ISSUE.readPending],
  })
  expect(managedBigbrainSetupStatus([{ ...reading, readAccess: 'revoked', connectionEnabled: false }])).toEqual({
    state: 'needs_attention',
    issues: [ISSUE.readRevoked],
  })
})

test('a Ready vault whose read connection is off says Ficus cannot read it, even when attached', () => {
  expect(managedBigbrainSetupStatus([{ ...reading, connectionEnabled: false }])).toEqual({
    state: 'needs_attention',
    issues: [ISSUE.readOff],
  })
  // A readable attached vault does not hide another vault's problem.
  expect(managedBigbrainSetupStatus([reading, { ...reading, state: 'failed', squadCount: 0 }])).toEqual({
    state: 'needs_attention',
    issues: [ISSUE.failed],
  })
})

test('a Ready vault whose read import keeps failing needs attention instead of looking in progress', () => {
  expect(
    managedBigbrainSetupStatus([{ ...reading, connectionEnabled: null, squadCount: 0, syncFailed: true }])
  ).toEqual({ state: 'needs_attention', issues: [ISSUE.readOff] })
})
