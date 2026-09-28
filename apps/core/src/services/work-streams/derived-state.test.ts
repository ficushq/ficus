import { WORK_STREAM_PRESENTATION_CASES } from '@ficus/shared/test-fixtures/work-stream-presentation'
import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { and, eq, like, inArray } from 'drizzle-orm'
import { db } from '../../db'
import { agents, agentTypes, executions, squads, workStreams, workStreamWaits } from '../../db/schema'
import { Squad } from '../../entities/Squad'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { AgentType } from '../../entities/AgentType'
import { computeDerivedStates, sortWaitsByDisplayPrecedence } from './derived-state'
import type { WorkStreamTerminalFailure, WorkStreamWait } from '@ficus/shared'

describe('work-stream derived state', () => {
  let testPrefix: string
  let squad: Squad
  let testAgentTypeId: string
  const createdAgentIds: string[] = []

  beforeEach(async () => {
    testPrefix = `wsder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-agent-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Derived Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    squad = await Squad.create({ name: `${testPrefix} Squad`, purpose: 'derived tests' })
  })

  afterEach(async () => {
    await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
    if (createdAgentIds.length) {
      await db.delete(executions).where(inArray(executions.agentId, createdAgentIds))
      await db.delete(agents).where(inArray(agents.id, createdAgentIds))
      createdAgentIds.length = 0
    }
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
    await db.delete(agentTypes).where(like(agentTypes.id, `${testPrefix}%`))
  })

  async function createAgent(): Promise<Agent> {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    return agent
  }

  async function createStream(title: string, overrides: Partial<Parameters<typeof WorkStream.create>[0]> = {}) {
    return storedLegacyWorkStream({ squadId: squad.id, title: `${testPrefix} ${title}`, ...overrides })
  }

  async function derived(ws: WorkStream) {
    const fresh = await WorkStream.mustFind(ws.id)
    return (await computeDerivedStates([fresh])).get(ws.id)!
  }

  it('serializes authoritative delivery and projects its approval wait without altering the wait', async () => {
    const ws = await createStream('approval')
    const { flowWaitReference } = await import('../workflows/wait-policy')
    const [wait] = await db
      .insert(workStreamWaits)
      .values({
        workStreamId: ws.id,
        type: 'manual',
        resolutionHandler: 'workflow',
        referenceId: flowWaitReference(ws.id, 'delivery', 0),
        createdBy: 'system',
      })
      .returning()
    const result = (
      await computeDerivedStates([ws], {
        loadDelivery: async () => new Map([[ws.id, { kind: 'approval' }]]),
      })
    ).get(ws.id)!
    const { selectWorkStreamPresentationState, workStreamNeedsHumanAttention, buildWorkInterestSnapshot } =
      await import('@ficus/shared')
    const json = { ...ws.toJson(), ...result }
    expect(result.derivedState).toBe('in_review')
    expect(result.delivery).toEqual({ kind: 'approval', approvalWaitId: wait!.id })
    expect(result.openWaits[0]!.type).toBe('manual')
    expect(selectWorkStreamPresentationState(json)).toBe('delivery_approval')
    expect(workStreamNeedsHumanAttention(json)).toBe(true)
    expect(buildWorkInterestSnapshot([json]).liveActivity.needsYouCount).toBe(1)
  })

  it('batch-loads active flow delivery independently of callers selecting metadata', async () => {
    const { workStreamFlowRuns } = await import('../../db/schema')
    const { attachFlow } = await import('../workflows/execution')
    const { workflowPresetSchema } = await import('@ficus/shared')
    const definition = workflowPresetSchema.parse(
      Bun.YAML.parse(
        await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
      )
    ).definition
    for (const participant of Object.values(definition.participants)) participant.agentTypeId = testAgentTypeId
    definition.completion = { mode: 'review-approval' }
    const ws = await createStream('batched delivery')
    await db.transaction(async (tx) => {
      const [stored] = await tx.select().from(workStreams).where(eq(workStreams.id, ws.id))
      const flow = await attachFlow(tx, stored!, { kind: 'inline', definition })
      await tx
        .update(workStreamFlowRuns)
        .set({ activated: true, state: { ...flow.state, status: 'completion-ready' } })
        .where(eq(workStreamFlowRuns.workStreamId, ws.id))
    })
    const states = await computeDerivedStates([{ id: ws.id, status: 'active', assigneeAgentId: null, agentIds: [] }])
    expect(states.get(ws.id)).toMatchObject({
      derivedState: 'in_review',
      delivery: { kind: 'approval' },
      openWaits: [],
    })
  })

  it('shared matrix survives derivation, JSON serialization, attention and both native projections', async () => {
    const { selectWorkStreamPresentationState, workStreamNeedsHumanAttention, buildWorkInterestSnapshot } =
      await import('@ficus/shared')
    for (const row of WORK_STREAM_PRESENTATION_CASES.filter((row) => row.facts.openWaits !== undefined)) {
      const ws = await createStream(row.name)
      for (const wait of row.facts.openWaits ?? [])
        await db.insert(workStreamWaits).values({ workStreamId: ws.id, type: wait.type, createdBy: 'system' })
      const input = { ...ws.toJson(), ...row.facts, agentIds: ['matrix-agent'], assigneeAgentId: null }
      const derived = (
        await computeDerivedStates([input], {
          loadDelivery: async () => new Map(row.facts.delivery ? [[ws.id, row.facts.delivery]] : []),
          loadBusyAgentIds: async () => new Set(row.facts.derivedState === 'in_progress' ? ['matrix-agent'] : []),
          loadSurfacedFailures: async () =>
            new Map(
              row.facts.derivedState === 'execution_failed'
                ? [
                    [
                      'matrix-agent',
                      {
                        executionId: 'failure',
                        failureClass: null,
                        failureReason: null,
                        endedAt: new Date(),
                      },
                    ],
                  ]
                : []
            ),
        })
      ).get(ws.id)!
      const json = JSON.parse(JSON.stringify({ ...input, ...derived }))
      expect(selectWorkStreamPresentationState(json)).toBe(row.state)
      expect(workStreamNeedsHumanAttention(json)).toBe(row.attention)
      const snapshot = buildWorkInterestSnapshot([json])
      expect(snapshot.top[0]?.bucket).toBe(row.bucket)
      expect(snapshot.liveActivity.top[0]?.bucket).toBe(row.bucket)
      expect(snapshot.liveActivity.needsYouCount).toBe(row.attention ? 1 : 0)
    }
  })

  it('in_progress requires a RUNNING execution for an assigned agent — assignee presence alone is NOT enough', async () => {
    const agent = await createAgent()
    const ws = await createStream('exec-check', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    // The assignment notification queues a wake-up turn; clear it so the
    // no-execution baseline is real.
    await db.delete(executions).where(eq(executions.agentId, agent.id))

    // Assigned but no execution: idle, the alarming display.
    expect((await derived(ws)).derivedState).toBe('idle')

    // A live execution flips it to in_progress.
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    expect((await derived(ws)).derivedState).toBe('in_progress')

    // A settled execution does not count.
    await db
      .update(executions)
      .set({ status: 'completed', endedAt: new Date() })
      .where(eq(executions.agentId, agent.id))
    expect((await derived(ws)).derivedState).toBe('idle')
  })

  it('idle ONLY when no execution AND no wait', async () => {
    const agent = await createAgent()
    const ws = await createStream('idle-check', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    expect((await derived(ws)).derivedState).toBe('idle')

    await ws.block({ message: 'held' })
    expect((await derived(ws)).derivedState).toBe('blocked')
    await ws.unblock()
    // The unblock notification wakes the assignee (queued execution) — clear
    // it to observe the no-execution/no-wait baseline again.
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    expect((await derived(ws)).derivedState).toBe('idle')
  })

  it('open waits WIN over a running execution (the wait is the actionable fact)', async () => {
    const agent = await createAgent()
    const ws = await createStream('wait-beats-exec', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.insert(executions).values({ agentId: agent.id, status: 'running' })
    await ws.handoffForReview({ message: 'please review' })
    expect((await derived(ws)).derivedState).toBe('in_review')
  })

  it('display precedence pinned: review > question > dependency > manual', async () => {
    const ws = await createStream('precedence')
    const wsRow = await WorkStream.mustFind(ws.id)
    await db.insert(workStreamWaits).values([
      { workStreamId: wsRow.id, type: 'manual' },
      { workStreamId: wsRow.id, type: 'dependency', referenceId: crypto.randomUUID() },
      { workStreamId: wsRow.id, type: 'question', referenceId: crypto.randomUUID() },
      { workStreamId: wsRow.id, type: 'review' },
    ])

    const info = await derived(ws)
    expect(info.derivedState).toBe('in_review')
    expect(info.openWaits.map((w) => w.type)).toEqual(['review', 'question', 'dependency', 'manual'])

    // Peel off the front and re-derive: each next type takes over.
    await db
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'sent_back', resolutionNote: 'n' })
      .where(and(eq(workStreamWaits.workStreamId, wsRow.id), eq(workStreamWaits.type, 'review')))
    expect((await derived(ws)).derivedState).toBe('waiting_on_answer')
    await db
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'answered' })
      .where(and(eq(workStreamWaits.workStreamId, wsRow.id), eq(workStreamWaits.type, 'question')))
    expect((await derived(ws)).derivedState).toBe('waiting_on_dependency')
    await db
      .update(workStreamWaits)
      .set({ closedAt: new Date(), resolution: 'satisfied' })
      .where(and(eq(workStreamWaits.workStreamId, wsRow.id), eq(workStreamWaits.type, 'dependency')))
    expect((await derived(ws)).derivedState).toBe('blocked')
  })

  it('queued and terminal statuses derive as themselves; queued with a wait shows the wait display', async () => {
    const q = await createStream('queued-plain')
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, q.id))
    expect((await derived(q)).derivedState).toBe('queued')

    await (await WorkStream.mustFind(q.id)).block({ message: 'parked hold' })
    expect((await derived(q)).derivedState).toBe('blocked')

    const d = await createStream('done-stream')
    await d.update({ status: 'done' })
    expect((await derived(d)).derivedState).toBe('done')

    const c = await createStream('canceled-stream')
    await c.cancel()
    expect((await derived(c)).derivedState).toBe('canceled')
  })

  it('execution_failed: a pre-tool platform refusal surfaces with terminal detail, never plain idle', async () => {
    const agent = await createAgent()
    const ws = await createStream('platform-refusal', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    const endedAt = new Date()
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'Admission effect was refused by the durable fence',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt,
    })

    const info = await derived(ws)
    expect(info.derivedState).toBe('execution_failed')
    expect(info.terminalFailure).toEqual({
      executionId: expect.any(String),
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt,
    })
  })

  it('execution_failed: a legacy NULL failed row still surfaces (the ambiguous idle case)', async () => {
    const agent = await createAgent()
    const ws = await createStream('legacy-failure', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'some old failure',
      failureClass: null,
      endedAt: new Date(),
    })

    const info = await derived(ws)
    expect(info.derivedState).toBe('execution_failed')
    expect(info.terminalFailure?.failureClass).toBeNull()
  })

  it('a provider_transport failure stays idle (auto-continued by the watchdog)', async () => {
    const agent = await createAgent()
    const ws = await createStream('transport-failure', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      error: 'Provider transport failure: The socket connection was closed unexpectedly',
      failureClass: 'provider_transport',
      failureReason: 'transport',
      endedAt: new Date(),
    })

    const info = await derived(ws)
    expect(info.derivedState).toBe('idle')
    expect(info.terminalFailure).toBeUndefined()
  })

  it('a newer running execution wins over a stale failure (in_progress, no terminal detail)', async () => {
    const agent = await createAgent()
    const ws = await createStream('race-running', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: new Date(Date.now() - 60_000),
    })
    // Scheduler re-admitted: a NEWER execution is live.
    await db.insert(executions).values({ agentId: agent.id, status: 'running', startedAt: new Date() })

    const info = await derived(ws)
    expect(info.derivedState).toBe('in_progress')
    expect(info.terminalFailure).toBeUndefined()
  })

  it('a newer completed execution deterministically clears the failure display', async () => {
    const agent = await createAgent()
    const ws = await createStream('race-completed', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: new Date(Date.now() - 120_000),
    })
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'completed',
      endedAt: new Date(Date.now() - 60_000),
    })

    const info = await derived(ws)
    expect(info.derivedState).toBe('idle')
    expect(info.terminalFailure).toBeUndefined()
  })

  it('an open wait still wins over a surfaced failure', async () => {
    const agent = await createAgent()
    const ws = await createStream('wait-wins', { assigneeAgentId: agent.id, agentIds: [agent.id] })
    await db.delete(executions).where(eq(executions.agentId, agent.id))
    await db.insert(executions).values({
      agentId: agent.id,
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: new Date(),
    })
    await ws.handoffForReview({ message: 'please review' })

    const info = await derived(ws)
    expect(info.derivedState).toBe('in_review')
    expect(info.terminalFailure).toBeUndefined()
  })

  it('the failure probe runs only for active-no-wait-no-busy agent ids', async () => {
    const busyAgent = await createAgent()
    const idleAgent = await createAgent()
    const waitedAgent = await createAgent()
    const busyStream = await createStream('probe-busy', {
      assigneeAgentId: busyAgent.id,
      agentIds: [busyAgent.id],
    })
    const idleStream = await createStream('probe-idle', {
      assigneeAgentId: idleAgent.id,
      agentIds: [idleAgent.id],
    })
    const waitedStream = await createStream('probe-waited', {
      assigneeAgentId: waitedAgent.id,
      agentIds: [waitedAgent.id],
    })
    await db.delete(executions).where(inArray(executions.agentId, [busyAgent.id, idleAgent.id, waitedAgent.id]))
    await db.insert(executions).values({ agentId: busyAgent.id, status: 'running' })
    await waitedStream.block({ message: 'held' })

    const probed: string[][] = []
    const failure: WorkStreamTerminalFailure = {
      executionId: 'exec-x',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
      endedAt: new Date(),
    }
    const infos = await computeDerivedStates(
      [
        await WorkStream.mustFind(busyStream.id),
        await WorkStream.mustFind(idleStream.id),
        await WorkStream.mustFind(waitedStream.id),
      ],
      {
        loadSurfacedFailures: async (agentIds) => {
          probed.push([...agentIds])
          return new Map([[idleAgent.id, failure]])
        },
      }
    )
    expect(probed).toEqual([[idleAgent.id]])
    expect(infos.get(busyStream.id)!.derivedState).toBe('in_progress')
    expect(infos.get(idleStream.id)!.derivedState).toBe('execution_failed')
    expect(infos.get(idleStream.id)!.terminalFailure).toBe(failure)
    expect(infos.get(waitedStream.id)!.derivedState).toBe('blocked')
  })

  it('sortWaitsByDisplayPrecedence orders by type precedence then newest first', () => {
    const wait = (type: WorkStreamWait['type'], openedAt: string): WorkStreamWait => ({
      id: crypto.randomUUID(),
      workStreamId: 'ws',
      type,
      referenceId: null,
      message: null,
      createdBy: 'system',
      createdByAgentId: null,
      createdByUserId: null,
      completesOnApproval: true,
      openedAt,
      closedAt: null,
      resolution: null,
      resolutionNote: null,
    })
    const sorted = sortWaitsByDisplayPrecedence([
      wait('manual', '2026-01-02T00:00:00Z'),
      wait('dependency', '2026-01-01T00:00:00Z'),
      wait('manual', '2026-01-03T00:00:00Z'),
      wait('review', '2026-01-01T00:00:00Z'),
    ])
    expect(sorted.map((w) => [w.type, w.openedAt])).toEqual([
      ['review', '2026-01-01T00:00:00Z'],
      ['dependency', '2026-01-01T00:00:00Z'],
      ['manual', '2026-01-03T00:00:00Z'],
      ['manual', '2026-01-02T00:00:00Z'],
    ])
  })
})
