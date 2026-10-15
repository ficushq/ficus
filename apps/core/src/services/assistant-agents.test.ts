import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import {
  agents,
  assistantConversationAgents,
  assistantConversations,
  db,
  squads,
  setDatabaseQueryObserverForTest,
} from '../db'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createPostgresConnection, getConnectionString } from '../db/connection'
import * as schema from '../db/schema'
import { Agent } from '../entities/Agent'
import { eventEmitter } from '../lib/infra/event-emitter'
import { Squad } from '../entities/Squad'
import { cleanupTestRbac, createTestUser } from '../test-utils'
import { ASSISTANT_TASK_CONSULTANT_NAME } from '@ficus/shared'
import { findOwningConversation, resolveOwnedAgent, isAssistantDelegate } from './assistant-agents'

const prefix = `assistant-agents-${randomUUID()}`
const conversationIds: string[] = []
const squadIds: string[] = []

async function conversation() {
  const owner = await createTestUser({ prefix })
  const [row] = await db.insert(assistantConversations).values({ ownerUserId: owner.id }).returning()
  conversationIds.push(row!.id)
  return row!
}

async function agentIdsFor(conversationId: string) {
  return db
    .select({ squadId: assistantConversationAgents.squadId, agentId: assistantConversationAgents.agentId })
    .from(assistantConversationAgents)
    .where(eq(assistantConversationAgents.conversationId, conversationId))
}

afterEach(async () => {
  const rows = conversationIds.length
    ? await db
        .select({ agentId: assistantConversationAgents.agentId })
        .from(assistantConversationAgents)
        .where(inArray(assistantConversationAgents.conversationId, conversationIds))
    : []
  if (conversationIds.length)
    await db.delete(assistantConversations).where(inArray(assistantConversations.id, conversationIds.splice(0)))
  if (rows.length)
    await db.delete(agents).where(
      inArray(
        agents.id,
        rows.map((row) => row.agentId)
      )
    )
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  await cleanupTestRbac(prefix)
})

test('the general helper is a system-manager owned by the conversation owner, created once', async () => {
  const row = await conversation()
  const first = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: null, taskLabel: 'General task' }, [])
  )
  const second = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: null, taskLabel: 'General task' }, [])
  )
  expect(second.id).toBe(first.id)
  expect(first.agentTypeId).toBe('system-manager')
  expect(first.ownerUserId).toBe(row.ownerUserId)
  expect(await agentIdsFor(row.id)).toEqual([{ squadId: null, agentId: first.id }])
  expect(await findOwningConversation(first.id)).toMatchObject({ id: row.id })
  expect(await isAssistantDelegate(first.id)).toBe(true)
})

test('a squad target creates one consultant per squad with the consultant scope', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'test' })
  squadIds.push(squad.id)
  const consultant = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'Squad task' }, [])
  )
  const again = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'Squad task' }, [])
  )
  expect(again.id).toBe(consultant.id)
  expect(consultant.agentTypeId).toBe('consultant')
  expect(consultant.squadId).toBe(squad.id)
  expect(consultant.persist).toBe(false)
  expect(consultant.ownerUserId).toBeNull()
  expect(consultant.metadata?.name).toBeString()
  expect(consultant.metadata?.name).not.toBe(ASSISTANT_TASK_CONSULTANT_NAME)
  expect(consultant.metadata?.purpose).toBe('Squad task')
  expect(consultant.context).toMatchObject({ scope: { type: 'consultant', id: squad.id }, origin: 'assistant' })
  // The general helper and the consultant coexist; the consultant never owns the page editor.
  const general = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: null, taskLabel: 'General task' }, [])
  )
  expect(general.id).not.toBe(consultant.id)
  expect((await agentIdsFor(row.id)).length).toBe(2)
  expect(await findOwningConversation(consultant.id)).toBeUndefined()
  expect(await isAssistantDelegate(consultant.id)).toBe(true)
  expect(await isAssistantDelegate(randomUUID())).toBe(false)
})

