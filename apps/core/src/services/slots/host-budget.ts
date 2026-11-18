import { sql } from 'drizzle-orm'
import type { db, DbTx } from '../../db'
import { getSettingsStore } from '../settings'
import { HOST_SLOT_CAPACITY_SETTING_KEY, resolveHostSlotCapacityOverride } from './host-capacity-setting'
import { rankedSlotWaiters } from './queue-order'
import { MAX_SLOT_CAPACITY } from './types'

/**
 * Host slot budget: the machine-level limit behind host-shared slot pools.
 *
 * A squad pool limits concurrency inside one squad, but on the VM runtime
 * several squads share one machine host, so each squad's own limit says
 * nothing about the total. A pool marked `hostShared` therefore draws on a
 * second budget as well: every host-shared pool of every squad whose box lives
 * on the same machine shares that machine's budget, and a claim is granted only
 * when both the pool and the machine have a free unit.
 *
 * A squad with no machine (k8s, Docker and host runtimes, or a squad whose box
 * was never placed) has no host budget, and its host-shared pools behave like
 * ordinary squad pools.
 */

type Reader = typeof db | DbTx

/** RAM one unit of the host budget stands for. */
export const HOST_SLOT_UNIT_MEM_MB = 4096
/** The same share of RAM the machine host keeps for itself (memory-model.md). */
const HOST_RESERVE_MIN_MB = 512
const HOST_RESERVE_FRACTION = 0.1
/** First key of the two-int advisory lock that serializes one machine's grants. */
const HOST_SLOT_LOCK_CLASS = 421110

/** Key of the pool a squad is given when it has never registered one. */
export const DEFAULT_HOST_POOL_KEY = 'heavy-work'
/** `created_by` of that pool. Retention keeps its row once unregistered (retention.ts). */
export const DEFAULT_HOST_POOL_CREATOR = 'system:default-host-pool'
export const DEFAULT_HOST_POOL_TIMEOUT_MS = 45 * 60 * 1000
export const DEFAULT_HOST_POOL_USAGE =
  'Machine-host capacity for memory- or CPU-heavy work in a box: dev servers, builds, full test suites, browser end-to-end runs, Docker Compose stacks and local databases. Claim before starting it, never after; if queued, end the turn and wait for the grant. Release as soon as it ends, including on failure, and stop what you started. Edits, lint, format checks and single-file tests need no claim.'

export interface HostBudget {
  machineId: string
  capacity: number
}

/**
 * Units in a machine's host budget: one per {@link HOST_SLOT_UNIT_MEM_MB} of
 * RAM left after the host's own reserve, never more than one per CPU and never
 * fewer than one, so a small host serializes heavy work and a large one runs
 * more of it.
 *
 * The `HOST_SLOT_CAPACITY` setting (Settings → System), or the
 * `FICUS_HOST_SLOT_CAPACITY` variable when nothing is stored, overrides this
 * for every machine: a positive number fixes the budget and 0 turns budgets
 * off. Read on every call, so a change applies to the next claim.
 *
 * Null when budgets are off or the machine's memory is unknown: no budget is
 * enforced then, and host-shared pools behave like ordinary squad pools.
 */
export function deriveHostSlotCapacity(
  capabilities: { memMb?: number; cpus?: number } | null | undefined
): number | null {
  const override = resolveHostSlotCapacityOverride(getSettingsStore().getStoredValue(HOST_SLOT_CAPACITY_SETTING_KEY))
  if (override === 'off') return null
  if (override !== 'auto') return override
  const memMb = capabilities?.memMb
  if (typeof memMb !== 'number' || !Number.isFinite(memMb) || memMb <= 0) return null
  const reserveMb = Math.max(HOST_RESERVE_MIN_MB, memMb * HOST_RESERVE_FRACTION)
  const memUnits = Math.floor((memMb - reserveMb) / HOST_SLOT_UNIT_MEM_MB)
  const cpus = capabilities?.cpus
  const cpuUnits = typeof cpus === 'number' && Number.isFinite(cpus) && cpus >= 1 ? Math.floor(cpus) : MAX_SLOT_CAPACITY
  return Math.max(1, Math.min(memUnits, cpuUnits, MAX_SLOT_CAPACITY))
}

type CapabilityRow = { machineId: string; capabilities: { memMb?: number; cpus?: number } | null }

function budgetOf(row: CapabilityRow | undefined): HostBudget | null {
  if (!row) return null
  const capacity = deriveHostSlotCapacity(row.capabilities)
  return capacity === null ? null : { machineId: row.machineId, capacity }
}

/**
 * The host budget a squad's host-shared pools draw on: the machine its box is
 * on, or the machine it is pinned to before the box exists.
 */
export async function resolveHostBudget(reader: Reader, squadId: string): Promise<HostBudget | null> {
  const [row] = await reader.execute<CapabilityRow>(sql`
    SELECT machine.id AS "machineId", machine.capabilities
    FROM squads squad
    LEFT JOIN machine_boxes box ON box.sandbox_id = 'squad_' || squad.id::text
    JOIN machines machine ON machine.id = COALESCE(box.machine_id, squad.machine_id)
    WHERE squad.id = ${squadId}
  `)
  return budgetOf(row)
}

