import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db'
import {
  agentQuestionRecipients,
  agentQuestions,
  agents,
  agentTypes,
  roleAssignments,
  roles,
  squads,
} from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { subscribeToSquad } from '../services/squad/subscriptions'
import * as rbacModule from '../services/rbac'
import * as questionAuthorizationModule from '../services/agents/question-authorization'
import { actionsRouter } from './actions'
import { agentQuestionsRouter } from './agent-questions'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agent-questions', agentQuestionsRouter)
app.route('/api/actions', actionsRouter)

const prefix = `agent-question-route-${crypto.randomUUID()}`
let squad: Squad
let agent: Agent
let direct: TestUser
let agentReader: TestUser
let outsider: TestUser
let questionId: string

beforeAll(async () => {
  await AgentType.create({ id: `${prefix}-type`, name: 'Question route', model: 'test:model', systemPrompt: 'test' })
  squad = await Squad.create({ name: prefix, purpose: 'question route policy' })
  agent = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id })
  direct = await createTestUser({ prefix: `${prefix}-direct` })
  agentReader = await createTestUser({ prefix: `${prefix}-reader` })
  outsider = await createTestUser({ prefix: `${prefix}-outsider` })
  const readRole = await createTestRole({ prefix: `${prefix}-read`, permissions: ['agents:read', 'actions:read'] })
  await assignRole({ userId: agentReader.id, roleId: readRole.id, scope: 'squad', squadId: squad.id })
})

beforeEach(async () => {
  await db
    .update(agents)
    .set({ status: 'active', ownerUserId: null, terminatedAt: null, pendingDormancyAt: null })
    .where(eq(agents.id, agent.id))
  await db.delete(agentQuestions).where(eq(agentQuestions.agentId, agent.id))
  const [question] = await db
    .insert(agentQuestions)
    .values({
      agentId: agent.id,
      squadId: squad.id,
      questionData: { questions: [{ id: 'q', type: 'text', question: 'Proceed?' }] },
    })
    .returning()
  questionId = question.id
  await db.insert(agentQuestionRecipients).values({
    questionId,
    userId: direct.id,
    reason: 'execution-participant',
  })
})

afterAll(async () => {
  await db.delete(agentQuestions).where(eq(agentQuestions.agentId, agent.id))
  await db.delete(agents).where(eq(agents.id, agent.id))
  await db.delete(squads).where(eq(squads.id, squad.id))
  await db.delete(agentTypes).where(eq(agentTypes.id, `${prefix}-type`))
  await cleanupTestRbac(prefix)
})