test('a terminated owned agent is replaced and the old one is left in place', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-squad-2`, purpose: 'test' })
  squadIds.push(squad.id)
  const stale = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'Squad task' }, [])
  )
  await Agent.update(stale.id, { status: 'terminated' })
  const fresh = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'Squad task' }, [])
  )
  expect(fresh.id).not.toBe(stale.id)
  expect(await agentIdsFor(row.id)).toEqual([{ squadId: squad.id, agentId: fresh.id }])
  expect(await Agent.find(stale.id)).not.toBeNull()
  await db.delete(agents).where(eq(agents.id, stale.id))
})

test('owned helper creation, reuse, and replacement never acquire another pool connection under the conversation lock', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-pool`, purpose: 'test' })
  squadIds.push(squad.id)
  const connection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
  const single = drizzle(connection, { schema })
  const afterCommit: Array<() => void> = []
  try {
    // tx uses a single independent connection. Any global-pool helper here would
    // hold-and-wait in production when the rest of the pool waits on this row.
    setDatabaseQueryObserverForTest(() => {
      throw new Error('Global pool query while resolving an owned agent')
    })
    for (const squadId of [null, squad.id]) {
      const resolve = (taskLabel = 'Pool task') =>
        single.transaction(async (tx) => {
          await tx.select().from(assistantConversations).where(eq(assistantConversations.id, row.id)).for('update')
          return resolveOwnedAgent(tx, row, { squadId, taskLabel }, afterCommit)
        })
      const first = await resolve()
      expect((await resolve()).id).toBe(first.id)
      // Re-purposing a reused helper for a new task stays on the transaction's connection too.
      expect((await resolve('Next pool task')).metadata?.purpose).toBe('Next pool task')
      await single.update(agents).set({ status: 'terminated' }).where(eq(agents.id, first.id))
      const replacement = await resolve()
      expect(replacement.id).not.toBe(first.id)
      await single.delete(agents).where(eq(agents.id, first.id))
    }
    expect(afterCommit).toHaveLength(6)
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await connection.end({ timeout: 5 })
  }
})

test('rolling back helper creation leaves neither an agent nor a binding', async () => {
  const row = await conversation()
  const afterCommit: Array<() => void> = []
  let agentId: string | undefined
  await expect(
    db.transaction(async (tx) => {
      await tx.select().from(assistantConversations).where(eq(assistantConversations.id, row.id)).for('update')
      agentId = (await resolveOwnedAgent(tx, row, { squadId: null, taskLabel: 'General task' }, afterCommit)).id
      throw new Error('Abort conversation update')
    })
  ).rejects.toThrow('Abort conversation update')
  expect(agentId).toBeDefined()
  expect(await Agent.find(agentId!)).toBeNull()
  expect(await agentIdsFor(row.id)).toEqual([])
})

for (const scoped of [false, true]) {
  test(`dormant helper reuse preserves identity and creation events wait for commit (squad=${scoped})`, async () => {
    const row = await conversation()
    const squad = scoped ? await Squad.create({ name: `${prefix}-events`, purpose: 'test' }) : null
    if (squad) squadIds.push(squad.id)
    const afterCommit: Array<() => void> = []
    const emitted: string[] = []
    const off = eventEmitter.on('agent.created', ({ agentId }) => {
      emitted.push(agentId)
    })
    try {
      const first = await db.transaction(async (tx) => {
        const agent = await resolveOwnedAgent(
          tx,
          row,
          { squadId: squad?.id ?? null, taskLabel: 'Event task' },
          afterCommit
        )
        expect(emitted).toEqual([])
        return agent
      })
      expect(await agentIdsFor(row.id)).toEqual([{ squadId: squad?.id ?? null, agentId: first.id }])
      expect(emitted).toEqual([])
      afterCommit.splice(0).forEach((emit) => emit())
      expect(emitted).toEqual([first.id])
      expect(first.metadata?.resourceGeneration).toBeString()
      await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, first.id))
      const reused = await db.transaction((tx) =>
        resolveOwnedAgent(tx, row, { squadId: squad?.id ?? null, taskLabel: 'Event task' }, afterCommit)
      )
      expect(reused.id).toBe(first.id)
      expect(reused.metadata?.resourceGeneration).toBe(first.metadata?.resourceGeneration)
      expect(reused.status).toBe('dormant')
      expect(afterCommit).toEqual([])
    } finally {
      off()
    }
  })
}

