import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun, resolveWorkflow, type WorkflowStep } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db'
import {
  agents,
  executions,
  inbox,
  instanceMaintenanceState,
  localDeployments,
  monitors,
  schedules,
  squads,
  workStreamWaits,
  workStreamFlowRuns,
  workStreams,
} from '../../db/schema'
import { MONITOR_LIVENESS_WINDOW_MS } from '../monitors/liveness'
import { getSquadDemandSnapshots, SUPERVISED_ACTIVITY_WINDOW_MS } from './demand'

const NOW = new Date('2026-08-18T12:00:00.000Z')
const at = (minutesBeforeNow: number) => new Date(NOW.getTime() - minutesBeforeNow * 60_000)

describe('actionable squad demand', () => {
  let targetSquadId: string
  let crossSquadId: string
  let quietSquadId: string
  let targetAgentId: string
  let secondTargetAgentId: string
  let terminatedTargetAgentId: string
  let liveTargetAgentId: string
  let crossAgentId: string
  let quietAgentId: string
  let ownedSquadIds: string[]
  let ownedScheduleIds: string[]

  beforeEach(async () => {
    targetSquadId = crypto.randomUUID()
    crossSquadId = crypto.randomUUID()
    quietSquadId = crypto.randomUUID()
    targetAgentId = crypto.randomUUID()
    secondTargetAgentId = crypto.randomUUID()
    terminatedTargetAgentId = crypto.randomUUID()
    liveTargetAgentId = crypto.randomUUID()
    crossAgentId = crypto.randomUUID()
    quietAgentId = crypto.randomUUID()
    ownedSquadIds = [targetSquadId, crossSquadId, quietSquadId]
    ownedScheduleIds = []

    await db.insert(squads).values([
      { id: targetSquadId, name: `demand-target-${targetSquadId}`, purpose: 'demand matrix' },
      { id: crossSquadId, name: `demand-cross-${crossSquadId}`, purpose: 'cross-squad grouping' },
      { id: quietSquadId, name: `demand-quiet-${quietSquadId}`, purpose: 'quiet squad' },
    ])
    await db.insert(agents).values([
      { id: targetAgentId, agentTypeId: 'engineer', squadId: targetSquadId, status: 'idle' },
      { id: secondTargetAgentId, agentTypeId: 'reviewer', squadId: targetSquadId, status: 'idle' },
      {
        id: terminatedTargetAgentId,
        agentTypeId: 'engineer',
        squadId: targetSquadId,
        status: 'terminated',
        terminatedAt: at(1),
      },
      { id: liveTargetAgentId, agentTypeId: 'engineer', squadId: targetSquadId, status: 'active' },
      { id: crossAgentId, agentTypeId: 'engineer', squadId: crossSquadId, status: 'idle' },
      { id: quietAgentId, agentTypeId: 'engineer', squadId: quietSquadId, status: 'idle' },
    ])
  })

  afterEach(async () => {
    if (ownedScheduleIds.length) await db.delete(schedules).where(inArray(schedules.id, ownedScheduleIds))
    await db
      .delete(inbox)
      .where(
        inArray(inbox.recipientId, [
          targetAgentId,
          secondTargetAgentId,
          terminatedTargetAgentId,
          liveTargetAgentId,
          crossAgentId,
          quietAgentId,
        ])
      )
    await db.delete(squads).where(inArray(squads.id, ownedSquadIds))
  })

  async function addSchedule(input: {
    scopeType: 'agent' | 'squad'
    scopeId: string
    enabled?: boolean
    nextTriggerAt?: Date | null
    schedule?: Record<string, unknown>
    action?: Record<string, unknown>
    webhookEnabled?: boolean
  }) {
    const id = crypto.randomUUID()
    ownedScheduleIds.push(id)
    await db.insert(schedules).values({
      id,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      name: `demand-schedule-${id}`,
      enabled: input.enabled ?? true,
      schedule: input.schedule ?? { runAt: at(1).toISOString() },
      action: input.action ?? { type: 'create_work_stream', title: `scheduled-${id}` },
      nextTriggerAt: input.nextTriggerAt === undefined ? at(1) : input.nextTriggerAt,
      webhookEnabled: input.webhookEnabled ?? false,
      createdAt: at(2),
      updatedAt: at(2),
    })
    return id
  }

  async function addWorkStream(input: {
    status?: 'queued' | 'active' | 'done' | 'canceled'
    assigneeAgentId?: string | null
    agentIds?: string[] | null
    createdAt?: Date
    metadata?: Record<string, unknown>
  }) {
    const id = crypto.randomUUID()
    await db.insert(workStreams).values({
      id,
      squadId: targetSquadId,
      title: `demand-work-${id}`,
      status: input.status ?? 'active',
      assigneeAgentId: input.assigneeAgentId,
      agentIds: input.agentIds,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? at(1),
      updatedAt: input.createdAt ?? at(1),
    })
    return id
  }

  test('paused streams suppress idle work, queued turns and inbox until explicitly resumed', async () => {
    const id = await addWorkStream({ assigneeAgentId: targetAgentId, agentIds: [secondTargetAgentId] })
    await db
      .update(workStreams)
      .set({
        pause: { id: crypto.randomUUID(), pausedAt: NOW.toISOString(), reason: null, parkAt: null, agentIds: [] },
      })
      .where(eq(workStreams.id, id))
    await db.insert(executions).values({ agentId: targetAgentId, status: 'queued', startedAt: at(4) })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: secondTargetAgentId,
      senderType: 'user',
      content: 'held',
      createdAt: at(3),
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
    await db.update(workStreams).set({ pause: null }).where(eq(workStreams.id, id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 2,
      firstDemandAt: at(4),
    })
  })

  test('dormant non-waking notices are quiet, but an eligible message wakes the whole batch', async () => {
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, targetAgentId))
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: targetAgentId,
      senderType: 'system',
      content: 'FYI',
      createdAt: at(3),
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: targetAgentId,
      senderType: 'user',
      content: 'continue',
      createdAt: at(1),
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 2,
      firstDemandAt: at(3),
    })
  })

  test('workflow assignment inbox respects attempt input gates and resumes when resolved', async () => {
    const id = await addWorkStream({ assigneeAgentId: targetAgentId })
    const definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: id,
      activated: true,
      state: createWorkflowRun(definition),
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': targetAgentId },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
    })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: targetAgentId,
      senderType: 'system',
      content: 'assignment',
      metadata: { source: 'workflow', workStreamId: id, attemptId: 1 },
      createdAt: at(3),
    })
    const [wait] = await db
      .insert(workStreamWaits)
      .values({ workStreamId: id, type: 'question', flowAttemptId: 1, openedAt: at(2) })
      .returning()
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
    await db.update(workStreamWaits).set({ closedAt: NOW }).where(eq(workStreamWaits.id, wait!.id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(2)
    await db
      .update(inbox)
      .set({ metadata: { source: 'workflow', workStreamId: id, attemptId: 999 } })
      .where(eq(inbox.recipientId, targetAgentId))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
    await db
      .update(inbox)
      .set({ metadata: { source: 'workflow-wait-resolution', workStreamId: id, attemptId: 999 } })
      .where(eq(inbox.recipientId, targetAgentId))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
    await db.update(workStreamWaits).set({ closedAt: null }).where(eq(workStreamWaits.id, wait!.id))
    await db
      .update(inbox)
      .set({ metadata: { source: 'workflow-wait-resolution', workStreamId: id, attemptId: 1 } })
      .where(eq(inbox.recipientId, targetAgentId))
    // A current resolution message is deliverable even if another wait remains.
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
  })

  test('workflow PR delivery and human gates are quiet while an unblocked parallel agent remains demand', async () => {
    const id = await addWorkStream({ assigneeAgentId: targetAgentId, agentIds: [secondTargetAgentId] })
    const definition = createBlankWorkflow()
    const state = createWorkflowRun(definition)
    await db.insert(workStreamFlowRuns).values({
      workStreamId: id,
      activated: true,
      state,
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': targetAgentId, '2': secondTargetAgentId },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
    })
    state.attempts[0]!.step = {
      ...(definition.steps[0] as Extract<WorkflowStep, { kind: 'agent' }>),
      kind: 'human-approval',
      approver: 'assigned-reviewers',
    }
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
    state.attempts.push({ ...state.attempts[0]!, id: 2, step: definition.steps[0]! })
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
    state.status = 'completion-ready'
    state.definition.completion = { mode: 'pr-auto-merge', followChanges: true }
    await db.update(workStreamFlowRuns).set({ state }).where(eq(workStreamFlowRuns.workStreamId, id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
    await db
      .update(workStreams)
      .set({
        metadata: { codeHost: { integration: 'github', repository: 'ficushq/ficus', changeRequest: { number: 1 } } },
      })
      .where(eq(workStreams.id, id))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
  })

  test('silent healthy monitors protect their attempt, but stale checks, ended monitors and expired deadlines do not', async () => {
    const id = await addWorkStream({ assigneeAgentId: targetAgentId })
    const definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: id,
      activated: true,
      state: createWorkflowRun(definition),
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': targetAgentId },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
    })
    const count = async () => (await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count
    const windowMinutes = SUPERVISED_ACTIVITY_WINDOW_MS / 60_000
    // No run, no monitor, no app: a real stall.
    expect(await count()).toBe(1)

    const monitorId = crypto.randomUUID()
    await db.insert(monitors).values({
      id: monitorId,
      agentId: targetAgentId,
      sandboxId: 'fixture-sandbox',
      label: 'download log',
      command: 'tail -F app.log | grep --line-buffered DONE',
      status: 'running',
      processId: `fixture-${monitorId}`,
      timeoutMs: 86_400_000,
      maxBatchLines: 20,
      maxBatchBytes: 4096,
      batchDebounceMs: 750,
      createdAt: at(windowMinutes + 60),
      startedAt: at(windowMinutes + 60),
      launchedAt: at(windowMinutes + 60),
      lastBatchAt: at(windowMinutes + 60),
      lastConfirmedAliveAt: at(1),
    })
    // Chlea regression: no output or agent run for hours, but successful process probes.
    expect(await count()).toBe(0)
    // Recent output does not cover failed/stopped supervision.
    await db
      .update(monitors)
      .set({
        lastBatchAt: at(0),
        lastConfirmedAliveAt: at(MONITOR_LIVENESS_WINDOW_MS / 60_000 + 0.01),
      })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    // Boundary and legacy rows: only real, recent confirmations count.
    await db
      .update(monitors)
      .set({ lastConfirmedAliveAt: at(MONITOR_LIVENESS_WINDOW_MS / 60_000) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(0)
    await db.update(monitors).set({ lastConfirmedAliveAt: null }).where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    await db
      .update(monitors)
      .set({ lastConfirmedAliveAt: at(-1) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    await db
      .update(monitors)
      .set({ lastConfirmedAliveAt: at(0) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(0)
    for (const status of ['starting', 'canceling', 'exited', 'failed', 'canceled', 'timed-out'] as const) {
      await db.update(monitors).set({ status }).where(eq(monitors.id, monitorId))
      expect(await count()).toBe(1)
    }
    await db.update(monitors).set({ status: 'running', deadlineAt: NOW }).where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    // Legacy deadline derives from first start, never a fresh heartbeat.
    await db
      .update(monitors)
      .set({ deadlineAt: null, startedAt: at(1500) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    await db
      .update(monitors)
      .set({ startedAt: at(180) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(0)
    await db
      .update(monitors)
      .set({ nextRestartAt: at(-1) })
      .where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)
    await db.update(monitors).set({ nextRestartAt: null }).where(eq(monitors.id, monitorId))
    // Another squad agent's monitor does not cover this stream's attempt agent.
    await db.update(monitors).set({ agentId: secondTargetAgentId }).where(eq(monitors.id, monitorId))
    expect(await count()).toBe(1)

    const appId = crypto.randomUUID()
    await db.insert(localDeployments).values({
      id: appId,
      squadId: targetSquadId,
      sandboxId: 'fixture-sandbox',
      name: 'archive-download',
      port: 20_000 + Math.floor(Math.random() * 40_000),
      portScope: `sandbox:fixture-${appId}`,
      targetHost: '127.0.0.1',
      mode: 'managed',
      status: 'running',
      restartPolicy: 'always',
      createdByAgentId: targetAgentId,
      createdAt: at(windowMinutes + 300),
      updatedAt: at(windowMinutes + 300),
    })
    // A long-running app whose owner has not checked in within the window can mask nothing.
    await db.insert(executions).values({
      agentId: targetAgentId,
      status: 'completed',
      startedAt: at(windowMinutes + 10),
      runStartedAt: at(windowMinutes + 10),
    })
    expect(await count()).toBe(1)
    // The owner checked on it recently: the running app is the stream's progress.
    await db
      .insert(executions)
      .values({ agentId: targetAgentId, status: 'completed', startedAt: at(50), runStartedAt: at(50) })
    expect(await count()).toBe(0)
    // Crashed, stopped, attached, foreign-squad or another agent's apps are not this stream's activity.
    await db.update(localDeployments).set({ status: 'crashed' }).where(eq(localDeployments.id, appId))
    expect(await count()).toBe(1)
    await db.update(localDeployments).set({ status: 'running', mode: 'attached' }).where(eq(localDeployments.id, appId))
    expect(await count()).toBe(1)
    await db
      .update(localDeployments)
      .set({ mode: 'managed', createdByAgentId: secondTargetAgentId })
      .where(eq(localDeployments.id, appId))
    expect(await count()).toBe(1)
    await db
      .update(localDeployments)
      .set({ createdByAgentId: targetAgentId, archivedAt: at(1) })
      .where(eq(localDeployments.id, appId))
    expect(await count()).toBe(1)
  })

  test('obsolete resume notices for finished streams are not inbox demand', async () => {
    const id = await addWorkStream({ status: 'done', assigneeAgentId: targetAgentId })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: targetAgentId,
      senderType: 'system',
      content: 'resume',
      metadata: { source: 'work-stream-resume', workStreamId: id },
      createdAt: at(90),
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
  })

  test('queue demand matches pickup lifecycle eligibility', async () => {
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, targetAgentId))
    await db
      .insert(executions)
      .values({ agentId: targetAgentId, status: 'queued', wakeEligible: false, startedAt: at(90) })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
    await db.update(executions).set({ wakeEligible: true }).where(eq(executions.agentId, targetAgentId))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.agentIds).toEqual([targetAgentId])
    await db.update(agents).set({ pendingDormancyAt: NOW }).where(eq(agents.id, targetAgentId))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
  })

  test('stale integration and observer mail never seed a lifecycle wake batch', async () => {
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, targetAgentId))
    await db.insert(inbox).values([
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'stale',
        metadata: { source: 'integration-output', integrationDeliveryId: crypto.randomUUID(), wakeEligible: true },
        createdAt: at(90),
      },
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'observer',
        metadata: { source: 'work-stream-observer', wakeEligible: true },
        createdAt: at(80),
      },
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'FYI',
        metadata: { wakeEligible: false },
        createdAt: at(1),
      },
    ])
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, targetAgentId))
    // Non-waking ordinary mail is executable for a nondormant standalone agent.
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
  })

  test('question answers for superseded attempts match dispatcher eligibility', async () => {
    const id = await addWorkStream({ status: 'queued', assigneeAgentId: targetAgentId })
    const definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: id,
      activated: true,
      state: createWorkflowRun(definition),
      source: resolveWorkflow({ kind: 'inline', definition }),
      attemptAgents: { '1': targetAgentId },
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'test',
      createdBy: 'test',
    })
    const questionId = crypto.randomUUID()
    await db.insert(workStreamWaits).values({
      workStreamId: id,
      type: 'question',
      referenceId: questionId,
      flowAttemptId: 999,
      openedAt: at(3),
      closedAt: at(2),
    })
    const [message] = await db
      .insert(inbox)
      .values({
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'answer',
        metadata: { source: 'agent-question-answer', questionId, wakeEligible: true },
        createdAt: at(1),
      })
      .returning()
    const { isCurrentFlowMessage } = await import('../workflows/execution')
    expect(await isCurrentFlowMessage(message!)).toBe(false)
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
    await db.update(workStreamWaits).set({ flowAttemptId: 1 }).where(eq(workStreamWaits.referenceId, questionId))
    expect(await isCurrentFlowMessage(message!)).toBe(true)
    // A parked branch's legitimate resolution is still deliverable.
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(1)
  })

  test('dead schedule scopes and inbox targets are not executable demand', async () => {
    for (const scopeId of [terminatedTargetAgentId, crypto.randomUUID()]) {
      await addSchedule({
        scopeType: 'agent',
        scopeId,
        action: { type: 'inbox_message', target: { type: 'agent', agentId: targetAgentId }, content: 'dead scope' },
      })
    }
    for (const agentId of [terminatedTargetAgentId, crypto.randomUUID()]) {
      await addSchedule({
        scopeType: 'squad',
        scopeId: targetSquadId,
        action: { type: 'inbox_message', target: { type: 'agent', agentId }, content: 'dead target' },
      })
    }
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
  })

  test('scheduled inbox housekeeping cannot execute for dormant or paused targets', async () => {
    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, secondTargetAgentId))
    await addSchedule({
      scopeType: 'agent',
      scopeId: secondTargetAgentId,
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: secondTargetAgentId },
        content: 'housekeeping',
      },
    })
    const id = await addWorkStream({ assigneeAgentId: targetAgentId })
    await db
      .update(workStreams)
      .set({
        pause: { id: crypto.randomUUID(), pausedAt: NOW.toISOString(), reason: null, parkAt: null, agentIds: [] },
      })
      .where(eq(workStreams.id, id))
    await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: targetAgentId },
        content: 'held housekeeping',
      },
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)?.count).toBe(0)
  })

  test('queued execution startup backoff is not demand until its retry deadline', async () => {
    await db.insert(executions).values({
      agentId: targetAgentId,
      status: 'queued',
      startedAt: at(90),
      startupRetryAt: new Date(NOW.getTime() + 60_000),
    })
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
    expect((await getSquadDemandSnapshots({ now: new Date(NOW.getTime() + 60_000) })).get(targetSquadId)).toMatchObject(
      {
        count: 1,
        firstDemandAt: at(90),
      }
    )
  })

  test('ignores old merger notices for terminated reviewers without hiding deliverable inbox work', async () => {
    await db.insert(inbox).values([
      {
        recipientType: 'agent',
        recipientId: terminatedTargetAgentId,
        senderType: 'system',
        content: 'PR #1350 merged',
        createdAt: at(4145),
      },
      {
        recipientType: 'agent',
        recipientId: terminatedTargetAgentId,
        senderType: 'system',
        content: 'PR #1351 merged',
        createdAt: at(3999),
      },
    ])
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })

    await db.update(agents).set({ status: 'dormant' }).where(eq(agents.id, secondTargetAgentId))
    await db.insert(inbox).values([
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'user',
        content: 'live work',
        createdAt: at(2),
      },
      {
        recipientType: 'agent',
        recipientId: secondTargetAgentId,
        senderType: 'system',
        content: 'wake dormant reviewer',
        metadata: { wakeEligible: true },
        createdAt: at(3),
      },
    ])
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 2,
      firstDemandAt: at(3),
    })

    await db
      .update(agents)
      .set({ status: 'terminated', terminatedAt: NOW })
      .where(inArray(agents.id, [targetAgentId, secondTargetAgentId]))
    expect((await getSquadDemandSnapshots({ now: NOW })).get(targetSquadId)).toMatchObject({
      count: 0,
      firstDemandAt: null,
    })
    // Detection never deletes or marks historical messages read.
    expect(
      await db
        .select()
        .from(inbox)
        .where(inArray(inbox.recipientId, [terminatedTargetAgentId, targetAgentId, secondTargetAgentId]))
    ).toHaveLength(4)
  })

  test('counts every actionable branch once and excludes waiting or cross-squad rows', async () => {
    // Included: queued execution, unread+undelivered inbox, due agent schedule,
    // due squad schedule, and idle active work stream with an executable participant.
    await db.insert(executions).values({ agentId: targetAgentId, status: 'queued', startedAt: at(4) })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: targetAgentId,
      senderType: 'system',
      content: 'actionable',
      createdAt: at(5),
    })
    await addSchedule({
      scopeType: 'agent',
      scopeId: targetAgentId,
      nextTriggerAt: at(3),
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: targetAgentId },
        content: 'scheduled agent work',
      },
    })
    await addSchedule({ scopeType: 'squad', scopeId: targetSquadId, nextTriggerAt: at(2) })
    await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      nextTriggerAt: at(2),
      action: { type: 'spawn_agent', agentTypeId: 'engineer', prompt: 'standalone scheduled work' },
    })
    const includedAssigneeWorkStreamId = await addWorkStream({
      assigneeAgentId: secondTargetAgentId,
      createdAt: at(1),
    })
    await db.insert(workStreamWaits).values({
      workStreamId: includedAssigneeWorkStreamId,
      type: 'manual',
      openedAt: at(10),
      closedAt: at(9),
      resolution: 'cleared',
    })
    await addWorkStream({ assigneeAgentId: null, agentIds: [secondTargetAgentId], createdAt: at(1) })

    // Excluded execution states, including both explicit waiting states.
    await db.insert(executions).values(
      ['waiting-maintenance', 'waiting-sandbox', 'running', 'stopping'].map((status) => ({
        agentId: targetAgentId,
        status: status as 'waiting-maintenance' | 'waiting-sandbox' | 'running' | 'stopping',
        startedAt: at(20),
      }))
    )

    // Excluded inbox rows: non-agent recipients, read messages, and delivered messages.
    await db.insert(inbox).values([
      {
        recipientType: 'user',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'non-agent recipient',
        createdAt: at(30),
      },
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'read',
        readAt: at(1),
        createdAt: at(20),
      },
      {
        recipientType: 'agent',
        recipientId: targetAgentId,
        senderType: 'system',
        content: 'delivered',
        deliveredAt: at(1),
        createdAt: at(20),
      },
    ])

    // Excluded schedules: disabled, not due, webhook-only, non-work-creating,
    // and skipIfUnresolved with a still-unresolved occurrence.
    await addSchedule({ scopeType: 'squad', scopeId: targetSquadId, enabled: false })
    await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      nextTriggerAt: new Date(NOW.getTime() + 60_000),
    })
    await addSchedule({ scopeType: 'squad', scopeId: targetSquadId, nextTriggerAt: null, webhookEnabled: true })
    await addSchedule({
      scopeType: 'agent',
      scopeId: targetAgentId,
      action: { type: 'noop' },
    })
    const unresolvedScheduleId = await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      schedule: { runAt: at(1).toISOString(), skipIfUnresolved: true },
    })
    await addWorkStream({
      status: 'queued',
      assigneeAgentId: secondTargetAgentId,
      metadata: { scheduleId: unresolvedScheduleId },
      createdAt: at(30),
    })
    const unresolvedSpawnScheduleId = await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      action: {
        type: 'spawn_agent',
        agentTypeId: 'engineer',
        prompt: 'scheduled stream',
        workStream: { title: 'scheduled unresolved stream' },
      },
    })
    await addWorkStream({
      status: 'queued',
      assigneeAgentId: secondTargetAgentId,
      metadata: { scheduleId: unresolvedSpawnScheduleId },
      createdAt: at(30),
    })
    const noSkipScheduleId = await addSchedule({
      scopeType: 'squad',
      scopeId: targetSquadId,
      schedule: { runAt: at(1).toISOString(), skipIfUnresolved: false },
    })
    await addWorkStream({
      status: 'queued',
      assigneeAgentId: secondTargetAgentId,
      metadata: { scheduleId: noSkipScheduleId },
      createdAt: at(30),
    })

    // Excluded work streams: parked/queued, terminal/nonactive, no executable
    // participant, each open wait type, and a participant with a live execution.
    await addWorkStream({ status: 'queued', assigneeAgentId: secondTargetAgentId, createdAt: at(30) })
    await addWorkStream({ status: 'done', assigneeAgentId: secondTargetAgentId, createdAt: at(30) })
    await addWorkStream({ status: 'canceled', assigneeAgentId: secondTargetAgentId, createdAt: at(30) })
    await addWorkStream({ status: 'active', assigneeAgentId: null, agentIds: [], createdAt: at(30) })
    await addWorkStream({
      status: 'active',
      assigneeAgentId: terminatedTargetAgentId,
      createdAt: at(30),
    })
    await addWorkStream({
      status: 'active',
      assigneeAgentId: crossAgentId,
      createdAt: at(30),
    })
    for (const type of ['dependency', 'question', 'review', 'manual'] as const) {
      const workStreamId = await addWorkStream({ assigneeAgentId: secondTargetAgentId, createdAt: at(30) })
      await db.insert(workStreamWaits).values({ workStreamId, type, openedAt: at(1) })
    }
    await db.insert(executions).values({ agentId: liveTargetAgentId, status: 'running', startedAt: at(30) })
    const liveParticipantWorkStreamIds = await Promise.all([
      addWorkStream({ assigneeAgentId: liveTargetAgentId, createdAt: at(30) }),
      addWorkStream({ assigneeAgentId: null, agentIds: [liveTargetAgentId], createdAt: at(30) }),
    ])
    expect(liveParticipantWorkStreamIds).toHaveLength(2)

    // Actionable cross-squad rows exercise the same joins and must aggregate only
    // into their owning squad, while a third active squad remains genuinely quiet.
    await db.insert(executions).values({ agentId: crossAgentId, status: 'queued', startedAt: at(40) })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: crossAgentId,
      senderType: 'system',
      content: 'cross-squad actionable',
      createdAt: at(41),
    })
    await addSchedule({ scopeType: 'squad', scopeId: crossSquadId, nextTriggerAt: at(42) })

    const snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 8, firstDemandAt: at(5) })
    expect(snapshots.get(crossSquadId)).toMatchObject({ count: 3, firstDemandAt: at(42) })
    expect(snapshots.get(quietSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
  })

  test('excludes queued executions whose agent is terminated but keeps counting live and dormant agents', async () => {
    // The incident shape: an unspawned agent's never-started execution stays
    // queued forever. A terminated agent can never serve it (pickup fails the
    // row on sight), so counting it as demand would alert eternally about work
    // no live agent exists to run.
    await db.insert(executions).values({
      agentId: terminatedTargetAgentId,
      status: 'queued',
      startedAt: at(2),
    })
    // A dormant agent CAN be woken by pickup to serve queued work, so its
    // demand stays genuine and must keep alerting exactly as today.
    const dormantAgentId = crypto.randomUUID()
    await db.insert(agents).values({
      id: dormantAgentId,
      agentTypeId: 'engineer',
      squadId: targetSquadId,
      status: 'dormant',
      dormantAt: at(1),
    })
    await db
      .insert(executions)
      .values({ agentId: dormantAgentId, status: 'queued', startedAt: at(3), wakeEligible: true })
    // Control: a live agent's queued execution still counts.
    await db.insert(executions).values({ agentId: targetAgentId, status: 'queued', startedAt: at(4) })

    const snapshots = await getSquadDemandSnapshots({ now: NOW })
    // Two genuine rows remain (dormant@at(3), live@at(4)); the terminated
    // agent's at(2) row is excluded — including from the earliest-demand clock.
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 2, firstDemandAt: at(4) })
  })

  test('uses each source-specific demand timestamp when it becomes the earliest row', async () => {
    await db.insert(executions).values({ agentId: targetAgentId, status: 'queued', startedAt: at(1) })
    let snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 1, firstDemandAt: at(1) })

    await addSchedule({
      scopeType: 'agent',
      scopeId: targetAgentId,
      nextTriggerAt: at(2),
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: targetAgentId },
        content: 'agent timestamp',
      },
    })
    snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 2, firstDemandAt: at(2) })

    await addSchedule({ scopeType: 'squad', scopeId: targetSquadId, nextTriggerAt: at(3) })
    snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 3, firstDemandAt: at(3) })

    await addWorkStream({ assigneeAgentId: secondTargetAgentId, createdAt: at(4) })
    snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 4, firstDemandAt: at(4) })
    expect(snapshots.get(quietSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
  })

  test('excludes actionable-looking rows while the owning squad is paused', async () => {
    await db
      .update(squads)
      .set({ status: 'paused' })
      .where(inArray(squads.id, [quietSquadId]))
    await db.insert(executions).values({ agentId: quietAgentId, status: 'queued', startedAt: at(5) })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: quietAgentId,
      senderType: 'system',
      content: 'paused squad',
      createdAt: at(6),
    })
    await addSchedule({
      scopeType: 'agent',
      scopeId: quietAgentId,
      nextTriggerAt: at(7),
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: quietAgentId },
        content: 'paused schedule',
      },
    })

    const snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.has(quietSquadId)).toBe(false)
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
    expect(snapshots.get(crossSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
  })

  test('excludes actionable-looking rows once the owning squad is archived', async () => {
    await db
      .update(squads)
      .set({ status: 'archived' })
      .where(inArray(squads.id, [quietSquadId]))
    await db.insert(executions).values({ agentId: quietAgentId, status: 'queued', startedAt: at(5) })
    await db.insert(inbox).values({
      recipientType: 'agent',
      recipientId: quietAgentId,
      senderType: 'system',
      content: 'archived squad',
      createdAt: at(6),
    })
    await addSchedule({
      scopeType: 'agent',
      scopeId: quietAgentId,
      nextTriggerAt: at(7),
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: quietAgentId },
        content: 'archived schedule',
      },
    })

    const snapshots = await getSquadDemandSnapshots({ now: NOW })
    expect(snapshots.has(quietSquadId)).toBe(false)
    expect(snapshots.get(targetSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
    expect(snapshots.get(crossSquadId)).toMatchObject({ count: 0, firstDemandAt: null })
  })
  test('suppresses all squad demand while the instance is maintenance-paused', async () => {
    const [prior] = await db.select().from(instanceMaintenanceState).where(eq(instanceMaintenanceState.id, 'global'))
    await db
      .insert(instanceMaintenanceState)
      .values({ id: 'global', adminHold: true })
      .onConflictDoUpdate({ target: instanceMaintenanceState.id, set: { adminHold: true } })
    try {
      await db.insert(executions).values({ agentId: targetAgentId, status: 'queued', startedAt: at(5) })
      expect(await getSquadDemandSnapshots({ now: NOW })).toEqual(new Map())
    } finally {
      if (prior) {
        await db
          .update(instanceMaintenanceState)
          .set({ adminHold: prior.adminHold })
          .where(eq(instanceMaintenanceState.id, 'global'))
      } else {
        await db.delete(instanceMaintenanceState).where(eq(instanceMaintenanceState.id, 'global'))
      }
    }
  })
})
