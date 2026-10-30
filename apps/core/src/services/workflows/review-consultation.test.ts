import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { eq, inArray, like } from 'drizzle-orm'
import { workflowDefinitionSchema, type WorkflowDefinition } from '@ficus/shared'
import { brief } from '@ficus/shared/test-fixtures/workflow-review'
import { db, agents, agentTypes, inbox, squads, workStreamFlowRuns, workStreams } from '../../db'
import { identityMiddleware } from '../../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../../test-utils/rbac'
import { Agent } from '../../entities/Agent'
import { agentsRouter } from '../../routes/agents'
import { messageTextForModel } from '../chat/message-context'
import { advanceFlow, attachFlow, getFlow } from './execution'
import { REVIEW_CONSULTATION_FORBIDDEN_MESSAGE, REVIEW_NOT_OPEN_MESSAGE } from './review-consultation'

const app = new Hono().use('*', identityMiddleware).route('/api/agents', agentsRouter)
const prefix = `review-consult-${randomUUID()}`
const profile = `${prefix}-profile`
let admin: TestUser, chatter: TestUser
let squadId: string
let producer: string, bystander: string
let streamId: string
const streams: string[] = []
let send: ReturnType<typeof spyOn<Agent, 'sendMessage'>>

const definition: WorkflowDefinition = workflowDefinitionSchema.parse({
  schemaVersion: 1,
  name: 'Design with approval',
  participants: { worker: { agentTypeId: profile, session: 'reuse-within-stream' } },
  entry: 'design',
  routing: { mode: 'guided', returnTo: 'declared-only', delegation: 'disabled' },
  limits: { maxDelegations: 0, onLimit: 'request-owner-input' },
  steps: [
    {
      id: 'design',
      participant: 'worker',
      instructions: 'Write the design.',
      output: 'Design.',
      outcomes: { completed: { next: 'approval' } },
    },
    {
      id: 'approval',
      kind: 'human-approval',
      name: 'Design approval',
      instructions: 'Approve the design.',
      output: 'Decision.',
      outcomes: { approved: { next: 'finish' }, 'changes-requested': { returnTo: 'design' } },
    },
  ],
  completion: { mode: 'review-approval' },
})

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  // May chat with agents but not decide reviews.
  chatter = await createTestUser({ prefix })
  const [squad] = await db.insert(squads).values({ name: prefix, purpose: 'Consultation tests' }).returning()
  squadId = squad!.id
  const role = await createTestRole({ prefix, permissions: ['agents:run', 'agents:read', 'workstreams:read'] })
  await assignRole({ userId: chatter.id, roleId: role.id, scope: 'squad', squadId })
  await db.insert(agentTypes).values({
    id: profile,
    name: 'Consultation worker',
    model: 'x',
    systemPrompt: 'Test.',
    extraScopes: ['workstreams:respond'],
  })
  const created = await db
    .insert(agents)
    .values([
      { agentTypeId: profile, squadId },
      { agentTypeId: profile, squadId },
    ])
    .returning({ id: agents.id })
  producer = created[0]!.id
  bystander = created[1]!.id
  send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({ success: true, status: 'queued', queued: true })
})
beforeEach(async () => {
  send.mockClear()
  const [stream] = await db.insert(workStreams).values({ squadId, title: prefix, status: 'active' }).returning()
  streamId = stream!.id
  streams.push(streamId)
  await db.transaction(async (tx) => {
    await attachFlow(tx, stream!, { kind: 'inline', definition })
  })
  await db
    .update(workStreamFlowRuns)
    .set({ attemptAgents: { '1': producer } })
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
  await advanceFlow(
    streamId,
    {
      action: 'complete',
      expectedVersion: (await getFlow(streamId))!.version,
      attemptId: 1,
      outcome: 'completed',
      evidence: 'Design evidence.',
      decisionBrief: brief,
    },
    randomUUID(),
    { type: 'agent', agentId: producer, squadId }
  )
})
afterEach(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [producer, bystander]))
  await db.delete(workStreams).where(inArray(workStreams.id, streams.splice(0)))
})
afterAll(async () => {
  send?.mockRestore()
  await db.delete(agents).where(eq(agents.agentTypeId, profile))
  await cleanupTestRbac(prefix)
  if (squadId) await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(agentTypes).where(like(agentTypes.id, `${prefix}%`))
})

function message(user: TestUser, agentId: string, extra: Record<string, unknown> = {}) {
  return app.request(`/api/agents/${agentId}/message`, {
    method: 'POST',
    headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Can you add a rollback note?', wake: true, ...extra }),
  })
}
const consultation = () => ({ reviewConsultation: { workStreamId: streamId, gateAttemptId: 2 } })
const sentMetadata = () => send.mock.calls.at(-1)![1]!.metadata!

