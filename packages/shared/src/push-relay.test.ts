import { describe, expect, test } from 'bun:test'
import {
  PUSH_RELAY_BASE_URL,
  pushAlertText,
  relayBindingTokenSchema,
  relayInstanceTokenPattern,
  relayRoutingSchema,
  type RelayRouting,
} from './push-relay'

test('push relay base URL is the live control plane, not a redirecting host', () => {
  expect(PUSH_RELAY_BASE_URL).toBe('https://ficus.sh')
})

describe('relay routing presentation keys', () => {
  const routing = {
    eventType: 'done',
    workStreamNumber: 197,
    preview: { title: 'Completed: #197 · Validate deletion', body: 'ship it', subtitle: 'Platform' },
    collapseKey: 'ws:abc',
    threadKey: 'squad:def',
    interruptionLevel: 'passive',
  } satisfies RelayRouting
  const rejects = (value: unknown) => relayRoutingSchema.safeParse(value).success === false

  test('accepts a preview subtitle and grouping keys, and still rejects unknown keys', () => {
    expect(relayRoutingSchema.parse(routing)).toEqual(routing)
    expect(rejects({ ...routing, sound: 'loud' })).toBe(true)
    expect(rejects({ ...routing, interruptionLevel: 'loud' })).toBe(true)
    expect(rejects({ ...routing, preview: { ...routing.preview, extra: 1 } })).toBe(true)
  })

  test('pushAlertText returns the preview subtitle only when a preview is present', () => {
    expect(
      pushAlertText({ eventType: 'done', workStreamNumber: 197, preview: { title: 'T', body: 'B', subtitle: 'S' } })
    ).toEqual({ title: 'T', body: 'B', subtitle: 'S' })
    expect(pushAlertText({ eventType: 'done', workStreamNumber: 197 })).toEqual({
      title: 'Work #197 completed',
      body: 'Open Ficus to see details.',
    })
    expect(pushAlertText({ eventType: 'update' })).toEqual({
      title: 'Ficus update',
      body: 'Open Ficus to see details.',
    })
    expect(pushAlertText({ eventType: 'done' }).title).toBe('Work completed')
  })
})

describe('relay token prefixes (no dual-accept)', () => {
  const instanceId = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const secret = 'A'.repeat(42) + '_'

  test('instance tokens are ficus_pri_ only', () => {
    expect(relayInstanceTokenPattern.exec(`ficus_pri_${instanceId}_${secret}`)?.[1]).toBe(instanceId)
    expect(relayInstanceTokenPattern.test(`tau_pri_${instanceId}_${secret}`)).toBe(false)
    expect(relayInstanceTokenPattern.test(`ficus_prd_${instanceId}_${secret}`)).toBe(false)
    expect(relayInstanceTokenPattern.test(`xficus_pri_${instanceId}_${secret}`)).toBe(false)
  })

  test('binding tokens are ficus_prd_ only', () => {
    expect(relayBindingTokenSchema.safeParse(`ficus_prd_${secret}`).success).toBe(true)
    expect(relayBindingTokenSchema.safeParse(`tau_prd_${secret}`).success).toBe(false)
    expect(relayBindingTokenSchema.safeParse(`ficus_pri_${secret}`).success).toBe(false)
    expect(relayBindingTokenSchema.safeParse(`xficus_prd_${secret}`).success).toBe(false)
  })
})