describe('agent question chat visibility, attention, and response authority', () => {
  test('by-agent history uses agents:read, not attention routing, and filters only lifecycle status', async () => {
    const readerOpen = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=open`, {
      headers: authHeaders(agentReader.token),
    })
    expect(readerOpen.status).toBe(200)
    expect(await readerOpen.json()).toEqual([expect.objectContaining({ id: questionId, status: 'open' })])

    const directChat = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=open`, {
      headers: authHeaders(direct.token),
    })
    expect(directChat.status).toBe(403)

    const outsiderChat = await app.request(`/api/agent-questions/by-agent/${agent.id}`, {
      headers: authHeaders(outsider.token),
    })
    expect(outsiderChat.status).toBe(403)

    await db
      .update(agentQuestions)
      .set({ status: 'answered', answer: 'done', answeredAt: new Date() })
      .where(eq(agentQuestions.id, questionId))

    const openAfterAnswer = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=open`, {
      headers: authHeaders(agentReader.token),
    })
    expect(await openAfterAnswer.json()).toEqual([])

    const answered = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=answered`, {
      headers: authHeaders(agentReader.token),
    })
    expect(await answered.json()).toEqual([expect.objectContaining({ id: questionId, status: 'answered' })])
  })

  test('attention routing stays independent from chat visibility', async () => {
    const directResponse = await app.request('/api/actions/pending', { headers: authHeaders(direct.token) })
    expect(directResponse.status).toBe(200)
    const directActions = (await directResponse.json()) as Array<{
      id: string
      createdAt: string
      canRespond: boolean
    }>
    expect(directActions).toContainEqual(
      expect.objectContaining({
        id: `agent-question:${questionId}`,
        createdAt: expect.any(String),
        canRespond: false,
      })
    )

    const readerIsRouted = async () => {
      const response = await app.request('/api/actions/pending', { headers: authHeaders(agentReader.token) })
      expect(response.status).toBe(200)
      const actions = (await response.json()) as Array<{ id: string }>
      return actions.some((action) => action.id === `agent-question:${questionId}`)
    }

    // `actions:read` alone routes the reader: with no attention row the default is `show`.
    expect(await readerIsRouted()).toBe(true)

    // Muting the squad's decisions takes the question out of their Action Center...
    await subscribeToSquad(squad.id, agentReader.id, { decisions: 'mute', progress: 'mute' })
    expect(await readerIsRouted()).toBe(false)

    // ...while they still see that same question through the by-agent chat route (Task 1): chat
    // visibility and attention routing are genuinely independent in both directions.
    const readerChat = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=open`, {
      headers: authHeaders(agentReader.token),
    })
    expect(readerChat.status).toBe(200)
    expect(await readerChat.json()).toEqual([expect.objectContaining({ id: questionId, status: 'open' })])

    const outsiderResponse = await app.request('/api/actions/pending', { headers: authHeaders(outsider.token) })
    expect(outsiderResponse.status).toBe(200)
    const outsiderActions = (await outsiderResponse.json()) as Array<{ id: string }>
    expect(outsiderActions.some((action) => action.id === `agent-question:${questionId}`)).toBe(false)
  })

  test('a resource-authorized user dismisses an open question and state converges across feeds', async () => {
    const runRole = await createTestRole({
      prefix: `${prefix}-dismiss-run-${crypto.randomUUID()}`,
      permissions: ['agents:run', 'agents:read'],
    })
    await assignRole({ userId: direct.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })

    const response = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: { ...authHeaders(direct.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'stale' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'dismissed',
      dismissalReason: 'user-dismissed: stale',
      dismissedByUserId: direct.id,
      dismissedByAgentId: null,
    })

    const pending = await app.request('/api/actions/pending', { headers: authHeaders(direct.token) })
    const actions = (await pending.json()) as Array<{ id: string }>
    expect(actions.some((action) => action.id === `agent-question:${questionId}`)).toBe(false)

    const openFeed = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=open`, {
      headers: authHeaders(direct.token),
    })
    expect(openFeed.status).toBe(200)
    const openQuestions = (await openFeed.json()) as Array<{ id: string }>
    expect(openQuestions.some((question) => question.id === questionId)).toBe(false)

    const history = await app.request(`/api/agent-questions/by-agent/${agent.id}?status=answered`, {
      headers: authHeaders(direct.token),
    })
    expect(await history.json()).toContainEqual(expect.objectContaining({ id: questionId, status: 'dismissed' }))

    const duplicate = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: authHeaders(direct.token),
    })
    expect(duplicate.status).toBe(409)

    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectId, direct.id), eq(roleAssignments.roleId, runRole.id)))
    invalidatePermissionCache()
  })

  test('dismissal rejects stored ownership without resource permission and non-open or missing questions', async () => {
    await db.update(agents).set({ ownerUserId: direct.id }).where(eq(agents.id, agent.id))
    const forbidden = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: authHeaders(direct.token),
    })
    expect(forbidden.status).toBe(403)

    const runner = await createTestUser({ prefix: `${prefix}-dismiss-conflict-${crypto.randomUUID()}` })
    const runRole = await createTestRole({
      prefix: `${prefix}-dismiss-conflict-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: runner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    await db
      .update(agentQuestions)
      .set({ status: 'answered', answer: 'done', answeredAt: new Date() })
      .where(eq(agentQuestions.id, questionId))

    const conflict = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: authHeaders(runner.token),
    })
    expect(conflict.status).toBe(409)

    const missing = await app.request('/api/agent-questions/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: authHeaders(runner.token),
    })
    expect(missing.status).toBe(404)
  })

  test('dismissal authorization and expected scope use the same snapshot across an A-B-A move', async () => {
    const authorizedSquad = await Squad.create({ name: `${prefix}-aba`, purpose: 'temporary authorized scope' })
    const runner = await createTestUser({ prefix: `${prefix}-dismiss-aba-${crypto.randomUUID()}` })
    const runRole = await createTestRole({
      prefix: `${prefix}-dismiss-aba-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: runner.id, roleId: runRole.id, scope: 'squad', squadId: authorizedSquad.id })
    const originalFind = Agent.find
    const originalHasAgentResourcePermission = rbacModule.hasAgentResourcePermission
    const originalCanAnswerAgentQuestion = questionAuthorizationModule.canAnswerAgentQuestion
    const authorizationSpy = spyOn(questionAuthorizationModule, 'canAnswerAgentQuestion').mockImplementation(
      originalCanAnswerAgentQuestion
    )
    const findSpy = spyOn(Agent, 'find').mockImplementation(async (id) => {
      const snapshot = await originalFind(id)
      if (id === agent.id && snapshot) {
        await db.update(agents).set({ squadId: authorizedSquad.id }).where(eq(agents.id, agent.id))
      }
      return snapshot
    })
    const permissionSpy = spyOn(rbacModule, 'hasAgentResourcePermission').mockImplementation(
      async (identity, target, permission) => {
        const allowed = await originalHasAgentResourcePermission(identity, target, permission)
        await db.update(agents).set({ squadId: squad.id }).where(eq(agents.id, agent.id))
        return allowed
      }
    )

    try {
      const response = await app.request(`/api/agent-questions/${questionId}`, {
        method: 'DELETE',
        headers: authHeaders(runner.token),
      })
      expect(response.status).toBe(403)
      expect((await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId)))[0]?.status).toBe('open')
      expect(authorizationSpy).toHaveBeenCalledTimes(1)
      expect(authorizationSpy.mock.calls[0]?.[1]).toMatchObject({ agentId: agent.id })
      expect(authorizationSpy.mock.calls[0]?.[2]).toMatchObject({
        allowTerminatedAgent: true,
        target: { id: agent.id, squadId: squad.id },
      })
    } finally {
      authorizationSpy.mockRestore()
      findSpy.mockRestore()
      permissionSpy.mockRestore()
      await db.update(agents).set({ squadId: squad.id }).where(eq(agents.id, agent.id))
      await db.delete(squads).where(eq(squads.id, authorizedSquad.id))
      invalidatePermissionCache()
    }
  })

  test('a resource-authorized user can dismiss after the asking agent terminates', async () => {
    const runner = await createTestUser({ prefix: `${prefix}-dismiss-terminated-${crypto.randomUUID()}` })
    const runRole = await createTestRole({
      prefix: `${prefix}-dismiss-terminated-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: runner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))

    const response = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: authHeaders(runner.token),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'dismissed', dismissedByUserId: runner.id })
  })

  test('an agent identity with agents:run on the asking agent squad can dismiss', async () => {
    const owner = await createTestUser({ prefix: `${prefix}-agent-identity-owner-${crypto.randomUUID()}` })
    const runRole = await createTestRole({
      prefix: `${prefix}-agent-identity-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: owner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    const dismissing = await Agent.create({ agentTypeId: `${prefix}-type`, squadId: squad.id, ownerUserId: owner.id })
    const token = await createTestAgentToken({ agentId: dismissing.id, squadId: squad.id, userId: owner.id })

    const response = await app.request(`/api/agent-questions/${questionId}`, {
      method: 'DELETE',
      headers: authHeaders(token.token),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'dismissed',
      dismissedByAgentId: dismissing.id,
      dismissedByUserId: null,
    })

    await db.delete(agents).where(eq(agents.id, dismissing.id))
  })

  test('surfaces and generation-safely retries a failed answer delivery', async () => {
    const runRole = await createTestRole({
      prefix: `${prefix}-delivery-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: direct.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    await db
      .update(agentQuestions)
      .set({
        status: 'answered',
        answer: 'accepted answer',
        answeredByUserId: direct.id,
        answeredAt: new Date(),
        answerDeliveryStatus: 'failed',
        answerDeliveryGeneration: 1,
        answerDeliveryAttemptCount: 5,
        answerDeliveryLastError: 'delivery exhausted',
      })
      .where(eq(agentQuestions.id, questionId))

    const pending = await app.request('/api/actions/pending', { headers: authHeaders(direct.token) })
    expect(pending.status).toBe(200)
    expect(await pending.json()).toContainEqual(
      expect.objectContaining({
        id: `agent-question:${questionId}`,
        type: 'agent-question',
        canRespond: true,
        data: expect.objectContaining({
          questionId,
          answerDelivery: expect.objectContaining({ status: 'failed', canRetry: true }),
        }),
      })
    )

    const retried = await app.request(`/api/agent-questions/${questionId}/retry-delivery`, {
      method: 'POST',
      headers: authHeaders(direct.token),
    })
    expect(retried.status).toBe(200)
    expect((await retried.json()).answerDelivery).toMatchObject({ status: 'pending', generation: 2 })

    const duplicate = await app.request(`/api/agent-questions/${questionId}/retry-delivery`, {
      method: 'POST',
      headers: authHeaders(direct.token),
    })
    expect(duplicate.status).toBe(409)
    await db
      .delete(roleAssignments)
      .where(and(eq(roleAssignments.subjectId, direct.id), eq(roleAssignments.roleId, runRole.id)))
    // Raw revoke bypasses the route, which is what clears the user-permission
    // cache in production — mirror it so the next test sees the revocation.
    invalidatePermissionCache()
  })

  test('acknowledges only the acting user and failed generation without changing history or retries', async () => {
    await subscribeToSquad(squad.id, agentReader.id, { decisions: 'show', progress: 'show' })
    await db
      .update(agentQuestions)
      .set({
        status: 'answered',
        answer: 'accepted answer',
        answeredByUserId: direct.id,
        answeredAt: new Date(),
        answerDeliveryStatus: 'failed',
        answerDeliveryGeneration: 1,
      })
      .where(eq(agentQuestions.id, questionId))
    const url = `/api/agent-questions/${questionId}/dismiss-delivery-failure`
    const pendingFor = async (token: string) =>
      (await (
        await app.request('/api/actions/pending', {
          headers: authHeaders(token),
        })
      ).json()) as Array<{ id: string }>
    expect((await pendingFor(direct.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(true)
    expect((await pendingFor(agentReader.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(true)
    const dismiss = (token: string, generation = 1) =>
      app.request(url, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ generation }),
      })
    expect((await dismiss(outsider.token)).status).toBe(403)
    expect((await dismiss(direct.token)).status).toBe(200)
    expect((await dismiss(direct.token)).status).toBe(200)
    expect((await pendingFor(direct.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(false)
    expect((await pendingFor(agentReader.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(true)
    let [row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(row).toMatchObject({
      status: 'answered',
      answer: 'accepted answer',
      answerDeliveryStatus: 'failed',
      answerDeliveryGeneration: 1,
    })
    expect(row.dismissedAt).toBeNull()
    await db
      .update(agentQuestions)
      .set({ answerDeliveryStatus: 'pending', answerDeliveryGeneration: 2 })
      .where(eq(agentQuestions.id, questionId))
    await db.update(agentQuestions).set({ answerDeliveryStatus: 'failed' }).where(eq(agentQuestions.id, questionId))
    expect((await dismiss(direct.token, 1)).status).toBe(409)
    expect((await pendingFor(direct.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(true)
    expect((await dismiss(direct.token, 2)).status).toBe(200)
    expect((await pendingFor(direct.token)).some((a) => a.id === `agent-question:${questionId}`)).toBe(false)
    ;[row] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(row.answerDeliveryStatus).toBe('failed')
  })

  test('answer authority needs current agents:run, not ownership metadata or chat visibility', async () => {
    const answerAs = async (user: TestUser, answer: string) =>
      app.request(`/api/agent-questions/${questionId}/answer`, {
        method: 'POST',
        headers: { ...authHeaders(user.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })

    // Chat read access alone never grants response authority.
    const readerAnswer = await answerAs(agentReader, 'readers cannot answer')
    expect(readerAnswer.status).toBe(403)

    // The direct attention recipient becomes the squad-bound agent's stored owner without
    // current-squad agents:run: ownership metadata must not bypass squad RBAC for answers.
    await db.update(agents).set({ ownerUserId: direct.id }).where(eq(agents.id, agent.id))
    const ownerAnswer = await answerAs(direct, 'owner shortcut must fail')
    expect(ownerAnswer.status).toBe(403)
    const ownerActions = (await (
      await app.request('/api/actions/pending', { headers: authHeaders(direct.token) })
    ).json()) as Array<{ id: string; canRespond: boolean }>
    expect(ownerActions.find(({ id }) => id === `agent-question:${questionId}`)?.canRespond).toBe(false)
    await db.update(agents).set({ ownerUserId: null }).where(eq(agents.id, agent.id))

    // A separate user with current-squad agents:run is accepted even though it is neither a
    // direct attention recipient nor a watcher; blank answers and late answers stay truthful.
    const runner = await createTestUser({ prefix: `${prefix}-runner-${crypto.randomUUID()}` })
    const runRole = await createTestRole({
      prefix: `${prefix}-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: runner.id, roleId: runRole.id, scope: 'squad', squadId: squad.id })
    const blank = await answerAs(runner, '  ')
    expect(blank.status).toBe(400)

    const accepted = await answerAs(runner, 'yes')
    expect(accepted.status).toBe(200)

    const conflict = await answerAs(runner, 'again')
    expect(conflict.status).toBe(409)
  })

  test('blocking conversion authority matches answer authority, not stored ownership', async () => {
    const convertAs = (token: string, targetQuestionId: string, blocking: boolean) =>
      app.request(`/api/agent-questions/${targetQuestionId}/blocking`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocking }),
      })

    // Regression: a squad-bound agent's stored owner without agents:run in that squad must
    // NOT be able to convert blocking (the legacy owner shortcut).
    await db.update(agents).set({ ownerUserId: outsider.id }).where(eq(agents.id, agent.id))
    expect((await convertAs(outsider.token, questionId, true)).status).toBe(403)
    expect((await convertAs(outsider.token, questionId, false)).status).toBe(403)

    // The same user authorized with current-squad agents:run may convert both ways.
    const blockingRunRole = await createTestRole({
      prefix: `${prefix}-blocking-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: outsider.id, roleId: blockingRunRole.id, scope: 'squad', squadId: squad.id })
    expect((await convertAs(outsider.token, questionId, true)).status).toBe(200)
    expect((await convertAs(outsider.token, questionId, false)).status).toBe(200)
    await db.update(agents).set({ ownerUserId: null }).where(eq(agents.id, agent.id))

    // A private (squadless) agent's owner still converts without any role.
    const privateOwner = await createTestUser({ prefix: `${prefix}-private-owner-${crypto.randomUUID()}` })
    const personalAgent = await Agent.create({ agentTypeId: `${prefix}-type`, ownerUserId: privateOwner.id })
    const [personalQuestion] = await db
      .insert(agentQuestions)
      .values({
        agentId: personalAgent.id,
        questionData: { questions: [{ id: 'q-private', type: 'text', question: 'Private?' }] },
      })
      .returning()
    expect((await convertAs(privateOwner.token, personalQuestion.id, true)).status).toBe(200)

    // Canonical edge now consistent with answer authority: an orphan (squadless, ownerless)
    // agent is convertible by a system-scoped agents:run identity (the old formula 403'd).
    const orphanAdmin = await createTestUser({ prefix: `${prefix}-orphan-admin-${crypto.randomUUID()}` })
    const globalRunRole = await createTestRole({
      prefix: `${prefix}-global-run-${crypto.randomUUID()}`,
      permissions: ['agents:run'],
    })
    await assignRole({ userId: orphanAdmin.id, roleId: globalRunRole.id, scope: 'system' })
    const orphanAgent = await Agent.create({ agentTypeId: `${prefix}-type` })
    const [orphanQuestion] = await db
      .insert(agentQuestions)
      .values({
        agentId: orphanAgent.id,
        questionData: { questions: [{ id: 'q-orphan', type: 'text', question: 'Orphan?' }] },
      })
      .returning()
    expect((await convertAs(orphanAdmin.token, orphanQuestion.id, true)).status).toBe(200)

    // An agent identity that holds squad agents:run stays allowed — the hasPermission squad
    // path is unchanged by this fix. Agent-type roles resolve straight from the roles table,
    // so seed the manager type's role deterministically for this assertion and restore it.
    const [managerRoleRow] = await db.select().from(roles).where(eq(roles.slug, 'default-manager'))
    if (managerRoleRow) {
      await db
        .update(roles)
        .set({ permissions: ['agents:run'] })
        .where(eq(roles.slug, 'default-manager'))
    } else {
      await db
        .insert(roles)
        .values({ slug: 'default-manager', name: 'Squad Manager', isSystem: true, permissions: ['agents:run'] })
    }
    const managerAgent = await Agent.create({ agentTypeId: 'manager', squadId: squad.id })
    const managerToken = (await createTestAgentToken({ agentId: managerAgent.id, squadId: squad.id })).token
    try {
      expect((await convertAs(managerToken, questionId, true)).status).toBe(200)
    } finally {
      if (managerRoleRow) {
        await db.update(roles).set({ permissions: managerRoleRow.permissions }).where(eq(roles.slug, 'default-manager'))
      } else {
        await db.delete(roles).where(eq(roles.slug, 'default-manager'))
      }
    }

    await db.delete(agents).where(inArray(agents.id, [personalAgent.id, orphanAgent.id, managerAgent.id]))
  })
})
