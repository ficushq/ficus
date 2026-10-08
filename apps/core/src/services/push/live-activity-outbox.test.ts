import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { users, liveActivityRelayInstallations as rows } from '../../db/schema'
import { encrypt, decrypt, getEncryptionKey } from '../secrets/crypto'
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
function update(key: string = crypto.randomUUID(), generation = 2): CoreLiveActivityRegistration {
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
  const [other] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.test` })
    .returning()
  try {
    await expect(registerActivityRelay(other!.id, start)).rejects.toThrow('another user')
  } finally {
    await db.delete(users).where(eq(users.id, other!.id))
  }
  expect(await registerActivityRelay(userId, start)).toEqual({ id: activationId })
  await expect(registerActivityRelay(userId, { ...start, bindingToken: token() })).rejects.toThrow('Stale')
  await unregisterActivityRelay(crypto.randomUUID(), activationId)
  expect(await row()).toBeDefined()
  await unregisterActivityRelay(userId, activationId)
  expect(await row()).toBeUndefined()
})

test('an unadmitted start waits for old lifecycle cleanup without changing its delivery identity', async () => {
  await registerActivityRelay(userId, start)
  const events: RelayLiveActivitySend[] = []
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async (event) => {
      events.push(event)
      return { ok: false, reason: 'conflict', retryable: false }
    },
  })
  expect((await state()).blocked).toBeUndefined()
  expect((await state()).pending).toEqual(events[0])
  await due()
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async (event) => {
      events.push(event)
      return { ok: true, status: 'sent' }
    },
  })
  expect(events[1]).toEqual(events[0])
  expect((await state()).pending).toBeUndefined()
})

test('uncertain updates request lifecycle replacement rather than treating token rotation as delivery proof', async () => {
  const registration = update()
  await registerActivityRelay(userId, registration)
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => ({ ok: false, reason: 'delivery_unknown', retryable: false }),
  })
  expect(await registerActivityRelay(userId, registration)).toEqual({ id: activationId, resetRequired: true })
  expect(await registerActivityRelay(userId, { ...registration, generation: 3 })).toEqual({
    id: activationId,
    resetRequired: true,
  })
  expect((await state()).blocked).toBe('delivery_unknown')
  expect(await registerActivityRelay(userId, update(crypto.randomUUID(), 4))).toEqual({ id: activationId })
  expect((await state()).blocked).toBeUndefined()
})
test('device observation can resolve an uncertain start without replacing its lifecycle', async () => {
  await registerActivityRelay(userId, start)
  let key = ''
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async (event) => {
      key = event.activityKey
      return { ok: false, reason: 'delivery_unknown', retryable: false }
    },
  })
  expect(await registerActivityRelay(userId, update(key))).toEqual({ id: activationId })
  expect((await state()).blocked).toBeUndefined()
})

test('user erasure retains only a content-free end and retries it without reading a user snapshot', async () => {
  const { User } = await import('../../entities/User')
  await registerActivityRelay(userId, update())
  await pumpActivityRelay({ snapshot: async () => active, send: async () => ({ ok: true, status: 'sent' }) })
  await (await User.findById(userId))!.delete()
  expect((await row()).userId).toBeNull()
  const retired = await state()
  expect(retired.pending.event).toBe('end')
  expect(retired.start).toBeUndefined()
  expect(retired.update).toBeUndefined()
  expect(retired.lastState).toBeUndefined()
  expect(retired.pending.contentState).toBeUndefined()
  const events: RelayLiveActivitySend[] = []
  const snapshot = async () => {
    throw new Error('deleted user snapshot must not be loaded')
  }
  await pumpActivityRelay({
    cleanupOnly: true,
    snapshot,
    send: async (event) => {
      events.push(event)
      return { ok: false, reason: 'relay_unavailable', retryable: true }
    },
  })
  await due()
  await pumpActivityRelay({
    cleanupOnly: true,
    snapshot,
    send: async (event) => {
      events.push(event)
      return { ok: true, status: 'sent' }
    },
  })
  expect(events).toEqual([retired.pending, retired.pending])
  expect(await row()).toBeUndefined()
})
test('deletion invalidates a worker snapshot lease before it can send cached content', async () => {
  const { User } = await import('../../entities/User')
  await registerActivityRelay(userId, update())
  let resolveSnapshot!: () => void
  let snapshotStarted!: () => void
  const started = new Promise<void>((resolve) => {
    snapshotStarted = resolve
  })
  let sent = 0
  const pump = pumpActivityRelay({
    snapshot: async () => {
      snapshotStarted()
      await new Promise<void>((resolve) => {
        resolveSnapshot = resolve
      })
      return active
    },
    send: async () => {
      sent++
      return { ok: true, status: 'sent' }
    },
  })
  await started
  await (await User.findById(userId))!.delete()
  resolveSnapshot()
  await pump
  expect(sent).toBe(0)
  expect((await state()).pending.event).toBe('end')
  await expect(registerActivityRelay(userId, start)).rejects.toThrow('User not found')
})
test('cleanup-only pumps ignore live users; deleted start-only registrations cannot restart activities', async () => {
  const { User } = await import('../../entities/User')
  await registerActivityRelay(userId, start)
  expect(await pumpActivityRelay({ cleanupOnly: true })).toBe(false)
  await (await User.findById(userId))!.delete()
  expect(await row()).toBeUndefined()
})

test('orphan cleanup expires without sending and corrupt state never blocks user erasure', async () => {
  const { User } = await import('../../entities/User')
  await registerActivityRelay(userId, update())
  await (await User.findById(userId))!.delete()
  const retired = await state()
  retired.cleanupExpiresAt = Date.now() - 1
  await db
    .update(rows)
    .set({ stateEnc: JSON.stringify(encrypt(JSON.stringify(retired), getEncryptionKey())) })
    .where(eq(rows.activationId, activationId))
  let sends = 0
  await pumpActivityRelay({
    cleanupOnly: true,
    send: async () => {
      sends++
      return { ok: true, status: 'sent' }
    },
  })
  expect(sends).toBe(0)
  expect(await row()).toBeUndefined()
  await db.insert(users).values({ id: userId, email: `${crypto.randomUUID()}@example.test` })
  await registerActivityRelay(userId, update())
  await db.update(rows).set({ stateEnc: 'unreadable' }).where(eq(rows.activationId, activationId))
  await (await User.findById(userId))!.delete()
  expect(await row()).toBeUndefined()
})

test('aggregate sources heartbeat unchanged and empty snapshots without ending other servers', async () => {
  const aggregateKey = crypto.randomUUID()
  await registerActivityRelay(userId, { ...update(), aggregateKey })
  const events: RelayLiveActivitySend[] = []
  const send = async (event: RelayLiveActivitySend) => {
    events.push(event)
    return { ok: true as const, status: 'queued' as const }
  }
  for (const snapshot of [active, active, empty, empty]) {
    await due()
    await pumpActivityRelay({ snapshot: async () => snapshot, send })
    expect((await state()).pending).toBeUndefined()
    expect((await state()).ended).toBe(false)
  }
  expect(events.map((event) => event.event)).toEqual(['update', 'update', 'update', 'update'])
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
  expect(events[2]).toMatchObject({ contentState: empty })
  expect(events[3]).toMatchObject({ contentState: empty })
  // Turning off a source still retires it, even though an ordinary empty snapshot does not.
  const { prepareActivityRelayUserDeletion } = await import('./live-activity-outbox')
  await db.transaction((tx) => prepareActivityRelayUserDeletion(tx, userId))
  await due()
  await pumpActivityRelay({ send })
  expect(events.at(-1)?.event).toBe('end')
  expect(await row()).toBeUndefined()
})

test('aggregate privacy change replaces a pending contribution with fresh empty state', async () => {
  await registerActivityRelay(userId, { ...update(), aggregateKey: crypto.randomUUID() })
  await pumpActivityRelay({
    snapshot: async () => active,
    send: async () => ({ ok: false, reason: 'relay_unavailable', retryable: true }),
  })
  await due()
  await pumpActivityRelay({
    snapshot: async () => empty,
    send: async (event) => {
      expect(event).toMatchObject({ event: 'update', sequence: 2, contentState: empty })
      return { ok: true, status: 'queued' }
    },
  })
  expect((await state()).lastState).toEqual(empty)
})

test('aggregate push-to-start contributions stay fresh before native update registration arrives', async () => {
  await registerActivityRelay(userId, { ...start, aggregateKey: crypto.randomUUID() })
  const events: RelayLiveActivitySend[] = []
  for (const snapshot of [empty, active, active, empty]) {
    await due()
    await pumpActivityRelay({
      snapshot: async () => snapshot,
      send: async (event) => {
        events.push(event)
        return { ok: true, status: 'queued' }
      },
    })
  }
  expect(events.map((event) => event.event)).toEqual(['start', 'start', 'start', 'start'])
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
  expect(new Set(events.map((event) => event.activityKey)).size).toBe(1)
  expect(events[3]).toMatchObject({ contentState: empty })
})

test('deleting an aggregate start-only source retires its contribution without native observation', async () => {
  await registerActivityRelay(userId, { ...start, aggregateKey: crypto.randomUUID() })
  await pumpActivityRelay({ snapshot: async () => active, send: async () => ({ ok: true, status: 'queued' }) })
  const { prepareActivityRelayUserDeletion } = await import('./live-activity-outbox')
  await db.transaction((tx) => prepareActivityRelayUserDeletion(tx, userId))
  await due()
  await pumpActivityRelay({
    send: async (event) => {
      expect(event).toMatchObject({ event: 'end', sequence: 2, bindingToken: start.bindingToken })
      return { ok: true, status: 'queued' }
    },
  })
  expect(await row()).toBeUndefined()
})
