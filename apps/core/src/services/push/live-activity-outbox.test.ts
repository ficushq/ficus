import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { users, liveActivityRelayInstallations as rows } from '../../db/schema'
import { decrypt, getEncryptionKey } from '../secrets/crypto'
import { registerActivityRelay, pumpActivityRelay, unregisterActivityRelay } from './live-activity-outbox'
import type { CoreLiveActivityRegistration, RelayLiveActivitySend } from '@ficus/shared/live-activity-relay'

let userId: string
let activationId: string
let priorKey: string | undefined
const active = { activeCount: 1, needsYouCount: 0, top: [] }
const empty = { activeCount: 0, needsYouCount: 0, top: [] }
const token = () => 'ficus_pla_' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
let start: CoreLiveActivityRegistration
beforeEach(async () => {
  priorKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY = 'activity-test-key'
  activationId = crypto.randomUUID()
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.test`, displayName: 'Activity test' })
    .returning()
  userId = user!.id
  start = {
    version: 1,
    kind: 'start',
    activationId,
    destinationId: crypto.randomUUID(),
    generation: 1,
    bindingToken: token(),
  }
})
afterEach(async () => {
  await db.delete(rows).where(eq(rows.activationId, activationId))
  await db.delete(users).where(eq(users.id, userId))
  if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = priorKey
})
async function row() {
  return (await db.select().from(rows).where(eq(rows.activationId, activationId)))[0]!
}
async function state() {
  const value = JSON.parse((await row()).stateEnc)
  return JSON.parse(decrypt(value.encrypted, value.iv, getEncryptionKey()))
}
async function due() {
  await db
    .update(rows)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(rows.activationId, activationId))
}
function update(key = crypto.randomUUID(), generation = 2): CoreLiveActivityRegistration {
  return {
    ...start,
    kind: 'update',
    activityKey: key,
    activityId: 'native-id',
    generation,
    destinationId: crypto.randomUUID(),
    bindingToken: token(),
  }
}

test('persists encrypted event before send and retries identical event across independent pumps', async () => {
  await registerActivityRelay(userId, start)
  const events: RelayLiveActivitySend[] = []
  const send = async (event: RelayLiveActivitySend) => {
    events.push(event)
    expect((await state()).pending).toEqual(event)
    expect((await row()).stateEnc).not.toContain(start.bindingToken)
    return { ok: false as const, reason: 'relay_unavailable' as const, retryable: true }
  }
  await pumpActivityRelay({ snapshot: async () => active, send })
  await due()
  await pumpActivityRelay({ snapshot: async () => active, send })
  expect(events).toHaveLength(2)
  expect(events[1]).toEqual(events[0])
  expect(events[0]!.sequence).toBe(1)
})

test('leases serialize concurrent pumps and late completion cannot overwrite a newer registration', async () => {
  await registerActivityRelay(userId, start)
  let release!: () => void
  let begun!: () => void
  const ready = new Promise<void>((r) => {
    begun = r
  })
  const first = pumpActivityRelay({
    snapshot: async () => active,
    send: async (_event) => {
      begun()
      await new Promise<void>((r) => {
        release = r
      })
      return { ok: true, status: 'sent' }
    },
  })
  await ready
  expect(
    await pumpActivityRelay({
      snapshot: async () => active,
      send: async () => {
        throw new Error('must not send')
      },
    })
  ).toBe(false)
  const pending = (await state()).pending
  await registerActivityRelay(userId, update(pending.activityKey))
  release()
  await first
  expect((await state()).pending).toBeUndefined()
  expect((await state()).sequence).toBe(1)
  const sent: RelayLiveActivitySend[] = []
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async (event) => {
      sent.push(event)
      return { ok: true, status: 'sent' }
    },
  })
  expect(sent[0]!.event).toBe('update')
  expect(sent[0]!.sequence).toBe(2)
})

test('an expired lease recovers the persisted event after process death', async () => {
  await registerActivityRelay(userId, start)
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => ({ ok: false, reason: 'relay_unavailable', retryable: true }),
  })
  const pending = (await state()).pending
  await db
    .update(rows)
    .set({ leaseId: crypto.randomUUID(), leaseUntil: new Date(0), nextAttemptAt: new Date(0) })
    .where(eq(rows.activationId, activationId))
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async (event) => {
      expect(event).toEqual(pending)
      return { ok: true, status: 'duplicate' }
    },
  })
  expect((await state()).pending).toBeUndefined()
})

test('permission loss sends a content-free successor end, never retries old content', async () => {
  const registration = update()
  await registerActivityRelay(userId, registration)
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => ({ ok: false, reason: 'relay_unavailable', retryable: true }),
  })
  await due()
  await pumpActivityRelay({
    snapshot: async () => empty,
    send: async (event) => {
      expect(event.event).toBe('end')
      expect(event.sequence).toBe(2)
      expect(event).not.toHaveProperty('contentState')
      return { ok: true, status: 'sent' }
    },
  })
  expect((await state()).ended).toBe(true)
  await expect(registerActivityRelay(userId, { ...registration, generation: 3 })).rejects.toThrow('ended')
})

test('updates use fresh projections while an unknown delivery remains blocked without resending', async () => {
  await registerActivityRelay(userId, update())
  let calls = 0
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => {
      calls++
      return { ok: false, reason: 'delivery_unknown', retryable: false }
    },
  })
  await due()
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => {
      calls++
      return { ok: true, status: 'sent' }
    },
  })
  expect(calls).toBe(1)
  expect((await state()).blocked).toBe('delivery_unknown')
})

test('ownership, stale generation and idempotent replay checks protect existing registrations', async () => {
  await registerActivityRelay(userId, start)
  await expect(registerActivityRelay(crypto.randomUUID(), start)).rejects.toThrow('another user')
  expect(await registerActivityRelay(userId, start)).toEqual({ id: activationId })
  await expect(registerActivityRelay(userId, { ...start, bindingToken: token() })).rejects.toThrow('Stale')
  await unregisterActivityRelay(crypto.randomUUID(), activationId)
  expect(await row()).toBeDefined()
  await unregisterActivityRelay(userId, activationId)
  expect(await row()).toBeUndefined()
})
