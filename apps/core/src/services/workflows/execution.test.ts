import { getPostgresError } from '../../db/errors'
import { externalDeliveryStreamIds } from './delivery-state'
import { listPendingActions } from '../agents/actions'
import { EMPTY_USER_ATTENTION } from '../attention/resolver'
import { evaluatePendingAction } from '../agents/pending-action-policy'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, like, inArray, sql } from 'drizzle-orm'
import {
  workflowPresetSchema,
  type WorkflowDefinition,
  createBlankWorkflow,
  workflowStepSchema,
  activeWorkflowAttempts,
  workflowReworkAttempt,
} from '@ficus/shared'
import {
  db,
  agents,
  agentTypes,
  modelTiers,
  squads,
  workStreams,
  worktreeCleanupJobs,
  workflowBindings,
  inbox,
  executions,
  messages as chatMessages,
  workStreamWaits,
} from '../../db'
import { Agent } from '../../entities/Agent'
import { WorkStream } from '../../entities/WorkStream'
import { Schedule } from '../../entities/Schedule'
import * as githubApi from '../github/api-client'
import { createTestUser, createTestRole, assignRole, cleanupTestRbac } from '../../test-utils/rbac'
import { validateSquadWorkflows } from './access'
import { openWait, closeOpenWaits, listOpenWaits, toWaitJson } from '../work-streams/waits'
import {
  attachFlow,
  dispatchFlow,
  ensureFlowDispatch,
  advanceFlow,
  getFlow,
  guardFlowMutation,
  isCurrentFlowMessage,
  flowAgentType,
  finishFlow,
  guardFlowWaitResolution,
  activeOutcomeBindings,
} from './execution'

const prefix = `flow-execution-${randomUUID()}`
const agentTypeId = `${prefix}-worker`
const overrideTier = `${prefix}-override`
let squadId: string
let flow: WorkflowDefinition
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>
const actor = { type: 'legacy' } as const

beforeAll(async () => {
  flow = workflowPresetSchema.parse(
    Bun.YAML.parse(
      await Bun.file(new URL('../../../../../config/workflows/builder-reviewer.yaml', import.meta.url)).text()
    )
  ).definition
  for (const participant of Object.values(flow.participants)) participant.agentTypeId = agentTypeId
  await db.insert(agentTypes).values({
    id: agentTypeId,
    name: 'Flow worker',
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Shared role expertise and operational guidance',
    extraScopes: ['workstreams:respond'],
  })
  await db
    .insert(modelTiers)
    .values({ slug: overrideTier, label: 'Override fixture', chain: 'anthropic:claude-haiku-4-5' })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Flow execution fixtures' }).returning()
  squadId = squad!.id
  // Exercise durable dispatch and inbox claims without starting a model or sandbox.
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
          owned.map((a) => a.id)
        )
      )
    await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
    await db.delete(agents).where(eq(agents.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  }
  await cleanupTestRbac(prefix)
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  await db.delete(modelTiers).where(eq(modelTiers.slug, overrideTier))
})
async function create(status: 'active' | 'queued' = 'active', definition = flow) {
  return db.transaction(async (tx) => {
    const [stream] = await tx.insert(workStreams).values({ squadId, title: prefix, status }).returning()
    const run = await attachFlow(tx, stream!, { kind: 'inline', definition })
    const callbacks: Array<() => void> = []
    await dispatchFlow(tx, stream!, run, callbacks)
    return stream!.id
  })
}
async function bindings(id: string) {
  return db.select().from(workflowBindings).where(eq(workflowBindings.workStreamId, id))
}
async function messages(id: string) {
  return db
    .select()
    .from(inbox)
    .where(like(inbox.idempotencyKey, `flow:${id}:%`))
}
async function advance(id: string, outcome: string) {
  const run = (await getFlow(id))!
  return advanceFlow(
    id,
    {
      expectedVersion: run.version,
      attemptId: run.state.activeAttemptId,
      action: 'complete',
      outcome,
      evidence: 'Verified result',
    },
    randomUUID(),
    actor
  )
}

describe('lazy flow execution', () => {
  test('queued work snapshots the flow without creating any participants or messages', async () => {
    const id = await create('queued')
    expect((await getFlow(id))!.participantSnapshots.builder!.systemPrompt).toBe(
      'Shared role expertise and operational guidance'
    )
    await ensureFlowDispatch(id)
    expect(await bindings(id)).toHaveLength(0)
    expect(await messages(id)).toHaveLength(0)
    await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, id))
    await ensureFlowDispatch(id)
    expect(await bindings(id)).toHaveLength(1)
    expect(await messages(id)).toHaveLength(1)
    expect((await messages(id))[0]!.content).toContain('Delegation: disabled')
    expect((await messages(id))[0]!.content).toContain('Outcomes:')
  })
  test('reviewer is created only on handoff; return reuses both sessions', async () => {
    const id = await create()
    const initial = await bindings(id)
    expect(initial).toHaveLength(1)
    expect(initial[0]!.participantId).toBe('builder')
    await advance(id, 'completed')
    expect(await bindings(id)).toHaveLength(2)
    await advance(id, 'changes-requested')
    expect((await WorkStream.mustFind(id)).assigneeAgentId).toBe(initial[0]!.agentId)
    await advance(id, 'completed')
    await advance(id, 'approved')
    expect(await bindings(id)).toHaveLength(2)
    expect(await messages(id)).toHaveLength(4)
    expect((await getFlow(id))!.state.status).toBe('completion-ready')
  })
  test('fresh-per-attempt creates a new session only when the return activates', async () => {
    const definition = structuredClone(flow)
    definition.participants.builder!.session = 'fresh-per-attempt'
    const id = await create('active', definition)
    expect(await bindings(id)).toHaveLength(1)
    await advance(id, 'completed')
    expect(await bindings(id)).toHaveLength(2)
    await advance(id, 'changes-requested')
    const rows = await bindings(id)
    expect(rows).toHaveLength(3)
    expect(new Set(rows.filter((r) => r.participantId === 'builder').map((r) => r.agentId)).size).toBe(2)
  })
  test('recovery and racing retries create one binding and dispatch per attempt', async () => {
    const id = await create()
    await Promise.all([ensureFlowDispatch(id), ensureFlowDispatch(id)])
    const command = {
      expectedVersion: 0,
      attemptId: 1,
      action: 'complete',
      outcome: 'completed',
      evidence: 'One result',
    }
    const requestId = randomUUID()
    const results = await Promise.all([
      advanceFlow(id, command, requestId, actor),
      advanceFlow(id, command, requestId, actor),
    ])
    expect(results[0]).toEqual(results[1])
    expect(await bindings(id)).toHaveLength(2)
    expect(await messages(id)).toHaveLength(2)
    await expect(advanceFlow(id, command, randomUUID(), actor)).rejects.toThrow('Stale')
  })
  test('human approval steps create no agent and reject automation as approver', async () => {
    const definition = structuredClone(flow)
    definition.steps[0] = {
      id: 'build',
      kind: 'human-approval',
      approver: 'assigned-reviewers',
      instructions: 'Approve scope',
      output: 'Decision',

      outcomes: { completed: { next: 'review' } },
    }
    const id = await create('active', definition)
    expect(await bindings(id)).toHaveLength(0)
    expect(await messages(id)).toHaveLength(0)
    await expect(advance(id, 'completed')).rejects.toThrow('designated human approver')
  })
  test('unassigned human gates allow squad reviewers by default, separate from settings or wait responses', async () => {
    const reviewer = await createTestUser({ prefix })
    const manager = await createTestUser({ prefix })
    const responder = await createTestUser({ prefix })
    const outsider = await createTestUser({ prefix })
    const reviewRole = await createTestRole({ prefix, permissions: ['workstreams:review'] })
    const settingsRole = await createTestRole({ prefix, permissions: ['squads:update'] })
    const responseRole = await createTestRole({ prefix, permissions: ['workstreams:respond'] })
    await assignRole({ userId: reviewer.id, roleId: reviewRole.id, scope: 'squad', squadId })
    await assignRole({ userId: manager.id, roleId: settingsRole.id, scope: 'squad', squadId })
    await assignRole({ userId: responder.id, roleId: responseRole.id, scope: 'squad', squadId })
    const [otherSquad] = await db
      .insert(squads)
      .values({ name: `${prefix}-other`, purpose: 'Permission isolation' })
      .returning()
    try {
      await assignRole({ userId: outsider.id, roleId: reviewRole.id, scope: 'squad', squadId: otherSquad!.id })
      const definition = structuredClone(flow)
      definition.steps[0] = workflowStepSchema.parse({
        id: 'build',
        kind: 'human-approval',
        instructions: 'Approve scope',
        output: 'Decision',
        outcomes: { completed: { next: 'review' } },
      })
      expect(definition.steps[0]!.kind === 'human-approval' && definition.steps[0]!.approver).toBe('assigned-reviewers')
      const id = await create('active', definition)
      const command = {
        action: 'complete',
        expectedVersion: 0,
        attemptId: 1,
        outcome: 'completed',
        evidence: 'Scope approved',
      }
      for (const user of [manager, responder, outsider])
        await expect(advanceFlow(id, command, randomUUID(), { type: 'user', userId: user.id })).rejects.toThrow()
      await expect(advanceFlow(id, command, randomUUID(), actor)).rejects.toThrow('designated human approver')
      expect((await getFlow(id))!.version).toBe(0)
      await advanceFlow(id, command, randomUUID(), { type: 'user', userId: reviewer.id })
      expect((await getFlow(id))!.version).toBe(1)
      // Assigned gates require assignment as well as review permission.
      const requesterGate = structuredClone(definition)
      if (requesterGate.steps[0]!.kind === 'human-approval') requesterGate.steps[0]!.approver = 'assigned-reviewers'
      const empty = await create('active', requesterGate)
      await advanceFlow(empty, command, randomUUID(), { type: 'user', userId: reviewer.id })
      const restricted = await create('active', requesterGate)
      await db
        .update(workStreams)
        .set({ assignedReviewerIds: [manager.id] })
        .where(eq(workStreams.id, restricted))
      await expect(
        advanceFlow(restricted, command, randomUUID(), { type: 'user', userId: reviewer.id })
      ).rejects.toThrow('designated human approver')
      await expect(
        advanceFlow(restricted, command, randomUUID(), { type: 'user', userId: manager.id })
      ).rejects.toThrow()
      await expect(WorkStream.update(restricted, { assignedReviewerIds: [outsider.id] })).rejects.toThrow(
        'review permission'
      )
      await assignRole({ userId: responder.id, roleId: reviewRole.id, scope: 'squad', squadId })
      await WorkStream.update(restricted, { assignedReviewerIds: [reviewer.id, responder.id] })
      expect((await WorkStream.mustFind(restricted)).toJson().assignedReviewerIds).toEqual([reviewer.id, responder.id])
      await advanceFlow(restricted, command, randomUUID(), { type: 'user', userId: responder.id })
    } finally {
      await db.delete(squads).where(eq(squads.id, otherSquad!.id))
    }
  })
  test('fresh and reused sessions both receive recent results in every activation handoff', async () => {
    for (const session of ['reuse-within-stream', 'fresh-per-attempt'] as const) {
      const definition = structuredClone(flow)
      definition.participants.builder!.session = session
      const id = await create('active', definition)
      const originalAgent = (await bindings(id))[0]!.agentId
      await advance(id, 'completed')
      await advance(id, 'changes-requested')
      const returned = (await messages(id)).find((message) => message.idempotencyKey === `flow:${id}:3`)!
      expect(returned.content).toContain('Incoming results:\n\nreview (attempt 2): Verified result')
      expect(returned.content).not.toContain('build (attempt 1): Verified result')
      expect(returned.content).toContain('Expected output:')
      // Follow-graph rework has no separate direct-return obligation.
      expect(returned.content).not.toContain('Open return requests:')
      expect(returned.recipientId === originalAgent).toBe(session === 'reuse-within-stream')
    }
  })
  test('bare ownership, approval, metadata, and completion writes cannot bypass flow gates', async () => {
    const id = await create()
    const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, id))
    for (const mutation of [
      { status: 'done' },
      { assigneeAgentId: randomUUID() },
      { agentIds: [] },
      { completionMode: 'deliverable' },
      { metadata: { completion: { mode: 'deliverable' } } },
    ])
      await expect(db.transaction((tx) => guardFlowMutation(tx, stream!, mutation))).rejects.toThrow()
    await advance(id, 'completed')
    await advance(id, 'approved')
    await expect(db.transaction((tx) => guardFlowMutation(tx, stream!, { status: 'done' }))).rejects.toThrow(
      'flow completion'
    )
  })
  test('superseded and parked handoff messages cannot wake a participant', async () => {
    const id = await create()
    const [first] = await messages(id)
    expect(await isCurrentFlowMessage(first!)).toBe(true)
    await advance(id, 'completed')
    expect(await isCurrentFlowMessage(first!)).toBe(false)
    await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, id))
    for (const message of await messages(id)) expect(await isCurrentFlowMessage(message)).toBe(false)
  })
  test('participant expertise is pinned while live disable still revokes execution', async () => {
    const id = await create()
    const [binding] = await bindings(id)
    await db.update(agentTypes).set({ systemPrompt: 'Changed catalog prompt' }).where(eq(agentTypes.id, agentTypeId))
    try {
      expect((await flowAgentType(binding!.agentId))!.systemPrompt).toBe(
        'Shared role expertise and operational guidance'
      )
      await db.update(agentTypes).set({ disabled: true }).where(eq(agentTypes.id, agentTypeId))
      await expect(flowAgentType(binding!.agentId)).rejects.toThrow('disabled')
    } finally {
      await db
        .update(agentTypes)
        .set({ systemPrompt: 'Shared role expertise and operational guidance', disabled: false })
        .where(eq(agentTypes.id, agentTypeId))
    }
  })
})

