import { expect, test } from 'bun:test'
import {
  activationOperationPayload,
  defaultNativeNotificationPolicy as defaults,
  nativeNotificationDecision as decide,
  nativeNotificationPolicySchema as schema,
} from './push-relay'
const squad = '93b58062-77e5-4e3e-938a-30db82665830'
const routing = { squadId: squad, eventType: 'question' as const, preview: { title: 'Secret', body: 'Private' } }
test('privacy and muting remain free and do not mutate routing', () => {
  expect(decide(defaults, routing, false).routing.preview).toBeUndefined()
  expect(routing.preview.title).toBe('Secret')
  expect(decide({ ...defaults, showPreviews: true }, routing, false).routing.preview).toEqual(routing.preview)
  expect(decide({ ...defaults, enabled: false }, routing, false).deliver).toBe(false)
  expect(decide({ ...defaults, mutedSquadIds: [squad] }, routing, false).deliver).toBe(false)
})
test('paid filters apply only under current coverage, missing squad cannot bypass inclusion', () => {
  const policy = { ...defaults, onlySquadIds: [squad], eventTypes: ['question' as const] }
  expect(decide(policy, routing, true).deliver).toBe(true)
  expect(decide(policy, {}, true).deliver).toBe(false)
  expect(decide(policy, {}, false).deliver).toBe(true)
  expect(decide({ ...defaults, eventTypes: [] }, routing, true).deliver).toBe(false)
})
test('quiet hours respect endpoints, overnight intervals, and both repeated DST hours', () => {
  const policy = { ...defaults, quietHours: { startMinute: 60, endMinute: 120, timeZone: 'America/New_York' } }
  for (const at of ['2026-11-01T05:00:00Z', '2026-11-01T06:30:00Z'])
    expect(decide(policy, routing, true, new Date(at)).deliver).toBe(false)
  expect(decide(policy, routing, true, new Date('2026-11-01T07:00:00Z')).deliver).toBe(true)
  const overnight = { ...defaults, quietHours: { startMinute: 1320, endMinute: 420, timeZone: 'UTC' } }
  expect(decide(overnight, routing, true, new Date('2026-10-04T23:00:00Z')).deliver).toBe(false)
  expect(decide(overnight, routing, true, new Date('2026-10-04T07:00:00Z')).deliver).toBe(true)
  expect(decide(overnight, routing, false, new Date('2026-10-04T23:00:00Z')).deliver).toBe(true)
})
test('invalid policy and caller-controlled destinations are rejected', () => {
  expect(
    schema.safeParse({ ...defaults, quietHours: { startMinute: 1, endMinute: 2, timeZone: 'invalid-zone' } }).success
  ).toBe(false)
  expect(schema.safeParse({ ...defaults, quietHours: { startMinute: 1, endMinute: 1, timeZone: 'UTC' } }).success).toBe(
    false
  )
  expect(schema.safeParse({ ...defaults, url: 'https://attacker.test' }).success).toBe(false)
})
test('the signed operation digest includes the device policy', () => {
  const bind = {
    action: 'bind' as const,
    activationId: squad,
    deviceToken: 'a'.repeat(64),
    environment: 'sandbox' as const,
    bindingToken: `ficus_prd_${'a'.repeat(43)}`,
  }
  expect(activationOperationPayload(bind)).not.toBe(
    activationOperationPayload({ ...bind, notificationPolicy: defaults })
  )
  expect(activationOperationPayload({ ...bind, notificationPolicy: defaults })).not.toBe(
    activationOperationPayload({ ...bind, notificationPolicy: { ...defaults, showPreviews: true } })
  )
})
