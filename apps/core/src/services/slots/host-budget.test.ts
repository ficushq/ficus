import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type WorkStreamPriority } from '@ficus/shared'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  agents,
  db,
  machineBoxes,
  machines,
  slotClaims,
  slotNotifications,
  slotPools,
  slotWaiters,
  squads,
  workStreams,
} from '../../db'
import { Squad } from '../../entities/Squad'
import { ensureDefaultHostPools } from './default-host-pool'
import {
  DEFAULT_HOST_POOL_CREATOR,
  DEFAULT_HOST_POOL_KEY,
  DEFAULT_HOST_POOL_USAGE,
  deriveHostSlotCapacity,
  describeDerivedHostSlotBudgets,
} from './host-budget'
import { loadSlotPoolPromptEntries } from '../../lib/prompts/slot-pools-prompt'
import { getSettingsStore } from '../settings'
import { HOST_SLOT_CAPACITY_SETTING_KEY } from './host-capacity-setting'
import { reconcileSlotsOnce } from './reconciliation'
import { pruneTerminalSlotState } from './retention'
import {
  claimSlot,
  getPool,
  listPools,
  registerPool,
  releaseSlot,
  setSlotPromptDrainEnabledForTest,
  subscribeSlot,
  unregisterPool,
  updatePool,
  updatePoolDetailed,
} from './store'
import { MAX_SLOT_USAGE_LENGTH } from './types'

describe('deriveHostSlotCapacity', () => {
  const saved = process.env.FICUS_HOST_SLOT_CAPACITY
  beforeEach(async () => {
    delete process.env.FICUS_HOST_SLOT_CAPACITY
    await getSettingsStore().delete(HOST_SLOT_CAPACITY_SETTING_KEY)
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env.FICUS_HOST_SLOT_CAPACITY
    else process.env.FICUS_HOST_SLOT_CAPACITY = saved
    await getSettingsStore().delete(HOST_SLOT_CAPACITY_SETTING_KEY)
  })

  test('scales with host memory, keeps one unit on a small host, and never exceeds the CPU count', () => {
    // MemTotal as the kernel reports it: a "16 GB" host has about 15991 MB.
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBe(3)
    expect(deriveHostSlotCapacity({ memMb: 1968, cpus: 1 })).toBe(1)
    expect(deriveHostSlotCapacity({ memMb: 3916, cpus: 2 })).toBe(1)
    expect(deriveHostSlotCapacity({ memMb: 7941, cpus: 4 })).toBe(1)
    expect(deriveHostSlotCapacity({ memMb: 32093, cpus: 8 })).toBe(7)
    expect(deriveHostSlotCapacity({ memMb: 64297, cpus: 4 })).toBe(4)
    expect(deriveHostSlotCapacity({ memMb: 32093 })).toBe(7)
  })

  test('enforces no budget when the host size is unknown', () => {
    expect(deriveHostSlotCapacity({})).toBeNull()
    expect(deriveHostSlotCapacity(null)).toBeNull()
    expect(deriveHostSlotCapacity({ memMb: 0, cpus: 4 })).toBeNull()
  })

  test('FICUS_HOST_SLOT_CAPACITY fixes the budget, and 0 turns budgets off', () => {
    process.env.FICUS_HOST_SLOT_CAPACITY = '5'
    expect(deriveHostSlotCapacity({ memMb: 1968, cpus: 1 })).toBe(5)
    expect(deriveHostSlotCapacity({})).toBe(5)
    process.env.FICUS_HOST_SLOT_CAPACITY = '0'
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBeNull()
    process.env.FICUS_HOST_SLOT_CAPACITY = 'many'
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBe(3)
  })

  test('the HOST_SLOT_CAPACITY setting applies at once and wins over the variable', async () => {
    const store = getSettingsStore()
    process.env.FICUS_HOST_SLOT_CAPACITY = '5'
    await store.set(HOST_SLOT_CAPACITY_SETTING_KEY, '2')
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBe(2)
    await store.set(HOST_SLOT_CAPACITY_SETTING_KEY, '0')
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBeNull()
    // Clearing it falls back to the variable, then to the machine's size.
    await store.delete(HOST_SLOT_CAPACITY_SETTING_KEY)
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBe(5)
    delete process.env.FICUS_HOST_SLOT_CAPACITY
    expect(deriveHostSlotCapacity({ memMb: 15991, cpus: 4 })).toBe(3)

    for (const invalid of ['-1', '1.5', '1001', 'auto', '']) {
      await expect(store.set(HOST_SLOT_CAPACITY_SETTING_KEY, invalid)).rejects.toThrow('whole number from 0 to 1000')
    }
    const entry = (await store.list()).find((setting) => setting.key === HOST_SLOT_CAPACITY_SETTING_KEY)
    expect(entry).toMatchObject({ type: 'number', isDefault: true, value: 'auto' })
    expect(entry!.description).toContain('FICUS_HOST_SLOT_CAPACITY environment variable')
  })
})

