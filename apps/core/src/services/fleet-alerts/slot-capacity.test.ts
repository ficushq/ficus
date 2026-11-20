import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  agents,
  db,
  fleetIncidentNotifications,
  fleetIncidents,
  machineBoxes,
  machines,
  slotClaims,
  slotNotifications,
  slotPools,
  slotWaiters,
  squads,
} from '../../db'
import { Squad } from '../../entities/Squad'
import { claimSlot, registerPool, releaseSlot, setSlotPromptDrainEnabledForTest } from '../slots/store'
import { renderFleetIncidentMessage } from './message'
import { reconcileSlotCapacityWaits, SLOT_CAPACITY_WAIT_MARGIN_MS } from './slot-capacity'
import { describeSlotCapacityWait, type FleetIncidentNotificationClaim } from './store'

const POOL = 'heavy-work'
const TIMEOUT_MS = 45 * 60_000
const squadIds: string[] = []
const machineIds: string[] = []
let port = 44_000

async function machine(): Promise<string> {
  const [row] = await db
    .insert(machines)
    .values({
      name: `slot-capacity-host-${crypto.randomUUID()}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'slot-capacity-test',
      sshPublicKey: '',
      status: 'ready',
      // About 10 GB: two units of host budget.
      capabilities: { memMb: 10_000, cpus: 4 },
    })
    .returning()
  machineIds.push(row!.id)
  return row!.id
}

async function squad(machineId: string | null, withManager = true): Promise<string> {
  const id = (await Squad.create({ name: `slot-capacity-${crypto.randomUUID()}`, purpose: 'test' })).id
  squadIds.push(id)
  // Squad.create gives the squad its manager.
  if (!withManager) await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, id))
  if (machineId) {
    port += 1
    await db.insert(machineBoxes).values({ sandboxId: `squad_${id}`, machineId, unixUser: 'ficus', port })
  }
  await registerPool({
    squadId: id,
    key: POOL,
    capacity: 2,
    claimTimeoutMs: TIMEOUT_MS,
    hostShared: machineId !== null,
    createdBy: 'test',
  })
  return id
}

async function agent(squadId: string): Promise<string> {
  const [row] = await db.insert(agents).values({ squadId, agentTypeId: 'engineer', status: 'idle' }).returning()
  return row!.id
}

async function hold(squadId: string) {
  const agentId = await agent(squadId)
  const result = await claimSlot(squadId, POOL, agentId)
  if (result.outcome !== 'granted') throw new Error(`expected a grant, got ${result.outcome}`)
  return { squadId, agentId, claimId: result.claim.id }
}

/** Queue an agent, as if it had queued `minutesAgo` minutes before `now`. */
async function queue(squadId: string, now: Date, minutesAgo: number) {
  const agentId = await agent(squadId)
  const result = await claimSlot(squadId, POOL, agentId)
  if (result.outcome !== 'queued') throw new Error(`expected to queue, got ${result.outcome}`)
  await db
    .update(slotWaiters)
    .set({ queuedAt: new Date(now.getTime() - minutesAgo * 60_000) })
    .where(eq(slotWaiters.id, result.waiter.id))
  return result.waiter.id
}

async function incidentsOf(squadId: string) {
  const incidents = await db.select().from(fleetIncidents).where(eq(fleetIncidents.squadId, squadId))
  const notices = incidents.length
    ? await db
        .select()
        .from(fleetIncidentNotifications)
        .where(
          inArray(
            fleetIncidentNotifications.incidentId,
            incidents.map((row) => row.id)
          )
        )
    : []
  return { incidents, notices }
}

function claimFor(
  incident: typeof fleetIncidents.$inferSelect,
  phase: 'alert' | 'recovery'
): FleetIncidentNotificationClaim {
  return {
    notificationId: crypto.randomUUID(),
    incidentId: incident.id,
    audience: 'human',
    recipientId: 'system',
    idempotencyKey: null,
    phase,
    claimToken: crypto.randomUUID(),
    attempts: 0,
    incidentResolvedAt: incident.resolvedAt,
    incidentStartedAt: incident.startedAt,
    incidentKind: incident.kind,
    squadId: incident.squadId ?? undefined,
    scopeKey: incident.scopeKey,
    causeCode: incident.causeCode,
    causeSummary: incident.causeSummary,
    remediation: incident.remediation ?? undefined,
    details: incident.details,
  }
}

beforeEach(() => setSlotPromptDrainEnabledForTest(false))

afterEach(async () => {
  setSlotPromptDrainEnabledForTest(true)
  if (squadIds.length) {
    const incidents = await db
      .select({ id: fleetIncidents.id })
      .from(fleetIncidents)
      .where(inArray(fleetIncidents.squadId, squadIds))
    if (incidents.length) {
      const ids = incidents.map((row) => row.id)
      await db.delete(fleetIncidentNotifications).where(inArray(fleetIncidentNotifications.incidentId, ids))
      await db.delete(fleetIncidents).where(inArray(fleetIncidents.id, ids))
    }
    const pools = await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
    const poolIds = pools.map((pool) => pool.id)
    if (poolIds.length) {
      await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
      await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
      await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
    }
    await db.delete(agents).where(inArray(agents.squadId, squadIds))
    await db.delete(machineBoxes).where(
      inArray(
        machineBoxes.sandboxId,
        squadIds.map((id) => `squad_${id}`)
      )
    )
    await db.delete(squads).where(inArray(squads.id, squadIds))
  }
  if (machineIds.length) await db.delete(machines).where(inArray(machines.id, machineIds))
  squadIds.length = 0
  machineIds.length = 0
})

describe('long slot capacity waits', () => {
  test('a queue within the claim timeout plus margin raises nothing', async () => {
    const host = await machine()
    const mine = await squad(host)
    const other = await squad(host)
    await hold(other)
    await hold(other)
    const now = new Date()
    await queue(mine, now, (TIMEOUT_MS + SLOT_CAPACITY_WAIT_MARGIN_MS) / 60_000 - 1)
    await reconcileSlotCapacityWaits({ now })
    expect((await incidentsOf(mine)).incidents).toEqual([])
  })

  test('a host budget held by other squads alerts with counts only, manager first, and recovers on grant', async () => {
    const host = await machine()
    const mine = await squad(host)
    const other = await squad(host)
    const first = await hold(other)
    await hold(other)
    const now = new Date()
    await queue(mine, now, 70)
    await queue(mine, now, 20)
    await reconcileSlotCapacityWaits({ now })

    const { incidents, notices } = await incidentsOf(mine)
    expect(incidents).toHaveLength(1)
    const incident = incidents[0]!
    expect(incident).toMatchObject({
      kind: 'slot_capacity_wait',
      causeCode: 'slot-host-held-elsewhere',
      resolvedAt: null,
    })
    expect(incident.details).toEqual({
      poolKey: POOL,
      queuedCount: 2,
      oldestQueuedAt: new Date(now.getTime() - 70 * 60_000).toISOString(),
      claimTimeoutMs: TIMEOUT_MS,
      capacity: 2,
      activeCount: 0,
      hostShared: true,
      hostCapacity: 2,
      hostActiveCount: 2,
      hostHeldByOtherSquads: 2,
    })
    // Never the other squad's name, agents or streams.
    expect(JSON.stringify(incident)).not.toContain(other)
    expect(incident.remediation).not.toContain('sandbox')
    expect(
      notices
        .filter((row) => row.kind === 'alert')
        .map((row) => row.audience)
        .sort()
    ).toEqual(['human', 'manager'])
    const human = notices.find((row) => row.audience === 'human')!
    expect(human.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime())

    const message = renderFleetIncidentMessage(claimFor(incident, 'alert'), { squadName: 'Ficus' }, now)
    expect(message.subject).toBe('Squad Ficus: waiting 1h 10m for heavy-work slot')
    expect(message.content).toContain(
      "2 agents in squad Ficus are queued for the heavy-work slot; the oldest has waited 1h 10m, longer than the pool's 45m claim timeout. Their work is waiting for capacity, not stalled."
    )
    expect(message.content).toContain('Host budget: 2 of 2 units in use, 2 held by other squads')
    expect(message.content).toContain('Fix: Nothing needs restarting')
    expect(message.content).not.toContain('sandbox-status')
    expect(message.content).not.toContain('worker pickup')

    // A second sweep refreshes the same episode instead of opening another.
    await reconcileSlotCapacityWaits({ now: new Date(now.getTime() + 60_000) })
    expect((await incidentsOf(mine)).incidents).toHaveLength(1)

    // The release goes to the oldest waiter; the remaining 20-minute wait is ordinary.
    await releaseSlot(first.squadId, POOL, first.agentId, first.claimId)
    await reconcileSlotCapacityWaits({ now: new Date(now.getTime() + 2 * 60_000) })
    const [resolved] = (await incidentsOf(mine)).incidents
    expect(resolved!.resolvedAt).not.toBeNull()
    const recovery = renderFleetIncidentMessage(claimFor(resolved!, 'recovery'), { squadName: 'Ficus' }, now)
    expect(recovery.subject).toBe('Squad Ficus: heavy-work slot queue is moving again')
  })

  test("a pool held by the squad's own agents points at its holders", async () => {
    const mine = await squad(null)
    await hold(mine)
    await hold(mine)
    const now = new Date()
    await queue(mine, now, 61)
    await reconcileSlotCapacityWaits({ now })
    const [incident] = (await incidentsOf(mine)).incidents
    expect(incident).toMatchObject({ causeCode: 'slot-held-by-squad' })
    expect(incident!.remediation).toContain('ficus slot list')
    expect(incident!.details).not.toHaveProperty('hostCapacity')
  })

  test('without a valid manager humans hear at once', async () => {
    const mine = await squad(null, false)
    await hold(mine)
    await hold(mine)
    const now = new Date()
    await queue(mine, now, 61)
    await reconcileSlotCapacityWaits({ now })
    const { notices } = await incidentsOf(mine)
    expect(notices.find((row) => row.audience === 'manager')!.status).toBe('skipped')
    expect(notices.find((row) => row.audience === 'human')!.nextAttemptAt.getTime()).toBeLessThanOrEqual(now.getTime())
  })
})

describe('describeSlotCapacityWait', () => {
  const base = {
    poolKey: POOL,
    queuedCount: 3,
    oldestQueuedAt: new Date().toISOString(),
    claimTimeoutMs: TIMEOUT_MS,
    capacity: 2,
    hostShared: true,
  }

  test('names the reason from counts alone', () => {
    expect(
      describeSlotCapacityWait({
        ...base,
        activeCount: 0,
        hostCapacity: 2,
        hostActiveCount: 2,
        hostHeldByOtherSquads: 2,
      }).summary
    ).toBe("The machine host's budget for host-shared pools is full: other squads hold 2 of its 2 units.")
    expect(
      describeSlotCapacityWait({
        ...base,
        activeCount: 2,
        hostCapacity: 2,
        hostActiveCount: 2,
        hostHeldByOtherSquads: 0,
      }).code
    ).toBe('slot-held-by-squad')
    // Free capacity with a standing queue is the one case that needs an operator.
    const stuck = describeSlotCapacityWait({ ...base, activeCount: 0, hostCapacity: 2, hostActiveCount: 0 })
    expect(stuck.code).toBe('slot-queue-not-granted')
    expect(stuck.remediation).toContain('operator')
  })
})