describe('flow lifecycle and authority', () => {
  test('squad setup and queued creation use the default without spawning a roster', async () => {
    const metadata = {
      workflow: { kind: 'inline' as const, definition: flow },
      workflowSetup: { guidance: 'Use the default for ordinary work.', choices: [] },
    }
    const before = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
    await validateSquadWorkflows(metadata, squadId)
    await db.update(squads).set({ metadata, maxConcurrentWorkStreams: 0 }).where(eq(squads.id, squadId))
    try {
      const stream = await WorkStream.create({ squadId, title: 'Default flow while capacity is full' })
      expect(stream.status).toBe('queued')
      expect((await getFlow(stream.id))!.state.definition).toEqual(flow)
      expect(await bindings(stream.id)).toHaveLength(0)
      expect(await messages(stream.id)).toHaveLength(0)
      expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))).toEqual(before)
      await expect(advance(stream.id, 'completed')).rejects.toThrow('Resume queued work')
    } finally {
      await db.update(squads).set({ metadata: {}, maxConcurrentWorkStreams: null }).where(eq(squads.id, squadId))
    }
  })
  test('human approval cannot be bypassed by generic unblock and resumes only for the designated user', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['workstreams:review'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
    const definition = structuredClone(flow)
    definition.steps[0] = {
      id: 'build',
      kind: 'human-approval',
      approver: 'assigned-reviewers',
      instructions: 'Approve scope',
      output: 'Decision',

      outcomes: { completed: { next: 'review' } },
    }
    const id = await create('active', definition)
    await db
      .update(workStreams)
      .set({ assignedReviewerIds: [user.id] })
      .where(eq(workStreams.id, id))
    expect(toWaitJson((await listOpenWaits(db, id))[0]!).resolutionHandler).toBe('workflow')
    await expect(db.transaction((tx) => guardFlowWaitResolution(tx, id))).rejects.toThrow('workflow decision')
    await expect((await WorkStream.mustFind(id)).unblock()).rejects.toThrow('workflow decision')
    await advanceFlow(
      id,
      { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: 'Scope approved' },
      randomUUID(),
      { type: 'user', userId: user.id }
    )
    expect(await bindings(id)).toHaveLength(1)
    expect((await getFlow(id))!.state.activeAttemptId).toBe(2)
  })
  test('only the active worker can submit an outcome and adaptive workers cannot weaken required participant settings', async () => {
    const definition = structuredClone(flow)
    definition.routing.mode = 'adaptive'
    const id = await create('active', definition)
    const [builder] = await bindings(id)
    const worker = { type: 'agent' as const, agentId: builder!.agentId, squadId }
    await expect(
      advanceFlow(
        id,
        {
          action: 'revise',
          expectedVersion: 0,
          attemptId: 1,
          active: 'keep',
          reason: 'Use cheaper required reviewer',
          operations: [
            {
              op: 'put-participant',
              id: 'reviewer',
              participant: { ...definition.participants.reviewer!, tier: overrideTier },
            },
          ],
        },
        randomUUID(),
        worker
      )
    ).rejects.toThrow('management permission')
    expect((await getFlow(id))!.version).toBe(0)
    await advanceFlow(
      id,
      { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: 'Built' },
      randomUUID(),
      worker
    )
    await expect(
      advanceFlow(
        id,
        { action: 'complete', expectedVersion: 1, attemptId: 2, outcome: 'approved', evidence: 'Self approval' },
        randomUUID(),
        worker
      )
    ).rejects.toThrow('active participant')
  })
  test.each(['maxStepAttempts', 'maxParallelAttempts'] as const)(
    'adaptive workers cannot remove an explicit %s cap',
    async (key) => {
      const definition = structuredClone(flow)
      definition.routing.mode = 'adaptive'
      definition.limits[key] = 8
      const id = await create('active', definition)
      const [builder] = await bindings(id)
      const limits = { ...definition.limits }
      delete limits[key]
      await expect(
        advanceFlow(
          id,
          {
            action: 'revise',
            expectedVersion: 0,
            attemptId: 1,
            active: 'keep',
            reason: 'Remove explicit cap',
            operations: [{ op: 'set-limits', limits }],
          },
          randomUUID(),
          { type: 'agent', agentId: builder!.agentId, squadId }
        )
      ).rejects.toThrow('management permission')
      expect((await getFlow(id))!.version).toBe(0)
      expect((await getFlow(id))!.state.definition.limits[key]).toBe(8)
    }
  )
  test('kept attempts retain their agent snapshot, but future rework uses the revised participant', async () => {
    const id = await create()
    const [builder] = await bindings(id)
    const model = 'anthropic:claude-haiku-4-5'
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: 0,
        attemptId: 1,
        active: 'keep',
        reason: 'Change future model',
        operations: [
          { op: 'put-participant', id: 'builder', participant: { ...flow.participants.builder!, tier: overrideTier } },
        ],
      },
      randomUUID(),
      actor
    )
    expect((await flowAgentType(builder!.agentId))!.model).toBe('anthropic:claude-sonnet-4-5')
    expect(await bindings(id)).toHaveLength(1)
    await advance(id, 'completed')
    await advance(id, 'changes-requested')
    const current = (await WorkStream.mustFind(id)).assigneeAgentId!
    expect(current).not.toBe(builder!.agentId)
    expect((await flowAgentType(current))!.model).toBe(model)
  })
  test('tracked delegation waits for the result and returns to the same requesting session', async () => {
    const definition = structuredClone(flow)
    definition.routing.delegation = 'allowed'
    definition.limits.maxDelegations = 3
    const id = await create('active', definition)
    const [builder] = await bindings(id)
    await advanceFlow(
      id,
      {
        action: 'delegate',
        expectedVersion: 0,
        attemptId: 1,
        participant: { agentTypeId: agentTypeId, session: 'reuse-within-stream' },
        task: 'Assess accessibility',
      },
      randomUUID(),
      actor
    )
    expect(await bindings(id)).toHaveLength(2)
    await advance(id, 'completed')
    expect((await WorkStream.mustFind(id)).assigneeAgentId).toBe(builder!.agentId)
    expect((await getFlow(id))!.state.returns[0]!.status).toBe('open')
    await advance(id, 'completed')
    expect((await getFlow(id))!.state.returns[0]!.status).toBe('resolved')
    expect(await bindings(id)).toHaveLength(3)
  })
  test('delivery enforces gates, marks done through the entity, and reopening starts a fresh session', async () => {
    const definition = structuredClone(flow)
    definition.completion.mode = 'deliverable'
    const id = await create('active', definition)
    const first = (await bindings(id))[0]!.agentId
    await expect(finishFlow(id, 0, actor)).rejects.toThrow('not ready')
    await advance(id, 'completed')
    await advance(id, 'approved')
    // No sandbox was provisioned by this fixture; retain durable teardown intent without running a driver.
    const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
    try {
      const completed = await finishFlow(id, 2, actor)
      expect(completed.status).toBe('done')
      const stream = await WorkStream.mustFind(id)
      await stream.reopen()
      await ensureFlowDispatch(id)
      const reopened = (await getFlow(id))!
      expect(reopened.state.status).toBe('running')
      expect(reopened.state.attempts).toHaveLength(3)
      expect(reopened.state.completedStepIds).toEqual([])
      expect((await WorkStream.mustFind(id)).assigneeAgentId).not.toBe(first)
    } finally {
      stop.mockRestore()
    }
  })
})

