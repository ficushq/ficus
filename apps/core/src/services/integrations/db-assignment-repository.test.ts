import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('bigbrain', 'github', 'notion')
import { expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import {
  db,
  integrationConnectionAssignments,
  integrationAuditEvents,
  integrationConnections,
  squads,
  users,
} from '../../db'
import { DbIntegrationConnectionRepository } from './db-connection-repository'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function createEnabled(repository: DbIntegrationConnectionRepository, providerKey = 'bigbrain') {
  const id = crypto.randomUUID()
  const connection = await repository.createPending({
    id,
    providerKey,
    adapterVersion: 1,
    displayName: `${providerKey} ${id}`,
    configuration: { version: 1, apiBase: 'https://provider.example' },
    credentialRef: `test:${id}`,
    materialRevision: crypto.randomUUID(),
  })
  await repository.enableValidated({
    id,
    materialRevision: connection.materialRevision,
    validation: { ok: true, grantedScopes: ['read'] },
    now: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })
  return connection
}

test('resolves only the assigned connection with squad runtime context', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Assignment ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const [assigned, unassigned] = await Promise.all([createEnabled(repository), createEnabled(repository)])
  try {
    expect(await repository.getAssigned(squad.id, 'bigbrain')).toBeNull()
    await repository.assign(squad.id, 'bigbrain', assigned.id)
    expect(await repository.getAssigned(squad.id, 'bigbrain')).toMatchObject({
      id: assigned.id,
      squadId: squad.id,
      providerKey: 'bigbrain',
    })
    expect((await repository.getAssigned(squad.id, 'bigbrain'))?.id).not.toBe(unassigned.id)
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [assigned.id, unassigned.id]))
  }
})

test('concurrent assignment upserts preserve one squad-provider binding', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Concurrent ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const [first, second] = await Promise.all([createEnabled(repository), createEnabled(repository)])
  try {
    await Promise.all([
      repository.assign(squad.id, 'bigbrain', first.id),
      repository.assign(squad.id, 'bigbrain', second.id),
    ])
    const rows = await db
      .select()
      .from(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.squadId, squad.id))
    expect(rows).toHaveLength(1)
    expect([first.id, second.id]).toContain(rows[0]!.connectionId)
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [first.id, second.id]))
  }
})

test('rejects provider mismatch and disabled selections', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Integrity ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const github = await createEnabled(repository, 'github')
  const disabled = await repository.createPending({
    id: crypto.randomUUID(),
    providerKey: 'bigbrain',
    adapterVersion: 1,
    displayName: `Disabled ${crypto.randomUUID()}`,
    configuration: {},
    credentialRef: 'test:disabled',
    materialRevision: crypto.randomUUID(),
  })
  try {
    await expect(repository.assign(squad.id, 'bigbrain', github.id)).rejects.toThrow('enabled provider connection')
    await expect(repository.assign(squad.id, 'bigbrain', disabled.id)).rejects.toThrow('enabled provider connection')
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, [github.id, disabled.id]))
  }
})

test('assignment changes write content-free squad and actor-attributed audits', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Audit ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com` })
    .returning()
  const connection = await createEnabled(repository)
  try {
    await repository.assign(squad.id, 'bigbrain', connection.id, { userId: user.id })
    await repository.unassign(squad.id, 'bigbrain', { userId: user.id })
    expect(
      await db
        .select({
          action: integrationAuditEvents.action,
          squadId: integrationAuditEvents.squadId,
          connectionId: integrationAuditEvents.connectionId,
          userId: integrationAuditEvents.userId,
        })
        .from(integrationAuditEvents)
        .where(eq(integrationAuditEvents.squadId, squad.id))
        .orderBy(integrationAuditEvents.createdAt)
    ).toEqual([
      { action: 'assignment_set', squadId: squad.id, connectionId: connection.id, userId: user.id },
      { action: 'assignment_unassign', squadId: squad.id, connectionId: connection.id, userId: user.id },
    ])
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(users).where(eq(users.id, user.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test('lifecycle mutations use authoritative assignment guards', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Guard ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const connection = await createEnabled(repository)
  try {
    await repository.assign(squad.id, 'bigbrain', connection.id)
    expect(await repository.disable(connection.id)).toMatchObject({
      status: 'in_use',
      usage: { squadCount: 1 },
    })
    expect(await repository.get(connection.id)).toMatchObject({ enabled: true })
    expect(await repository.delete(connection.id)).toMatchObject({ status: 'in_use' })
    expect(await repository.delete(connection.id, true)).toEqual({
      status: 'updated',
      value: { retiredCredentialRef: connection.credentialRef },
    })
    expect(await repository.getAssigned(squad.id, 'bigbrain')).toBeNull()
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})

test.each(['unassign-first', 'delete-first'] as const)(
  'confirmed deletion and unassignment use one lock order (%s)',
  async (order) => {
    const plain = new DbIntegrationConnectionRepository()
    const [squad] = await db
      .insert(squads)
      .values({ name: `Delete race ${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    const connection = await createEnabled(plain)
    await plain.assign(squad.id, 'bigbrain', connection.id)
    const locked = deferred()
    const release = deferred()
    const repository = new DbIntegrationConnectionRepository({
      ...(order === 'unassign-first'
        ? {
            afterAssignmentConnectionLock: async () => {
              locked.resolve()
              await release.promise
            },
          }
        : {
            afterLifecycleConnectionLock: async () => {
              locked.resolve()
              await release.promise
            },
          }),
    })
    try {
      let unassignSettled = false
      let deleteSettled = false
      const first =
        order === 'unassign-first'
          ? repository.unassign(squad.id, 'bigbrain').finally(() => (unassignSettled = true))
          : repository.delete(connection.id, true).finally(() => (deleteSettled = true))
      await locked.promise
      const second =
        order === 'unassign-first'
          ? plain.delete(connection.id, true).finally(() => (deleteSettled = true))
          : plain.unassign(squad.id, 'bigbrain').finally(() => (unassignSettled = true))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(order === 'unassign-first' ? deleteSettled : unassignSettled).toBe(false)
      release.resolve()
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect([firstResult, secondResult]).toContainEqual(expect.objectContaining({ status: 'updated' }))
      expect(await plain.get(connection.id)).toBeNull()
      expect(await plain.getAssigned(squad.id, 'bigbrain')).toBeNull()
      const audits = await db
        .select({ action: integrationAuditEvents.action })
        .from(integrationAuditEvents)
        .where(
          and(eq(integrationAuditEvents.squadId, squad.id), eq(integrationAuditEvents.action, 'assignment_unassign'))
        )
      expect(audits).toHaveLength(order === 'unassign-first' ? 1 : 0)
    } finally {
      release.resolve()
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
    }
  }
)

test('pool summaries expose only redacted lifecycle fields and usage', async () => {
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db
    .insert(squads)
    .values({ name: `Summary ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const connection = await createEnabled(repository)
  try {
    await repository.assign(squad.id, 'bigbrain', connection.id)
    expect(await repository.listPoolSummaries('bigbrain')).toEqual([
      {
        id: connection.id,
        providerKey: 'bigbrain',
        displayName: connection.displayName,
        enabled: true,
        healthState: 'healthy',
      },
    ])
    expect(await repository.usage(connection.id)).toEqual({
      squadCount: 1,
      squads: [{ id: squad.id, name: squad.name }],
    })
    expect(await repository.unassign(squad.id, 'bigbrain')).toBe(true)
    expect(await repository.usage(connection.id)).toEqual({ squadCount: 0, squads: [] })
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connection.id))
  }
})
