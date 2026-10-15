import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { agents, db, executions, inbox, slotClaims, slotNotifications, slotPools, slotWaiters, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { loadSlotPoolPromptEntries } from '../../lib/prompts/slot-pools-prompt'
import { MAX_SLOT_USAGE_LENGTH } from './types'
import { SlotNotificationNotifier } from './notifications'
import {
  claimSlot,
  getPool,
  listPools,
  registerPool,
  releaseSlot,
  renewSlot,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
  unregisterPool,
  updatePool,
  updatePoolDetailed,
} from './store'

const squadIds: string[] = []
const agentIds: string[] = []

// Outbox rows are asserted directly; delivery is driven explicitly below.
beforeAll(() => setSlotPromptDrainEnabledForTest(false))
afterAll(() => setSlotPromptDrainEnabledForTest(true))

afterEach(async () => {
  if (squadIds.length > 0) {
    const poolIds = (
      await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
    ).map((row) => row.id)
    if (poolIds.length > 0) {
      await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
      await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
      await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
    }
  }
  if (agentIds.length > 0) {
    await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
    await db.delete(executions).where(inArray(executions.agentId, agentIds))
    await db.delete(agents).where(inArray(agents.id, agentIds))
  }
  if (squadIds.length > 0) await db.delete(squads).where(inArray(squads.id, squadIds))
  squadIds.length = 0
  agentIds.length = 0
})

async function createSquad(): Promise<Squad> {
  const squad = await Squad.create({ name: `slot-settings-${crypto.randomUUID().slice(0, 8)}`, purpose: 'test' })
  squadIds.push(squad.id)
  return squad
}

async function createAgent(squadId: string): Promise<string> {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'slot-settings-test', squadId }).returning()
  agentIds.push(agent!.id)
  return agent!.id
}

describe('slot pool usage guidance', () => {
  test('register stores trimmed guidance and treats blank guidance as none', async () => {
    const squad = await createSquad()
    const guided = await registerPool({
      squadId: squad.id,
      key: 'tests',
      usage: '  Claim before DB-backed tests.  ',
      createdBy: 'test',
    })
    const blank = await registerPool({ squadId: squad.id, key: 'builds', usage: '   ', createdBy: 'test' })
    const omitted = await registerPool({ squadId: squad.id, key: 'deploys', createdBy: 'test' })

    expect(guided.usage).toBe('Claim before DB-backed tests.')
    expect(blank.usage).toBeNull()
    expect(omitted.usage).toBeNull()
  })

  test('rejects guidance over the prompt budget', async () => {
    const squad = await createSquad()
    await expect(
      registerPool({ squadId: squad.id, key: 'tests', usage: 'x'.repeat(MAX_SLOT_USAGE_LENGTH + 1), createdBy: 'test' })
    ).rejects.toMatchObject({ code: 'invalid_usage' })
    await registerPool({ squadId: squad.id, key: 'tests', usage: 'x'.repeat(MAX_SLOT_USAGE_LENGTH), createdBy: 'test' })
    await expect(updatePool(squad.id, 'tests', { usage: 'y'.repeat(MAX_SLOT_USAGE_LENGTH + 1) })).rejects.toMatchObject(
      { code: 'invalid_usage' }
    )
  })

  test('the database refuses oversized guidance written around the service', async () => {
    const squad = await createSquad()
    // Promise.resolve adopts Drizzle's thenable query builder.
    await expect(
      Promise.resolve(
        db.insert(slotPools).values({
          squadId: squad.id,
          key: 'raw',
          usage: 'x'.repeat(MAX_SLOT_USAGE_LENGTH + 1),
          createdBy: 'test',
        })
      )
    ).rejects.toThrow()
  })

  test('partial updates change or clear guidance without touching capacity or timeout', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', capacity: 2, claimTimeoutMs: 45 * 60_000, createdBy: 'test' })

    const guided = await updatePool(squad.id, 'tests', { usage: 'Claim before heavy builds.' })
    expect(guided).toMatchObject({ capacity: 2, claimTimeoutMs: 45 * 60_000, usage: 'Claim before heavy builds.' })

    const resized = await updatePool(squad.id, 'tests', { capacity: 3 })
    expect(resized).toMatchObject({ capacity: 3, usage: 'Claim before heavy builds.' })

    expect((await updatePool(squad.id, 'tests', { usage: null })).usage).toBeNull()
    await updatePool(squad.id, 'tests', { usage: 'again' })
    expect((await updatePool(squad.id, 'tests', { usage: '' })).usage).toBeNull()
  })

  test('requires at least one field to update', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', createdBy: 'test' })
    await expect(updatePool(squad.id, 'tests', {})).rejects.toMatchObject({ code: 'invalid_capacity' })
  })

  test('list and detail projections carry guidance and enabled state', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'tests', usage: 'Claim before tests.', createdBy: 'test' })

    const [listed] = await listPools(squad.id, { diagnostics: true })
    expect(listed).toMatchObject({ key: 'tests', usage: 'Claim before tests.', enabled: true, disabledAt: null })
    expect(await getPool(squad.id, 'tests', { diagnostics: false })).toMatchObject({
      usage: 'Claim before tests.',
      enabled: true,
    })
  })
})