export async function hostBudgetOfMachine(reader: Reader, machineId: string): Promise<HostBudget | null> {
  const [row] = await reader.execute<CapabilityRow>(sql`
    SELECT machine.id AS "machineId", machine.capabilities FROM machines machine WHERE machine.id = ${machineId}
  `)
  return budgetOf(row)
}

/**
 * Serialize every grant against one machine's budget until the transaction
 * ends. Lock order is pool rows first, then this lock: a transaction that
 * locks several pools must lock all of them before it promotes any.
 */
export async function lockHostBudget(tx: DbTx, machineId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${HOST_SLOT_LOCK_CLASS}, hashtext(${machineId}))`)
}

export interface HostGroupPool {
  id: string
  squadId: string
  capacity: number
  disabled: boolean
  /** Active claims that have not passed their expiry. */
  activeCount: number
}

export interface HostGroup {
  pools: HostGroupPool[]
  /** Claims held against the machine's budget, across every pool. */
  activeCount: number
  heldBySquad: Map<string, number>
}

/** Every registered host-shared pool of a live squad on this machine. */
export async function loadHostGroup(reader: Reader, machineId: string, now: Date): Promise<HostGroup> {
  const pools = await reader.execute<HostGroupPool & Record<string, unknown>>(sql`
    SELECT pool.id, pool.squad_id AS "squadId", pool.capacity, (pool.disabled_at IS NOT NULL) AS disabled,
      (SELECT count(*)::int FROM slot_claims claim
       WHERE claim.pool_id = pool.id AND claim.status = 'active'
         AND claim.expires_at > ${now.toISOString()}::timestamptz) AS "activeCount"
    FROM slot_pools pool
    JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
    LEFT JOIN machine_boxes box ON box.sandbox_id = 'squad_' || pool.squad_id::text
    WHERE pool.host_shared AND pool.unregistered_at IS NULL
      AND COALESCE(box.machine_id, squad.machine_id) = ${machineId}
    ORDER BY pool.id
  `)
  const heldBySquad = new Map<string, number>()
  let activeCount = 0
  for (const pool of pools) {
    activeCount += pool.activeCount
    heldBySquad.set(pool.squadId, (heldBySquad.get(pool.squadId) ?? 0) + pool.activeCount)
  }
  return { pools: [...pools], activeCount, heldBySquad }
}

export interface HostWaiter {
  waiterId: string
  poolId: string
  squadId: string
  /** Work-stream priority rank after aging (see queue-order.ts). */
  rank: number
  enqueueSequence: bigint
}

/**
 * Order waiters of different squads for one machine's budget: priority first,
 * then the squad holding fewer of the machine's units, then first come. The
 * middle key shares the machine under contention without capping a squad that
 * is alone on it.
 */
export function compareHostWaiters(a: HostWaiter, b: HostWaiter, heldBySquad: ReadonlyMap<string, number>): number {
  if (a.rank !== b.rank) return b.rank - a.rank
  const held = (heldBySquad.get(a.squadId) ?? 0) - (heldBySquad.get(b.squadId) ?? 0)
  if (held !== 0) return held
  if (a.enqueueSequence !== b.enqueueSequence) return a.enqueueSequence < b.enqueueSequence ? -1 : 1
  return a.waiterId < b.waiterId ? -1 : a.waiterId > b.waiterId ? 1 : 0
}

/**
 * Queued waiters that only the machine's budget is holding back: their own
 * pool is enabled and has a free unit. `exceptPoolId` leaves one pool out.
 */
export async function eligibleHostWaiters(
  reader: Reader,
  group: HostGroup,
  now: Date,
  exceptPoolId?: string
): Promise<HostWaiter[]> {
  const open = group.pools.filter(
    (pool) => pool.id !== exceptPoolId && !pool.disabled && pool.activeCount < pool.capacity
  )
  if (open.length === 0) return []
  const squadOfPool = new Map(open.map((pool) => [pool.id, pool.squadId]))
  const ranked = await rankedSlotWaiters(
    reader,
    open.map((pool) => pool.id),
    now
  )
  return ranked.map(({ waiter, rank }) => ({
    waiterId: waiter.id,
    poolId: waiter.poolId,
    squadId: squadOfPool.get(waiter.poolId)!,
    rank,
    enqueueSequence: waiter.enqueueSequence,
  }))
}

/** Machines that have a host-shared pool with someone queued on it. */
export async function machinesWithQueuedHostWaiters(reader: Reader): Promise<string[]> {
  const rows = await reader.execute<{ machineId: string }>(sql`
    SELECT DISTINCT COALESCE(box.machine_id, squad.machine_id) AS "machineId"
    FROM slot_pools pool
    JOIN squads squad ON squad.id = pool.squad_id AND squad.archived_at IS NULL
    LEFT JOIN machine_boxes box ON box.sandbox_id = 'squad_' || pool.squad_id::text
    JOIN slot_waiters waiter ON waiter.pool_id = pool.id AND waiter.status = 'queued'
    WHERE pool.host_shared AND pool.unregistered_at IS NULL AND pool.disabled_at IS NULL
      AND COALESCE(box.machine_id, squad.machine_id) IS NOT NULL
  `)
  return rows.map((row) => row.machineId)
}
