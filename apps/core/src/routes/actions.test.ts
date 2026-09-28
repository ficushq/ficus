import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import { agentQuestions, agents, agentTypes, squads, workStreams } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { subscribeToSquad } from '../services/squad/subscriptions'
import { parkWorkStream } from '../services/work-streams/admission'
import { openWait } from '../services/work-streams/waits'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser, type TestUser } from '../test-utils'
import type { WorkStreamActionData } from '@ficus/shared'
import { actionsRouter } from './actions'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/actions', actionsRouter)

const prefix = `actions-route-${crypto.randomUUID()}`
let squad: Squad
let responder: TestUser
let updater: TestUser
let reader: TestUser
let ownerOnly: TestUser
const agentIds: string[] = []

beforeAll(async () => {
  await AgentType.create({ id: `${prefix}-type`, name: 'Action route', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: prefix, purpose: 'pending action route matrix' })
  responder = await createTestUser({ prefix: `${prefix}-responder` })
  updater = await createTestUser({ prefix: `${prefix}-updater` })
  reader = await createTestUser({ prefix: `${prefix}-reader` })
  ownerOnly = await createTestUser({ prefix: `${prefix}-owner` })
  const responderRole = await createTestRole({
    prefix: `${prefix}-responder-role`,
    permissions: ['actions:read', 'agents:run', 'workstreams:respond'],
  })
  const updaterRole = await createTestRole({
    prefix: `${prefix}-updater-role`,
    permissions: ['actions:read', 'workstreams:update'],
  })
  const readerRole = await createTestRole({ prefix: `${prefix}-reader-role`, permissions: ['actions:read'] })
  await assignRole({ userId: responder.id, roleId: responderRole.id, scope: 'squad', squadId: squad.id })
  await assignRole({ userId: updater.id, roleId: updaterRole.id, scope: 'squad', squadId: squad.id })
  await assignRole({ userId: reader.id, roleId: readerRole.id, scope: 'squad', squadId: squad.id })
  await Promise.all([
    subscribeToSquad(squad.id, responder.id),
    subscribeToSquad(squad.id, updater.id),
    subscribeToSquad(squad.id, reader.id),
  ])

  const squadQuestionAgent = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id })
  const errorAgent = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id })
  const asyncAgent = await Agent.create({
    agentTypeId: `${prefix}-type`,
    squadId: squad.id,
    ownerUserId: responder.id,
  })
  const personalAgent = await Agent.create({ agentTypeId: `${prefix}-type`, ownerUserId: ownerOnly.id })
  agentIds.push(squadQuestionAgent.id, errorAgent.id, asyncAgent.id, personalAgent.id)
  await db
    .update(agents)
    .set({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'input', type: 'text', question: 'Squad input?' }] },
    })
    .where(eq(agents.id, squadQuestionAgent.id))
  await db
    .update(agents)
    .set({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'rate_limit', type: 'text', question: 'Provider unavailable' }] },
    })
    .where(eq(agents.id, errorAgent.id))
  await db
    .update(agents)
    .set({
      status: 'waiting-input',
      questionData: { questions: [{ id: 'rate_limit', type: 'text', question: 'Personal provider unavailable' }] },
    })
    .where(eq(agents.id, personalAgent.id))
  await db.insert(agentQuestions).values([
    {
      agentId: asyncAgent.id,
      squadId: squad.id,
      ownerUserId: responder.id,
      questionData: { questions: [{ id: 'async', type: 'text', question: 'Async input?' }] },
    },
    {
      agentId: personalAgent.id,
      ownerUserId: ownerOnly.id,
      questionData: { questions: [{ id: 'personal', type: 'text', question: 'Personal input?' }] },
    },
  ])

  const review = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} review` })
  await review.handoffForReview({ message: 'Review this' })
  const blocked = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} blocked` })
  await blocked.block({ message: 'Need input' })
  const queuedReview = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} queued review` })
  await queuedReview.handoffForReview({ message: 'Queued review' })
  await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, queuedReview.id))
  const queuedBlocked = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} queued blocked` })
  await queuedBlocked.block({ message: 'Queued input' })
  await db.update(workStreams).set({ status: 'queued' }).where(eq(workStreams.id, queuedBlocked.id))
  const terminal = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} terminal` })
  await terminal.handoffForReview({ message: 'Must be filtered' })
  await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, terminal.id))
})

afterAll(async () => {
  await db.delete(agentQuestions).where(inArray(agentQuestions.agentId, agentIds))
  await db.delete(workStreams).where(eq(workStreams.squadId, squad.id))
  await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

describe('GET /api/actions/pending policy matrix', () => {
  test('serializes all five current action types in priority order with ISO timestamps and response capability', async () => {
    const response = await app.request('/api/actions/pending', { headers: authHeaders(responder.token) })
    expect(response.status).toBe(200)
    const actions = (await response.json()) as Array<{
      id: string
      type: string
      priority: number
      createdAt: string
      canRespond: boolean
      data: { workStreamTitle?: string }
    }>
    expect(actions.map((action) => action.type)).toEqual([
      'agent-error',
      'agent-question',
      'squad-question',
      'workstream-review',
      'workstream-review',
      'workstream-blocked',
      'workstream-blocked',
    ])
    expect(actions.map((action) => action.priority)).toEqual([0, 1, 1, 2, 2, 3, 3])
    expect(actions.every((action) => !Number.isNaN(Date.parse(action.createdAt)))).toBe(true)
    expect(actions.every((action) => action.canRespond)).toBe(true)
    expect(actions.some((action) => action.data.workStreamTitle?.includes('terminal'))).toBe(false)
    expect(actions.some((action) => action.data.workStreamTitle?.includes('queued review'))).toBe(true)
    expect(actions.some((action) => action.data.workStreamTitle?.includes('queued blocked'))).toBe(true)
  })

  test('serializes concurrent waits with full stable identities and checkpoint truth', async () => {
    const manual = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} exact manual waits` })
    const checkpoint = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} exact checkpoint` })
    try {
      const first = await manual.block({ message: 'first input' })
      const second = await manual.block({ message: 'second input' })
      const { wait: review } = await checkpoint.handoffForReview({
        message: 'checkpoint review',
        completesOnApproval: false,
      })

      const response = await app.request('/api/actions/pending', { headers: authHeaders(responder.token) })
      expect(response.status).toBe(200)
      const actions = (await response.json()) as Array<{ id: string; data: WorkStreamActionData }>
      for (const wait of [first, second, review]) {
        const action = actions.find((item) => item.data.waitId === wait.id)
        expect(action).toBeDefined()
        expect(action!.id).toEndWith(`:${wait.id}`)
        expect(action!.data.wait).toMatchObject({
          id: wait.id,
          type: wait.type,
          message: wait.message,
          completesOnApproval: wait.completesOnApproval,
        })
        expect(action!.data.focus).toEqual({
          kind: 'workstream-wait',
          workStreamId: wait.workStreamId,
          waitId: wait.id,
        })
      }
    } finally {
      await db.delete(workStreams).where(inArray(workStreams.id, [manual.id, checkpoint.id]))
    }
  })

  test('includes a stream parked through the verb path but excludes dependency and question waits', async () => {
    const parked = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} parked via verb` })
    const dependency = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} dependency only` })
    const question = await storedLegacyWorkStream({ squadId: squad.id, title: `${prefix} question only` })
    try {
      const manual = await parked.block({ message: 'parked manual input' })
      await parkWorkStream(parked.id)
      const dependencyWait = await openWait(db, {
        workStreamId: dependency.id,
        type: 'dependency',
        referenceId: parked.id,
      })
      const questionWait = await openWait(db, {
        workStreamId: question.id,
        type: 'question',
        referenceId: crypto.randomUUID(),
      })

      const response = await app.request('/api/actions/pending', { headers: authHeaders(responder.token) })
      const actions = (await response.json()) as Array<{ id: string; data: WorkStreamActionData }>
      expect(actions.some((action) => action.data.waitId === manual.id)).toBe(true)
      expect(actions.some((action) => action.data.waitId === dependencyWait.wait.id)).toBe(false)
      expect(actions.some((action) => action.data.waitId === questionWait.wait.id)).toBe(false)
    } finally {
      await db.delete(workStreams).where(inArray(workStreams.id, [parked.id, dependency.id, question.id]))
    }
  })

  test('keeps the same watched actions visible but read-only without mutation permissions', async () => {
    const response = await app.request('/api/actions/pending', { headers: authHeaders(reader.token) })
    expect(response.status).toBe(200)
    const actions = (await response.json()) as Array<{ type: string; canRespond: boolean }>
    expect(new Set(actions.map((action) => action.type))).toEqual(
      new Set(['agent-error', 'agent-question', 'squad-question', 'workstream-review', 'workstream-blocked'])
    )
    expect(actions).toHaveLength(7)
    expect(actions.every((action) => action.canRespond === false)).toBe(true)
  })

  test('grants work-stream capability independently through workstreams:update', async () => {
    const response = await app.request('/api/actions/pending', { headers: authHeaders(updater.token) })
    expect(response.status).toBe(200)
    const actions = (await response.json()) as Array<{ type: string; canRespond: boolean }>
    expect(actions.filter((action) => action.type.startsWith('workstream-'))).toHaveLength(4)
    expect(actions.filter((action) => action.type.startsWith('workstream-')).every((action) => action.canRespond)).toBe(
      true
    )
    expect(
      actions.filter((action) => !action.type.startsWith('workstream-')).every((action) => !action.canRespond)
    ).toBe(true)
  })

  test('owners without actions:read receive only their personal question and error bypasses', async () => {
    const response = await app.request('/api/actions/pending', { headers: authHeaders(ownerOnly.token) })
    expect(response.status).toBe(200)
    const actions = (await response.json()) as Array<{ type: string; canRespond: boolean; squadId?: string }>
    expect(actions.map((action) => action.type)).toEqual(['agent-error', 'agent-question'])
    expect(actions.every((action) => action.squadId === undefined)).toBe(true)
    expect(actions.every((action) => action.canRespond)).toBe(true)
  })
})