test('saved schedule definitions create only the active participant when triggered', async () => {
  const schedule = await Schedule.create({
    scopeType: 'squad',
    scopeId: squadId,
    name: `${prefix}-schedule`,
    schedule: { interval: '1h' },
    action: {
      type: 'create_work_stream',
      title: `${prefix}-scheduled`,
      workflow: { kind: 'inline', definition: flow },
    },
  })
  const before = await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))
  try {
    expect(await db.select({ id: agents.id }).from(agents).where(eq(agents.squadId, squadId))).toEqual(before)
    await schedule.trigger()
    const [stream] = await db
      .select()
      .from(workStreams)
      .where(eq(workStreams.title, `${prefix}-scheduled`))
    expect(stream).toBeDefined()
    expect(await bindings(stream!.id)).toHaveLength(1)
    expect((await getFlow(stream!.id))!.state.definition).toEqual(flow)
  } finally {
    await Schedule.delete(schedule.id)
  }
})
test('PR and direct-merge delivery require independently fetched merge evidence', async () => {
  const api = spyOn(githubApi, 'githubApiGet')
  const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
  try {
    for (const mode of ['pr-merge', 'pr-auto-merge', 'direct-merge'] as const) {
      for (const canonical of [false, true]) {
        const definition = structuredClone(flow)
        definition.completion.mode = mode
        const id = await create('active', definition)
        const [assignment] = await messages(id)
        expect(assignment!.content).not.toContain('Delivery policy:')
        expect(assignment!.content).toContain(`ficus workstream advance ${(await WorkStream.mustFind(id)).number}`)
        await advance(id, 'completed')
        await advance(id, 'approved')
        await db
          .update(workStreams)
          .set({
            metadata: {
              completion: { mode },
              ...(canonical
                ? { codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 42 } } }
                : { github: { repo: 'example/repo', pr: { number: 42 } } }),
              git: { branch: 'feature', baseBranch: 'main', commit: 'a'.repeat(40) },
            },
          })
          .where(eq(workStreams.id, id))
        api.mockResolvedValue(
          mode === 'direct-merge'
            ? { status: 'ahead' }
            : { merged: false, base: { ref: 'main' }, head: { ref: 'feature' } }
        )
        await expect(finishFlow(id, 2, actor)).rejects.toThrow(
          mode === 'direct-merge' ? 'included in the base' : 'must be merged'
        )
        expect((await WorkStream.mustFind(id)).status).toBe('active')
        api.mockResolvedValue(
          mode === 'direct-merge'
            ? { status: 'behind' }
            : { merged: true, base: { ref: 'main' }, head: { ref: 'feature', sha: 'a'.repeat(40) } }
        )
        expect((await finishFlow(id, 2, actor)).status).toBe('done')
        const [cleanup] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
        expect(cleanup).toHaveProperty('deliveredHead', 'a'.repeat(40))
      }
    }
    expect(api.mock.calls.map((call) => call[0])).toContain('/repos/example/repo/pulls/42')
    expect(api.mock.calls.map((call) => call[0])).toContain(`/repos/example/repo/compare/main...${'a'.repeat(40)}`)
  } finally {
    api.mockRestore()
    stop.mockRestore()
  }
})
test('every designated delivery pull request must be merged before the flow finishes', async () => {
  const api = spyOn(githubApi, 'githubApiGet')
  const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
  try {
    const definition = structuredClone(flow)
    definition.completion.mode = 'pr-merge'
    const id = await create('active', definition)
    await advance(id, 'completed')
    await advance(id, 'approved')
    const tracked = {
      integration: 'github',
      repository: 'example/docs',
      kind: 'pull_request' as const,
      number: 7,
      delivery: true as const,
    }
    await db
      .update(workStreams)
      .set({
        metadata: {
          codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 42 } },
          tracked: [tracked],
          git: { branch: 'feature', baseBranch: 'main' },
        },
      })
      .where(eq(workStreams.id, id))
    const primary = { merged: true, base: { ref: 'main' }, head: { ref: 'feature', sha: 'a'.repeat(40) } }
    const additional = (merged: boolean) => ({
      merged,
      base: { ref: 'main' },
      head: { ref: 'docs', sha: 'b'.repeat(40) },
    })
    api.mockImplementation(((path: string) =>
      Promise.resolve(path.includes('example/docs') ? additional(false) : primary)) as any)
    await expect(finishFlow(id, 2, actor)).rejects.toThrow(
      'Delivery pull request example/docs#7 must be merged before completion'
    )
    expect((await WorkStream.mustFind(id)).status).toBe('active')
    api.mockImplementation(((path: string) =>
      Promise.resolve(path.includes('example/docs') ? additional(true) : primary)) as any)
    expect((await finishFlow(id, 2, actor)).status).toBe('done')
    const metadata = (await WorkStream.mustFind(id)).metadata as any
    // JSONB does not preserve key order, so assert the map, not its ordering.
    expect(
      Object.fromEntries(
        Object.entries(metadata.delivery.pullRequests).map(([key, value]: [string, any]) => [key, value.state])
      )
    ).toEqual({
      'github:example/repo:pull_request:42': 'merged',
      'github:example/docs:pull_request:7': 'merged',
    })
    const [cleanup] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
    expect(cleanup).toHaveProperty('deliveredHead', 'a'.repeat(40))
  } finally {
    api.mockRestore()
    stop.mockRestore()
  }
})

