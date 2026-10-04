import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  liveActivityRegistrationPayload,
  buildRelayLiveActivityPayload,
  orderLiveActivityDelivery,
  projectRelayLiveActivityState,
  relayLiveActivityRegistrationSchema,
  relayLiveActivitySendSchema,
  type LiveActivityDeliveryHead,
  type RelayLiveActivitySend,
} from './live-activity-relay'
import { relaySendSchema } from './push-relay'

const bindingToken = `ficus_pla_${'a'.repeat(43)}`
const activityKey = randomUUID()
const state = {
  activeCount: 1,
  needsYouCount: 0,
  top: [{ id: randomUUID(), squadId: randomUUID(), title: 'private task', bucket: 'running' as const, number: 12 }],
}
const input: RelayLiveActivitySend = {
  version: 1,
  bindingToken,
  activityKey,
  eventId: randomUUID(),
  sequence: 1,
  event: 'start',
  contentState: state,
}
const head: LiveActivityDeliveryHead = {
  sequence: 1,
  eventId: input.eventId,
  payloadHash: 'digest',
  ended: false,
  outcome: 'sent',
}
const next = (sequence: number, event: 'update' | 'end' = 'update'): RelayLiveActivitySend => ({
  version: 1,
  bindingToken,
  activityKey,
  sequence,
  eventId: randomUUID(),
  ...(event === 'end' ? { event } : { event, contentState: state }),
})