test('the default pool guidance fits the usage budget', () => {
  expect(DEFAULT_HOST_POOL_USAGE.length).toBeLessThanOrEqual(MAX_SLOT_USAGE_LENGTH)
})

const POOL = 'heavy'
/** About 10 GB: two units of host budget. */
const TWO_UNIT_HOST = { memMb: 10_000, cpus: 4 }

const squadIds: string[] = []
const machineIds: string[] = []
let port = 41_000

async function machine(capabilities: { memMb?: number; cpus?: number } = TWO_UNIT_HOST): Promise<string> {
  const [row] = await db
    .insert(machines)
    .values({
      name: `slot-host-${crypto.randomUUID()}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'slot-host-test',
      sshPublicKey: '',
      status: 'ready',
      capabilities,
    })
    .returning()
  machineIds.push(row!.id)
  return row!.id
}

/** A squad whose box is on `machineId` (or on no machine), with a `heavy` pool. */
async function squad(
  machineId: string | null,
  pool: { capacity?: number; hostShared?: boolean; capacityFollowsHost?: boolean } | null = {}
): Promise<string> {
  const id = (await Squad.create({ name: `slot-host-${crypto.randomUUID()}`, purpose: 'test' })).id
  squadIds.push(id)
  if (machineId) {
    port += 1
    await db.insert(machineBoxes).values({ sandboxId: `squad_${id}`, machineId, unixUser: 'ficus', port })
  }
  if (pool) {
    // registerPool makes a new pool host-shared unless told otherwise.
    await registerPool({
      squadId: id,
      key: POOL,
      capacity: pool.capacity ?? 5,
      ...(pool.hostShared === undefined ? {} : { hostShared: pool.hostShared }),
      ...(pool.capacityFollowsHost === undefined ? {} : { capacityFollowsHost: pool.capacityFollowsHost }),
      createdBy: 'test',
    })
  }
  return id
}

async function agent(squadId: string, priority?: WorkStreamPriority): Promise<string> {
  const [row] = await db.insert(agents).values({ squadId, agentTypeId: 'slot-host-test', status: 'idle' }).returning()
  if (priority) await db.insert(workStreams).values({ squadId, title: 'test', priority, agentIds: [row!.id] })
  return row!.id
}

async function hold(squadId: string, priority?: WorkStreamPriority) {
  const agentId = await agent(squadId, priority)
  const result = await claimSlot(squadId, POOL, agentId)
  if (result.outcome !== 'granted') throw new Error(`expected a grant, got ${result.outcome}`)
  return { squadId, agentId, claimId: result.claim.id }
}

async function wait(squadId: string, priority?: WorkStreamPriority) {
  const agentId = await agent(squadId, priority)
  const result = await claimSlot(squadId, POOL, agentId)
  if (result.outcome !== 'queued') throw new Error(`expected to queue, got ${result.outcome}`)
  return { squadId, agentId, waiterId: result.waiter.id, message: result.message, pool: result.pool }
}

async function release(holder: { squadId: string; agentId: string; claimId: string }) {
  return releaseSlot(holder.squadId, POOL, holder.agentId, holder.claimId)
}

async function waiterStatus(waiterId: string): Promise<string> {
  const [row] = await db.select({ status: slotWaiters.status }).from(slotWaiters).where(eq(slotWaiters.id, waiterId))
  return row!.status
}

beforeEach(() => {
  setSlotPromptDrainEnabledForTest(false)
})

afterEach(async () => {
  setSlotPromptDrainEnabledForTest(true)
  if (squadIds.length > 0) {
    const pools = await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
    const poolIds = pools.map((pool) => pool.id)
    if (poolIds.length > 0) {
      await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
      await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
      await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
    }
    await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
    await db.delete(agents).where(inArray(agents.squadId, squadIds))
    await db.delete(machineBoxes).where(
      inArray(
        machineBoxes.sandboxId,
        squadIds.map((id) => `squad_${id}`)
      )
    )
    await db.delete(squads).where(inArray(squads.id, squadIds))
  }
  if (machineIds.length > 0) await db.delete(machines).where(inArray(machines.id, machineIds))
  squadIds.length = 0
  machineIds.length = 0
})

describe('host-shared pools', () => {
  test('squads on one machine share its budget, and a release hands the unit to the other squad', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    const first = await hold(a)
    await hold(a)

    // Squad B's own pool is empty, but the machine's two units are taken.
    const blocked = await wait(b)
    expect(blocked.message).toContain("machine host's shared slot budget is full (2 of 2 in use across squads)")
    expect(blocked.pool).toMatchObject({
      activeCount: 0,
      availableCount: 0,
      queuedCount: 1,
      host: { capacity: 2, activeCount: 2, availableCount: 0 },
    })
    expect(await getPool(b, POOL, { diagnostics: true })).toMatchObject({
      hostShared: true,
      activeCount: 0,
      availableCount: 0,
      host: { capacity: 2, activeCount: 2, availableCount: 0 },
    })

    await release(first)
    expect(await waiterStatus(blocked.waiterId)).toBe('granted')
    expect(await getPool(a, POOL, { diagnostics: true })).toMatchObject({
      activeCount: 1,
      host: { capacity: 2, activeCount: 2, availableCount: 0 },
    })
  })

  test('a claim still needs room in its own pool', async () => {
    const host = await machine()
    const a = await squad(host, { capacity: 1 })
    await hold(a)
    const blocked = await wait(a)
    expect(blocked.message).toBe(`No capacity is available for "${POOL}"; you are queued.`)
    expect(blocked.pool.host).toEqual({ capacity: 2, activeCount: 1, availableCount: 1 })
  })

  test('under contention the freed unit goes to the squad holding fewer, then first come', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    const first = await hold(a)
    const second = await hold(a)
    const ownWaiter = await wait(a)
    const otherSquad = await wait(b)

    // Squad A still holds one unit after the release; squad B holds none.
    await release(first)
    expect(await waiterStatus(otherSquad.waiterId)).toBe('granted')
    expect(await waiterStatus(ownWaiter.waiterId)).toBe('queued')

    await release(second)
    expect(await waiterStatus(ownWaiter.waiterId)).toBe('granted')
  })

  test('priority outranks the fair share between squads', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    const first = await hold(a)
    await hold(a)
    const urgent = await wait(a, 'critical')
    const routine = await wait(b)

    await release(first)
    expect(await waiterStatus(urgent.waiterId)).toBe('granted')
    expect(await waiterStatus(routine.waiterId)).toBe('queued')
  })

  test('a newcomer does not take a unit another squad is already queued for', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    const expiring = await hold(a)
    await hold(a)
    const queued = await wait(b)
    await db
      .update(slotClaims)
      .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(slotClaims.id, expiring.claimId))

    // The newcomer's claim is what notices the expiry: the unit it frees goes
    // to squad B's waiter, and the newcomer queues behind it.
    const newcomer = await wait(a)
    expect(newcomer.message).toContain('Other squads are already queued')
    expect(await waiterStatus(queued.waiterId)).toBe('granted')
    expect(await waiterStatus(newcomer.waiterId)).toBe('queued')
    expect((await subscribeSlot(a, POOL, newcomer.agentId)).outcome).toBe('queued')
  })

  test('pools that are not host-shared, and squads on other machines, are not counted', async () => {
    const host = await machine()
    const a = await squad(host)
    const plain = await squad(host, { hostShared: false })
    const elsewhere = await squad(await machine())
    const unplaced = await squad(null)
    await hold(a)
    await hold(a)

    for (const other of [plain, elsewhere, unplaced]) await hold(other)
    expect(await getPool(plain, POOL, { diagnostics: true })).toMatchObject({ hostShared: false, availableCount: 4 })
    expect((await getPool(plain, POOL, { diagnostics: true })).host).toBeUndefined()
    // A host-shared pool with no machine behaves like an ordinary squad pool.
    expect((await getPool(unplaced, POOL, { diagnostics: true })).host).toBeUndefined()
    expect((await getPool(elsewhere, POOL, { diagnostics: true })).host).toEqual({
      capacity: 2,
      activeCount: 1,
      availableCount: 1,
    })
  })

  test('a pool that stops being host-shared hands its units back, and one that starts is counted', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    await hold(a)
    await hold(a)
    const blocked = await wait(b)

    await updatePool(a, POOL, { hostShared: false })
    expect(await waiterStatus(blocked.waiterId)).toBe('granted')
    expect((await getPool(b, POOL, { diagnostics: true })).host).toMatchObject({ activeCount: 1 })

    // Existing claims count from the moment the pool is host-shared again.
    await updatePool(a, POOL, { hostShared: true })
    expect((await getPool(b, POOL, { diagnostics: true })).host).toMatchObject({ activeCount: 3, availableCount: 0 })
    expect((await claimSlot(b, POOL, await agent(b), { subscribe: false })).outcome).toBe('unavailable')
  })

  test('raising the HOST_SLOT_CAPACITY setting admits the next claim without a restart', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    await hold(a)
    await hold(a)
    const blocked = await wait(b)
    try {
      await getSettingsStore().set(HOST_SLOT_CAPACITY_SETTING_KEY, '4')
      expect((await getPool(b, POOL, { diagnostics: true })).host).toEqual({
        capacity: 4,
        activeCount: 2,
        availableCount: 2,
      })
      // The waiter is granted by the next operation or reconciliation sweep.
      await reconcileSlotsOnce()
      expect(await waiterStatus(blocked.waiterId)).toBe('granted')
      await hold(b)

      // Off: the pools are limited only by their own capacity.
      await getSettingsStore().set(HOST_SLOT_CAPACITY_SETTING_KEY, '0')
      await hold(b)
      expect((await getPool(b, POOL, { diagnostics: true })).host).toBeUndefined()
    } finally {
      await getSettingsStore().delete(HOST_SLOT_CAPACITY_SETTING_KEY)
    }
  })

  test('reconciliation grants a unit that was freed without a pool operation', async () => {
    const host = await machine()
    const a = await squad(host)
    const b = await squad(host)
    const first = await hold(a)
    await hold(a)
    const blocked = await wait(b)
    // What dormancy cleanup or squad archival leaves behind: the claim is gone
    // and no pool operation ran for the other squad.
    await db
      .update(slotClaims)
      .set({ status: 'released', endedAt: sql`clock_timestamp()`, terminalReason: 'pool_cleanup' })
      .where(eq(slotClaims.id, first.claimId))
    expect(await waiterStatus(blocked.waiterId)).toBe('queued')

    expect((await reconcileSlotsOnce()).promotedClaims).toBeGreaterThanOrEqual(1)
    expect(await waiterStatus(blocked.waiterId)).toBe('granted')
  })

  test('agent prompts say when a pool is host-shared and how many claims the host allows', async () => {
    const host = await machine()
    const a = await squad(host)
    const unplaced = await squad(null)
    expect(await loadSlotPoolPromptEntries(a)).toEqual([
      { key: POOL, capacity: 5, claimTimeoutMs: 3_600_000, usage: null, hostCapacity: 2 },
    ])
    expect(await loadSlotPoolPromptEntries(unplaced)).toEqual([
      { key: POOL, capacity: 5, claimTimeoutMs: 3_600_000, usage: null },
    ])
  })
})

describe('pools with no cap of their own', () => {
  test('the capacity is the machine host budget and follows the setting at once', async () => {
    const host = await machine()
    const a = await squad(host, { capacity: 1, capacityFollowsHost: true })
    expect(await getPool(a, POOL, { diagnostics: true })).toMatchObject({
      capacity: 2,
      capacityFollowsHost: true,
      availableCount: 2,
    })
    // Its own stored capacity of 1 does not hold the second claim back.
    await hold(a)
    await hold(a)
    const blocked = await wait(a)
    expect(blocked.pool).toMatchObject({ capacity: 2, activeCount: 2, availableCount: 0 })

    try {
      await getSettingsStore().set(HOST_SLOT_CAPACITY_SETTING_KEY, '3')
      expect(await getPool(a, POOL, { diagnostics: true })).toMatchObject({ capacity: 3, availableCount: 1 })
      await reconcileSlotsOnce()
      expect(await waiterStatus(blocked.waiterId)).toBe('granted')
      expect(await loadSlotPoolPromptEntries(a)).toEqual([
        { key: POOL, capacity: 3, claimTimeoutMs: 3_600_000, usage: null, hostCapacity: 3, capacityFollowsHost: true },
      ])

      // With budgets off there is nothing to follow: the stored capacity applies.
      await getSettingsStore().set(HOST_SLOT_CAPACITY_SETTING_KEY, '0')
      expect(await getPool(a, POOL, { diagnostics: true })).toMatchObject({
        capacity: 1,
        capacityFollowsHost: true,
        availableCount: 0,
      })
      expect((await claimSlot(a, POOL, await agent(a), { subscribe: false })).outcome).toBe('unavailable')
    } finally {
      await getSettingsStore().delete(HOST_SLOT_CAPACITY_SETTING_KEY)
    }
  })

  test('a squad whose pool follows the host still shares the machine fairly with others', async () => {
    const host = await machine()
    const a = await squad(host, { capacity: 1, capacityFollowsHost: true })
    const b = await squad(host)
    const first = await hold(a)
    await hold(a)
    const own = await wait(a)
    const other = await wait(b)
    // Squad A could take the freed unit under its host-sized capacity, but it
    // still holds one and squad B holds none.
    await release(first)
    expect(await waiterStatus(other.waiterId)).toBe('granted')
    expect(await waiterStatus(own.waiterId)).toBe('queued')
  })

  test('a number gives the pool its own cap again, and only host-shared pools can follow', async () => {
    const host = await machine()
    const a = await squad(host, { capacity: 1, capacityFollowsHost: true })
    expect(await updatePool(a, POOL, { capacity: 1 })).toMatchObject({ capacity: 1, capacityFollowsHost: false })
    expect(await getPool(a, POOL, { diagnostics: true })).toMatchObject({ capacity: 1, capacityFollowsHost: false })
    // Both together keep following and store the number as the fallback.
    expect(await updatePool(a, POOL, { capacity: 4, capacityFollowsHost: true })).toMatchObject({
      capacity: 4,
      capacityFollowsHost: true,
    })
    expect((await getPool(a, POOL, { diagnostics: true })).capacity).toBe(2)
    // Leaving the host budget leaves nothing to follow.
    expect(await updatePool(a, POOL, { hostShared: false })).toMatchObject({
      hostShared: false,
      capacityFollowsHost: false,
      capacity: 4,
    })
    await expect(updatePool(a, POOL, { capacityFollowsHost: true })).rejects.toThrow('Only a host-shared pool')
    await expect(
      registerPool({ squadId: a, key: 'lock', hostShared: false, capacityFollowsHost: true, createdBy: 'test' })
    ).rejects.toThrow('Only a host-shared pool')
  })
})

describe('renaming a pool', () => {
  test('claims, waiters and history stay with the pool under its new key', async () => {
    const host = await machine()
    const a = await squad(host, { capacity: 1 })
    const holder = await hold(a)
    const queued = await wait(a)

    const result = await updatePoolDetailed(a, POOL, { newKey: 'heavy-work' })
    expect(result).toMatchObject({ renamedFrom: POOL, pool: { key: 'heavy-work' } })
    await expect(getPool(a, POOL, { diagnostics: true })).rejects.toThrow('was not found')
    expect(await getPool(a, 'heavy-work', { diagnostics: true })).toMatchObject({
      key: 'heavy-work',
      activeCount: 1,
      queuedCount: 1,
    })

    // The holder's claim id still releases, and the waiter is granted in the renamed pool.
    expect((await releaseSlot(a, 'heavy-work', holder.agentId, holder.claimId)).outcome).toBe('released')
    expect(await waiterStatus(queued.waiterId)).toBe('granted')
    expect((await claimSlot(a, 'heavy-work', queued.agentId)).outcome).toBe('granted')
  })

  test('refuses a key another pool of the squad already has, and accepts its own', async () => {
    const a = await squad(null)
    await registerPool({ squadId: a, key: 'other', createdBy: 'test' })
    await expect(updatePoolDetailed(a, POOL, { newKey: 'other' })).rejects.toThrow('already registered')
    await expect(updatePoolDetailed(a, POOL, { newKey: 'Not A Key' })).rejects.toThrow('Invalid slot pool key')
    expect((await updatePoolDetailed(a, POOL, { newKey: POOL })).renamedFrom).toBeUndefined()
    // A key freed by unregistering can be taken.
    await unregisterPool(a, 'other')
    expect((await updatePoolDetailed(a, POOL, { newKey: 'other' })).pool.key).toBe('other')
  })
})

test('settings can say what each machine size derives to, whatever the override', async () => {
  const sized = await machine()
  const unknown = await machine({})
  const names = await db.select({ id: machines.id, name: machines.name }).from(machines)
  const nameOf = (id: string) => names.find((row) => row.id === id)!.name
  try {
    await getSettingsStore().set(HOST_SLOT_CAPACITY_SETTING_KEY, '7')
    const line = await describeDerivedHostSlotBudgets(db)
    expect(line).toStartWith('Derived from machine size right now: ')
    expect(line).toContain(`${nameOf(sized)}: 2 (9.8 GiB, 4 CPUs)`)
    expect(line).toContain(`${nameOf(unknown)}: unknown size, no budget`)
  } finally {
    await getSettingsStore().delete(HOST_SLOT_CAPACITY_SETTING_KEY)
  }
})

describe('default host-shared pool', () => {
  test('a squad with no pools on a machine gets heavy-work once, with the host budget as capacity', async () => {
    const host = await machine()
    const fresh = await squad(host, null)
    const configured = await squad(host, { hostShared: false })
    const unplaced = await squad(null, null)

    expect(await ensureDefaultHostPools()).toBeGreaterThanOrEqual(1)
    const [pool] = await listPools(fresh, { diagnostics: true })
    expect(pool).toMatchObject({
      key: DEFAULT_HOST_POOL_KEY,
      capacity: 2,
      // No cap of its own: it keeps following the machine's budget.
      capacityFollowsHost: true,
      claimTimeoutMs: 45 * 60_000,
      usage: DEFAULT_HOST_POOL_USAGE,
      hostShared: true,
      enabled: true,
    })
    // A squad that manages its own pools, or has no machine, is left alone.
    expect((await listPools(configured, { diagnostics: true })).map((entry) => entry.key)).toEqual([POOL])
    expect(await listPools(unplaced, { diagnostics: true })).toEqual([])

    await ensureDefaultHostPools()
    expect(await listPools(fresh, { diagnostics: true })).toHaveLength(1)
  })

  test('a default pool its manager unregisters is not registered again, even after retention', async () => {
    const host = await machine()
    const fresh = await squad(host, null)
    await ensureDefaultHostPools()
    await unregisterPool(fresh, DEFAULT_HOST_POOL_KEY)
    const [row] = await db.select().from(slotPools).where(eq(slotPools.squadId, fresh))
    expect(row!.createdBy).toBe(DEFAULT_HOST_POOL_CREATOR)

    await db
      .update(slotPools)
      .set({ unregisteredAt: sql`clock_timestamp() - interval '90 days'` })
      .where(eq(slotPools.id, row!.id))
    await pruneTerminalSlotState()
    expect(await db.select({ id: slotPools.id }).from(slotPools).where(eq(slotPools.squadId, fresh))).toHaveLength(1)

    await ensureDefaultHostPools()
    expect(await listPools(fresh, { diagnostics: true })).toEqual([])
  })

  test('no pool is registered while the machine size is unknown', async () => {
    const fresh = await squad(await machine({}), null)
    await ensureDefaultHostPools()
    expect(await listPools(fresh, { diagnostics: true })).toEqual([])
  })
})
