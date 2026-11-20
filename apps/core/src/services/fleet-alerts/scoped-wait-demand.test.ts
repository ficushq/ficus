import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, resolveWorkflow } from '@ficus/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  fleetIncidents,
  fleetIncidentNotifications,
  inbox,
  schedules,
  slotPools,
  slotWaiters,
  squads,
  workStreams,
  workStreamFlowRuns,
} from '../../db/schema'
import { getSquadDemandSnapshots } from './demand'
import { reconcileDeadFleet } from './dead-fleet'

const START = new Date('2026-08-18T12:00:00Z')
const at = (minutes: number) => new Date(START.getTime() + minutes * 60_000)
const NOW = at(45)

describe('route-scoped slot waiting and alternative participant clocks', () => {
  let squadId: string
  let owner: string
  let sibling: string
  let streamId: string
  let poolId: string
  let definition: ReturnType<typeof createBlankWorkflow>

  beforeEach(async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: 'Scoped slot fixture', purpose: 'Fleet demand scope' })
      .returning()
    squadId = squad!.id
    const participants = await db
      .insert(agents)
      .values([0, 1].map(() => ({ squadId, agentTypeId: 'engineer', status: 'idle' as const })))
      .returning()
    owner = participants[0]!.id
    sibling = participants[1]!.id
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId,
        title: 'Scoped demand',
        status: 'active',
        assigneeAgentId: owner,
        agentIds: [owner],
        createdAt: START,
      })
      .returning()
    streamId = stream!.id
    definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: streamId,
      activated: true,
      state: createWorkflowRun(definition),
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': owner },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
      createdAt: START,
      updatedAt: START,
    })
    const [pool] = await db
      .insert(slotPools)
      .values({
        squadId,
        key: 'heavy-work',
        capacity: 1,
        hostShared: true,
        claimTimeoutMs: 60 * 60_000,
        createdBy: 'test',
      })
      .returning()
    poolId = pool!.id
  })

  afterEach(async () => {
    const incidents = await db
      .select({ id: fleetIncidents.id })
      .from(fleetIncidents)
      .where(eq(fleetIncidents.squadId, squadId))
    if (incidents.length) {
      await db.delete(fleetIncidentNotifications).where(
        inArray(
          fleetIncidentNotifications.incidentId,
          incidents.map((row) => row.id)
        )
      )
      await db.delete(fleetIncidents).where(
        inArray(
          fleetIncidents.id,
          incidents.map((row) => row.id)
        )
      )
    }
    await db.delete(slotWaiters).where(eq(slotWaiters.poolId, poolId))
    await db.delete(slotPools).where(eq(slotPools.id, poolId))
    await db.delete(schedules).where(eq(schedules.scopeId, squadId))
    const owners = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        owners.map((row) => row.id)
      )
    )
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  async function run(agentId = owner, minutes = 2, attemptId: number | null = 1, workStreamId = streamId) {
    return db
      .insert(executions)
      .values({
        agentId,
        status: 'completed',
        startedAt: at(minutes - 1),
        runStartedAt: at(minutes - 1),
        endedAt: at(minutes),
        flowContext: attemptId == null ? null : { workStreamId, attemptId, stepId: definition.steps[0]!.id },
      })
      .returning()
  }

  async function wait(attemptId = 1, workStreamId = streamId, minutes = 1) {
    await run(owner, minutes + 1, attemptId, workStreamId)
    const [waiter] = await db
      .insert(slotWaiters)
      .values({ poolId, ownerAgentId: owner, queuedAt: at(minutes) })
      .returning()
    return waiter!
  }

  async function observe(now = NOW) {
    const snapshot = (await getSquadDemandSnapshots({ now })).get(squadId)!
    await reconcileDeadFleet({ now, demand: new Map([[squadId, snapshot]]) })
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
    return { snapshot, incidents, notices }
  }

  test('an attributed waiter exempts its current attempt for as long as it stays queued, past the pool timeout', async () => {
    const waiter = await wait()
    expect((await observe()).snapshot.count).toBe(0)
    expect((await observe()).incidents).toEqual([])
    // Waiting for capacity is not a stall at any age; a long queue is the separate slot_capacity_wait alert.
    for (const minutes of [61, 300]) {
      const later = await observe(at(minutes))
      expect(later.snapshot.count).toBe(0)
      expect(later.incidents).toEqual([])
    }
    expect((await db.select().from(slotWaiters).where(eq(slotWaiters.id, waiter.id)))[0]!.status).toBe('queued')

    // Once granted, the attempt is ordinary demand again with a fresh readmission clock.
    await db
      .update(slotWaiters)
      .set({ status: 'granted', endedAt: at(300) })
      .where(eq(slotWaiters.id, waiter.id))
    const granted = await observe(at(310))
    expect(granted.snapshot.count).toBe(1)
    expect(granted.notices).toEqual([])
    const unserved = await observe(at(331))
    expect(unserved.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    expect(unserved.incidents[0]!.causeCode).toBe('demand-not-served')
  })

  test('the reported shape: a 45-minute host-shared pool queued for 48 minutes stays quiet', async () => {
    await db
      .update(slotPools)
      .set({ claimTimeoutMs: 45 * 60_000 })
      .where(eq(slotPools.id, poolId))
    await wait(1, streamId, 1)
    const result = await observe(at(49))
    expect(result.snapshot.count).toBe(0)
    expect(result.incidents).toEqual([])
  })

  test('the same idle attempt without a subscription still alerts as an unexplained stall', async () => {
    await run()
    const result = await observe()
    expect(result.snapshot.count).toBe(1)
    expect(result.incidents[0]!.causeCode).toBe('demand-not-served')
    expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
  })

  test.each(['queued execution', 'inbox', 'schedule'] as const)(
    'a valid slot wait does not hide independent %s demand for the same agent',
    async (source) => {
      await wait()
      if (source === 'queued execution')
        await db.insert(executions).values({ agentId: owner, status: 'queued', startedAt: at(5) })
      else if (source === 'inbox')
        await db.insert(inbox).values({
          recipientType: 'agent',
          recipientId: owner,
          senderType: 'system',
          content: 'Independent control',
          createdAt: at(5),
        })
      else
        await db.insert(schedules).values({
          scopeType: 'squad',
          scopeId: squadId,
          name: 'Independent reminder',
          enabled: true,
          schedule: { runAt: at(5).toISOString() },
          action: {
            type: 'inbox_message',
            target: { type: 'agent', agentId: owner },
            content: 'Independent reminder',
          },
          nextTriggerAt: at(5),
        })
      const result = await observe()
      expect(result.snapshot.count).toBe(1)
      expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test.each(['old attempt', 'other stream', 'unpinned', 'legacy stream'] as const)(
    'a waiter attributed to %s cannot cover the current demand route',
    async (scope) => {
      if (scope === 'old attempt') await wait(99)
      else if (scope === 'other stream') await wait(1, crypto.randomUUID())
      else if (scope === 'legacy stream') {
        await wait()
        await db.delete(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
      } else {
        await wait()
        await db
          .update(workStreamFlowRuns)
          .set({ attemptAgents: {} })
          .where(eq(workStreamFlowRuns.workStreamId, streamId))
      }
      const result = await observe()
      expect(result.snapshot.count).toBe(1)
      expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test.each(['same agent', 'different agent'] as const)(
    'a waiting attempt cannot hide a parallel attempt owned by the %s',
    async (ownership) => {
      const state = createWorkflowRun(definition)
      state.attempts.push({ ...state.attempts[0]!, id: 2 })
      await db
        .update(workStreamFlowRuns)
        .set({ state, attemptAgents: { '1': owner, '2': ownership === 'same agent' ? owner : sibling } })
        .where(eq(workStreamFlowRuns.workStreamId, streamId))
      await wait()
      const result = await observe()
      expect(result.snapshot.count).toBe(1)
      expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test.each(['missing provenance', 'outside execution interval', 'missing execution'] as const)(
    'a subscription with %s cannot cover stream demand',
    async (origin) => {
      if (origin === 'missing execution')
        await db.insert(slotWaiters).values({ poolId, ownerAgentId: owner, queuedAt: at(1) })
      else {
        await wait()
        await db
          .update(executions)
          .set(
            origin === 'missing provenance'
              ? { flowContext: null }
              : { startedAt: at(-2), runStartedAt: at(-2), endedAt: at(-1) }
          )
          .where(eq(executions.agentId, owner))
      }
      const result = await observe()
      expect(result.snapshot.count).toBe(1)
      expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test('a subscription queued for several hours is a capacity wait, not a stall', async () => {
    await db
      .update(workStreams)
      .set({ createdAt: at(-300) })
      .where(eq(workStreams.id, streamId))
    await db
      .update(workStreamFlowRuns)
      .set({ createdAt: at(-300) })
      .where(eq(workStreamFlowRuns.workStreamId, streamId))
    await wait(1, streamId, -240)
    const result = await observe()
    expect(result.snapshot.count).toBe(0)
    expect(result.incidents).toEqual([])
  })

  test('subscribing cannot resolve an incident while independent overdue inbox work remains', async () => {
    await run()
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: owner,
      senderType: 'system',
      content: 'Independent control',
      createdAt: at(5),
    })
    const stalled = await observe()
    const incident = stalled.incidents[0]!
    await db
      .update(fleetIncidentNotifications)
      .set({ status: 'delivered', deliveredAt: NOW })
      .where(
        and(eq(fleetIncidentNotifications.incidentId, incident.id), eq(fleetIncidentNotifications.audience, 'manager'))
      )
    await wait(1, streamId, 44)
    const waiting = await observe(at(46))
    expect(waiting.snapshot.count).toBe(1)
    expect(waiting.incidents[0]!.id).toBe(incident.id)
    expect(waiting.incidents[0]!.resolvedAt).toBeNull()
    expect(waiting.notices.filter((row) => row.kind === 'recovery')).toEqual([])
  })

  test.each(['legacy', 'completion-ready', 'unbound attempt'] as const)(
    'alternative owners of a %s route use newest progress, then expire',
    async (mode) => {
      await db
        .update(workStreams)
        .set({ agentIds: [owner, sibling] })
        .where(eq(workStreams.id, streamId))
      if (mode === 'legacy') await db.delete(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
      else {
        const state = createWorkflowRun(definition)
        if (mode === 'completion-ready') {
          state.status = 'completion-ready'
          state.attempts[0]!.status = 'completed'
          state.definition.completion = { mode: 'pr-auto-merge', followChanges: true }
        }
        await db
          .update(workStreamFlowRuns)
          .set({ state, attemptAgents: mode === 'unbound attempt' ? {} : { '1': owner } })
          .where(eq(workStreamFlowRuns.workStreamId, streamId))
      }
      await run(owner, 44, mode === 'legacy' ? null : 1)
      await run(sibling, -5, mode === 'legacy' ? null : 1)
      const fresh = await observe()
      expect(fresh.snapshot.unservedSince).toEqual(at(44))
      expect(fresh.notices).toEqual([])
      expect((await observe(at(74 - 1 / 60_000))).notices).toEqual([])
      expect((await observe(at(74))).notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test.each(['completion-ready', 'unbound attempt'] as const)(
    'a historical-only owner cannot lend fresh progress to a %s routing audience',
    async (mode) => {
      const [historical] = await db
        .insert(agents)
        .values({ squadId, agentTypeId: 'engineer', status: 'idle' })
        .returning()
      const state = createWorkflowRun(definition)
      state.attempts.push({ ...state.attempts[0]!, id: 99, status: 'completed' })
      if (mode === 'completion-ready') {
        state.status = 'completion-ready'
        state.attempts[0]!.status = 'completed'
        state.definition.completion = { mode: 'pr-auto-merge', followChanges: true }
      }
      await db
        .update(workStreamFlowRuns)
        .set({ state, attemptAgents: { '99': historical!.id } })
        .where(eq(workStreamFlowRuns.workStreamId, streamId))
      await db
        .update(workStreams)
        .set({ agentIds: [owner, sibling] })
        .where(eq(workStreams.id, streamId))
      await run(owner, 2)
      await run(sibling, -5)
      await run(historical!.id, 44, 99)
      const result = await observe()
      expect(result.snapshot.unservedSince).toEqual(at(2))
      expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
    }
  )

  test('independent pinned attempts still use the oldest clock', async () => {
    const state = createWorkflowRun(definition)
    state.attempts.push({ ...state.attempts[0]!, id: 2 })
    await db
      .update(workStreamFlowRuns)
      .set({ state, attemptAgents: { '1': owner, '2': sibling } })
      .where(eq(workStreamFlowRuns.workStreamId, streamId))
    await db
      .update(workStreams)
      .set({ agentIds: [owner, sibling] })
      .where(eq(workStreams.id, streamId))
    await run(owner, 44, 1)
    await run(sibling, -5, 2)
    const result = await observe()
    expect(result.snapshot.unservedSince).toEqual(START)
    expect(result.notices.filter((row) => row.kind === 'alert')).toHaveLength(2)
  })
})