describe('closed ActivityKit relay protocol', () => {
  test('ordinary alerts and ActivityKit capabilities cannot be interchanged', () => {
    expect(relayLiveActivitySendSchema.safeParse(input).success).toBe(true)
    expect(
      relayLiveActivitySendSchema.safeParse({ ...input, bindingToken: `ficus_prd_${'a'.repeat(43)}` }).success
    ).toBe(false)
    expect(relaySendSchema.safeParse({ version: 1, bindingToken, eventId: randomUUID(), routing: {} }).success).toBe(
      false
    )
  })
  test('callers cannot choose APNs destinations, topics, environment or timestamps at send time', () => {
    for (const extra of [
      { deviceToken: 'a'.repeat(64) },
      { origin: 'https://elsewhere.test' },
      { topic: 'other' },
      { environment: 'sandbox' },
      { timestamp: 99 },
      { attributes: {} },
      { alert: {} },
    ])
      expect(relayLiveActivitySendSchema.safeParse({ ...input, ...extra }).success).toBe(false)
    for (const sequence of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(relayLiveActivitySendSchema.safeParse({ ...input, sequence }).success).toBe(false)
  })
  test('end contains no stale/private work and the state projection is bounded', () => {
    expect(relayLiveActivitySendSchema.safeParse(next(2, 'end')).success).toBe(true)
    expect(relayLiveActivitySendSchema.safeParse({ ...input, event: 'end' }).success).toBe(false)
    for (const contentState of [
      { ...state, activeCount: -1 },
      { ...state, top: Array(4).fill(state.top[0]) },
      { ...state, extra: true },
      { ...state, top: [{ ...state.top[0], title: 'x'.repeat(201) }] },
    ])
      expect(relayLiveActivitySendSchema.safeParse({ ...input, contentState }).success).toBe(false)
  })
  test('privacy projection preserves routing and buckets but removes titles when previews are off', () => {
    expect(projectRelayLiveActivityState(state, false).top[0]).toEqual({ ...state.top[0], title: 'Work #12' })
    expect(projectRelayLiveActivityState(state, true)).toEqual(state)
    const large = { ...state, top: Array(4).fill({ ...state.top[0], title: '🌿'.repeat(201) }) }
    expect(projectRelayLiveActivityState(large, true).top).toHaveLength(3)
    expect(projectRelayLiveActivityState(large, true).top[0].title).toBe('🌿'.repeat(100))
  })
  test('signed registration binds kind, environment, destination, capability and immutable lifecycle', () => {
    const registration = {
      version: 1 as const,
      activationId: randomUUID(),
      bindingToken,
      deviceToken: 'ab'.repeat(32),
      kind: 'update' as const,
      environment: 'sandbox' as const,
      activityKey,
      activityId: 'native-opaque-id',
    }
    const canonical = liveActivityRegistrationPayload(registration)
    expect(
      liveActivityRegistrationPayload({ ...registration, deviceToken: registration.deviceToken.toUpperCase() })
    ).toBe(canonical)
    for (const change of [
      { activityKey: randomUUID() },
      { activityId: 'new-native-id' },
      { deviceToken: 'cd'.repeat(32) },
      { environment: 'production' as const },
      { bindingToken: `ficus_pla_${'b'.repeat(43)}` },
      { activationId: randomUUID() },
    ])
      expect(liveActivityRegistrationPayload({ ...registration, ...change })).not.toBe(canonical)
    expect(relayLiveActivityRegistrationSchema.safeParse({ ...registration, kind: 'start' }).success).toBe(false)
    const { activityKey: _key, activityId: _id, ...start } = registration
    expect(relayLiveActivityRegistrationSchema.safeParse({ ...start, kind: 'start' }).success).toBe(true)
  })
})

describe('durable relay ordering policy', () => {
  test('start creates a lifecycle; updates need a registered or started lifecycle', () => {
    expect(orderLiveActivityDelivery(null, input, 'digest')).toBe('admit')
    expect(orderLiveActivityDelivery(null, next(1), 'digest')).toBe('conflict')
    expect(
      orderLiveActivityDelivery(
        { ...head, sequence: 0, eventId: null, payloadHash: null, outcome: 'registered' },
        next(1),
        'digest'
      )
    ).toBe('admit')
  })
  test('only confirmed provider acceptance is a duplicate success', () => {
    expect(orderLiveActivityDelivery(head, input, 'digest')).toBe('duplicate')
    for (const [outcome, expected] of [
      ['in_flight', 'in_flight'],
      ['unknown', 'delivery_unknown'],
      ['failed', 'admit'],
    ] as const)
      expect(orderLiveActivityDelivery({ ...head, outcome }, input, 'digest')).toBe(expected)
    expect(orderLiveActivityDelivery(head, { ...input, eventId: randomUUID() }, 'digest')).toBe('conflict')
    expect(orderLiveActivityDelivery(head, input, 'changed')).toBe('conflict')
    expect(orderLiveActivityDelivery(head, { ...input, sequence: 2 }, 'digest')).toBe('conflict')
  })
  test('late/new updates cannot revive an ended lifecycle; exact failed end can retry', () => {
    const end = next(2, 'end')
    const ended = { ...head, sequence: 2, eventId: end.eventId, ended: true }
    expect(orderLiveActivityDelivery(ended, next(3), 'new')).toBe('superseded')
    expect(orderLiveActivityDelivery(ended, input, 'digest')).toBe('superseded')
    expect(orderLiveActivityDelivery({ ...ended, outcome: 'failed' }, end, 'digest')).toBe('admit')
    expect(orderLiveActivityDelivery({ ...ended, outcome: 'unknown' }, end, 'digest')).toBe('delivery_unknown')
  })
  test('provider calls cannot race or restart a lifecycle', () => {
    expect(orderLiveActivityDelivery(head, next(2), 'new')).toBe('admit')
    expect(orderLiveActivityDelivery({ ...head, outcome: 'in_flight' }, next(2), 'new')).toBe('in_flight')
    expect(orderLiveActivityDelivery({ ...head, outcome: 'unknown' }, next(2), 'new')).toBe('delivery_unknown')
    expect(orderLiveActivityDelivery(head, { ...input, eventId: randomUUID(), sequence: 2 }, 'new')).toBe('conflict')
  })
})

describe('relay-owned ActivityKit payload', () => {
  const admission = { origin: 'https://one.example/base', timestamp: 1000, coverageExpiresAt: 1100, previews: false }
  test('remote start includes required fixed attributes/alert and bounded stale date', () => {
    const { aps } = buildRelayLiveActivityPayload(input, admission)
    expect(aps).toMatchObject({
      timestamp: 1000,
      event: 'start',
      'stale-date': 1100,
      'attributes-type': 'FicusWorkAttributes',
      attributes: { origin: admission.origin, activityKey },
      alert: { title: 'Ficus' },
    })
    expect(JSON.stringify(aps)).not.toContain('private task')
    expect(aps.sound).toBeUndefined()
    expect(buildRelayLiveActivityPayload(input, { ...admission, coverageExpiresAt: 5000 }).aps['stale-date']).toBe(1300)
  })
  test('cleanup after expiry is empty and dismisses immediately without start keys', () => {
    expect(buildRelayLiveActivityPayload(next(2, 'end'), { ...admission, coverageExpiresAt: null })).toEqual({
      aps: {
        timestamp: 1000,
        event: 'end',
        'content-state': { activeCount: 0, needsYouCount: 0, top: [] },
        'dismissal-date': 1000,
      },
    })
    expect(buildRelayLiveActivityPayload(next(2), { ...admission, previews: true }).aps.alert).toBeUndefined()
  })
  test('expired/invalid admission and oversized final envelopes cannot be dispatched', () => {
    for (const change of [
      { coverageExpiresAt: 1000 },
      { coverageExpiresAt: null },
      { timestamp: NaN },
      { origin: 'http://one.example' },
      { origin: 'https://u:secret@one.example' },
      { origin: 'https://one.example/?secret=x' },
    ])
      expect(() => buildRelayLiveActivityPayload(input, { ...admission, ...change })).toThrow()
    expect(() =>
      buildRelayLiveActivityPayload(input, { ...admission, origin: `https://one.example/${'a'.repeat(5000)}` })
    ).toThrow('too large')
  })
})

describe('installation registration proof', () => {
  test('binds every challenge field and uses a separate proof domain', async () => {
    const { liveActivityRegistrationProofMessage } = await import('./live-activity-relay')
    const { activationProofMessage } = await import('./push-relay')
    const challenge = {
      version: 1 as const,
      id: randomUUID(),
      instanceId: randomUUID(),
      activationId: randomUUID(),
      origin: 'https://home.example.test',
      nonce: 'a'.repeat(43),
      expiresAt: '2030-01-01T00:00:00.000Z',
      operationDigest: 'b'.repeat(64),
      generation: 0,
    }
    const message = liveActivityRegistrationProofMessage(challenge)
    expect(message).not.toBe(activationProofMessage(challenge))
    for (const change of [
      { id: randomUUID() },
      { instanceId: randomUUID() },
      { activationId: randomUUID() },
      { origin: 'https://other.example.test' },
      { nonce: 'b'.repeat(43) },
      { expiresAt: '2030-01-02T00:00:00.000Z' },
      { operationDigest: 'c'.repeat(64) },
      { generation: 1 },
    ])
      expect(liveActivityRegistrationProofMessage({ ...challenge, ...change })).not.toBe(message)
    expect(() => liveActivityRegistrationProofMessage({ ...challenge, generation: -1 })).toThrow()
  })
  test('preview consent is part of the signed registration payload and defaults off', () => {
    const registration = {
      version: 1 as const,
      activationId: randomUUID(),
      bindingToken,
      deviceToken: 'a'.repeat(64),
      environment: 'sandbox' as const,
      kind: 'start' as const,
    }
    expect(liveActivityRegistrationPayload(registration)).toBe(
      liveActivityRegistrationPayload({ ...registration, previews: false })
    )
    expect(liveActivityRegistrationPayload(registration)).not.toBe(
      liveActivityRegistrationPayload({ ...registration, previews: true })
    )
  })
})
