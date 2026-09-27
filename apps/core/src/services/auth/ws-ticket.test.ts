import { describe, it, expect, afterEach } from 'bun:test'
import { createHash } from 'crypto'
import { eq } from 'drizzle-orm'
import { db, users, wsTickets } from '../../db'
import { createTestUser, cleanupTestRbac } from '../../test-utils'
import { createDeviceToken, revokeDeviceToken } from './device-tokens'
import { createWsTicket, consumeWsTicket, pruneWsTickets } from './ws-ticket'

const PREFIX = 'ws-ticket-test'

describe('ws-ticket', () => {
  afterEach(async () => {
    await cleanupTestRbac(PREFIX)
  })

  it('mints a ticket that consumes once to the minting user', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const ticket = await createWsTicket(user.id)
    expect(typeof ticket).toBe('string')
    expect(await consumeWsTicket(ticket)).toEqual({
      identity: { type: 'user', userId: user.id },
      deviceTokenId: null,
    })
    // single-use: a second consume fails closed
    expect(await consumeWsTicket(ticket)).toBeNull()
  })

  it('retains device provenance and rejects a revoked source credential', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const device = await createDeviceToken({ userId: user.id, name: 'CLI', platform: 'cli' })
    const validTicket = await createWsTicket(user.id, device.id)

    expect(await consumeWsTicket(validTicket)).toEqual({
      identity: { type: 'user', userId: user.id },
      deviceTokenId: device.id,
    })

    const revokedTicket = await createWsTicket(user.id, device.id)
    await revokeDeviceToken(user.id, device.id)
    expect(await consumeWsTicket(revokedTicket)).toBeNull()
  })

  it('rejects a ticket when its user is disabled', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const ticket = await createWsTicket(user.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.id))
    expect(await consumeWsTicket(ticket)).toBeNull()
  })

  it('rejects an unknown ticket', async () => {
    expect(await consumeWsTicket('ficus_wst_does-not-exist')).toBeNull()
  })

  it('rejects an expired ticket', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const ticket = await createWsTicket(user.id)
    const hash = createHash('sha256').update(ticket).digest('hex')
    await db
      .update(wsTickets)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(wsTickets.tokenHash, hash))
    expect(await consumeWsTicket(ticket)).toBeNull()
  })

  it('prune removes used and expired tickets but keeps fresh ones', async () => {
    const user = await createTestUser({ prefix: PREFIX })
    const used = await createWsTicket(user.id)
    await consumeWsTicket(used)
    await createWsTicket(user.id) // fresh, unused
    await pruneWsTickets()
    const rows = await db.select().from(wsTickets).where(eq(wsTickets.userId, user.id))
    expect(rows.length).toBe(1)
    expect(rows[0].usedAt).toBeNull()
  })
})
