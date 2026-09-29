import { afterEach, describe, expect, it, mock } from 'bun:test'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { deviceTokens, users } from '../../db/schema'
import { createHash } from 'node:crypto'
import {
  DEVICE_TOKEN_PREFIX,
  createDeviceToken,
  findActiveDeviceTokenIds,
  listDeviceTokens,
  resolveDeviceToken,
  revokeDeviceToken,
} from './device-tokens'
import { resolveToken, resolveTokenContext } from './resolve-token'
import { DeviceConnectionRegistry, deviceConnectionRegistry } from './device-connection-registry'
import { localDeviceTokenEvents } from './device-token-events'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function waitForBlockedDeviceTokenUpdate(): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const rows = await db.execute<{ blocked: number }>(sql`
      SELECT count(*)::int AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query ILIKE 'update %device_tokens%'
    `)
    if (rows[0]?.blocked > 0) return
    await Bun.sleep(5)
  }
  throw new Error('competing device-token UPDATE never reached the PostgreSQL row lock')
}

describe('device tokens', () => {
  const userIds: string[] = []

  async function makeUser(email: string): Promise<string> {
    const [u] = await db.insert(users).values({ email }).returning({ id: users.id })
    userIds.push(u.id)
    return u.id
  }

  afterEach(async () => {
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds)) // cascades device tokens
    userIds.length = 0
  })

  it('creates a token that resolves to the owning user; revoking invalidates it', async () => {
    const userId = await makeUser('dt-resolve@test.local')
    const { token, id } = await createDeviceToken({ userId, name: 'iPhone', platform: 'ios' })
    expect(DEVICE_TOKEN_PREFIX).toBe('ficus_dev_')
    expect(token.startsWith('ficus_dev_')).toBe(true)

    expect(await resolveDeviceToken(token)).toEqual({ id, userId })
    // Integration: resolveToken retains its compatibility identity-only result,
    // while resolveTokenContext preserves the credential provenance.
    expect(await resolveToken(token)).toEqual({ type: 'user', userId })
    expect(await resolveTokenContext(token)).toEqual({
      identity: { type: 'user', userId },
      deviceTokenId: id,
    })

    expect(await revokeDeviceToken(userId, id)).toBe(true)
    expect(await resolveDeviceToken(token)).toBeNull()
    expect(await resolveToken(token)).toBeNull()
  })

  it('device tokens with the old_dev_ prefix are rejected (no dual-accept)', async () => {
    expect(await resolveDeviceToken('old_dev_' + 'x'.repeat(43))).toBeNull()
  })

  it('a live old_dev_ row no longer authenticates anywhere', async () => {
    const userId = await makeUser('dt-legacy@test.local')
    const legacy = 'old_dev_' + 'y'.repeat(43)
    await db.insert(deviceTokens).values({ userId, tokenHash: tokenHash(legacy), name: 'Old CLI', platform: 'cli' })

    expect(await resolveDeviceToken(legacy)).toBeNull()
    expect(await resolveToken(legacy)).toBeNull()
    expect(await resolveTokenContext(legacy)).toBeNull()
  })

  it('never resolves a device row whose token only resembles the device prefix', async () => {
    const userId = await makeUser('dt-lookalike@test.local')
    const secret = 'z'.repeat(43)
    for (const raw of [`ficus_devx${secret}`, `ficus_de_${secret}`, `ficus_sys_${secret}`, `FICUS_DEV_${secret}`]) {
      await db
        .insert(deviceTokens)
        .values({ userId, tokenHash: tokenHash(raw), name: raw.slice(0, 12), platform: 'cli' })
      expect(await resolveDeviceToken(raw)).toBeNull()
      expect(await resolveTokenContext(raw)).toBeNull()
    }
  })

  it('committed revoke closes only locally attached connections for that DB token', async () => {
    const userId = await makeUser('dt-local-close@test.local')
    const deviceA = await createDeviceToken({ userId, name: 'A', platform: 'cli' })
    const deviceB = await createDeviceToken({ userId, name: 'B', platform: 'cli' })
    const closeA = mock(() => {})
    const closeB = mock(() => {})
    const handleA = await deviceConnectionRegistry.register(deviceA.id, closeA)
    const handleB = await deviceConnectionRegistry.register(deviceB.id, closeB)

    await revokeDeviceToken(userId, deviceA.id)

    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).not.toHaveBeenCalled()
    handleA.dispose()
    handleB.dispose()
  })

  it('waits for peer revocation dispatch after the durable revoke commits', async () => {
    const userId = await makeUser('dt-peer-barrier@test.local')
    const device = await createDeviceToken({ userId, name: 'Peer', platform: 'cli' })
    const localClose = mock(() => {})
    const localHandle = await deviceConnectionRegistry.register(device.id, localClose)
    const dispatchStarted = deferred()
    const peerAcknowledged = deferred()

    const updateLocked = deferred()
    const releaseUpdate = deferred()
    let heldUpdate: Promise<void> | undefined
    let revoking: Promise<boolean> | undefined
    let completed = false

    try {
      heldUpdate = db.transaction(async (tx) => {
        await tx.update(deviceTokens).set({ lastUsedAt: new Date() }).where(eq(deviceTokens.id, device.id))
        updateLocked.resolve()
        await releaseUpdate.promise
      })
      await updateLocked.promise

      revoking = revokeDeviceToken(userId, device.id, {
        publishRevocation: async (id) => {
          expect(id).toBe(device.id)
          localDeviceTokenEvents.publish(id)
          dispatchStarted.resolve()
          await peerAcknowledged.promise
        },
      }).then((result) => {
        completed = true
        return result
      })

      await waitForBlockedDeviceTokenUpdate()
      expect(localClose).not.toHaveBeenCalled()
      expect(completed).toBe(false)
      releaseUpdate.resolve()
      await heldUpdate

      // Peer publication starts only after the durable UPDATE and synchronous
      // local termination. Its deferred acknowledgement pins revoke completion.
      await dispatchStarted.promise
      const [row] = await db
        .select({ revokedAt: deviceTokens.revokedAt })
        .from(deviceTokens)
        .where(eq(deviceTokens.id, device.id))
      expect(row?.revokedAt).toBeInstanceOf(Date)
      expect(localClose).toHaveBeenCalledTimes(1)
      expect(deviceConnectionRegistry.connectionCount(device.id)).toBe(0)
      expect(completed).toBe(false)

      peerAcknowledged.resolve()
      expect(await revoking).toBe(true)
      expect(completed).toBe(true)
    } finally {
      // Always release both causal gates and settle their work before allowing
      // database fixture cleanup.
      releaseUpdate.resolve()
      peerAcknowledged.resolve()
      await Promise.allSettled([heldUpdate, revoking].filter((work) => work !== undefined))
      localHandle.dispose()
    }
  })

  it('a fresh process registry rejects an already-revoked authoritative row', async () => {
    const userId = await makeUser('dt-restart@test.local')
    const device = await createDeviceToken({ userId, name: 'Restart', platform: 'cli' })
    await revokeDeviceToken(userId, device.id)
    const freshRegistry = new DeviceConnectionRegistry(findActiveDeviceTokenIds)
    const close = mock(() => {})

    const handle = await freshRegistry.register(device.id, close)

    expect(handle.isActive()).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not resolve a disabled user’s token', async () => {
    const userId = await makeUser('dt-disabled@test.local')
    const { token } = await createDeviceToken({ userId, name: 'iPhone', platform: 'ios' })
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId))
    expect(await resolveDeviceToken(token)).toBeNull()
  })

  it('finds only distinct active device IDs owned by enabled users', async () => {
    const enabled = await makeUser('dt-active-enabled@test.local')
    const disabled = await makeUser('dt-active-disabled@test.local')
    const active = await createDeviceToken({ userId: enabled, name: 'Active', platform: 'cli' })
    const revoked = await createDeviceToken({ userId: enabled, name: 'Revoked', platform: 'cli' })
    const disabledOwner = await createDeviceToken({ userId: disabled, name: 'Disabled', platform: 'cli' })
    await revokeDeviceToken(enabled, revoked.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled))

    expect(await findActiveDeviceTokenIds([active.id, active.id, revoked.id, disabledOwner.id])).toEqual(
      new Set([active.id])
    )
    expect(await findActiveDeviceTokenIds([])).toEqual(new Set())
  })

  it('orders concurrent resolve-first and revoke-first statements by the token row lock', async () => {
    const userId = await makeUser('dt-ordering@test.local')

    const resolveFirst = await createDeviceToken({ userId, name: 'Resolve first', platform: 'cli' })
    const releaseResolve = deferred()
    const resolveLocked = deferred()
    const resolving = db.transaction(async (tx) => {
      const [row] = await tx
        .update(deviceTokens)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(deviceTokens.tokenHash, tokenHash(resolveFirst.token)), isNull(deviceTokens.revokedAt)))
        .returning({ id: deviceTokens.id })
      resolveLocked.resolve()
      await releaseResolve.promise
      return row
    })
    await resolveLocked.promise
    const revoking = revokeDeviceToken(userId, resolveFirst.id)
    await waitForBlockedDeviceTokenUpdate()
    releaseResolve.resolve()
    expect(await resolving).toEqual({ id: resolveFirst.id })
    expect(await revoking).toBe(true)
    expect(await resolveDeviceToken(resolveFirst.token)).toBeNull()

    const revokeFirst = await createDeviceToken({ userId, name: 'Revoke first', platform: 'cli' })
    const before = await db
      .select({ lastUsedAt: deviceTokens.lastUsedAt })
      .from(deviceTokens)
      .where(eq(deviceTokens.id, revokeFirst.id))
    const releaseRevoke = deferred()
    const revokeLocked = deferred()
    const heldRevoke = db.transaction(async (tx) => {
      await tx.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, revokeFirst.id))
      revokeLocked.resolve()
      await releaseRevoke.promise
    })
    await revokeLocked.promise
    const blockedResolve = resolveDeviceToken(revokeFirst.token)
    await waitForBlockedDeviceTokenUpdate()
    releaseRevoke.resolve()
    await heldRevoke
    expect(await blockedResolve).toBeNull()
    const [after] = await db
      .select({ lastUsedAt: deviceTokens.lastUsedAt })
      .from(deviceTokens)
      .where(eq(deviceTokens.id, revokeFirst.id))
    expect(after.lastUsedAt).toEqual(before[0].lastUsedAt)
  })

  it('lists only the user’s active (non-revoked) devices', async () => {
    const userId = await makeUser('dt-list@test.local')
    const a = await createDeviceToken({ userId, name: 'A', platform: 'ios' })
    await createDeviceToken({ userId, name: 'B', platform: 'android' })
    await revokeDeviceToken(userId, a.id)
    const list = await listDeviceTokens(userId)
    expect(list.map((d) => d.name)).toEqual(['B'])
  })

  it('revokeDeviceToken only affects the owner’s devices', async () => {
    const owner = await makeUser('dt-owner@test.local')
    const other = await makeUser('dt-other@test.local')
    const { id } = await createDeviceToken({ userId: owner, name: 'Owned', platform: 'ios' })
    expect(await revokeDeviceToken(other, id)).toBe(false)
  })
})