test('review-approval completion requires a human even after every agent gate has passed', async () => {
  const definition = structuredClone(flow)
  definition.completion.mode = 'review-approval'
  const id = await create('active', definition)
  await advance(id, 'completed')
  await advance(id, 'approved')
  await expect(finishFlow(id, 2, actor)).rejects.toThrow('human must approve')
  await ensureFlowDispatch(id)
  const deliveryWaits = await listOpenWaits(db, id)
  expect(deliveryWaits).toHaveLength(1)
  expect(deliveryWaits[0]!.resolutionHandler).toBe('workflow')
  expect((await listPendingActions()).some((a) => 'workStreamId' in a.data && a.data.workStreamId === id)).toBe(true)
  await expect(guardFlowWaitResolution(db as any, id, deliveryWaits[0]!.id)).rejects.toThrow('workflow decision')
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['workstreams:respond'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
  try {
    const blocker = await openWait(db, {
      workStreamId: id,
      type: 'manual',
      scope: 'stream',
      message: 'Additional operator input',
    })
    await expect(finishFlow(id, 2, { type: 'user', userId: user.id })).rejects.toThrow('wait')
    expect(await listOpenWaits(db, id)).toHaveLength(2)
    await closeOpenWaits(db, { waitId: blocker.wait.id }, 'cleared')
    expect((await finishFlow(id, 2, { type: 'user', userId: user.id })).status).toBe('done')
    expect(await listOpenWaits(db, id)).toHaveLength(0)
  } finally {
    stop.mockRestore()
  }
})

test('completion stays ready with a clear conflict while another blocking wait is open', async () => {
  const definition = structuredClone(flow)
  definition.completion.mode = 'deliverable'
  const id = await create('active', definition)
  await advance(id, 'completed')
  await advance(id, 'approved')
  const { wait } = await openWait(db, { workStreamId: id, type: 'manual', message: 'Wait for the requested input' })
  try {
    await expect(finishFlow(id, 2, actor)).rejects.toMatchObject({ status: 409 })
    expect((await getFlow(id))!.state.status).toBe('completion-ready')
    expect((await WorkStream.mustFind(id)).status).toBe('active')
  } finally {
    await closeOpenWaits(db, { waitId: wait.id }, 'cleared')
  }
})

test('a revised participant reuses its replacement session after agent snapshot timestamps round-trip through JSONB', async () => {
  const id = await create()
  await advanceFlow(
    id,
    {
      action: 'revise',
      expectedVersion: 0,
      attemptId: 1,
      active: 'restart',
      reason: 'Change the active model',
      operations: [
        {
          op: 'put-participant',
          id: 'builder',
          participant: { ...flow.participants.builder!, tier: overrideTier },
        },
      ],
    },
    randomUUID(),
    actor
  )
  const replacement = (await WorkStream.mustFind(id)).assigneeAgentId
  await advance(id, 'completed')
  await advance(id, 'changes-requested')
  expect((await WorkStream.mustFind(id)).assigneeAgentId).toBe(replacement)
  expect(await bindings(id)).toHaveLength(3)
})

function parallelDefinition(limit = 8) {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = agentTypeId
  definition.limits.maxParallelAttempts = limit
  definition.steps[0]!.outcomes.completed = { parallel: ['security', 'qa'], join: 'deliver' }
  for (const id of ['security', 'qa', 'deliver'])
    definition.steps.push(
      workflowStepSchema.parse({
        id,
        participant: 'worker',
        instructions: id,
        output: 'Evidence',
        outcomes: { completed: { next: id === 'deliver' ? 'finish' : 'deliver' } },
      })
    )
  return definition
}
async function completeStep(id: string, stepId: string) {
  const run = (await getFlow(id))!
  return advanceFlow(
    id,
    {
      expectedVersion: run.version,
      attemptId: activeWorkflowAttempts(run.state).find((a) => a.stepId === stepId)!.id,
      action: 'complete',
      outcome: 'completed',
      evidence: 'Verified',
    },
    randomUUID(),
    actor
  )
}

describe('parallel dispatch and pause', () => {
  test('inferred convergence dispatches one destination agent after isolated parallel branches, respecting capacity', async () => {
    for (const limit of [1, 8]) {
      const flow = parallelDefinition(limit)
      flow.steps[0]!.outcomes.completed = { parallel: ['security', 'qa'], join: 'finish' }
      const id = await create('active', flow)
      await completeStep(id, 'execute')
      const fork = (await getFlow(id))!
      expect(fork.state.joins![0]!.join).toBe('deliver')
      expect(activeWorkflowAttempts(fork.state)).toHaveLength(limit === 1 ? 1 : 2)
      expect(await bindings(id)).toHaveLength(limit === 1 ? 2 : 3)
      if (limit === 8) {
        const ids = activeWorkflowAttempts(fork.state).map((a) => fork.attemptAgents[String(a.id)])
        expect(new Set(ids).size).toBe(2)
        for (const a of activeWorkflowAttempts(fork.state))
          expect(
            await isCurrentFlowMessage({
              metadata: { source: 'workflow', workStreamId: id, attemptId: a.id },
              recipientId: fork.attemptAgents[String(a.id)]!,
            })
          ).toBe(true)
      }
      await completeStep(id, 'security')
      expect(activeWorkflowAttempts((await getFlow(id))!.state).map((a) => a.stepId)).toEqual(['qa'])
      await completeStep(id, 'qa')
      await Promise.all([ensureFlowDispatch(id), ensureFlowDispatch(id)])
      expect(activeWorkflowAttempts((await getFlow(id))!.state).map((a) => a.stepId)).toEqual(['deliver'])
      expect((await messages(id)).filter((m) => (m.metadata as any)?.attemptId === 4)).toHaveLength(1)
      await completeStep(id, 'deliver')
    }
  })

  test('finish names an invalid code host binding instead of claiming the fields are missing', async () => {
    const definition = structuredClone(flow)
    definition.completion.mode = 'pr-merge'
    const id = await create('active', definition)
    await advance(id, 'completed')
    await advance(id, 'approved')
    await db
      .update(workStreams)
      .set({
        metadata: {
          completion: { mode: 'pr-merge' },
          codeHost: {
            integration: 'github',
            repository: 'example/repo',
            changeRequest: { number: 1482, url: 'https://github.com/example/repo/pull/1482', state: 'MERGED' },
          },
        },
      })
      .where(eq(workStreams.id, id))
    await expect(finishFlow(id, 2, actor)).rejects.toThrow(
      'codeHost metadata is present but invalid: codeHost.changeRequest: unknown keys `state` (allowed: number, url)'
    )
    await db
      .update(workStreams)
      .set({
        metadata: { completion: { mode: 'pr-merge' }, codeHost: { integration: 'bitbucket', repository: 'x/y' } },
      })
      .where(eq(workStreams.id, id))
    await expect(finishFlow(id, 2, actor)).rejects.toThrow("codeHost.integration 'bitbucket' is not a supported")
    await db
      .update(workStreams)
      .set({ metadata: { completion: { mode: 'pr-merge' } } })
      .where(eq(workStreams.id, id))
    await expect(finishFlow(id, 2, actor)).rejects.toThrow(
      'Set codeHost.integration and codeHost.repository to a supported code hosting integration before completion'
    )
    await expect(finishFlow(id, 2, actor)).rejects.toThrow(
      `ficus workstream set-meta ${id} codeHost '{"integration":"github","repository":"<owner/repo>"}'`
    )
  })
  test('finish names the exact repair for each delivery binding failure class', async () => {
    const api = spyOn(githubApi, 'githubApiGet')
    const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
    try {
      const definition = structuredClone(flow)
      definition.completion.mode = 'pr-merge'
      const id = await create('active', definition)
      await advance(id, 'completed')
      await advance(id, 'approved')
      // (b) no branch recorded: resolution is impossible, so the manual bind is required.
      await db
        .update(workStreams)
        .set({
          metadata: {
            completion: { mode: 'pr-merge' },
            codeHost: { integration: 'github', repository: 'example/repo' },
          },
        })
        .where(eq(workStreams.id, id))
      let missing = await finishFlow(id, 2, actor).catch((error: Error) => error.message)
      expect(missing).toContain('codeHost.changeRequest is not set')
      expect(missing).toContain('records no branch (metadata.git.branch)')
      expect(missing).toContain(
        `ficus workstream set-meta ${id} codeHost.changeRequest '{"number":<pr-number>,"url":"<pr-url>"}'`
      )
      expect(missing).toContain(`ficus workstream track ${id} --pr <owner/repo#n> --delivery`)
      // (b) with a branch: an empty owner-namespace lookup and an ambiguous one both fail with
      // the exact repair, and the legacy shape gets a shape-matching command.
      await db
        .update(workStreams)
        .set({
          metadata: {
            completion: { mode: 'pr-merge' },
            codeHost: { integration: 'github', repository: 'example/repo' },
            git: { branch: 'feature', baseBranch: 'main' },
          },
        })
        .where(eq(workStreams.id, id))
      api.mockImplementation(((path: string) => Promise.resolve(path.includes('pulls?head=') ? [] : null)) as any)
      missing = await finishFlow(id, 2, actor).catch((error: Error) => error.message)
      expect(missing).toContain("No pull request was found for branch 'feature' in example/repo")
      expect(missing).toContain('owner-namespace head lookup excludes fork pull requests')
      api.mockImplementation(((path: string) =>
        Promise.resolve(
          path.includes('pulls?head=')
            ? [
                {
                  number: 1,
                  merged: false,
                  state: 'open',
                  head: { ref: 'feature', repo: { full_name: 'example/repo' } },
                  base: { ref: 'main' },
                },
                {
                  number: 2,
                  merged: false,
                  state: 'open',
                  head: { ref: 'feature', repo: { full_name: 'example/repo' } },
                  base: { ref: 'main' },
                },
              ]
            : null
        )) as any)
      missing = await finishFlow(id, 2, actor).catch((error: Error) => error.message)
      expect(missing).toContain(
        "Branch 'feature' does not identify one delivery pull request (candidates PR #1, PR #2)"
      )
      api.mockImplementation(((path: string) => Promise.resolve(path.includes('pulls?head=') ? null : null)) as any)
      missing = await finishFlow(id, 2, actor).catch((error: Error) => error.message)
      expect(missing).toContain("pull requests for branch 'feature' could not be read through the github integration")
      // A legacy github-repo stream is told to bind github.pr, never a partial codeHost.
      await db
        .update(workStreams)
        .set({
          metadata: {
            completion: { mode: 'pr-merge' },
            github: { repo: 'example/repo' },
            git: { branch: 'feature' },
          },
        })
        .where(eq(workStreams.id, id))
      api.mockImplementation(((path: string) => Promise.resolve(path.includes('pulls?head=') ? [] : null)) as any)
      missing = await finishFlow(id, 2, actor).catch((error: Error) => error.message)
      expect(missing).toContain(`ficus workstream set-meta ${id} github.pr '{"number":<pr-number>,"url":"<pr-url>"}'`)
      // (c) the binding exists but cannot be verified at all, distinct from not-merged.
      await db
        .update(workStreams)
        .set({
          metadata: {
            completion: { mode: 'pr-merge' },
            codeHost: { integration: 'github', repository: 'example/repo', changeRequest: { number: 42 } },
            git: { branch: 'feature' },
          },
        })
        .where(eq(workStreams.id, id))
      api.mockResolvedValue(null)
      await expect(finishFlow(id, 2, actor)).rejects.toThrow(
        "Could not verify delivery pull request example/repo#42 through the github integration: it is missing, inaccessible to the squad's connection, or the connection is unavailable"
      )
      expect((await WorkStream.mustFind(id)).status).toBe('active')
      // The not-merged class keeps its own message once the pull request is visible again.
      api.mockResolvedValue({ merged: false, base: { ref: 'main' }, head: { ref: 'feature' } })
      await expect(finishFlow(id, 2, actor)).rejects.toThrow('The change request must be merged before completion')
    } finally {
      api.mockRestore()
      stop.mockRestore()
    }
  })
  test('finish resolves the delivery pull request from the stream branch and persists the binding', async () => {
    const api = spyOn(githubApi, 'githubApiGet')
    const stop = spyOn(Agent.prototype, 'tryTerminate').mockResolvedValue(undefined)
    try {
      const definition = structuredClone(flow)
      definition.completion.mode = 'pr-merge'
      const id = await create('active', definition)
      await advance(id, 'completed')
      await advance(id, 'approved')
      await db
        .update(workStreams)
        .set({
          metadata: {
            completion: { mode: 'pr-merge' },
            github: { repo: 'example/repo' },
            git: { branch: 'feature', baseBranch: 'main' },
          },
        })
        .where(eq(workStreams.id, id))
      // One open pull request on the branch: it is bound and persisted, then verified unmerged.
      api.mockImplementation(((path: string) =>
        Promise.resolve(
          path.includes('pulls?head=')
            ? [
                {
                  number: 42,
                  html_url: 'https://github.com/example/repo/pull/42',
                  merged: false,
                  state: 'open',
                  head: { ref: 'feature', repo: { full_name: 'example/repo' } },
                  base: { ref: 'main' },
                },
              ]
            : { merged: false, base: { ref: 'main' }, head: { ref: 'feature' } }
        )) as any)
      await expect(finishFlow(id, 2, actor)).rejects.toThrow('The change request must be merged before completion')
      const bound = ((await WorkStream.mustFind(id)).metadata as Record<string, any>).codeHost
      expect(bound).toEqual({
        integration: 'github',
        repository: 'example/repo',
        changeRequest: { number: 42, url: 'https://github.com/example/repo/pull/42' },
      })
      expect((await WorkStream.mustFind(id)).status).toBe('active')
      // Once merged, the same persisted binding finishes the flow.
      api.mockImplementation(((path: string) =>
        Promise.resolve(
          path.includes('pulls?head=')
            ? [
                {
                  number: 42,
                  merged: true,
                  state: 'closed',
                  head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'example/repo' } },
                  base: { ref: 'main' },
                },
              ]
            : { merged: true, base: { ref: 'main' }, head: { ref: 'feature', sha: 'a'.repeat(40) } }
        )) as any)
      expect((await finishFlow(id, 2, actor)).status).toBe('done')
      const [cleanup] = await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, id))
      expect(cleanup).toHaveProperty('deliveredHead', 'a'.repeat(40))
      // The lookup is owner-namespace scoped, which is what excludes fork pull requests.
      expect(api.mock.calls.map((call) => call[0])).toContain(
        `/repos/example/repo/pulls?head=${encodeURIComponent('example:feature')}&state=all`
      )
    } finally {
      api.mockRestore()
      stop.mockRestore()
    }
  })
  test('usage is captured at acceptance even when it settles after a handoff', async () => {
    const { getFlowUsage } = await import('./usage')
    const id = await create()
    const first = (await bindings(id))[0]!
    const execution = await (await Agent.mustFind(first.agentId)).queueExecution({ message: 'Build' })
    expect(execution.flowContext).toEqual({ workStreamId: id, stepId: 'build', attemptId: 1 })
    await advance(id, 'completed')
    await db
      .update(executions)
      .set({
        status: 'completed',
        usage: {
          context: null,
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            totalMessages: 2,
            tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
            cost: 0.1,
          },
          delta: { tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: 0.1 },
        },
      })
      .where(eq(executions.id, execution.id))
    const usage = await getFlowUsage(id, (await getFlow(id))!.state)
    expect(usage.attempts['1']!.tokens).toBe(12)
    expect(usage.steps.build!.tokens).toBe(12)
    expect(usage.steps.review?.tokens ?? 0).toBe(0)
  })
  test('pause stops every queued branch, blocks new executions/advances and watchdog nudges, resume retains attempts', async () => {
    const { pauseWorkStream, resumeWorkStream } = await import('../work-streams/pause')
    const { reconcileWorkStreamContinuationsOnce } = await import('../work-streams/continuation')
    const id = await create('active', parallelDefinition())
    await completeStep(id, 'execute')
    const run = (await getFlow(id))!
    const crew = activeWorkflowAttempts(run.state).map((a) => run.attemptAgents[String(a.id)]!)
    const queued = []
    for (const agentId of crew) queued.push(await (await Agent.mustFind(agentId)).queueExecution({ message: 'Review' }))
    const paused = await pauseWorkStream(id, { reason: 'Hold for feedback' })
    expect(paused.status).toBe('active')
    expect(paused.pause?.reason).toBe('Hold for feedback')
    for (const execution of queued) {
      await execution.reload()
      expect(execution.status).toBe('stopped')
    }
    for (const agentId of crew)
      await expect((await Agent.mustFind(agentId)).queueExecution({ message: 'No continuation' })).rejects.toThrow(
        'paused'
      )
    await expect(completeStep(id, 'security')).rejects.toThrow('paused')
    await expect(paused.update({ status: 'done' })).rejects.toThrow('Resume')
    const countBefore = (await db.select().from(inbox).where(inArray(inbox.recipientId, crew))).length
    await reconcileWorkStreamContinuationsOnce({ squadId, now: new Date(Date.now() + 600000) })
    expect((await db.select().from(inbox).where(inArray(inbox.recipientId, crew))).length).toBe(countBefore)

    expect(await db.select().from(inbox).where(like(inbox.idempotencyKey, 'pause:%'))).toHaveLength(0)
    const firstPause = paused.pause
    expect((await pauseWorkStream(id)).pause).toEqual(firstPause)
    await resumeWorkStream(id)
    expect((await WorkStream.mustFind(id)).pause).toBeNull()
    expect((await getFlow(id))!.state).toEqual(run.state)
    const resumes = await db
      .select()
      .from(inbox)
      .where(like(inbox.idempotencyKey, `resume:${firstPause!.id}:%`))
    expect(resumes).toHaveLength(2)
    expect(resumes.every((message) => message.content.includes('Hold for feedback'))).toBe(true)
    expect(await bindings(id)).toHaveLength(3)
    for (const a of activeWorkflowAttempts(run.state))
      expect(
        await isCurrentFlowMessage({
          metadata: { source: 'workflow', workStreamId: id, attemptId: a.id },
          recipientId: run.attemptAgents[String(a.id)]!,
        })
      ).toBe(true)
    await completeStep(id, 'security')
    await completeStep(id, 'qa')
  })
})

