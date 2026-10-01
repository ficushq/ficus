import { getPostgresError } from '../db/errors'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db, setDatabaseQueryObserverForTest, withDedicatedDbTransaction } from '../db'
import { agents, schedules, users } from '../db/schema'
import { SubagentTestFixture } from '../test-utils/subagent-fixture'
import { Agent } from './Agent'
import * as agentQueries from './agent-queries'
import { AgentType } from './AgentType'
import { Execution } from './Execution'
import { Schedule } from './Schedule'
import { InboxMessage } from './InboxMessage'
import { SUBAGENT_WATCHDOG_KIND, Subagent } from './Subagent'
import {
  makeDormant,
  requestAgentLifecycle,
  runPendingAgentLifecycleSweep,
  setDormancyEffectHookForTest,
} from '../services/agent/lifecycle'

// Keep the real sweep and claim SQL, but use its existing exact-scope seam so
// these destructive exercises never claim another test's pending fixture.
async function sweepPendingFixtureAgents(
  agentIds: string[],
  options: Parameters<typeof runPendingAgentLifecycleSweep>[0] = {}
): Promise<number> {
  const claim = spyOn(agentQueries, 'claimAgentLifecycleSweepCandidates').mockImplementation((input) =>
    agentQueries.claimAgentLifecycleSweepCandidatesForTest(input, agentIds)
  )
  try {
    return await runPendingAgentLifecycleSweep(options)
  } finally {
    claim.mockRestore()
  }
}

