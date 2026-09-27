import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { db } from '../../db'
import { pairingCodes, users } from '../../db/schema'
import { claimPairingCode, createPairingCode } from './pairing'

describe('device pairing', () => {
  const userIds: string[] = []

  async function makeUser(email: string): Promise<string> {
    const [u] = await db.insert(users).values({ email }).returning({ id: users.id })
    userIds.push(u.id)
    return u.id
  }

  afterEach(async () => {
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds)) // cascades pairing codes + device tokens
    userIds.length = 0
  })

  it('claims a valid code → a device token + the bound user', async () => {
    const userId = await makeUser('pair-ok@test.local')
    const { code } = await createPairingCode(userId)
    const result = await claimPairingCode({ code, name: 'iPhone', platform: 'ios' })
    expect(result?.token.startsWith('ficus_dev_')).toBe(true)
    expect(result?.user.id).toBe(userId)
  })

  it('rejects a second claim of the same code (single-use)', async () => {
    const userId = await makeUser('pair-once@test.local')
    const { code } = await createPairingCode(userId)
    expect(await claimPairingCode({ code, name: 'A', platform: 'ios' })).not.toBeNull()
    expect(await claimPairingCode({ code, name: 'B', platform: 'ios' })).toBeNull()
  })

  it('rejects an expired code', async () => {
    const userId = await makeUser('pair-expired@test.local')
    const code = 'expired-test-code'
    await db.insert(pairingCodes).values({
      codeHash: createHash('sha256').update(code).digest('hex'),
      userId,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await claimPairingCode({ code, name: 'iPhone', platform: 'ios' })).toBeNull()
  })

  it('rejects an unknown code', async () => {
    expect(await claimPairingCode({ code: 'nope', name: 'iPhone', platform: 'ios' })).toBeNull()
  })
})
