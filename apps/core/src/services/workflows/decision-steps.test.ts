import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
  workflowDefinitionSchema,
  type DecisionAnswer,
  type DecisionRequest,
  type WorkflowDecisionReply,
  type WorkflowDefinition,
} from '@ficus/shared'
import { db, agents, agentTypes, inbox, squads, workStreams, workStreamFlowTransitions } from '../../db'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../../test-utils/rbac'
import { listOpenWaits } from '../work-streams/waits'
import { attachFlow, dispatchFlow, advanceFlow, getFlow, guardFlowWaitResolution } from './execution'
import {
  applyDecision,
  decisionRequestId,
  evaluateFlowDecisions,
  DECISION_ACTOR_KEY,
  type DecideFn,
} from './decision-steps'
import { flowWaitReference } from './wait-policy'

const prefix = `flow-decisions-${randomUUID()}`
const agentTypeId = `${prefix}-worker`
let squadId: string
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>
const actor = { type: 'legacy' } as const

beforeAll(async () => {
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Decision flow worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Builds things',
    extraScopes: ['workstreams:respond'],
  })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Decision step fixtures' }).returning()
  squadId = squad!.id
  // Durable dispatch only: no model or sandbox starts.
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
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  await cleanupTestRbac(prefix)
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
})

/** build (agent) → triage (decision) → ship: finish | review: approve (human) | rework: back to build. */
function definition(triage: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'Decided delivery',
    participants: { builder: { agentTypeId, session: 'reuse-within-stream' } },
    entry: 'build',
    routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
    limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
    steps: [
      {
        id: 'build',
        participant: 'builder',
        instructions: 'Build it.',
        output: 'The change.',
        outcomes: { done: { next: 'triage' } },
      },
      {
        id: 'triage',
        kind: 'decision',
        instructions: 'Decide whether the change can ship.',
        questions: {
          ready: { type: 'yesno', instructions: 'The change is complete and verified.' },
          kind: { type: 'choice', instructions: 'What kind of change?', options: { bug: 'A fix', feature: 'New' } },
        },
        routes: [
          { when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.8 }, outcome: 'ship' },
          { when: { type: 'yesno', question: 'ready', op: 'at-most', probability: 0.2 }, outcome: 'rework' },
        ],
        otherwise: 'review',
        unavailable: 'review',
        outcomes: { ship: { next: 'finish' }, review: { next: 'approve' }, rework: { returnTo: 'build' } },
        ...triage,
      },
      ...extra,
      {
        id: 'approve',
        kind: 'human-approval',
        approver: 'reviewers',
        instructions: 'Approve the change.',
        output: 'Approval.',
        outcomes: { approved: { next: 'finish' } },
      },
    ],
    completion: { mode: 'deliverable' },
  })
}

async function create(flow: WorkflowDefinition) {
  return db.transaction(async (tx) => {
    const [stream] = await tx
      .insert(workStreams)
      .values({ squadId, title: `${prefix} change`, description: 'Fix the login bug.', status: 'active' })
      .returning()
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition: flow })
    await dispatchFlow(tx, stream!, run, [])
    return stream!.id
  })
}

/** Create a stream and complete its build step, so the decision step is active. */
async function atDecision(flow = definition()) {
  const id = await create(flow)
  await advanceFlow(
    id,
    { expectedVersion: 0, attemptId: 1, action: 'complete', outcome: 'done', evidence: 'Built and tested.' },
    randomUUID(),
    actor
  )
  return id
}

function stub(reply: WorkflowDecisionReply | (() => WorkflowDecisionReply | Promise<WorkflowDecisionReply>)) {
  const requests: DecisionRequest[] = []
  const decide: DecideFn = async (_purpose, request) => {
    requests.push(request)
    return typeof reply === 'function' ? reply() : reply
  }
  return { decide, requests }
}

const answered = (answers: Record<string, DecisionAnswer>): WorkflowDecisionReply => ({
  ok: true,
  result: { answers, providerId: 'jev', model: 'jev-latest', latencyMs: 87 },
})
const ready = (probability: number) =>
  answered({
    ready: { type: 'yesno', probability },
    kind: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9, feature: 0.1 } },
  })

async function transitions(id: string) {
  return db.select().from(workStreamFlowTransitions).where(eq(workStreamFlowTransitions.workStreamId, id))
}