describe('Subagent.dispatch', () => {
  const standardChain = 'openai-codex:gpt-5.6-sol:medium,anthropic:claude-sonnet-5:high,zai:glm-5.3:high'
  let parentTypeId: string
  let createdIds: string[]
  let createdUserIds: string[]

  let fixture: SubagentTestFixture

  beforeEach(async () => {
    fixture = new SubagentTestFixture('subagent-entities', standardChain)
    parentTypeId = fixture.parentTypeId
    createdIds = fixture.agentIds
    createdUserIds = fixture.userIds
    await fixture.setup()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  it('rejects dispatch to an already terminated parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await parent.update({ terminatedAt: new Date() })
    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        subagents: [{ label: 'orphan', instructions: 'must not queue' }],
      })
    ).rejects.toThrow('is not live')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('holds the parent lock through child admission before a racing termination cascades', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const admitting = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const terminating = Promise.withResolvers<void>()
    const originalQueue = Agent.prototype.queueExecution
    const queue = spyOn(Agent.prototype, 'queueExecution').mockImplementation(async function (
      this: Agent,
      input: Parameters<Agent['queueExecution']>[0]
    ) {
      if (this.parentAgentId === parent.id) {
        admitting.resolve()
        await resume.promise
      }
      return originalQueue.call(this, input)
    })
    const dispatch = Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ label: 'race', instructions: 'race termination' }],
    })
    let termination: Promise<Agent> | undefined
    // Fail a missing barrier early enough to release the paused operation and
    // join teardown within the unchanged 5s test budget.
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Race barrier was not reached')), 2000)
    })
    try {
      await Promise.race([
        admitting.promise,
        deadline,
        dispatch.then(() => {
          throw new Error('Dispatch completed without reaching child admission')
        }),
      ])
      // Prove the real row lock is held, rather than relying on two promises
      // happening to overlap. Removing the dispatch lock must fail this test.
      await expect(
        withDedicatedDbTransaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM ${agents} WHERE id = ${parent.id} FOR NO KEY UPDATE NOWAIT`)
        }).catch(getPostgresError)
      ).resolves.toEqual({ code: '55P03' })
      setDatabaseQueryObserverForTest((query, params) => {
        if (query.endsWith(' for update') && params.includes(parent.id)) terminating.resolve()
      })
      termination = parent.update({ terminatedAt: new Date() })
      await Promise.race([
        terminating.promise,
        deadline,
        termination.then(() => {
          throw new Error('Termination completed without attempting its parent lock')
        }),
      ])
    } finally {
      clearTimeout(timer!)
      resume.resolve()
      setDatabaseQueryObserverForTest(undefined)
      queue.mockRestore()
      // Join both operations on assertion failures too. Unlike allSettled,
      // unexpected dispatch/termination failures cannot silently pass.
      await Promise.all([dispatch, termination])
    }
    const children = await Agent.list({ parentAgentId: parent.id })
    expect(children).toHaveLength(1)
    expect((await Agent.mustFind(parent.id)).status).toBe('terminated')
    expect(children[0].status).toBe('terminated')
    expect(children[0].terminatedAt).toBeInstanceOf(Date)
    expect((await Execution.list({ agentId: children[0].id })).map(({ status }) => status)).toEqual(['stopped'])
    expect(await Subagent.countLive(parent.id)).toBe(0)
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toEqual([])
  })

  it('rejects racing dispatch after termination fences the parent but before teardown completes', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    let checked = false
    setDormancyEffectHookForTest(async (stage) => {
      if (stage !== 'schedules') return
      expect((await Agent.mustFind(parent.id)).status).toBe('dormant')
      await expect(
        Subagent.dispatch({
          parentAgentId: parent.id,
          subagents: [{ instructions: 'must not escape the termination fence' }],
        })
      ).rejects.toThrow('is not live')
      checked = true
    })
    try {
      await parent.update({ terminatedAt: new Date() })
    } finally {
      setDormancyEffectHookForTest(undefined)
    }
    expect(checked).toBe(true)
    expect((await Agent.mustFind(parent.id)).status).toBe('terminated')
    expect(await Agent.list({ parentAgentId: parent.id })).toEqual([])
  })

  it('batch-creates subagents, queues first execution, and arms a watchdog', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)
    const result = await Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'A', label: 'A' }] })
    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.parentAgentId).toBe(parent.id)
    expect(child.agentTypeId).toBe('subagent')
    expect(child.persist).toBe(false)
    expect(await Subagent.countLive(parent.id)).toBe(1)

    const parentSchedules = await db.select().from(schedules).where(eq(schedules.scopeId, parent.id))
    expect(parentSchedules).toHaveLength(1)
    expect(parentSchedules[0].metadata).toEqual({ kind: 'subagent-watchdog' })
  })

  it('persists only normalized server-derived parent execution context', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      parentExecutionContext: {
        version: 1,
        squadId: null,
        environmentToolNames: ['read', 'bash', 'read'],
      },
      subagents: [{ instructions: 'inspect repository' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.metadata).toMatchObject({
      parentExecutionContext: {
        version: 1,
        squadId: null,
        environmentToolNames: ['bash', 'read'],
      },
    })
    expect(child.context).toEqual({})
    expect(JSON.stringify(child.metadata)).not.toMatch(/token|sandbox|\/home\//i)
  })

  it('rejects a parent execution context whose squad does not match the locked parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        parentExecutionContext: { version: 1, squadId: 'forged-squad', environmentToolNames: ['squad_bash'] },
        subagents: [{ instructions: 'inspect repository' }],
      })
    ).rejects.toThrow('squad')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('rejects malformed parent execution context metadata', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        parentExecutionContext: {
          version: 2,
          squadId: null,
          environmentToolNames: ['bash'],
        } as any,
        subagents: [{ instructions: 'inspect repository' }],
      })
    ).rejects.toThrow('Invalid parent execution context')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('copies owner identity so a solo child mints its own author-attributed token', async () => {
    const [owner] = await db
      .insert(users)
      .values({ email: `subagent-owner-${crypto.randomUUID()}@test.local`, displayName: 'Subagent owner' })
      .returning()
    createdUserIds.push(owner.id)
    const parent = await Agent.create({ agentTypeId: parentTypeId, squadId: null, ownerUserId: owner.id })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      parentExecutionContext: { version: 1, squadId: null, environmentToolNames: ['bash'] },
      subagents: [{ instructions: 'inspect repository' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.ownerUserId).toBe(owner.id)
    const parentToken = await parent.getOrCreateToken()
    const childToken = await child.getOrCreateToken()
    expect(childToken).toMatch(/^ficus_agent_/)
    expect(childToken).not.toBe(parentToken)
  })

  it('compensates every child when a later queue fails and leaves no watchdog', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const originalQueue = Agent.prototype.queueExecution
    let queueCalls = 0
    const queue = spyOn(Agent.prototype, 'queueExecution').mockImplementation(async function (
      this: Agent,
      input: Parameters<Agent['queueExecution']>[0]
    ) {
      queueCalls += 1
      if (queueCalls === 2) throw new Error('injected second queue failure')
      return originalQueue.call(this, input)
    })
    try {
      await expect(
        Subagent.dispatch({
          parentAgentId: parent.id,
          subagents: [
            { label: 'first', instructions: 'first succeeds' },
            { label: 'second', instructions: 'second fails' },
          ],
        })
      ).rejects.toThrow('injected second queue failure')
    } finally {
      queue.mockRestore()
    }
    const children = await Agent.list({ parentAgentId: parent.id })
    createdIds.push(...children.map((child) => child.id))
    expect(children).toHaveLength(2)
    expect(children.every((child) => child.terminatedAt instanceof Date)).toBe(true)
    expect(await Subagent.countLive(parent.id)).toBe(0)
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      0
    )
  })

  it('leaves sweepable final requests when partial-dispatch teardown fails', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const originalQueue = Agent.prototype.queueExecution
    let queueCalls = 0
    const queue = spyOn(Agent.prototype, 'queueExecution').mockImplementation(async function (
      this: Agent,
      input: Parameters<Agent['queueExecution']>[0]
    ) {
      queueCalls += 1
      if (queueCalls === 2) throw new Error('injected queue failure')
      return originalQueue.call(this, input)
    })
    setDormancyEffectHookForTest(async (stage) => {
      if (stage === 'schedules') throw new Error('injected dormancy cleanup failure')
    })
    try {
      await expect(
        Subagent.dispatch({
          parentAgentId: parent.id,
          subagents: [
            { label: 'first', instructions: 'first' },
            { label: 'second', instructions: 'second' },
          ],
        })
      ).rejects.toThrow('injected queue failure')
    } finally {
      queue.mockRestore()
      setDormancyEffectHookForTest(undefined)
    }

    let children = await Agent.list({ parentAgentId: parent.id })
    createdIds.push(...children.map((child) => child.id))
    expect(children).toHaveLength(2)
    for (const child of children) {
      expect(child.status).toBe('dormant')
      expect(child.metadata).toMatchObject({
        pendingLifecycleTarget: 'terminated',
        pendingLifecycleRequestId: expect.any(String),
        dispatchCompensation: true,
      })
    }

    expect(
      await sweepPendingFixtureAgents(
        children.map((child) => child.id),
        { maxCandidates: 1 }
      )
    ).toBe(1)
    expect(
      (await Agent.list({ parentAgentId: parent.id })).filter((child) => child.status === 'terminated')
    ).toHaveLength(1)
    expect(
      await sweepPendingFixtureAgents(
        children.map((child) => child.id),
        { maxCandidates: 1 }
      )
    ).toBe(1)
    children = await Agent.list({ parentAgentId: parent.id })
    expect(children.every((child) => child.status === 'terminated')).toBe(true)
    expect(children.every((child) => child.metadata?.pendingLifecycleTarget === undefined)).toBe(true)
  })

  it('rotates a busy pending candidate so a later request is reached on the next capped tick', async () => {
    // An unrelated pending fixture must neither steal this test's capped tick
    // nor be destructively reconciled by it (as happened in shuffled order).
    const neighbor = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(neighbor.id)
    await db
      .update(agents)
      .set({
        metadata: {
          pendingLifecycleTarget: 'dormant',
          pendingLifecycleRequestId: crypto.randomUUID(),
          pendingLifecycleSweepAt: -1,
        },
      })
      .where(eq(agents.id, neighbor.id))
    const neighborBefore = (await db.select().from(agents).where(eq(agents.id, neighbor.id)))[0]
    const stuck = await Agent.create({ agentTypeId: parentTypeId })
    const later = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(stuck.id, later.id)
    const episodeId = crypto.randomUUID()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          pendingLifecycleTarget: 'terminated',
          pendingLifecycleRequestId: crypto.randomUUID(),
          pendingLifecycleSweepAt: 0,
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, stuck.id))
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          pendingLifecycleTarget: 'dormant',
          pendingLifecycleRequestId: crypto.randomUUID(),
          pendingLifecycleSweepAt: 1,
        },
      })
      .where(eq(agents.id, later.id))

    expect(await sweepPendingFixtureAgents([stuck.id, later.id], { maxCandidates: 1 })).toBe(0)
    expect((await Agent.mustFind(stuck.id)).metadata).toHaveProperty('pendingLifecycleTarget')
    expect(await sweepPendingFixtureAgents([stuck.id, later.id], { maxCandidates: 1 })).toBe(1)
    expect(await Agent.mustFind(later.id)).toMatchObject({ status: 'dormant' })
    expect((await Agent.mustFind(later.id)).metadata).not.toHaveProperty('pendingLifecycleTarget')
    expect((await db.select().from(agents).where(eq(agents.id, neighbor.id)))[0]).toEqual(neighborBefore)
  })

  it('replays durable stop intent and never downgrades a pending final request', async () => {
    const child = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(child.id)
    const execution = await child.queueExecution({ message: 'active lifecycle request' })
    await execution.update({ status: 'running' })
    await child.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    try {
      expect(
        await requestAgentLifecycle(child, {
          target: 'terminated',
          reason: 'final request',
          stopActive: true,
        })
      ).toBe(false)
      expect(await requestAgentLifecycle(child, { target: 'dormant', reason: 'stale weaker request' })).toBe(false)
      expect(await sweepPendingFixtureAgents([child.id])).toBe(0)
      expect(stop.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect((await Agent.mustFind(child.id)).metadata).toMatchObject({
        pendingLifecycleTarget: 'terminated',
        pendingLifecycleStopActive: true,
      })
    } finally {
      stop.mockRestore()
    }

    await execution.update({ status: 'stopped' })
    await child.update({ status: 'idle' })
    expect(await sweepPendingFixtureAgents([child.id])).toBe(1)
    expect(await Agent.mustFind(child.id)).toMatchObject({ status: 'terminated' })
    expect((await Agent.mustFind(child.id)).metadata).not.toHaveProperty('pendingLifecycleTarget')
  })

  it('uses the configured subagent tier without storing a child override by default', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'use defaults' }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBeNull()
    expect(await child.getEffectiveModelSpec()).toBe(standardChain)
    expect(child.metadata).not.toHaveProperty('requestedModel')
    expect(child.metadata).not.toHaveProperty('inheritModel')
  })

  it('stores an explicit child override before any model is selected', async () => {
    const explicitChain = 'openai:gpt-5.3-codex'
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'use explicit model', model: explicitChain }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect((await child.mustGetAgentType()).tier).toBe(fixture.tierSlug)
    expect(child.modelOverride).toBe(explicitChain)
    expect(child.selectedModel).toBeNull()
    expect(child.toJson()).toMatchObject({
      modelOverride: explicitChain,
      configuredModel: explicitChain,
    })
    expect(child.metadata).toMatchObject({ requestedModel: explicitChain })
    expect(child.metadata).not.toHaveProperty('inheritModel')
  })

  it('inherits the complete parent override instead of its selected model', async () => {
    const parentChain = 'openai-codex:gpt-5.6-sol:high,anthropic:claude-opus-5:high'
    const parent = await Agent.create({ agentTypeId: parentTypeId, modelOverride: parentChain })
    await db.update(agents).set({ selectedModel: 'anthropic:claude-opus-5:high' }).where(eq(agents.id, parent.id))
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'inherit override', inheritModel: true }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBe(parentChain)
    expect(child.metadata).toMatchObject({ inheritModel: true })
    expect(child.metadata).not.toHaveProperty('requestedModel')
  })

  it('inherits the full parent tier chain', async () => {
    await AgentType.upsert({
      id: parentTypeId,
      name: 'Sub Parent',
      model: '',
      tier: fixture.tierSlug,
      systemPrompt: 'parent',
    })
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    const result = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'inherit tier', inheritModel: true }],
    })

    const child = await Agent.mustFind(result.subagents[0].subagentId)
    expect(child.modelOverride).toBe(standardChain)
    expect(child.metadata).toMatchObject({ inheritModel: true })
    expect(child.metadata).not.toHaveProperty('requestedModel')
  })

  it('rejects model with inheritModel=true atomically', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)

    await expect(
      Subagent.dispatch({
        parentAgentId: parent.id,
        subagents: [
          {
            instructions: 'invalid',
            model: 'anthropic:claude-opus-5:high',
            inheritModel: true,
          },
        ],
      })
    ).rejects.toThrow('model and inheritModel=true are mutually exclusive')
    expect(await Subagent.countLive(parent.id)).toBe(0)
  })

  it('revive clears prior result status without stale delivery metadata', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const { subagents } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'running', label: 'researcher' }],
    })
    const child = await Agent.mustFind(subagents[0].subagentId)
    await child.update({
      status: 'dormant',
      dormantAt: new Date(),
      metadata: { ...(child.metadata ?? {}), resultStatus: 'completed' },
    })

    await Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'continue' })

    const revived = await Agent.mustFind(child.id)
    expect(revived.terminatedAt).toBeNull()
    expect(revived.status).toBe('idle')
    expect(revived.metadata).toMatchObject({ resultStatus: null })
    expect(revived.metadata).not.toMatchObject({ conversational: true })
  })

  it('reports deferred revive while the child dormancy claim is busy', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          ...(child.metadata ?? {}),
          dormancyCompletionPending: true,
          dormancyCompletionId: crypto.randomUUID(),
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, child.id))

    await expect(
      Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'retry later' })
    ).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE', message: expect.stringContaining('retry shortly') })
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('never revives an irreversibly terminated child', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, child.id))

    await expect(
      Subagent.revive({ parentAgentId: parent.id, subagentId: child.id, instructions: 'must stay historical' })
    ).rejects.toThrow('terminated')
    expect((await Agent.mustFind(child.id)).status).toBe('terminated')
  })

  it('stops active execution and returns stopped, then no-ops already terminated child', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    const { subagents } = await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: [{ instructions: 'running', label: 'runner' }],
    })
    const child = await Agent.mustFind(subagents[0].subagentId)
    const active = (await child.getActiveExecution()) as Execution

    const result = await Subagent.stop({ parentAgentId: parent.id, subagentId: child.id, reason: 'test stop' })

    expect(result.status).toBe('stopped')
    expect((await Execution.mustFind(active.id)).status).toBe('stopped')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
    expect((await Subagent.stop({ parentAgentId: parent.id, subagentId: child.id })).status).toBe('already-terminated')
  })

  it('reconcileWatchdog collapses duplicate watchdogs to exactly one while live children exist', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'running' }] })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-a',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-b',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })

    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      3
    )

    await Subagent.reconcileWatchdog(parent.id)

    const watchdogs = await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })
    expect(watchdogs).toHaveLength(1)
    expect(watchdogs[0].metadata).toEqual({ kind: SUBAGENT_WATCHDOG_KIND })
  })

  it('reconcileWatchdog preserves an automatically-disabled breaker projection', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await Subagent.reconcileWatchdog(parent.id)
    const [watchdog] = await Schedule.list({ scopeType: 'agent', scopeId: parent.id })
    const disabledAt = new Date()
    await db
      .update(schedules)
      .set({
        enabled: false,
        nextTriggerAt: null,
        automaticallyDisabledAt: disabledAt,
        automaticDisableReason: 'Automatically disabled after 10 consecutive transient failures.',
      })
      .where(eq(schedules.id, watchdog.id))

    await Subagent.reconcileWatchdog(parent.id)

    const reconciled = await Schedule.mustFind(watchdog.id)
    expect(reconciled).toMatchObject({ enabled: false, nextTriggerAt: null })
    expect(reconciled.automaticallyDisabledAt).toEqual(disabledAt)
  })

  it('reconcileWatchdog deletes all duplicate watchdogs when no live children remain', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-a',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })
    await db.insert(schedules).values({
      scopeType: 'agent',
      scopeId: parent.id,
      name: 'duplicate-watchdog-b',
      schedule: { interval: '15m' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: parent.id }, content: 'check_subagents' },
      metadata: { kind: SUBAGENT_WATCHDOG_KIND },
    })

    await Subagent.reconcileWatchdog(parent.id)

    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toEqual([])
  })

  it('making a parent dormant stops work and makes every child dormant', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)
    const execution = await child.queueExecution({ message: 'child work' })
    await Subagent.reconcileWatchdog(parent.id)
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toHaveLength(
      1
    )

    await parent.tryTerminate()

    expect((await Agent.mustFind(parent.id)).status).toBe('dormant')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
    expect((await Agent.mustFind(child.id)).terminatedAt).toBeNull()
    expect((await Agent.mustFind(grandchild.id)).status).toBe('dormant')
    expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
    expect(await Schedule.list({ scopeType: 'agent', scopeId: parent.id, kind: SUBAGENT_WATCHDOG_KIND })).toEqual([])
  })

  it('defers child teardown until an active worker authoritatively settles', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const execution = await child.queueExecution({ message: 'running child work' })
    await execution.update({ status: 'running' })
    await child.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    let childRevocations = 0
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (
      this: Agent,
      options?: Parameters<Agent['revokeTokensForAgent']>[0]
    ) {
      if (this.id === child.id) childRevocations++
      return originalRevoke.call(this, options)
    })
    try {
      await expect(parent.tryTerminate()).resolves.toBeUndefined()
      expect(await Agent.mustFind(parent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(child.id)).toMatchObject({
        status: 'active',
        pendingDormancyAt: expect.any(Date),
        metadata: expect.objectContaining({
          pendingLifecycleTarget: 'dormant',
          pendingLifecycleStopActive: true,
        }),
      })
      expect((await Execution.mustFind(execution.id)).status).toBe('running')
      expect(stop).toHaveBeenCalled()
      expect(childRevocations).toBe(0)
    } finally {
      stop.mockRestore()
      revoke.mockRestore()
    }
  })

  it('defers a three-level cascade when a busy grandchild leaves its dormant parent incomplete', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)
    const execution = await grandchild.queueExecution({ message: 'running grandchild work' })
    await execution.update({ status: 'running' })
    await grandchild.update({ status: 'active' })
    const stop = spyOn(Execution.prototype, 'requestStopWithSignal').mockResolvedValue(false)
    try {
      await expect(parent.tryTerminate()).resolves.toBeUndefined()
      expect(await Agent.mustFind(parent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(child.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({ dormancyCompletionPending: true }),
      })
      expect(await Agent.mustFind(grandchild.id)).toMatchObject({
        status: 'active',
        metadata: expect.objectContaining({ pendingLifecycleTarget: 'dormant' }),
      })
      expect((await Execution.mustFind(execution.id)).status).toBe('running')
    } finally {
      stop.mockRestore()
    }
  })

  it('defers an already-dormant child whose completion claim is busy', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const completionId = crypto.randomUUID()
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          ...(child.metadata ?? {}),
          dormancyCompletionPending: true,
          dormancyCompletionId: completionId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      .where(eq(agents.id, child.id))

    await expect(Subagent.cascadeDormantChildren(parent.id, new Date())).resolves.toBe(false)
    expect(await Agent.mustFind(child.id)).toMatchObject({
      status: 'dormant',
      metadata: expect.objectContaining({ dormancyCompletionPending: true, dormancyCompletionId: completionId }),
    })
  })

  it('persists child dormancy intent before stopping work and fences racing admission', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const first = await child.queueExecution({ message: 'initial child work' })
    const originalStop = Execution.prototype.requestStopWithSignal
    let racingError: unknown
    const stopSpy = spyOn(Execution.prototype, 'requestStopWithSignal').mockImplementation(async function (
      this: Execution
    ) {
      const result = await originalStop.call(this)
      if (this.id === first.id && !racingError) {
        try {
          await child.queueExecution({ message: 'racing child work' })
        } catch (error) {
          racingError = error
        }
      }
      return result
    })
    try {
      await parent.tryTerminate()
    } finally {
      stopSpy.mockRestore()
    }

    expect(racingError).toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })
    expect(await Agent.mustFind(child.id)).toMatchObject({ status: 'dormant', dormantAt: expect.any(Date) })
    expect((await Execution.list({ agentId: child.id })).map(({ status }) => status)).toEqual(['stopped'])
  })

  it('retains parent and child dormancy completion until failed child teardown retries', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    let failChild = true
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (this: Agent) {
      if (this.id === child.id && failChild) throw new Error('injected child teardown failure')
      return originalRevoke.call(this)
    })
    try {
      await expect(parent.tryTerminate()).rejects.toThrow('Failed to make 1 subagent(s) dormant')
      expect((await Agent.mustFind(parent.id)).metadata).toMatchObject({ dormancyCompletionPending: true })
      expect((await Agent.mustFind(child.id)).metadata).toMatchObject({ dormancyCompletionPending: true })
      failChild = false
      await makeDormant(await Agent.mustFind(parent.id))
    } finally {
      revoke.mockRestore()
    }

    expect((await Agent.mustFind(parent.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    expect((await Agent.mustFind(child.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('generic parent termination cascades through nested descendants', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const grandchild = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: child.id })
    createdIds.push(parent.id, child.id, grandchild.id)

    await parent.update({ terminatedAt: new Date() })

    expect((await Agent.mustFind(child.id)).terminatedAt).toBeInstanceOf(Date)
    expect((await Agent.mustFind(grandchild.id)).terminatedAt).toBeInstanceOf(Date)
  })

  it('continues cascading later siblings and propagates a child finalization failure', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const first = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    const second = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, first.id, second.id)
    const originalRevoke = Agent.prototype.revokeTokensForAgent
    const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (this: Agent) {
      if (this.id === first.id) throw new Error('injected child failure')
      return originalRevoke.call(this)
    })
    try {
      await expect(Subagent.cascadeStopChildren(parent.id)).rejects.toThrow(
        'Failed to finalize one or more descendants'
      )
    } finally {
      revoke.mockRestore()
    }
    expect(await Agent.mustFind(first.id)).toMatchObject({
      status: 'dormant',
      metadata: expect.objectContaining({ dormancyCompletionPending: true }),
    })
    expect(await Agent.mustFind(second.id)).toMatchObject({ status: 'terminated', terminatedAt: expect.any(Date) })
  })

  it('stops a child without delivering to an already terminated parent', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    const child = await Agent.create({ agentTypeId: parentTypeId, parentAgentId: parent.id })
    createdIds.push(parent.id, child.id)
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, parent.id))
    const send = spyOn(InboxMessage, 'send')
    try {
      await expect(Subagent.stop({ parentAgentId: parent.id, subagentId: child.id })).resolves.toEqual({
        status: 'stopped',
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      send.mockRestore()
    }
    expect((await Agent.mustFind(child.id)).status).toBe('dormant')
  })

  it('errors atomically when over the cap and excludes terminated children from live count', async () => {
    const parent = await Agent.create({ agentTypeId: parentTypeId })
    createdIds.push(parent.id)
    await Subagent.dispatch({
      parentAgentId: parent.id,
      subagents: Array.from({ length: 10 }, (_, i) => ({ instructions: `t${i}` })),
    })
    await expect(
      Subagent.dispatch({ parentAgentId: parent.id, subagents: [{ instructions: 'overflow' }] })
    ).rejects.toThrow(/slots free/)
    expect(await Subagent.countLive(parent.id)).toBe(10)
  })
})
