import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { workflowPresetSchema, type WorkflowDefinition, type WorkStreamActionData } from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  executions,
  inbox,
  squads,
  workStreams,
  workStreamFlowTransitions,
  workStreamWaits,
  workflowBindings,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../../test-utils/rbac'
import { listOpenWaits, toWaitJson } from '../work-streams/waits'
import { computeDerivedStates } from '../work-streams/derived-state'
import { listPendingActions } from '../agents/actions'
import { evaluatePendingAction } from '../agents/pending-action-policy'
import { EMPTY_USER_ATTENTION } from '../attention/resolver'
import { attachFlow, dispatchFlow, advanceFlow, getFlow, guardFlowWaitResolution } from './execution'

const prefix = `attempt-limit-${randomUUID()}`
const agentTypeId = `${prefix}-worker`
const legacy = { type: 'legacy' } as const
let squadId: string
let flow: WorkflowDefinition
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

beforeAll(async () => {
  flow = workflowPresetSchema.parse(
    Bun.YAML.parse(
      await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
    )
  ).definition
  for (const participant of Object.values(flow.participants)) participant.agentTypeId = agentTypeId
  flow.limits.maxStepAttempts = 1
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Attempt limit worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Synthetic fixture',
    extraScopes: ['workstreams:respond'],
  })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Attempt limit fixtures' }).returning()
  squadId = squad!.id
  // Durable dispatch and inbox claims run without starting a model or sandbox.
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, status: 'queued', queued: true })
})
afterAll(async () => {
  send?.mockRestore()
  if (squadId) {
    const owned = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    if (owned.length)
      await db.delete(inbox).where(
        inArray(
          inbox.recipientId,
          owned.map((agent) => agent.id)
        )
      )
    await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squadId))
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  await cleanupTestRbac(prefix)
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
})

/** A stream whose build step used its one attempt and was sent back, so the flow paused at the limit. */
async function pausedStream() {
  const id = await db.transaction(async (tx) => {
    const [stream] = await tx.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    await dispatchFlow(tx, stream!, run, [])
    return stream!.id
  })
  for (const outcome of ['completed', 'changes-requested']) {
    const run = (await getFlow(id))!
    await advanceFlow(
      id,
      {
        action: 'complete',
        expectedVersion: run.version,
        attemptId: run.state.activeAttemptId,
        outcome,
        evidence: 'Synthetic result',
      },
      randomUUID(),
      legacy
    )
  }
  const run = (await getFlow(id))!
  expect(run.state.status).toBe('paused')
  const bound = await db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, id))
  return {
    id,
    run,
    builder: bound.find((binding) => binding.participantId === 'builder')!.agentId,
    reviewer: bound.find((binding) => binding.participantId === 'reviewer')!.agentId,
  }
}
const raise = (version: number, maxStepAttempts: number | null) => ({
  action: 'raise-limit' as const,
  expectedVersion: version,
  maxStepAttempts,
})
async function limitWaits(id: string) {
  return (await listOpenWaits(db, id)).filter((wait) => wait.resolutionHandler === 'workflow')
}
async function reviewerUser(permissions: string[] = ['actions:read', 'workstreams:review']) {
  const user = await createTestUser({ prefix, displayName: 'Synthetic Reviewer' })
  const role = await createTestRole({ prefix, permissions })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  return user
}