test('paused streams retain admission unless parked; auto-park and manual park never auto-resume', async () => {
  const { pauseWorkStream, resumeWorkStream } = await import('../work-streams/pause')
  const { runSquadAdmissionMaintenance, parkWorkStream } = await import('../work-streams/admission')
  const [squad] = await db
    .insert(squads)
    .values({ name: prefix + '-pause-admission', purpose: 'Pause admission', maxConcurrentWorkStreams: 1 })
    .returning()
  const sid = squad!.id
  const deps = { loadAgent: async () => null }
  try {
    const [first, second] = await db
      .insert(workStreams)
      .values([
        { squadId: sid, title: 'First', status: 'active' },
        { squadId: sid, title: 'Second', status: 'queued' },
      ])
      .returning()
    await pauseWorkStream(first!.id.slice(0, 8))
    await runSquadAdmissionMaintenance(sid, deps)
    expect((await WorkStream.mustFind(first!.id)).status).toBe('active')
    expect((await WorkStream.mustFind(second!.id)).status).toBe('queued')
    await parkWorkStream(first!.id, deps)
    expect((await WorkStream.mustFind(first!.id)).pause).not.toBeNull()
    expect((await WorkStream.mustFind(second!.id)).status).toBe('active')
    await resumeWorkStream(first!.id.slice(0, 8))
    expect((await WorkStream.mustFind(first!.id)).status).toBe('queued')
    await pauseWorkStream(second!.id, { parkAfterMinutes: 1 })
    await db
      .update(workStreams)
      .set({
        pause: sql`jsonb_set(${workStreams.pause}, '{parkAt}', to_jsonb((clock_timestamp() - interval '1 second')::text))`,
      })
      .where(eq(workStreams.id, second!.id))
    const result = await runSquadAdmissionMaintenance(sid, deps)
    expect(result.parked.map((s) => s.id)).toContain(second!.id)
    expect((await WorkStream.mustFind(first!.id)).status).toBe('active')
    expect((await WorkStream.mustFind(second!.id)).status).toBe('queued')
    expect((await WorkStream.mustFind(second!.id)).pause).not.toBeNull()
    await runSquadAdmissionMaintenance(sid, deps)
    expect((await WorkStream.mustFind(second!.id)).status).toBe('queued')
    await expect((await WorkStream.mustFind(second!.id)).update({ status: 'done' })).rejects.toThrow('Resume')
  } finally {
    await db.delete(workStreams).where(eq(workStreams.squadId, sid))
    await db.delete(squads).where(eq(squads.id, sid))
  }
})

test('resume waits for the interrupted turn to settle and duplicate stop retries cannot stop resumed work', async () => {
  const { pauseWorkStream, resumeWorkStream } = await import('../work-streams/pause')
  const id = await create()
  const agent = await Agent.mustFind((await bindings(id))[0]!.agentId)
  const interrupted = await agent.queueExecution({ message: 'Working' })
  await interrupted.update({ status: 'running' })
  const paused = await pauseWorkStream(id)
  await interrupted.reload()
  expect(interrupted.status).toBe('stopping')
  const sent = send.mock.calls.length
  await resumeWorkStream(id)
  expect(send.mock.calls.length).toBe(sent)
  await interrupted.stop()
  await ensureFlowDispatch(id)
  expect(send.mock.calls.length).toBeGreaterThan(sent)
  const resumed = await agent.queueExecution({ message: 'Resumed turn' })
  await pauseWorkStream(id, {}, paused.pause!.id)
  await resumed.reload()
  expect(resumed.status).toBe('queued')
  expect((await WorkStream.mustFind(id)).pause).toBeNull()
  await resumed.stop()
})

describe('attempt-scoped waits', () => {
  test('an unbound manager defaults to a whole-stream wait while a retired participant cannot block an old attempt', async () => {
    const { resolveWaitAttempt } = await import('../work-streams/wait-scope')
    const id = await create()
    const oldAgent = (await getFlow(id))!.attemptAgents['1']!
    expect(
      await resolveWaitAttempt(db, { workStreamId: id, type: 'manual', createdByAgentId: randomUUID() })
    ).toBeNull()
    await advance(id, 'completed')
    await expect(
      resolveWaitAttempt(db, { workStreamId: id, type: 'manual', createdByAgentId: oldAgent })
    ).rejects.toThrow('currently active')
  })

  test('question creation locks the flow before reaching the locked-agent boundary', async () => {
    const { createAgentQuestion } = await import('../agents/questions')
    const id = await create()
    const agentId = (await getFlow(id))!.attemptAgents['1']!
    const execution = await (await Agent.mustFind(agentId)).queueExecution({ message: 'Question fixture' })
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const question = createAgentQuestion(
      { agentId, executionId: execution.id },
      { questions: [{ id: 'input', type: 'text', question: 'Which input?' }] },
      {
        testHooks: {
          afterAgentLocked: async () => {
            locked.resolve()
            await release.promise
          },
        },
      }
    )
    // Propagate an early failure instead of waiting indefinitely for the fixture boundary.
    void question.catch(locked.reject)
    try {
      await locked.promise
      await expect(
        db
          .transaction((tx) => tx.execute(sql`SELECT id FROM work_streams WHERE id = ${id} FOR UPDATE NOWAIT`))
          .catch(getPostgresError)
      ).resolves.toEqual({ code: '55P03' })
    } finally {
      release.resolve()
      await question
      await execution.stop()
    }
  })

  test('a security blocker leaves QA runnable, holds the join, and resolves to the same security attempt', async () => {
    const { admissionBlockingWaits, waitsForAgent, waitingAssigneeStreamIds, admissionBlockedStreamIds } =
      await import('../work-streams/wait-scope')
    const id = await create('active', parallelDefinition())
    await completeStep(id, 'execute')
    const run = (await getFlow(id))!
    const security = activeWorkflowAttempts(run.state).find((a) => a.stepId === 'security')!
    const qa = activeWorkflowAttempts(run.state).find((a) => a.stepId === 'qa')!
    const securityAgent = run.attemptAgents[String(security.id)]!
    const qaAgent = run.attemptAgents[String(qa.id)]!
    const stream = await WorkStream.mustFind(id)
    const wait = await stream.block({
      message: 'Confirm threat model',
      createdBy: 'agent',
      createdByAgentId: securityAgent,
    })
    expect(wait.flowAttemptId).toBe(security.id)
    const action = (await listPendingActions()).find((a) => 'waitId' in a.data && a.data.waitId === wait.id)!
    expect((action.data as import('@ficus/shared').WorkStreamActionData).assigneeAgentId).toBe(securityAgent)
    expect(await admissionBlockingWaits(db, id)).toHaveLength(0)
    expect(await waitsForAgent(db, id, qaAgent)).toHaveLength(0)
    expect(await waitsForAgent(db, id, securityAgent)).toHaveLength(1)
    expect(await waitingAssigneeStreamIds(db, [{ id, assigneeAgentId: qaAgent }])).toEqual(new Set())
    expect(await waitingAssigneeStreamIds(db, [{ id, assigneeAgentId: securityAgent }])).toEqual(new Set([id]))
    expect(await admissionBlockedStreamIds(db, [id])).toEqual(new Set())
    expect((await WorkStream.mustFind(id)).assigneeAgentId).toBe(qaAgent)
    await expect(completeStep(id, 'security')).rejects.toThrow('Resolve the waits')
    await completeStep(id, 'qa')
    expect(activeWorkflowAttempts((await getFlow(id))!.state).map((a) => a.id)).toEqual([security.id])
    expect(await admissionBlockingWaits(db, id)).toHaveLength(1)
    await stream.unblock({ note: 'Use the documented threat model' })
    const current = (await getFlow(id))!
    expect(activeWorkflowAttempts(current.state).map((a) => a.id)).toEqual([security.id])
    expect(current.attemptAgents[String(security.id)]).toBe(securityAgent)
    expect((await WorkStream.mustFind(id)).assigneeAgentId).toBe(securityAgent)
    const [resolution] = await db
      .select()
      .from(inbox)
      .where(eq(inbox.idempotencyKey, `flow-wait:${wait.id}:${security.id}`))
    expect(resolution?.recipientId).toBe(securityAgent)
    expect(resolution?.content).toBe(
      `Work stream ${id}, step security (attempt ${security.id})\nWait resolved: Confirm threat model\n\nUse the documented threat model`
    )
    await completeStep(id, 'security')
    expect(activeWorkflowAttempts((await getFlow(id))!.state).map((a) => a.stepId)).toEqual(['deliver'])
  })

  test('explicit whole-stream waits hold both reviewers without being mistaken for step approval', async () => {
    const id = await create('active', parallelDefinition())
    await completeStep(id, 'execute')
    const run = (await getFlow(id))!
    const agentId = run.attemptAgents[String(run.state.activeAttemptId)]!
    const wait = await (
      await WorkStream.mustFind(id)
    ).block({ scope: 'stream', message: 'Release freeze', createdBy: 'agent', createdByAgentId: agentId })
    expect(wait.flowAttemptId).toBeNull()
    await expect(completeStep(id, 'security')).rejects.toThrow('Resolve the waits')
    await expect(completeStep(id, 'qa')).rejects.toThrow('Resolve the waits')
  })

  test('restart retires old scoped waits and rejects delayed messages even when a session is reused', async () => {
    const { lockFlowInboxDelivery } = await import('../work-streams/wait-scope')
    const id = await create()
    const run = (await getFlow(id))!
    const first = (await messages(id))[0]!
    const agentId = run.attemptAgents['1']!
    await openWait(db, { workStreamId: id, type: 'manual', flowAttemptId: 1, message: 'Old input' })
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: run.version,
        attemptId: 1,
        operations: [
          {
            op: 'put-participant',
            id: 'builder',
            participant: { ...flow.participants.builder!, tier: overrideTier },
          },
        ],
        reason: 'Restart with a fresh brief',
        active: 'restart',
      },
      randomUUID(),
      actor
    )
    expect(await listOpenWaits(db, id)).toHaveLength(0)
    await expect(db.transaction((tx) => lockFlowInboxDelivery(tx, agentId, [first.id]))).rejects.toThrow('superseded')
    await expect(
      openWait(db, { workStreamId: id, type: 'question', flowAttemptId: 1, createdByAgentId: agentId })
    ).rejects.toThrow('currently active')
  })

  test('all branches must be blocked for the full parking grace', async () => {
    const { admissionBlockingWaits, admissionBlockedSince } = await import('../work-streams/wait-scope')
    const id = await create('active', parallelDefinition())
    await completeStep(id, 'execute')
    const attempts = activeWorkflowAttempts((await getFlow(id))!.state)
    const first = await openWait(db, {
      workStreamId: id,
      type: 'manual',
      flowAttemptId: attempts[0]!.id,
      message: 'First input',
    })
    expect(await admissionBlockingWaits(db, id)).toHaveLength(0)
    const second = await openWait(db, {
      workStreamId: id,
      type: 'manual',
      flowAttemptId: attempts[1]!.id,
      message: 'Second input',
    })
    const waits = await admissionBlockingWaits(db, id)
    expect(waits).toHaveLength(2)
    expect(admissionBlockedSince(waits)).toBe(Math.max(first.wait.openedAt.getTime(), second.wait.openedAt.getTime()))
  })
})