test('a reviewer messaging the producing agent from an open gate gives it the consultation context', async () => {
  const response = await message(admin, producer, consultation())
  expect(response.status).toBe(200)
  expect(send).toHaveBeenCalledTimes(1)
  const [content, options] = send.mock.calls[0]!
  expect(content).toBe('Can you add a rollback note?')
  // Same agent, existing session: an ordinary send that may wake a dormant agent.
  expect(options!.refuseIfDormant).toBe(false)
  const metadata = sentMetadata()
  expect(metadata.reviewConsultation).toEqual({
    workStreamId: streamId,
    workStreamRef: expect.any(String),
    gateAttemptId: 2,
    gateStepId: 'approval',
    gateName: 'Design approval',
    sources: [{ attemptId: 1, stepId: 'design', revision: 1 }],
    amend: { available: true },
  })
  const model = messageTextForModel({ content, metadata })
  expect(model).toStartWith('Can you add a rollback note?')
  expect(model).toContain("a person is deciding human approval 'Design approval' (step approval, attempt 2)")
  expect(model).toContain('Under review: your design attempt 1, revision 1.')
  expect(model).toContain('cite your evidence')
  expect(model).toContain('action "amend"')
  expect(model).toContain('recommend Changes requested instead')
})

test('an ordinary chat to the same agent carries no consultation context', async () => {
  expect((await message(admin, producer)).status).toBe(200)
  const metadata = sentMetadata()
  expect(metadata.reviewConsultation).toBeUndefined()
  expect(messageTextForModel({ content: 'Hello', metadata })).not.toContain('Review consultation')
})

test('a stamp a client sends itself is ignored', async () => {
  expect((await message(admin, producer, { metadata: { reviewConsultation: { gateAttemptId: 2 } } })).status).toBe(200)
  expect(sentMetadata().reviewConsultation).toBeUndefined()
})

test('a closed gate, a non-producing agent and a person who cannot decide are refused, and nothing is sent', async () => {
  const notProducer = await message(admin, bystander, consultation())
  expect(notProducer.status).toBe(409)
  expect(await notProducer.json()).toEqual({ error: REVIEW_NOT_OPEN_MESSAGE, code: 'REVIEW_NOT_OPEN' })

  const forbidden = await message(chatter, producer, consultation())
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({
    error: REVIEW_CONSULTATION_FORBIDDEN_MESSAGE,
    code: 'REVIEW_CONSULTATION_FORBIDDEN',
  })

  await advanceFlow(
    streamId,
    {
      action: 'complete',
      expectedVersion: (await getFlow(streamId))!.version,
      attemptId: 2,
      outcome: 'approved',
      evidence: '',
    },
    randomUUID(),
    { type: 'user', userId: admin.id }
  )
  const closed = await message(admin, producer, consultation())
  expect(closed.status).toBe(409)
  expect((await closed.json()).code).toBe('REVIEW_NOT_OPEN')
  expect(send).not.toHaveBeenCalled()
})

test('a queued stream does not offer amend, which Core would refuse there', async () => {
  await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, streamId))
  expect((await message(admin, producer, consultation())).status).toBe(200)
  expect(sentMetadata().reviewConsultation!.amend).toEqual({
    available: false,
    reason: 'Resume queued work before amending its attempt.',
  })
})

test('a retried send that was already accepted is replayed even if the review closed since', async () => {
  const accepted = spyOn(Agent.prototype, 'hasAcceptedClientSend').mockResolvedValue(true)
  try {
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, streamId))
    const retried = await message(admin, producer, { ...consultation(), clientId: 'review-send-1' })
    expect(retried.status).toBe(200)
    expect(accepted).toHaveBeenCalledWith('review-send-1')
    expect(send).toHaveBeenCalledTimes(1)
    // A new send to the closed review is still refused.
    accepted.mockResolvedValue(false)
    expect((await message(admin, producer, { ...consultation(), clientId: 'review-send-2' })).status).toBe(409)
  } finally {
    accepted.mockRestore()
  }
})

test('when amend is not available the agent is told to recommend Changes requested', async () => {
  const run = (await getFlow(streamId))!
  run.state.attempts[1]!.reviewBrief = { kind: 'legacy' }
  await db.update(workStreamFlowRuns).set({ state: run.state }).where(eq(workStreamFlowRuns.workStreamId, streamId))
  expect((await message(admin, producer, consultation())).status).toBe(200)
  const metadata = sentMetadata()
  expect(metadata.reviewConsultation!.amend).toEqual({
    available: false,
    reason:
      "Human approval 'approval' did not open with this attempt's decision brief, so it cannot be amended; recommend Changes requested instead.",
  })
  const model = messageTextForModel({ content: 'Hi', metadata })
  expect(model).toContain('Amending is not available for this gate:')
  expect(model).toContain('For any change, recommend Changes requested.')
  expect(model).not.toContain('action "amend"')
})
