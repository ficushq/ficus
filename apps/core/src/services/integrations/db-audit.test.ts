import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, integrationAuditEvents, squads } from '../../db'
import { DbIntegrationAuditRecorder } from './db-audit'

test('persists global lifecycle audit without squad attribution', async () => {
  const at = new Date(0)
  await new DbIntegrationAuditRecorder().record({
    action: 'connection_create',
    outcome: 'succeeded',
    at,
  })
  const [row] = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.createdAt, at)).limit(1)
  expect(row).toMatchObject({ squadId: null, action: 'connection_create', outcome: 'succeeded' })
  await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.id, row!.id))
})

test('persists only bounded content-free audit metadata', async () => {
  const [squad] = await db.insert(squads).values({ name: 'Integration audit', purpose: 'test' }).returning()
  try {
    await new DbIntegrationAuditRecorder().record({
      squadId: squad.id,
      action: 'connection_enable',
      outcome: 'failed',
      code: 'remote body must not persist !',
      recordCount: 2,
      byteCount: 10,
      at: new Date(0),
    })
    const [row] = await db
      .select()
      .from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.squadId, squad.id))
      .limit(1)
    expect(row).toMatchObject({
      squadId: squad.id,
      action: 'connection_enable',
      outcome: 'failed',
      code: 'invalid_code',
      recordCount: 2,
      byteCount: 10,
    })
    expect(JSON.stringify(row)).not.toContain('remote body')
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
  }
})

test('persists the literal actor and a content-free target', async () => {
  const requestId = crypto.randomUUID()
  const vaultId = crypto.randomUUID()
  await new DbIntegrationAuditRecorder().record({
    actorKey: `user:${requestId}`,
    targetKind: 'managed_bigbrain_vault',
    targetId: vaultId,
    action: 'managed_vault_owner_invite',
    outcome: 'succeeded',
    requestId,
    at: new Date(0),
  })
  const [row] = await db
    .select()
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.requestId, requestId))
    .limit(1)
  expect(row).toMatchObject({
    actorKey: `user:${requestId}`,
    targetKind: 'managed_bigbrain_vault',
    targetId: vaultId,
    action: 'managed_vault_owner_invite',
  })
  await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.id, row!.id))
})