test('blocking questions pin their origin attempt and late answers cannot wake its replacement', async () => {
  const { createAgentQuestion, answerAgentQuestion, setQuestionBlocking } = await import('../agents/questions')
  const { waitForQuestionAnswerDeliveryDrains } = await import('../agents/question-answer-delivery')
  const id = await create('active', parallelDefinition())
  await completeStep(id, 'execute')
  const run = (await getFlow(id))!
  const attempt = activeWorkflowAttempts(run.state).find((a) => a.stepId === 'security')!
  const agentId = run.attemptAgents[String(attempt.id)]!
  const agent = await Agent.mustFind(agentId)
  const execution = await agent.queueExecution({ message: 'Review security' })
  const [handoff] = await db
    .select()
    .from(inbox)
    .where(eq(inbox.idempotencyKey, `flow:${id}:${attempt.id}`))
  expect((handoff!.metadata as any).source).toBe('workflow')
  await db.insert(chatMessages).values({
    agentId,
    role: 'human',
    content: 'Review security',
    pending: false,
    metadata: {
      source: 'inbox',
      inboxMessageIds: [handoff!.id],
      executionId: execution.id,
      consumedAt: execution.startedAt.toISOString(),
    },
  })
  const question = await createAgentQuestion(
    { agentId, executionId: execution.id },
    { questions: [{ id: 'threat', type: 'text', question: 'Which threat model?' }] },
    { blocking: true }
  )
  expect(question.openedWaitWorkStreamIds).toEqual([id])
  expect((await listOpenWaits(db, id))[0]?.flowAttemptId).toBe(attempt.id)
  await completeStep(id, 'qa')
  await expect(completeStep(id, 'security')).rejects.toThrow('Resolve the waits')
  await setQuestionBlocking(question.id, false)
  await setQuestionBlocking(question.id, true)
  expect((await listOpenWaits(db, id))[0]?.flowAttemptId).toBe(attempt.id)
  await execution.stop()
  const current = (await getFlow(id))!
  await advanceFlow(
    id,
    {
      action: 'revise',
      expectedVersion: current.version,
      attemptId: attempt.id,
      operations: [
        {
          op: 'put-participant',
          id: 'worker',
          participant: { ...current.state.definition.participants.worker!, tier: overrideTier },
        },
      ],
      reason: 'Restart review with new instructions',
      active: 'restart',
    },
    randomUUID(),
    actor
  )
  await expect(setQuestionBlocking(question.id, true)).rejects.toThrow('superseded')
  const user = await createTestUser({ prefix })
  await answerAgentQuestion(question.id, 'Use the documented threat model', user.id)
  await waitForQuestionAnswerDeliveryDrains()
  const replies = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
  const answer = replies.find((m) => (m.metadata as any)?.questionId === question.id)!
  expect(answer).toBeDefined()
  expect(await isCurrentFlowMessage(answer)).toBe(false)
  await expect(
    agent.queueExecution({ message: answer.content, metadata: { inboxMessageIds: [answer.id] } })
  ).rejects.toThrow('superseded')
})

test('only completed PR workflows with a linked change and event routing suppress idle nudges', async () => {
  const definition = structuredClone(flow)
  definition.completion = { mode: 'pr-merge', followChanges: true }
  const id = await create('active', definition)
  const metadata = { codeHost: { integration: 'github', repository: 'owner/repo', changeRequest: { number: 1 } } }
  expect((await externalDeliveryStreamIds(db, [{ id, metadata }])).size).toBe(0)
  await advance(id, 'completed')
  await advance(id, 'approved')
  expect((await externalDeliveryStreamIds(db, [{ id, metadata }])).has(id)).toBe(true)
  expect((await externalDeliveryStreamIds(db, [{ id, metadata: {} }])).size).toBe(0)
  expect(
    (
      await externalDeliveryStreamIds(db, [
        { id, metadata: { codeHost: { integration: 'github', repository: 'owner/repo' } } },
      ])
    ).size
  ).toBe(0)
})

test('action center human gates use review permission and assigned reviewer filter', async () => {
  const definition = structuredClone(flow)
  definition.steps[0] = {
    id: 'build',
    kind: 'human-approval',
    approver: 'assigned-reviewers',
    instructions: 'Approve scope',
    output: 'Decision',
    outcomes: { completed: { next: 'review' } },
  }
  const id = await create('active', definition)
  const reviewer = await createTestUser({ prefix })
  const responder = await createTestUser({ prefix })
  const reviewRole = await createTestRole({ prefix, permissions: ['actions:read', 'workstreams:review'] })
  const responseRole = await createTestRole({ prefix, permissions: ['actions:read', 'workstreams:respond'] })
  await assignRole({ userId: reviewer.id, roleId: reviewRole.id, scope: 'squad', squadId })
  await assignRole({ userId: responder.id, roleId: responseRole.id, scope: 'squad', squadId })
  const action = (await listPendingActions()).find((a) => 'workStreamId' in a.data && a.data.workStreamId === id)!
  const context = { attention: EMPTY_USER_ATTENTION }
  expect(await evaluatePendingAction({ type: 'user', userId: reviewer.id }, action, context)).toEqual({
    visible: true,
    canRespond: true,
  })
  expect(await evaluatePendingAction({ type: 'user', userId: responder.id }, action, context)).toEqual({
    visible: true,
    canRespond: false,
  })
  await db
    .update(workStreams)
    .set({ assignedReviewerIds: [responder.id] })
    .where(eq(workStreams.id, id))
  expect((await evaluatePendingAction({ type: 'user', userId: reviewer.id }, action, context)).canRespond).toBe(false)
})

test('participant tier resolves for each execution without changing the snapshotted role or current runner', async () => {
  const slug = prefix + '-deep'
  const initial = 'anthropic:claude-haiku-4-5'
  const updated = 'anthropic:claude-opus-4-5'
  await db.insert(modelTiers).values({ slug, label: 'Deep fixture', chain: initial })
  try {
    const definition = structuredClone(flow)
    definition.participants.builder!.tier = slug
    const id = await create('queued', definition)
    expect((await getFlow(id))!.participantSnapshots.builder).toMatchObject({ id: agentTypeId, model: '', tier: slug })
    expect((await getFlow(id))!.participantSnapshots.reviewer!.model).toBe('anthropic:claude-sonnet-4-5')
    await db.update(modelTiers).set({ chain: updated }).where(eq(modelTiers.slug, slug))
    await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, id))
    await ensureFlowDispatch(id)
    const binding = (await bindings(id))[0]!
    expect(binding.agentSnapshot).toMatchObject({ model: '', tier: slug })
    const worker = await Agent.mustFind(binding.agentId)
    expect(worker.modelOverride).toBeNull()
    const runningType = (await flowAgentType(worker.id))!
    expect(runningType.model).toBe(updated)
    expect(await worker.getEffectiveModelSpec(runningType.model)).toBe(updated)
    await db.update(modelTiers).set({ chain: initial }).where(eq(modelTiers.slug, slug))
    expect(runningType.model).toBe(updated)
    expect((await flowAgentType(worker.id))!.model).toBe(initial)
    expect((await flowAgentType(worker.id))!.systemPrompt).toBe('Shared role expertise and operational guidance')
    await db.update(modelTiers).set({ disabled: true }).where(eq(modelTiers.slug, slug))
    await expect(flowAgentType(worker.id)).rejects.toThrow('does not exist or is disabled')
  } finally {
    await db.delete(modelTiers).where(eq(modelTiers.slug, slug))
  }
})

test('workflow tier overrides reject missing and disabled tiers without falling back', async () => {
  const definition = structuredClone(flow)
  const slug = prefix + '-disabled'
  definition.participants.builder!.tier = slug
  await expect(create('queued', definition)).rejects.toThrow('does not exist or is disabled')
  await db
    .insert(modelTiers)
    .values({ slug, label: 'Disabled fixture', chain: 'anthropic:claude-haiku-4-5', disabled: true })
  try {
    await expect(create('queued', definition)).rejects.toThrow('does not exist or is disabled')
  } finally {
    await db.delete(modelTiers).where(eq(modelTiers.slug, slug))
  }
})

