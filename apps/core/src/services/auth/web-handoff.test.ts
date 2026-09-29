import { afterEach, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, users, webHandoffs } from '../../db'
import { cleanupTestRbac, createTestUser } from '../../test-utils'
import { cleanupExpiredAuthData } from './cleanup'
import { createDeviceToken, revokeDeviceToken } from './device-tokens'
import { consumeWebHandoff, createWebHandoff, WEB_HANDOFF_TTL_MS } from './web-handoff'

const PREFIX = 'web-handoff-test'

async function pairedPhone() {
  const user = await createTestUser({ prefix: PREFIX })
  const device = await createDeviceToken({ userId: user.id, name: 'iPhone', platform: 'ios' })
  return { user, device }
}

describe('web handoff', () => {
  afterEach(async () => {
    await cleanupTestRbac(PREFIX)
  })

  it('mints a one-minute code that works once, for the minting device', async () => {
    const { user, device } = await pairedPhone()
    const now = new Date()
    const { code, expiresAt } = await createWebHandoff(user.id, device.id, now)
    expect(code.startsWith('ficus_wh_')).toBe(true)
    expect(expiresAt.getTime() - now.getTime()).toBe(WEB_HANDOFF_TTL_MS)

    expect(await consumeWebHandoff(code)).toEqual({ userId: user.id, deviceTokenId: device.id })
    expect(await consumeWebHandoff(code)).toBeNull()
  })

  it('a code racing itself is used once', async () => {
    const { user, device } = await pairedPhone()
    const { code } = await createWebHandoff(user.id, device.id)
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeWebHandoff(code)))
    expect(results.filter(Boolean)).toEqual([{ userId: user.id, deviceTokenId: device.id }])
  })

  it('stores only a hash of the code', async () => {
    const { user, device } = await pairedPhone()
    const { code } = await createWebHandoff(user.id, device.id)
    const rows = await db.select().from(webHandoffs).where(eq(webHandoffs.userId, user.id))
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(code)
  })

  it('rejects an expired code', async () => {
    const { user, device } = await pairedPhone()
    const { code } = await createWebHandoff(user.id, device.id, new Date(Date.now() - WEB_HANDOFF_TTL_MS - 1000))
    expect(await consumeWebHandoff(code)).toBeNull()
  })

  it('rejects a code whose device was unpaired or whose user was disabled', async () => {
    const { user, device } = await pairedPhone()
    const unpaired = await createWebHandoff(user.id, device.id)
    await revokeDeviceToken(user.id, device.id)
    expect(await consumeWebHandoff(unpaired.code)).toBeNull()

    const other = await pairedPhone()
    const disabled = await createWebHandoff(other.user.id, other.device.id)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, other.user.id))
    expect(await consumeWebHandoff(disabled.code)).toBeNull()
  })

  it('rejects other kinds of token and unknown codes', async () => {
    const { device } = await pairedPhone()
    expect(await consumeWebHandoff(device.token)).toBeNull()
    expect(await consumeWebHandoff('ficus_wh_does-not-exist')).toBeNull()
  })

  it('cleanup drops used and expired codes but keeps fresh ones', async () => {
    const { user, device } = await pairedPhone()
    const used = await createWebHandoff(user.id, device.id)
    await consumeWebHandoff(used.code)
    await createWebHandoff(user.id, device.id, new Date(Date.now() - WEB_HANDOFF_TTL_MS - 1000))
    const fresh = await createWebHandoff(user.id, device.id)
    await cleanupExpiredAuthData()
    const left = await db.select().from(webHandoffs).where(eq(webHandoffs.userId, user.id))
    expect(left).toHaveLength(1)
    expect(await consumeWebHandoff(fresh.code)).toEqual({ userId: user.id, deviceTokenId: device.id })
  })
})