for (const scoped of [false, true]) {
  test(`a reused helper's purpose follows a new task label but not a repeat of the same one (squad=${scoped})`, async () => {
    const row = await conversation()
    const squad = scoped ? await Squad.create({ name: `${prefix}-purpose`, purpose: 'test' }) : null
    if (squad) squadIds.push(squad.id)
    const squadId = squad?.id ?? null
    const resolve = (taskLabel: string, afterCommit: Array<() => void> = []) =>
      db.transaction((tx) => resolveOwnedAgent(tx, row, { squadId, taskLabel }, afterCommit))
    const created = await resolve('Check enabled schedules')
    expect(created.metadata).toMatchObject({ purpose: 'Check enabled schedules' })
    const name = created.metadata?.name
    // The helper refines its own purpose; a repeat of the same task (retry) keeps the refinement.
    await Agent.update(created.id, { purpose: 'Audit nightly schedules' })
    const repeatEvents: Array<() => void> = []
    const repeated = await resolve('Check enabled schedules', repeatEvents)
    expect(repeated.metadata?.purpose).toBe('Audit nightly schedules')
    expect(repeatEvents).toEqual([])
    // A different task moves the purpose to it, keeps the name, and announces the change after commit.
    const updates: string[] = []
    const off = eventEmitter.on('agent.updated', ({ agentId }) => {
      updates.push(agentId)
    })
    try {
      const nextEvents: Array<() => void> = []
      const next = await resolve('Pause the deploy stream', nextEvents)
      expect(next.id).toBe(created.id)
      expect(next.metadata).toMatchObject({ name, purpose: 'Pause the deploy stream' })
      expect(next.metadata?.resourceGeneration).toBe(created.metadata?.resourceGeneration)
      expect(updates).toEqual([])
      nextEvents.forEach((emit) => emit())
      expect(updates).toEqual([created.id])
    } finally {
      off()
    }
    expect((await Agent.mustFind(created.id)).metadata?.purpose).toBe('Pause the deploy stream')
  })
}

test('a reused consultant still carrying the placeholder name gets a real name and a stamped origin', async () => {
  const row = await conversation()
  const squad = await Squad.create({ name: `${prefix}-legacy`, purpose: 'test' })
  squadIds.push(squad.id)
  const consultant = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'First task' }, [])
  )
  // Shape of a consultant created before names and purposes followed the task, and before origins were stamped.
  await db
    .update(agents)
    .set({
      metadata: {
        name: ASSISTANT_TASK_CONSULTANT_NAME,
        purpose: 'Assistant squad tasks',
        resourceGeneration: consultant.metadata?.resourceGeneration,
      },
      context: { scope: { type: 'consultant', id: squad.id } },
    })
    .where(eq(agents.id, consultant.id))
  const reused = await db.transaction((tx) =>
    resolveOwnedAgent(tx, row, { squadId: squad.id, taskLabel: 'First task' }, [])
  )
  expect(reused.id).toBe(consultant.id)
  expect(reused.metadata?.name).toBeString()
  expect(reused.metadata?.name).not.toBe(ASSISTANT_TASK_CONSULTANT_NAME)
  expect(reused.metadata?.purpose).toBe('First task')
  expect(reused.context).toMatchObject({ scope: { type: 'consultant', id: squad.id }, origin: 'assistant' })
})