test('completion-ready rework is authorized, idempotent, tracked, and respects unrelated waits', async () => {
  const definition = structuredClone(flow)
  definition.completion.mode = 'review-approval'
  const id = await create('active', definition)
  await advance(id, 'completed')
  await advance(id, 'approved')
  const ready = (await getFlow(id))!
  const command = {
    action: 'rework',
    expectedVersion: ready.version,
    attemptId: 2,
    feedback: 'CI literal-type failure on current head',
  }
  await expect(
    advanceFlow(id, command, randomUUID(), { type: 'agent', agentId: ready.attemptAgents['1']!, squadId })
  ).rejects.toThrow('delivery participant')
  const { wait } = await openWait(db, {
    workStreamId: id,
    type: 'manual',
    scope: 'stream',
    message: 'Operator maintenance',
  })
  await expect(advanceFlow(id, command, randomUUID(), actor)).rejects.toThrow('Resolve the waits')
  expect((await listOpenWaits(db, id)).some((w) => w.id === wait.id)).toBe(true)
  await closeOpenWaits(db, { waitId: wait.id }, 'cleared')
  const requestId = randomUUID()
  const result = await advanceFlow(id, command, requestId, {
    type: 'agent',
    agentId: ready.attemptAgents['2']!,
    squadId,
  })
  expect(
    await advanceFlow(id, command, requestId, { type: 'agent', agentId: ready.attemptAgents['2']!, squadId })
  ).toEqual(result)
  expect(result.stateStatus).toBe('running')
  const run = (await getFlow(id))!
  expect(run.state.attempts).toHaveLength(3)
  expect(run.attemptAgents['3']).toBe(ready.attemptAgents['2'])
  expect(await listOpenWaits(db, id)).toHaveLength(0)
  expect(result.assignments?.[0]).toMatchObject({ attemptId: 3, stepId: 'review', version: result.version })
  expect(result.assignments?.[0]?.content).toContain('CI literal-type failure')
  expect((await messages(id)).some((m) => m.metadata?.attemptId === 3)).toBe(false)
  await ensureFlowDispatch(id)
  expect((await messages(id)).some((m) => m.metadata?.attemptId === 3)).toBe(false)
  await advance(id, 'changes-requested')
  await advance(id, 'completed')
  await advance(id, 'approved')
  expect((await getFlow(id))!.state.status).toBe('completion-ready')
  expect(await listOpenWaits(db, id)).toHaveLength(1)
})

test('a human who can approve delivery can send it back, but only while delivery approval is open', async () => {
  const user = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['workstreams:respond'] })
  await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })
  const approver = { type: 'user' as const, userId: user.id }
  const readyFlow = async (mode: WorkflowDefinition['completion']['mode']) => {
    const definition = structuredClone(flow)
    definition.completion.mode = mode
    const id = await create('active', definition)
    await advance(id, 'completed')
    await advance(id, 'approved')
    const ready = (await getFlow(id))!
    const command = {
      action: 'rework',
      expectedVersion: ready.version,
      attemptId: workflowReworkAttempt(ready.state)!.id,
      feedback: 'The summary misses the migration risk',
    }
    return { id, command }
  }

  const unreviewed = await readyFlow('deliverable')
  await expect(advanceFlow(unreviewed.id, unreviewed.command, randomUUID(), approver)).rejects.toThrow(
    'delivery approver'
  )

  const reviewed = await readyFlow('review-approval')
  const [delivery] = await listOpenWaits(db, reviewed.id)
  expect(delivery!.resolutionHandler).toBe('workflow')
  const result = await advanceFlow(reviewed.id, reviewed.command, randomUUID(), approver)
  expect(result.stateStatus).toBe('running')
  expect(await listOpenWaits(db, reviewed.id)).toHaveLength(0)
  const [closed] = await db.select().from(workStreamWaits).where(eq(workStreamWaits.id, delivery!.id))
  expect(closed).toMatchObject({ resolution: 'sent_back', resolutionNote: 'The summary misses the migration risk' })
})

test('parked completion-ready rework clears delivery review but waits for capacity admission', async () => {
  const { parkWorkStream, promoteEligibleQueuedStreams } = await import('../work-streams/admission')
  const definition = structuredClone(flow)
  definition.completion.mode = 'review-approval'
  const id = await create('active', definition)
  await advance(id, 'completed')
  await advance(id, 'approved')
  const ready = (await getFlow(id))!
  await parkWorkStream(id)
  expect((await WorkStream.mustFind(id)).status).toBe('queued')
  const [squad] = await db.select().from(squads).where(eq(squads.id, squadId))
  await create('active') // Own a competing slot even when this test runs alone.
  await db.update(squads).set({ maxConcurrentWorkStreams: 1 }).where(eq(squads.id, squadId))
  try {
    const result = await advanceFlow(
      id,
      {
        action: 'rework',
        expectedVersion: ready.version,
        attemptId: 2,
        feedback: 'CI needs correction after delivery was parked',
      },
      randomUUID(),
      { type: 'agent', agentId: ready.attemptAgents['2']!, squadId }
    )
    expect(result.stateStatus).toBe('running')
    expect(result.assignments).toBeUndefined()
    expect((await WorkStream.mustFind(id)).status).toBe('queued')
    expect((await getFlow(id))!.attemptAgents['3']).toBeUndefined()
    expect(await listOpenWaits(db, id)).toHaveLength(0)
    await db.update(squads).set({ maxConcurrentWorkStreams: null }).where(eq(squads.id, squadId))
    await promoteEligibleQueuedStreams(squadId)
    expect((await WorkStream.mustFind(id)).status).toBe('active')
    expect((await getFlow(id))!.attemptAgents['3']).toBe(ready.attemptAgents['2'])
    expect((await messages(id)).find((m) => m.metadata?.attemptId === 3)?.recipientId).toBe(ready.attemptAgents['2'])
  } finally {
    await db
      .update(squads)
      .set({ maxConcurrentWorkStreams: squad!.maxConcurrentWorkStreams })
      .where(eq(squads.id, squadId))
  }
})

test('same-agent step transitions return durable assignments without inbox duplicates, including racing retries', async () => {
  const definition = structuredClone(flow)
  definition.steps[1] = { ...definition.steps[1]!, kind: 'agent', participant: 'builder' }
  const id = await create('active', definition)
  const initial = (await getFlow(id))!
  const worker = { type: 'agent' as const, agentId: initial.attemptAgents['1']!, squadId }
  const requestId = randomUUID()
  const command = {
    action: 'complete',
    expectedVersion: initial.version,
    attemptId: 1,
    outcome: 'completed',
    evidence: 'Build checks passed',
  }
  const [first, retry] = await Promise.all([
    advanceFlow(id, command, requestId, worker),
    advanceFlow(id, command, requestId, worker),
  ])
  expect(retry).toEqual(first)
  expect(first.assignments).toHaveLength(1)
  expect(first.assignments![0]).toMatchObject({ workStreamId: id, stepId: 'review', attemptId: 2, version: 1 })
  expect(first.assignments![0]!.content).toContain('Build checks passed')
  expect(await messages(id)).toHaveLength(1) // Only the original assignment.
  expect(await bindings(id)).toHaveLength(1)
  await db.update(workStreams).set({ title: 'Changed after response' }).where(eq(workStreams.id, id))
  await ensureFlowDispatch(id)
  expect(await advanceFlow(id, command, requestId, worker)).toEqual(first)
  expect(await messages(id)).toHaveLength(1)
  expect((await getFlow(id))!.state.attempts[1]!.responseAssignment).toMatchObject({
    requestId,
    agentId: worker.agentId,
  })
  const correction = await advanceFlow(
    id,
    {
      action: 'complete',
      expectedVersion: 1,
      attemptId: 2,
      outcome: 'changes-requested',
      evidence: 'Correct the literal type',
    },
    randomUUID(),
    worker
  )
  expect(correction.assignments?.[0]).toMatchObject({ attemptId: 3, stepId: 'build' })
  expect(correction.assignments?.[0]?.content).toContain('Correct the literal type')
  await ensureFlowDispatch(id)
  expect(await messages(id)).toHaveLength(1)
  expect(await advanceFlow(id, command, requestId, worker)).toEqual(first)
})

test.each(['different-participant', 'fresh-session'] as const)(
  'a %s handoff still notifies the receiving agent',
  async (mode) => {
    const definition = structuredClone(flow)
    if (mode === 'fresh-session') {
      definition.participants.builder!.session = 'fresh-per-attempt'
      definition.steps[1] = { ...definition.steps[1]!, kind: 'agent', participant: 'builder' }
    }
    const id = await create('active', definition)
    const initial = (await getFlow(id))!
    const caller = initial.attemptAgents['1']!
    const result = await advanceFlow(
      id,
      { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: 'Ready' },
      randomUUID(),
      { type: 'agent', agentId: caller, squadId }
    )
    expect(result.assignments).toBeUndefined()
    const next = (await getFlow(id))!.attemptAgents['2']!
    expect(next).not.toBe(caller)
    expect((await messages(id)).find((m) => m.metadata?.attemptId === 2)?.recipientId).toBe(next)
  }
)

test('a self-handoff in a parallel branch stays durable while an earlier sibling remains active', async () => {
  const definition = parallelDefinition()
  definition.steps.find((step) => step.id === 'qa')!.outcomes.completed = { next: 'qa-followup' }
  definition.steps.push(
    workflowStepSchema.parse({
      id: 'qa-followup',
      participant: 'worker',
      instructions: 'Follow up QA',
      output: 'Evidence',
      outcomes: { completed: { next: 'deliver' } },
    })
  )
  const id = await create('active', definition)
  await completeStep(id, 'execute')
  const run = (await getFlow(id))!
  const qa = run.state.attempts.find((attempt) => attempt.stepId === 'qa')!
  const worker = { type: 'agent' as const, agentId: run.attemptAgents[String(qa.id)]!, squadId }
  const result = await advanceFlow(
    id,
    { action: 'complete', expectedVersion: run.version, attemptId: qa.id, outcome: 'completed', evidence: 'QA passed' },
    randomUUID(),
    worker
  )
  expect(result.assignments?.[0]).toMatchObject({ stepId: 'qa-followup', attemptId: 4 })
  await ensureFlowDispatch(id)
  expect((await messages(id)).some((message) => message.metadata?.attemptId === 4)).toBe(false)
  expect(activeWorkflowAttempts((await getFlow(id))!.state).map((attempt) => attempt.stepId)).toEqual([
    'security',
    'qa-followup',
  ])
})

