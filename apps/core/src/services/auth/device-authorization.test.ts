import { afterEach, afterAll, describe, expect, it, test } from 'bun:test'
import { createHash } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { deviceAuthorizations, users } from '../../db/schema'
import { cleanupTestRbac, createTestUser } from '../../test-utils/rbac'
import { listDeviceTokens } from './device-tokens'
import {
  approveDeviceAuthorization,
  createDeviceAuthorization,
  DEVICE_AUTH_POLL_INTERVAL_SECONDS,
  DEVICE_AUTH_TTL_MS,
  exchangeDeviceAuthorization,
  inspectDeviceAuthorization,
} from './device-authorization'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const prefix = 'device-auth-service'

describe('device authorization grants', () => {
  const userIds: string[] = []
  const grantHashes: string[] = []
  async function makeUser(email: string) {
    const [user] = await db.insert(users).values({ email }).returning({ id: users.id })
    userIds.push(user.id)
    return user.id
  }
  afterEach(async () => {
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds))
    if (grantHashes.length) {
      await db.delete(deviceAuthorizations).where(inArray(deviceAuthorizations.deviceCodeHash, grantHashes))
    }
    userIds.length = 0
    grantHashes.length = 0
  })

  it('creates distinct high-entropy capabilities and stores only their hashes', async () => {
    const before = Date.now()
    const grant = await createDeviceAuthorization({ name: 'Tau CLI on atlas' })
    grantHashes.push(hash(grant.deviceCode))
    expect(Buffer.from(grant.deviceCode, 'base64url')).toHaveLength(32)
    expect(Buffer.from(grant.verificationCode, 'base64url')).toHaveLength(32)
    expect(grant.deviceCode).not.toBe(grant.verificationCode)
    expect(grant.expiresAt.getTime()).toBeGreaterThanOrEqual(before + DEVICE_AUTH_TTL_MS)
    const [row] = await db
      .select()
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.deviceCodeHash, hash(grant.deviceCode)))
    expect(row.deviceCodeHash).toBe(hash(grant.deviceCode))
    expect(row.verificationCodeHash).toBe(hash(grant.verificationCode))
    expect(JSON.stringify(row)).not.toContain(grant.deviceCode)
    expect(JSON.stringify(row)).not.toContain(grant.verificationCode)
  })

  it('requires approval and exchanges an approved grant exactly once', async () => {
    const userId = await makeUser('device-auth@test.local')
    const grant = await createDeviceAuthorization({ name: 'Tau CLI on atlas' })
    grantHashes.push(hash(grant.deviceCode))
    expect(await inspectDeviceAuthorization(grant.verificationCode)).toMatchObject({
      name: 'Tau CLI on atlas',
      platform: 'cli',
    })
    expect(await exchangeDeviceAuthorization(grant.deviceCode)).toEqual({
      status: 'pending',
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
    })
    expect(await approveDeviceAuthorization(grant.verificationCode, userId)).toBe(true)
    await db
      .update(deviceAuthorizations)
      .set({ lastPolledAt: null })
      .where(eq(deviceAuthorizations.deviceCodeHash, hash(grant.deviceCode)))
    const result = await exchangeDeviceAuthorization(grant.deviceCode)
    expect(result.status).toBe('authorized')
    if (result.status === 'authorized') expect(result.token).toStartWith('ficus_dev_')
    expect(await exchangeDeviceAuthorization(grant.deviceCode)).toEqual({ status: 'invalid' })
    expect(await approveDeviceAuthorization(grant.verificationCode, userId)).toBe(false)
  })

  it('rejects expired grants and durably throttles pending polling', async () => {
    const grant = await createDeviceAuthorization({ name: 'CLI' })
    grantHashes.push(hash(grant.deviceCode))
    expect((await exchangeDeviceAuthorization(grant.deviceCode)).status).toBe('pending')
    expect(await exchangeDeviceAuthorization(grant.deviceCode)).toEqual({
      status: 'slow_down',
      interval: DEVICE_AUTH_POLL_INTERVAL_SECONDS,
    })
    await db
      .update(deviceAuthorizations)
      .set({ expiresAt: new Date(0) })
      .where(eq(deviceAuthorizations.deviceCodeHash, hash(grant.deviceCode)))
    expect(await inspectDeviceAuthorization(grant.verificationCode)).toBeNull()
    expect(await exchangeDeviceAuthorization(grant.deviceCode)).toEqual({ status: 'invalid' })
  })

  afterAll(() => cleanupTestRbac(prefix))

  test('a desktop grant mints a desktop device token and defaults its name', async () => {
    const user = await createTestUser({ prefix })
    const grant = await createDeviceAuthorization({ name: '  ', platform: 'desktop' })
    grantHashes.push(hash(grant.deviceCode))
    expect(await approveDeviceAuthorization(grant.verificationCode, user.id)).toBe(true)
    const result = await exchangeDeviceAuthorization(grant.deviceCode)
    expect(result.status).toBe('authorized')
    const devices = await listDeviceTokens(user.id)
    expect(devices.find((d) => d.id === (result as { deviceId: string }).deviceId)).toMatchObject({
      name: 'Tau Desktop',
      platform: 'desktop',
    })
  })

  test('an unspecified platform stays a CLI grant', async () => {
    const grant = await createDeviceAuthorization({ name: '' })
    grantHashes.push(hash(grant.deviceCode))
    expect(await inspectDeviceAuthorization(grant.verificationCode)).toMatchObject({ name: 'Tau CLI', platform: 'cli' })
  })
})
