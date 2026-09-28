import { sql } from 'drizzle-orm'
import type { SandboxPressure } from '@ficus/shared'
import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { isVmRuntime } from '../sandbox/runtime'
import { listOpenSandboxOverloadSandboxIds, observeSandboxOverload } from './store'

const log = createLogger('fleet-sandbox-overload')

/** Per-box budget for attaching and reading `/healthz`; a slower box is skipped this tick. */
export const SANDBOX_PRESSURE_PROBE_TIMEOUT_MS = 5_000
/** Boxes probed per tick. With the concurrency below, a tick's worst case stays well inside its 60s interval. */
export const MAX_SANDBOX_PRESSURE_PROBES = 48
const PROBE_CONCURRENCY = 8

export interface SandboxOverloadReconcileDeps {
  isVmRuntime?: () => boolean
  /**
   * Live boxes an agent is running in right now. Only these are probed: a
   * `/healthz` request wakes a socket-activated box and resets its idle-exit
   * clock, so probing a box nobody is using would wake it or keep it (and any
   * runaway job in it) alive.
   */
  listBusySandboxIds?: () => Promise<string[]>
  listOpenIncidentSandboxIds?: () => Promise<string[]>
  /** One box's current load and memory; null or a rejection means no reading. */
  readPressure?: (sandboxId: string) => Promise<SandboxPressure | null | undefined>
  observe?: typeof observeSandboxOverload
  probeTimeoutMs?: number
  maxProbes?: number
}

interface BusySandboxRow extends Record<string, unknown> {
  sandboxId: string
}

/**
 * Ready VM boxes with a running execution: the agent's own box and, for squad
 * members, the squad box. A running agent is talking to its boxes, so their
 * servers are already awake and one more request neither wakes them nor keeps
 * them up past the agent's run.
 */
export async function listBusySandboxIds(): Promise<string[]> {
  const rows = await db.execute<BusySandboxRow>(sql`
    WITH running AS (
      SELECT DISTINCT agent.id AS agent_id, agent.squad_id
      FROM executions AS execution
      JOIN agents AS agent ON agent.id = execution.agent_id
      WHERE execution.status = 'running'
    ),
    busy AS (
      SELECT 'agent_' || agent_id::text AS sandbox_id FROM running
      UNION
      SELECT 'squad_' || squad_id::text AS sandbox_id FROM running WHERE squad_id IS NOT NULL
    )
    SELECT box.sandbox_id AS "sandboxId"
    FROM machine_boxes AS box
    JOIN busy ON busy.sandbox_id = box.sandbox_id
    WHERE box.status = 'ready'
    ORDER BY box.sandbox_id
  `)
  return rows.map((row) => row.sandboxId)
}

async function readPressureFromBox(sandboxId: string): Promise<SandboxPressure | undefined> {
  const { getSandboxManager } = await import('../sandbox/factory')
  const manager = getSandboxManager() as unknown as {
    getOrAttachClient?: (id: string) => Promise<{ health(): Promise<{ pressure?: SandboxPressure }> } | null>
  }
  const client = await manager.getOrAttachClient?.(sandboxId)
  if (!client) return undefined
  return (await client.health()).pressure
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function forEachBounded<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!)
  })
  await Promise.all(workers)
}

/**
 * Probes boxes with an open episode first, then rotates through the rest by
 * minute so a fleet larger than the cap is still covered over successive ticks.
 */
function chooseProbes(busy: readonly string[], open: ReadonlySet<string>, cap: number, now: Date): string[] {
  const first = busy.filter((id) => open.has(id))
  const rest = busy.filter((id) => !open.has(id))
  const offset = rest.length ? Math.floor(now.getTime() / 60_000) % rest.length : 0
  return [...first, ...rest.slice(offset), ...rest.slice(0, offset)].slice(0, cap)
}

/**
 * Sample the load of busy VM boxes and record overload episodes. VM only: the
 * other runtimes have no shared machine to overload. A box that fails or times
 * out is simply not read this tick, and an open episode no box reading renews
 * is closed by the store once it goes stale.
 */
export async function reconcileSandboxOverload(
  input: { now: Date },
  deps: SandboxOverloadReconcileDeps = {}
): Promise<void> {
  if (!(deps.isVmRuntime ?? isVmRuntime)()) return
  const observe = deps.observe ?? observeSandboxOverload
  const readPressure = deps.readPressure ?? readPressureFromBox
  const timeoutMs = deps.probeTimeoutMs ?? SANDBOX_PRESSURE_PROBE_TIMEOUT_MS

  const [busy, open] = await Promise.all([
    (deps.listBusySandboxIds ?? listBusySandboxIds)(),
    (deps.listOpenIncidentSandboxIds ?? listOpenSandboxOverloadSandboxIds)(),
  ])
  const openIds = new Set(open)
  const probes = chooseProbes(busy, openIds, deps.maxProbes ?? MAX_SANDBOX_PRESSURE_PROBES, input.now)

  const read = new Set<string>()
  await forEachBounded(probes, PROBE_CONCURRENCY, async (sandboxId) => {
    const pressure = await withTimeout(
      readPressure(sandboxId).catch(() => undefined),
      timeoutMs
    )
    if (!pressure) return
    read.add(sandboxId)
    await observe({ status: 'sampled', sandboxId, pressure, now: input.now }).catch((error) =>
      log.warn(`Recording load for ${sandboxId} failed:`, error)
    )
  })

  await forEachBounded(
    open.filter((sandboxId) => !read.has(sandboxId)),
    PROBE_CONCURRENCY,
    async (sandboxId) => {
      await observe({ status: 'unobserved', sandboxId, now: input.now }).catch((error) =>
        log.warn(`Closing stale overload episode for ${sandboxId} failed:`, error)
      )
    }
  )
}
