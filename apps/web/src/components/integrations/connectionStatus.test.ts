import { expect, test } from 'bun:test'
import { connectionConfirmQuestion, connectionStatus } from './connectionStatus'

const healthy = { enabled: true, authState: 'authenticated', healthState: 'healthy' } as const

test('the status names the most urgent problem first', () => {
  const finding = { label: 'Needs permissions', color: 'attention' } as const
  expect(connectionStatus({ ...healthy, enabled: false, authState: 'invalid' }, finding).label).toBe('Disabled')
  expect(connectionStatus({ ...healthy, authState: 'reauthorization_required' }, finding).label).toBe(
    'Reconnect required'
  )
  expect(connectionStatus({ ...healthy, authState: 'invalid' }, finding).label).toBe('Invalid credentials')
  expect(connectionStatus({ ...healthy, authState: 'pending' }, finding).label).toBe('Pending')
  // A provider's own finding outranks health once the connection is enabled and signed in.
  expect(connectionStatus({ ...healthy, healthState: 'unreachable' }, finding).label).toBe('Needs permissions')
  expect(connectionStatus(healthy)).toEqual({ label: 'Healthy', color: 'success' })
  expect(connectionStatus({ ...healthy, healthState: 'degraded' }).label).toBe('Degraded')
  expect(connectionStatus({ ...healthy, healthState: 'unreachable' }).label).toBe('Unreachable')
  expect(connectionStatus({ ...healthy, healthState: 'unknown' }).label).toBe('Not checked yet')
})

test('a confirmation says how many squads lose access, and nothing when none do', () => {
  expect(connectionConfirmQuestion('remove', 'Acme', 0, 'Notion')).toBe('Remove the Acme connection?')
  expect(connectionConfirmQuestion('disable', 'Acme', 1, 'Notion')).toBe(
    'Disable the Acme connection? 1 squad loses Notion access.'
  )
  expect(connectionConfirmQuestion('remove', 'Acme', 3, 'GitHub')).toBe(
    'Remove the Acme connection? 3 squads lose GitHub access.'
  )
})