async function reviewer() {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['workstreams:review'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  return { type: 'user' as const, userId: user.id }
}

describe('decision steps', () => {
  test('an answered decision follows the first matching route and records why', async () => {
    const id = await atDecision()
    const { decide, requests } = stub(ready(0.5))
    expect(await evaluateFlowDecisions(id, { decide })).toBe(1)

    // The model sees only the selected inputs, with the result handed to the decision.
    expect(requests).toHaveLength(1)
    expect(requests[0]!.state).toEqual({
      title: `${prefix} change`,
      description: 'Fix the login bug.',
      incomingResults: [{ step: 'build', outcome: 'done', result: 'Built and tested.' }],
    })
    const run = (await getFlow(id))!
    const decided = run.state.attempts[1]!
    expect(decided).toMatchObject({ stepId: 'triage', status: 'completed', outcome: 'review' })
    expect(decided.decision).toMatchObject({
      status: 'answered',
      matched: 'otherwise',
      outcome: 'review',
      providerId: 'jev',
      model: 'jev-latest',
      latencyMs: 87,
      answers: { ready: { type: 'yesno', probability: 0.5 } },
    })
    expect(decided.evidence).toContain("Decision: 'review' (no route matched).")
    expect(run.state.attempts[2]).toMatchObject({ stepId: 'approve', status: 'running' })
    expect(run.version).toBe(2)

    const [receipt] = (await transitions(id)).filter((row) => row.actorKey === DECISION_ACTOR_KEY)
    expect(receipt).toMatchObject({ requestId: decisionRequestId(id, 2), version: 2 })
    expect(receipt!.command).toMatchObject({ action: 'complete', attemptId: 2, outcome: 'review' })
    // The approval it routed to opens its human gate.
    expect((await listOpenWaits(db, id)).map((wait) => wait.referenceId)).toEqual([flowWaitReference(id, 'human', 3)])
  })

  test('a send-back route returns the work to the agent with the decision as feedback', async () => {
    const id = await atDecision()
    await evaluateFlowDecisions(id, stub(ready(0.1)))
    const run = (await getFlow(id))!
    expect(run.state.attempts[1]).toMatchObject({ status: 'returned', outcome: 'rework' })
    expect(run.state.attempts[2]).toMatchObject({ stepId: 'build', status: 'running' })
    const handoff = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `flow:${id}:3`))
    expect(handoff[0]!.content).toContain("Decision: 'rework' (route 2: ready ≤ 20%).")
  })

  test('a decision that finishes a deliverable flow completes the work stream', async () => {
    const id = await atDecision()
    await evaluateFlowDecisions(id, stub(ready(0.95)))
    expect((await getFlow(id))!.state.status).toBe('completion-ready')
    expect((await WorkStream.mustFind(id)).status).toBe('done')
  })

  test('a refusal follows the unavailable outcome', async () => {
    const id = await atDecision()
    await evaluateFlowDecisions(
      id,
      stub(answered({ ready: { type: 'refusal' }, kind: { type: 'choice', choice: 'bug', probabilities: {} } }))
    )
    const decided = (await getFlow(id))!.state.attempts[1]!
    expect(decided).toMatchObject({ status: 'completed', outcome: 'review' })
    expect(decided.decision).toMatchObject({ status: 'refused', matched: 'unavailable', outcome: 'review' })
  })

  test('a failing decision service counts as no answer instead of retrying forever', async () => {
    const id = await atDecision()
    await evaluateFlowDecisions(id, {
      decide: async () => {
        throw new Error('boom')
      },
    })
    expect((await getFlow(id))!.state.attempts[1]!.decision).toMatchObject({
      status: 'unavailable',
      outcome: 'review',
      errors: [{ providerId: 'core', error: 'boom' }],
    })
  })

  test('unconfigured with no unavailable outcome waits for a person, who chooses through the approval path', async () => {
    const id = await atDecision(definition({ unavailable: undefined }))
    const first = stub({ ok: false, reason: 'unconfigured', errors: [] })
    expect(await evaluateFlowDecisions(id, first)).toBe(1)

    let run = (await getFlow(id))!
    const waiting = run.state.attempts[1]!
    expect(waiting.status).toBe('running')
    expect(waiting.decision).toMatchObject({ status: 'unconfigured', awaitingPerson: true })
    expect(waiting.outcome).toBeUndefined()
    expect(run.version).toBe(1)
    const [wait] = await listOpenWaits(db, id)
    expect(wait).toMatchObject({
      referenceId: flowWaitReference(id, 'human', 2),
      flowAttemptId: 2,
      resolutionHandler: 'workflow',
    })
    expect(wait!.message).toContain('Decide whether the change can ship.')
    expect(wait!.message).toContain('no decision provider is configured')
    expect((await WorkStream.mustFind(id)).assigneeAgentId).toBeNull()
    await expect(db.transaction((tx) => guardFlowWaitResolution(tx, id, wait!.id))).rejects.toThrow(
      'Use the workflow decision'
    )

    // It never asks again on its own.
    const again = stub(ready(0.95))
    expect(await evaluateFlowDecisions(id, again)).toBe(0)
    expect(again.requests).toHaveLength(0)

    const command = { action: 'complete', expectedVersion: 1, attemptId: 2, outcome: 'ship', evidence: '' }
    await expect(advanceFlow(id, command, randomUUID(), actor)).rejects.toThrow('review permission')
    await advanceFlow(id, command, randomUUID(), await reviewer())
    run = (await getFlow(id))!
    expect(run.state.attempts[1]).toMatchObject({ status: 'completed', outcome: 'ship' })
    expect(run.state.status).toBe('completion-ready')
    expect(await listOpenWaits(db, id)).toHaveLength(0)
  })

  test('nobody can choose for a decision step the model is still deciding', async () => {
    const id = await atDecision()
    const command = { action: 'complete', expectedVersion: 1, attemptId: 2, outcome: 'ship', evidence: '' }
    await expect(advanceFlow(id, command, randomUUID(), await reviewer())).rejects.toThrow(
      'A decision model is deciding this step'
    )
  })

  test('retries, restarts and racing evaluators never advance a decision twice', async () => {
    const id = await atDecision()
    const reply = ready(0.5)
    const results = await Promise.all([applyDecision(id, 2, reply), applyDecision(id, 2, reply)])
    expect(results.filter(Boolean)).toHaveLength(1)
    // A retry after a crash between the answer and the commit, or a late duplicate, is a no-op.
    expect(await applyDecision(id, 2, ready(0.95))).toBe(false)
    const run = (await getFlow(id))!
    expect(run.version).toBe(2)
    expect(run.state.attempts[1]!.outcome).toBe('review')
    expect((await transitions(id)).filter((row) => row.actorKey === DECISION_ACTOR_KEY)).toHaveLength(1)

    // Coalesced evaluations of one stream ask the model once.
    const other = await atDecision()
    let calls = 0
    const slow: DecideFn = async () => {
      calls++
      await Promise.resolve()
      return ready(0.5)
    }
    await Promise.all([evaluateFlowDecisions(other, { decide: slow }), evaluateFlowDecisions(other, { decide: slow })])
    expect(calls).toBe(1)
    expect((await getFlow(other))!.version).toBe(2)
  })

  test('a paused stream is not decided until it resumes', async () => {
    const id = await atDecision()
    await db
      .update(workStreams)
      .set({ pause: { requestedAt: new Date().toISOString() } as never })
      .where(eq(workStreams.id, id))
    const { decide, requests } = stub(ready(0.5))
    expect(await evaluateFlowDecisions(id, { decide })).toBe(0)
    expect(requests).toHaveLength(0)
    expect(await applyDecision(id, 2, ready(0.5))).toBe(false)
    await db.update(workStreams).set({ pause: null }).where(eq(workStreams.id, id))
    expect(await evaluateFlowDecisions(id, { decide })).toBe(1)
  })

  test('chained decision steps are decided in one pass', async () => {
    const flow = definition(
      { outcomes: { ship: { next: 'second' }, review: { next: 'approve' }, rework: { returnTo: 'build' } } },
      [
        {
          id: 'second',
          kind: 'decision',
          instructions: 'Second opinion.',
          input: ['incoming-results'],
          questions: { ready: { type: 'yesno', instructions: 'Still ready.' } },
          routes: [{ when: { type: 'yesno', question: 'ready', op: 'at-least', probability: 0.5 }, outcome: 'go' }],
          outcomes: { go: { next: 'finish' } },
        },
      ]
    )
    const id = await atDecision(flow)
    const { decide, requests } = stub(ready(0.9))
    expect(await evaluateFlowDecisions(id, { decide })).toBe(2)
    expect(requests[1]!.state).toEqual({
      incomingResults: [
        { step: 'build', outcome: 'done', result: 'Built and tested.' },
        expect.objectContaining({ step: 'triage', outcome: 'ship' }),
      ],
    })
    const run = (await getFlow(id))!
    expect(run.state.attempts.map((attempt) => [attempt.stepId, attempt.outcome])).toEqual([
      ['build', 'done'],
      ['triage', 'ship'],
      ['second', 'go'],
    ])
    const rows = await db
      .select()
      .from(workStreamFlowTransitions)
      .where(
        and(eq(workStreamFlowTransitions.workStreamId, id), eq(workStreamFlowTransitions.actorKey, DECISION_ACTOR_KEY))
      )
    expect(rows.map((row) => row.version).sort()).toEqual([2, 3])
  })
})
