import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createBlankWorkflow,
  createWorkflowRun,
  resolveWorkflow,
  selectWorkStreamPresentationState,
  workStreamSlotWaitLabel,
} from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import {
  agents,
  db,
  executions,
  machineBoxes,
  machines,
  slotClaims,
  slotNotifications,
  slotPools,
  slotWaiters,
  squads,
  workStreamFlowRuns,
  workStreams,
} from '../../db'
import { Squad } from '../../entities/Squad'
import { claimSlot, registerPool, releaseSlot, setSlotPromptDrainEnabledForTest } from '../slots/store'
import { computeDerivedStates } from './derived-state'
import { loadStreamSlotWaits } from './slot-waits'

const POOL = 'heavy-work'
const squadIds: string[] = []
const machineIds: string[] = []
let port = 43_000

async function machine(): Promise<string> {
  const [row] = await db
    .insert(machines)
    .values({
      name: `slot-wait-host-${crypto.randomUUID()}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'slot-wait-test',
      sshPublicKey: '',
      status: 'ready',
      // About 10 GB: two units of host budget.
      capabilities: { memMb: 10_000, cpus: 4 },
    })
    .returning()
  machineIds.push(row!.id)
  return row!.id
}

async function squad(machineId: string | null, capacity = 1): Promise<string> {
  const id = (await Squad.create({ name: `slot-wait-${crypto.randomUUID()}`, purpose: 'test' })).id
  squadIds.push(id)
  if (machineId) {
    port += 1
    await db.insert(machineBoxes).values({ sandboxId: `squad_${id}`, machineId, unixUser: 'ficus', port })
  }
  await registerPool({ squadId: id, key: POOL, capacity, hostShared: machineId !== null, createdBy: 'test' })
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

/** An active flow stream whose attempt 1 participant queued for the pool during its own turn, then went idle. */
async function queuedStream(squadId: string) {
  const owner = await agent(squadId)
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Queued for capacity', status: 'active', assigneeAgentId: owner, agentIds: [owner] })
    .returning()
  const definition = createBlankWorkflow()
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream!.id,
    activated: true,
    state: createWorkflowRun(definition),
    source: resolveWorkflow({ kind: 'inline', definition }),
    attemptAgents: { '1': owner },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'test',
    createdBy: 'test',
  })
  const [turn] = await db
    .insert(executions)
    .values({
      agentId: owner,
      status: 'running',
      startedAt: new Date(Date.now() - 60_000),
      runStartedAt: new Date(Date.now() - 60_000),
      flowContext: { workStreamId: stream!.id, attemptId: 1, stepId: definition.steps[0]!.id },
    })
    .returning()
  const result = await claimSlot(squadId, POOL, owner)
  if (result.outcome !== 'queued') throw new Error(`expected to queue, got ${result.outcome}`)
  // Queued, the agent ends its turn as the slot rules require.
  await db
    .update(executions)
    .set({ status: 'completed', endedAt: new Date(Date.now() + 1_000) })
    .where(eq(executions.id, turn!.id))
  return { streamId: stream!.id, owner, waiterId: result.waiter.id }
}

async function presentation(streamId: string) {
  const [row] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  const derived = (await computeDerivedStates([row!])).get(streamId)!
  return { derived, state: selectWorkStreamPresentationState({ status: row!.status, ...derived }) }
}

beforeEach(() => setSlotPromptDrainEnabledForTest(false))

afterEach(async () => {
  setSlotPromptDrainEnabledForTest(true)
  if (squadIds.length) {
    const pools = await db.select({ id: slotPools.id }).from(slotPools).where(inArray(slotPools.squadId, squadIds))
    const poolIds = pools.map((pool) => pool.id)
    if (poolIds.length) {
      await db.delete(slotNotifications).where(inArray(slotNotifications.poolId, poolIds))
      await db.delete(slotWaiters).where(inArray(slotWaiters.poolId, poolIds))
      await db.delete(slotClaims).where(inArray(slotClaims.poolId, poolIds))
      await db.delete(slotPools).where(inArray(slotPools.id, poolIds))
    }
    const streams = await db
      .select({ id: workStreams.id })
      .from(workStreams)
      .where(inArray(workStreams.squadId, squadIds))
    if (streams.length)
      await db.delete(workStreamFlowRuns).where(
        inArray(
          workStreamFlowRuns.workStreamId,
          streams.map((stream) => stream.id)
        )
      )
    await db.delete(workStreams).where(inArray(workStreams.squadId, squadIds))
    const owners = await db.select({ id: agents.id }).from(agents).where(inArray(agents.squadId, squadIds))
    if (owners.length)
      await db.delete(executions).where(
        inArray(
          executions.agentId,
          owners.map((owner) => owner.id)
        )
      )
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

describe('a stream whose participant is queued for a slot', () => {
  test('shows the pool, its queue position and a busy host while queued, and clears on grant', async () => {
    const host = await machine()
    const mine = await squad(host, 2)
    const other = await squad(host, 2)
    // Another squad holds both units of the machine host's budget.
    const first = await hold(other)
    const second = await hold(other)
    const earlier = await agent(mine)
    expect((await claimSlot(mine, POOL, earlier)).outcome).toBe('queued')
    const { streamId } = await queuedStream(mine)

    const slotWait = (await loadStreamSlotWaits([streamId])).get(streamId)
    expect(slotWait).toMatchObject({ poolKey: POOL, attemptId: 1, position: 2, queuedCount: 2, hostBusy: true })
    expect(workStreamSlotWaitLabel(slotWait)).toBe('Waiting for heavy-work slot (position 2 of 2, host busy)')
    const queued = await presentation(streamId)
    expect(queued.derived).toMatchObject({ derivedState: 'idle', hasActiveSlotWait: true, slotWait })
    expect(queued.state).toBe('waiting_for_slot')
    // Nothing about the other squad leaks beyond the single host fact.
    expect(Object.keys(slotWait!).sort()).toEqual([
      'attemptId',
      'hostBusy',
      'poolKey',
      'position',
      'queuedAt',
      'queuedCount',
    ])

    // The first release goes to the earlier waiter; the stream moves up to the front.
    await releaseSlot(first.squadId, POOL, first.agentId, first.claimId)
    expect((await loadStreamSlotWaits([streamId])).get(streamId)).toMatchObject({ position: 1, queuedCount: 1 })

    await releaseSlot(second.squadId, POOL, second.agentId, second.claimId)
    expect((await loadStreamSlotWaits([streamId])).has(streamId)).toBe(false)
    const granted = await presentation(streamId)
    expect(granted.derived.hasActiveSlotWait).toBe(false)
    expect(granted.derived.slotWait).toBeUndefined()
    expect(granted.state).toBe('idle')
  })

  test('a squad-only pool reports its position without any host fact', async () => {
    const mine = await squad(null, 1)
    await hold(mine)
    const { streamId } = await queuedStream(mine)
    const slotWait = (await loadStreamSlotWaits([streamId])).get(streamId)!
    expect(slotWait).toMatchObject({ poolKey: POOL, position: 1, queuedCount: 1 })
    expect(slotWait.hostBusy).toBeUndefined()
    expect(workStreamSlotWaitLabel(slotWait)).toBe('Waiting for heavy-work slot (position 1)')
  })
})