describe('attempt-limit pause', () => {
  test('opens a plain-language wait that every surface can recognize, and keeps the stream blocked', async () => {
    const { id } = await pausedStream()
    const [wait] = await limitWaits(id)
    const stream = (await db.select().from(workStreams).where(eq(workStreams.id, id)))[0]!
    expect(wait!.message).toContain('"build" has used all 1 of its allowed attempts')
    expect(wait!.message).toContain('raise the attempt limit, or remove it')
    expect(wait!.message).toContain(`ficus workstream raise-limit ${stream.number} --max-step-attempts <number>`)
    expect(toWaitJson(wait!).workflowAttemptLimit).toBe(true)
    // The stream is blocked on a person (not the Resume-only cloche pause); the wait names the reason.
    expect(stream.pause).toBeNull()
    const derived = (await computeDerivedStates([stream])).get(id)!
    expect(derived.derivedState).toBe('blocked')
    expect(derived.openWaits.find((entry) => entry.id === wait!.id)?.workflowAttemptLimit).toBe(true)
  })

  test('generic unblock and typed input refuse the wait and name the raise-limit action', async () => {
    const { id } = await pausedStream()
    const [wait] = await limitWaits(id)
    await expect(guardFlowWaitResolution(db, id, wait!.id)).rejects.toThrow('ficus workstream raise-limit')
    const { resolveStructuredInput } = await import('../recovery/structured-input')
    await expect(
      resolveStructuredInput(id, wait!.id, { action: 'continue', expectedVersion: 0 }, { userId: null })
    ).rejects.toThrow('attempt-limit pause')
  })

  test('a revision with attemptId omitted resumes the paused flow', async () => {
    const { id, run } = await pausedStream()
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: run.version,
        active: 'keep',
        reason: 'Allow another pass',
        operations: [{ op: 'set-limits', limits: { ...run.state.definition.limits, maxStepAttempts: 3 } }],
      },
      randomUUID(),
      legacy
    )
    const resumed = (await getFlow(id))!
    expect(resumed.state.status).toBe('running')
    expect(await limitWaits(id)).toHaveLength(0)
  })

  test('a reviewer raises the limit in one step, recorded with who did it', async () => {
    const { id, run } = await pausedStream()
    const reviewer = await reviewerUser()
    const [wait] = await limitWaits(id)
    const requestId = randomUUID()
    const result = await advanceFlow(id, raise(run.version, 4), requestId, {
      type: 'user',
      userId: reviewer.id,
    })
    expect(result.stateStatus).toBe('running')
    const resumed = (await getFlow(id))!
    expect(resumed.state.definition.limits.maxStepAttempts).toBe(4)
    expect(resumed.state.pauseReason).toBeUndefined()
    const started = resumed.state.attempts.find((attempt) => attempt.id === resumed.state.activeAttemptId)!
    expect(started.stepId).toBe('build')
    expect(started.status).toBe('running')
    const revision = resumed.state.revisions!.at(-1)!
    expect(revision.actor).toBe(`user:${reviewer.id}`)
    expect(revision.reason).toBe("Attempt limit raised from 1 to 4 to resume step 'build' (by Synthetic Reviewer)")
    const [closed] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, wait!.id))
    expect(closed!.closedAt).not.toBeNull()
    expect(closed!.resolution).toBe('cleared')
    expect(closed!.resolutionNote).toBe(revision.reason)
    const [transition] = await db
      .select()
      .from(workStreamFlowTransitions)
      .where(and(eq(workStreamFlowTransitions.workStreamId, id), eq(workStreamFlowTransitions.requestId, requestId)))
    expect(transition!.actorKey).toBe(`user:${reviewer.id}`)
    expect(transition!.command).toMatchObject({ action: 'raise-limit', maxStepAttempts: 4 })
    // The held build attempt is dispatched again to the builder.
    expect((await db.select().from(workStreams).where(eq(workStreams.id, id)))[0]!.assigneeAgentId).not.toBeNull()
  })

  test('the squad manager agent removes the limit; the stream owner agent may raise it', async () => {
    const manager = await Agent.create({ agentTypeId, squadId })
    await db.update(squads).set({ managerAgentId: manager.id }).where(eq(squads.id, squadId))
    try {
      const first = await pausedStream()
      await advanceFlow(first.id, raise(first.run.version, null), randomUUID(), {
        type: 'agent',
        agentId: manager.id,
        squadId,
      })
      const removed = (await getFlow(first.id))!
      expect(removed.state.definition.limits.maxStepAttempts).toBeUndefined()
      expect(removed.state.revisions!.at(-1)!.actor).toBe(`agent:${manager.id}`)
      expect(removed.state.revisions!.at(-1)!.reason).toContain('Attempt limit removed (was 1)')
    } finally {
      await db.update(squads).set({ managerAgentId: null }).where(eq(squads.id, squadId))
    }
    const owner = await Agent.create({ agentTypeId, squadId })
    const second = await pausedStream()
    await db.update(workStreams).set({ ownerAgentId: owner.id }).where(eq(workStreams.id, second.id))
    await advanceFlow(second.id, raise(second.run.version, 2), randomUUID(), {
      type: 'agent',
      agentId: owner.id,
      squadId,
    })
    expect((await getFlow(second.id))!.state.status).toBe('running')
  })

  test('refuses the stuck agent, other workers, people without review rights and unassigned reviewers', async () => {
    const { id, run, builder, reviewer: reviewerAgent } = await pausedStream()
    const outsider = await reviewerUser(['actions:read', 'workstreams:respond'])
    const unassigned = await reviewerUser()
    const assigned = await reviewerUser()
    const command = raise(run.version, 5)
    // The agent that ran the paused step cannot unblock itself, even as the stream owner.
    await db.update(workStreams).set({ ownerAgentId: builder }).where(eq(workStreams.id, id))
    for (const identity of [
      { type: 'agent' as const, agentId: builder, squadId },
      { type: 'agent' as const, agentId: reviewerAgent, squadId },
      { type: 'user' as const, userId: outsider.id },
    ])
      await expect(advanceFlow(id, command, randomUUID(), identity)).rejects.toThrow('raise the attempt limit')
    await db
      .update(workStreams)
      .set({ assignedReviewerIds: [assigned.id] })
      .where(eq(workStreams.id, id))
    await expect(advanceFlow(id, command, randomUUID(), { type: 'user', userId: unassigned.id })).rejects.toThrow(
      'raise the attempt limit'
    )
    expect((await getFlow(id))!.version).toBe(run.version)
    expect(await limitWaits(id)).toHaveLength(1)
    await advanceFlow(id, command, randomUUID(), { type: 'user', userId: assigned.id })
    expect((await getFlow(id))!.state.status).toBe('running')
  })

  test('refuses a limit that would pause again, and raise-limit on a running flow', async () => {
    const { id, run } = await pausedStream()
    await expect(advanceFlow(id, raise(run.version, 1), randomUUID(), legacy)).rejects.toThrow('choose a limit above 1')
    await advanceFlow(id, raise(run.version, 2), randomUUID(), legacy)
    const running = (await getFlow(id))!
    await expect(advanceFlow(id, raise(running.version, 9), randomUUID(), legacy)).rejects.toThrow(
      'not paused at an attempt limit'
    )
  })

  test('the Action Center card carries the pause and lets reviewers act', async () => {
    const { id, run } = await pausedStream()
    const reviewer = await reviewerUser()
    const responder = await reviewerUser(['actions:read', 'workstreams:respond'])
    const action = (await listPendingActions()).find(
      (entry) => 'workStreamId' in entry.data && entry.data.workStreamId === id
    )!
    const data = action.data as WorkStreamActionData
    expect(data.attemptLimit).toMatchObject({ stepId: 'build', attemptsUsed: 1, limit: 1, flowVersion: run.version })
    expect(data.wait.workflowAttemptLimit).toBe(true)
    const context = { attention: EMPTY_USER_ATTENTION }
    expect(await evaluatePendingAction({ type: 'user', userId: reviewer.id }, action, context)).toEqual({
      visible: true,
      canRespond: true,
    })
    expect(await evaluatePendingAction({ type: 'user', userId: responder.id }, action, context)).toEqual({
      visible: true,
      canRespond: false,
    })
  })
})