describe('live outcome binding', () => {
  test('manager keep updates routing without dispatch or session changes; retries return the original binding', async () => {
    const id = await create()
    await ensureFlowDispatch(id)
    const manager = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['workstreams:revise-flow'] })
    await assignRole({ userId: manager.id, roleId: role.id, scope: 'squad', squadId })
    const managerIdentity = { type: 'user', userId: manager.id } as const
    const initial = (await getFlow(id))!
    const agentId = initial.attemptAgents['1']!
    const worker = { type: 'agent', agentId, squadId } as const
    const binding = await bindings(id)
    const handoffs = await messages(id)
    const dispatchCount = send.mock.calls.length
    const execution = await (await Agent.mustFind(agentId)).queueExecution({ message: 'Preserved conversation' })
    await db
      .insert(chatMessages)
      .values({ agentId, role: 'human', content: 'Initial session context', metadata: { executionId: execution.id } })
    const history = await db.select().from(chatMessages).where(eq(chatMessages.agentId, agentId))
    const step = initial.state.definition.steps[0]!
    const command = {
      action: 'revise',
      expectedVersion: 0,
      attemptId: 1,
      active: 'keep',
      reason: 'Owner waived build',
      operations: [
        {
          op: 'put-step',
          step: {
            ...step,
            instructions: 'Future instructions',
            output: 'Future output',
            outcomes: { ...step.outcomes, waived: { next: 'review' } },
          },
        },
      ],
    }
    const requestId = randomUUID()
    const first = await advanceFlow(id, command, requestId, managerIdentity)
    expect(first.outcomeUpdates).toEqual([
      {
        attemptId: 1,
        stepId: 'build',
        agentId,
        version: 1,
        outcomes: { ...step.outcomes, waived: { next: 'review' } },
      },
    ])
    expect(await advanceFlow(id, command, requestId, managerIdentity)).toEqual(first)
    const kept = (await getFlow(id))!
    expect(kept.state.attempts[0]!.step).toEqual(initial.state.attempts[0]!.step)
    expect(kept.attemptAgents).toEqual(initial.attemptAgents)
    expect(activeOutcomeBindings(kept)).toEqual(first.outcomeUpdates!)
    expect(send.mock.calls.length).toBe(dispatchCount)
    expect(await bindings(id)).toEqual(binding)
    expect(await messages(id)).toEqual(handoffs)
    expect(await db.select().from(chatMessages).where(eq(chatMessages.agentId, agentId))).toEqual(history)
    expect(await isCurrentFlowMessage(handoffs[0]!)).toBe(true)
    await expect(
      advanceFlow(
        id,
        { action: 'complete', expectedVersion: 0, attemptId: 1, outcome: 'completed', evidence: 'Stale' },
        randomUUID(),
        worker
      )
    ).rejects.toThrow('Stale')
    await advanceFlow(
      id,
      {
        ...command,
        expectedVersion: 1,
        operations: [{ op: 'put-step', step: { ...step, outcomes: { waived: { next: 'review' } } } }],
      },
      randomUUID(),
      managerIdentity
    )
    await expect(
      advanceFlow(
        id,
        { action: 'complete', expectedVersion: 2, attemptId: 1, outcome: 'completed', evidence: 'Removed' },
        randomUUID(),
        worker
      )
    ).rejects.toThrow('Unknown outcome')
    expect(await advanceFlow(id, command, requestId, managerIdentity)).toEqual(first)
    await advanceFlow(
      id,
      { action: 'complete', expectedVersion: 2, attemptId: 1, outcome: 'waived', evidence: 'Actual owner waiver' },
      randomUUID(),
      worker
    )
    expect((await getFlow(id))!.state.attempts[1]!.stepId).toBe('review')
    await execution.stop()
  })

  test('limited adaptive workers may revise future outcomes but not any kept active outcomes', async () => {
    const definition = structuredClone(flow)
    definition.routing.mode = 'adaptive'
    const id = await create('active', definition)
    const agentId = (await getFlow(id))!.attemptAgents['1']!
    const worker = { type: 'agent', agentId, squadId } as const
    const command = {
      action: 'revise',
      expectedVersion: 0,
      attemptId: 1,
      active: 'keep',
      reason: 'Attempt to bypass review',
      operations: [
        {
          op: 'put-step',
          step: { ...definition.steps[0]!, outcomes: { completed: { next: 'review' }, waived: { next: 'finish' } } },
        },
      ],
    }
    await expect(advanceFlow(id, command, randomUUID(), worker)).rejects.toThrow('flow management permission')
    expect((await getFlow(id))!.version).toBe(0)
    await advanceFlow(
      id,
      {
        ...command,
        operations: [
          {
            op: 'put-step',
            step: {
              ...definition.steps[1]!,
              outcomes: { ...definition.steps[1]!.outcomes, verified: { next: 'finish' } },
            },
          },
        ],
      },
      randomUUID(),
      worker
    )
    expect((await getFlow(id))!.state.attempts[0]!.effectiveOutcomes).toBeUndefined()
  })

  test('outcome keep preserves waits and human gates; restart explicitly replaces the session and stale token', async () => {
    const id = await create()
    const initial = (await getFlow(id))!
    const oldAgent = initial.attemptAgents['1']!
    const { wait } = await openWait(db, {
      workStreamId: id,
      type: 'manual',
      flowAttemptId: 1,
      message: 'Required input',
    })
    const step = initial.state.definition.steps[0]!
    const gate = {
      id: 'approval',
      kind: 'human-approval',
      approver: 'reviewers',
      instructions: 'Human verdict',
      output: 'Approval',
      outcomes: { approved: { next: 'review' } },
    }
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: 0,
        attemptId: 1,
        active: 'keep',
        reason: 'Route through human',
        operations: [
          { op: 'put-step', step: gate },
          { op: 'put-step', step: { ...step, outcomes: { verified: { next: 'approval' } } } },
        ],
      },
      randomUUID(),
      actor
    )
    expect((await listOpenWaits(db, id)).map((w) => w.id)).toEqual([wait.id])
    await expect(advance(id, 'verified')).rejects.toThrow('Resolve the waits')
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: 1,
        attemptId: 1,
        active: 'restart',
        reason: 'Deliberate fresh context',
        operations: [{ op: 'set-name', name: 'Restart' }],
      },
      randomUUID(),
      actor
    )
    const restarted = (await getFlow(id))!
    expect(restarted.state.attempts[0]!.status).toBe('canceled')
    expect(restarted.state.attempts[1]!.freshSession).toBe(true)
    expect(restarted.attemptAgents['2']).not.toBe(oldAgent)
    expect(await bindings(id)).toHaveLength(2)
    expect(await listOpenWaits(db, id)).toHaveLength(0)
    await expect(
      advanceFlow(
        id,
        { action: 'complete', expectedVersion: 2, attemptId: 1, outcome: 'verified', evidence: 'Old token' },
        randomUUID(),
        actor
      )
    ).rejects.toThrow('Stale step attempt')
    await advance(id, 'verified')
    const human = (await getFlow(id))!
    expect(human.state.attempts.at(-1)!.stepId).toBe('approval')
    const waits = await listOpenWaits(db, id)
    await advanceFlow(
      id,
      {
        action: 'revise',
        expectedVersion: human.version,
        attemptId: human.state.activeAttemptId,
        active: 'keep',
        reason: 'Alternate human verdict',
        operations: [{ op: 'put-step', step: { ...gate, outcomes: { accepted: { next: 'review' } } } }],
      },
      randomUUID(),
      actor
    )
    expect(await listOpenWaits(db, id)).toEqual(waits)
    await expect(advance(id, 'accepted')).rejects.toThrow('designated human approver')
  })
})

test('live outcome revision reports the affected sibling agent without touching unrelated active work', async () => {
  const definition = parallelDefinition()
  definition.routing.mode = 'adaptive'
  const id = await create('active', definition)
  await completeStep(id, 'execute')
  await ensureFlowDispatch(id)
  const initial = (await getFlow(id))!
  const security = activeWorkflowAttempts(initial.state).find((a) => a.stepId === 'security')!
  const qa = activeWorkflowAttempts(initial.state).find((a) => a.stepId === 'qa')!
  const command = {
    action: 'revise',
    expectedVersion: initial.version,
    attemptId: qa.id,
    active: 'keep',
    reason: 'Accurate security verdict',
    operations: [
      {
        op: 'put-step',
        step: { ...security.step!, outcomes: { ...security.step!.outcomes, waived: { next: 'deliver' } } },
      },
    ],
  }
  const bindingsBefore = await bindings(id)
  const messagesBefore = await messages(id)
  await expect(
    advanceFlow(id, command, randomUUID(), { type: 'agent', agentId: initial.attemptAgents[String(qa.id)]!, squadId })
  ).rejects.toThrow('flow management permission')
  const result = await advanceFlow(id, command, randomUUID(), actor)
  expect(result.outcomeUpdates).toEqual([
    {
      attemptId: security.id,
      stepId: 'security',
      agentId: initial.attemptAgents[String(security.id)],
      version: initial.version + 1,
      outcomes: { ...security.step!.outcomes, waived: { next: 'deliver' } },
    },
  ])
  const revised = (await getFlow(id))!
  expect(revised.state.attempts.find((a) => a.id === qa.id)).toEqual(qa)
  expect(revised.state.joins).toEqual(initial.state.joins)
  expect(revised.attemptAgents).toEqual(initial.attemptAgents)
  expect(await bindings(id)).toEqual(bindingsBefore)
  expect(await messages(id)).toEqual(messagesBefore)
})

test('queued live revision receipts retain unbound identities after admission and dispatch', async () => {
  const id = await create('queued')
  const initial = (await getFlow(id))!
  const step = initial.state.definition.steps[0]!
  const command = {
    action: 'revise',
    expectedVersion: initial.version,
    attemptId: initial.state.activeAttemptId,
    active: 'keep',
    reason: 'Add a truthful verdict while awaiting admission',
    operations: [{ op: 'put-step', step: { ...step, outcomes: { ...step.outcomes, waived: { next: 'review' } } } }],
  }
  const requestId = randomUUID()
  const first = await advanceFlow(id, command, requestId, actor)
  expect(first.outcomeUpdates).toEqual([
    {
      attemptId: 1,
      stepId: 'build',
      agentId: null,
      version: 1,
      outcomes: { ...step.outcomes, waived: { next: 'review' } },
    },
  ])
  expect(await bindings(id)).toHaveLength(0)
  await db.update(workStreams).set({ status: 'active' }).where(eq(workStreams.id, id))
  await ensureFlowDispatch(id)
  const admitted = (await getFlow(id))!
  expect(admitted.attemptAgents['1']).toBeString()
  expect(activeOutcomeBindings(admitted)[0]!.agentId).toBe(admitted.attemptAgents['1']!)
  expect(await advanceFlow(id, command, requestId, actor)).toEqual(first)
  expect(admitted.state.revisions!.at(-1)!.outcomeUpdates).toEqual(first.outcomeUpdates!)
})