describe('disabling and re-enabling a slot pool', () => {
  async function contestedPool() {
    const squad = await createSquad()
    const pool = await registerPool({
      squadId: squad.id,
      key: 'tests',
      usage: 'Claim before tests.',
      createdBy: 'test',
    })
    const holder = await createAgent(squad.id)
    const waiterA = await createAgent(squad.id)
    const waiterB = await createAgent(squad.id)
    const granted = await claimSlot(squad.id, 'tests', holder)
    const queuedA = await claimSlot(squad.id, 'tests', waiterA)
    const queuedB = await subscribeSlot(squad.id, 'tests', waiterB)
    if (granted.outcome !== 'granted' || queuedA.outcome !== 'queued' || queuedB.outcome !== 'queued') {
      throw new Error('bad fixture')
    }
    return { squad, pool, holder, waiterA, waiterB, claimId: granted.claim.id, queuedA, queuedB }
  }

  test('disable cancels every queued waiter and queues one disabled notice each', async () => {
    const { squad, pool, waiterA, waiterB, queuedA, queuedB } = await contestedPool()

    const result = await updatePoolDetailed(squad.id, 'tests', { enabled: false })

    expect(result.releasedWaiters).toBe(2)
    expect(result.pool.disabledAt).toBeInstanceOf(Date)
    const waiters = await db.select().from(slotWaiters).where(eq(slotWaiters.poolId, pool.id))
    expect(waiters.map((waiter) => [waiter.status, waiter.terminalReason])).toEqual([
      ['canceled', 'pool_disabled'],
      ['canceled', 'pool_disabled'],
    ])
    const notices = await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'pool_disabled')))
    expect(notices.map((notice) => notice.recipientAgentId).sort()).toEqual([waiterA, waiterB].sort())
    expect(notices.map((notice) => notice.waiterId).sort()).toEqual(
      [
        queuedA.outcome === 'queued' ? queuedA.waiter.id : '',
        queuedB.outcome === 'queued' ? queuedB.waiter.id : '',
      ].sort()
    )
    expect(notices.every((notice) => notice.claimId === null && notice.status === 'pending')).toBe(true)

    // Disabling again is a no-op: no duplicate cancellations or notices.
    expect((await updatePoolDetailed(squad.id, 'tests', { enabled: false })).releasedWaiters).toBe(0)
    expect(
      await db
        .select()
        .from(slotNotifications)
        .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.kind, 'pool_disabled')))
    ).toHaveLength(2)
  })

  test('the disabled notice is delivered to the waiting agent', async () => {
    const { squad, pool, waiterA } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })
    const [notice] = await db
      .select()
      .from(slotNotifications)
      .where(and(eq(slotNotifications.poolId, pool.id), eq(slotNotifications.recipientAgentId, waiterA)))

    const summary = await new SlotNotificationNotifier().drain({
      now: notice!.nextAttemptAt,
      notificationId: notice!.id,
    })

    expect(summary.delivered).toBe(1)
    const [message] = await db.select().from(inbox).where(eq(inbox.recipientId, waiterA))
    expect(message!.subject).toBe('Slot pool disabled: tests (no longer queued)')
    expect(message!.content).toContain(`your queued wait ${notice!.waiterId} was canceled`)
    expect(message!.content).toContain('not slot-gated')
    expect(message!.metadata).toMatchObject({ source: 'slot', poolId: pool.id, waiterId: notice!.waiterId })
    const [settled] = await db.select().from(slotNotifications).where(eq(slotNotifications.id, notice!.id))
    expect(settled!.status).toBe('delivered')
  })

  test('claim and subscribe on a disabled pool report disabled without queueing', async () => {
    const { squad, pool } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })
    const newcomer = await createAgent(squad.id)

    const claim = await claimSlot(squad.id, 'tests', newcomer)
    const subscribe = await subscribeSlot(squad.id, 'tests', newcomer)

    for (const result of [claim, subscribe]) {
      expect(result.outcome).toBe('disabled')
      expect(result.message).toContain('not enforced right now')
      expect(Object.keys(result.pool).sort()).toEqual([
        'activeCount',
        'availableCount',
        'capacity',
        'key',
        'queuedCount',
      ])
      expect('claim' in result || 'waiter' in result).toBe(false)
    }
    const newcomerState = await Promise.all([
      db
        .select()
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.ownerAgentId, newcomer))),
      db
        .select()
        .from(slotClaims)
        .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, newcomer))),
    ])
    expect(newcomerState.flat()).toHaveLength(0)
  })

  test('existing holders keep, renew, and release their claim while disabled', async () => {
    const { squad, holder, claimId } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })

    const [listed] = await listPools(squad.id, { diagnostics: true })
    expect(listed).toMatchObject({ enabled: false, activeCount: 1, queuedCount: 0 })
    expect((await renewSlot(squad.id, 'tests', holder, claimId)).outcome).toBe('renewed')
    expect((await releaseSlot(squad.id, 'tests', holder, claimId)).outcome).toBe('released')
  })

  test('configuration and guidance can still be edited while disabled', async () => {
    const { squad } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })

    const updated = await updatePool(squad.id, 'tests', { capacity: 4, usage: 'New guidance.' })

    expect(updated).toMatchObject({ capacity: 4, usage: 'New guidance.' })
    expect(updated.disabledAt).toBeInstanceOf(Date)
  })

  test('re-enabling restores admission with the same configuration and no stale waiters', async () => {
    const { squad, pool, holder, waiterA, claimId } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })

    const enabled = await updatePool(squad.id, 'tests', { enabled: true })
    expect(enabled).toMatchObject({ disabledAt: null, capacity: 1, usage: 'Claim before tests.' })
    expect(
      await db
        .select()
        .from(slotWaiters)
        .where(and(eq(slotWaiters.poolId, pool.id), eq(slotWaiters.status, 'queued')))
    ).toHaveLength(0)

    // The surviving holder still occupies the only unit, so a new claim queues again.
    expect((await claimSlot(squad.id, 'tests', waiterA)).outcome).toBe('queued')
    await releaseSlot(squad.id, 'tests', holder, claimId)
    const [promoted] = await db
      .select()
      .from(slotClaims)
      .where(and(eq(slotClaims.poolId, pool.id), eq(slotClaims.ownerAgentId, waiterA), eq(slotClaims.status, 'active')))
    expect(promoted).toBeDefined()
  })

  test('a disabled empty pool can be unregistered; a disabled busy pool cannot', async () => {
    const { squad, holder, claimId } = await contestedPool()
    await updatePool(squad.id, 'tests', { enabled: false })
    await expect(unregisterPool(squad.id, 'tests')).rejects.toMatchObject({ code: 'pool_busy' })

    await releaseSlot(squad.id, 'tests', holder, claimId)
    expect((await unregisterPool(squad.id, 'tests')).unregisteredAt).toBeInstanceOf(Date)
  })

  test('the prompt section reads only enabled, registered pools', async () => {
    const squad = await createSquad()
    await registerPool({ squadId: squad.id, key: 'zeta', usage: 'Claim before zeta work.', createdBy: 'test' })
    await registerPool({ squadId: squad.id, key: 'alpha', capacity: 2, createdBy: 'test' })
    await registerPool({ squadId: squad.id, key: 'off', createdBy: 'test' })
    await registerPool({ squadId: squad.id, key: 'gone', createdBy: 'test' })
    await updatePool(squad.id, 'off', { enabled: false })
    await unregisterPool(squad.id, 'gone')

    expect(await loadSlotPoolPromptEntries(squad.id)).toEqual([
      { key: 'alpha', capacity: 2, claimTimeoutMs: 3_600_000, usage: null },
      { key: 'zeta', capacity: 1, claimTimeoutMs: 3_600_000, usage: 'Claim before zeta work.' },
    ])

    await updatePool(squad.id, 'off', { enabled: true })
    expect((await loadSlotPoolPromptEntries(squad.id)).map((pool) => pool.key)).toEqual(['alpha', 'off', 'zeta'])
  })
})