describe('ask_human recovery guard', () => {
  test('an attempt-limit pause and an automatic retry never block a question; a held recovery does', async () => {
    const { createAgentQuestion } = await import('../agents/questions')
    const { recordRecoveryFailure } = await import('../recovery/store')
    await pausedStream()
    const manager = await Agent.create({ agentTypeId, squadId })
    const ask = async () => {
      const [execution] = await db.insert(executions).values({ agentId: manager.id, status: 'running' }).returning()
      return createAgentQuestion(
        { agentId: manager.id, executionId: execution!.id },
        { questions: [{ id: 'q1', type: 'text', question: 'Which release window should I target?' }] }
      )
    }
    const [failing] = await db.insert(executions).values({ agentId: manager.id, status: 'running' }).returning()
    const fail = (invocationId: string) =>
      recordRecoveryFailure(
        { agentId: manager.id, executionId: failing!.id },
        { operationKey: 'unrelated-command', attempted: 'Run a command', invocationId, error: new Error('lost') }
      )
    expect((await fail('first')).state.state).toBe('recovering')
    expect((await ask()).status).toBe('open')
    await fail('second')
    // The fixture squad has no manager agent, so the held decision routes to the owner.
    expect(['waiting-manager', 'waiting-owner']).toContain((await fail('third')).state.state)
    await expect(ask()).rejects.toThrow('unresolved recovery')
  })
})
