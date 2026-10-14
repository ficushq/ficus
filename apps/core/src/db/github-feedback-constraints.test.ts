import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db } from './index'
import * as schema from './schema'

async function ownedRows() {
  const userIds = [crypto.randomUUID(), crypto.randomUUID()]
  const squadIds = [crypto.randomUUID(), crypto.randomUUID()]
  await db.insert(schema.users).values(userIds.map((id) => ({ id, email: `${id}@feedback.test` })))
  await db.insert(schema.squads).values(squadIds.map((id) => ({ id, name: 'Feedback test', purpose: 'Test' })))
  return {
    userIds,
    squadIds,
    async close() {
      await db.delete(schema.squads).where(inArray(schema.squads.id, squadIds))
      await db.delete(schema.users).where(inArray(schema.users.id, userIds))
    },
  }
}

test('one provider account cannot belong to two active Ficus users, but unlink frees ownership', async () => {
  expect(schema.githubPersonalIdentities).toBeDefined()
  const h = await ownedRows()
  const identity = schema.githubPersonalIdentities
  try {
    await db.insert(identity).values({ userId: h.userIds[0], accountId: '101', login: 'alice' })
    await expect(
      db.insert(identity).values({ userId: h.userIds[1], accountId: '101', login: 'renamed' }).execute()
    ).rejects.toThrow()
    await db.update(identity).set({ unlinkedAt: new Date(), generation: 1 }).where(eq(identity.userId, h.userIds[0]))
    await db.insert(identity).values({ userId: h.userIds[1], accountId: '101', login: 'renamed' }).execute()
    const active = await db.select().from(identity).where(eq(identity.userId, h.userIds[1]))
    expect(active).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('manual trust is unique per squad and cannot accept malformed or organization IDs', async () => {
  expect(schema.githubTrustedAuthors).toBeDefined()
  const h = await ownedRows()
  const trusted = schema.githubTrustedAuthors
  try {
    const row = {
      squadId: h.squadIds[0],
      accountId: '202',
      login: 'helper[bot]',
      accountType: 'Bot' as const,
      addedByUserId: h.userIds[0],
    }
    await db.insert(trusted).values(row)
    await expect(
      db
        .insert(trusted)
        .values({ ...row, login: 'renamed' })
        .execute()
    ).rejects.toThrow()
    await db.insert(trusted).values({ ...row, squadId: h.squadIds[1] })
    for (const accountId of ['0', '01', '9007199254740992']) {
      await expect(
        db
          .insert(trusted)
          .values({ ...row, accountId })
          .execute()
      ).rejects.toThrow()
    }
    await expect(
      db
        .insert(trusted)
        .values({ ...row, accountId: '203', accountType: 'Organization' as 'User' })
        .execute()
    ).rejects.toThrow()
  } finally {
    await h.close()
  }
})
