import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agents, agentTypes, db, executions, inbox, messages, squads } from '../db'
import { Agent, AgentDormantError, setSendMessageLockedHookForTests } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { InboxMessage, setBeforeRecipientLifecycleLockHookForTest } from '../entities/InboxMessage'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { makeDormant } from '../services/agent/lifecycle'
import { authHeaders, cleanupTestRbac, createTestAdmin, createTestAgentToken, type TestUser } from '../test-utils'
import { agentsRouter } from './agents'
import { inboxRouter } from './inbox'

/**
 * Direct sends (CLI, API clients, agent tools) must not wake a dormant agent by accident: the
 * message routes refuse a dormant recipient with AGENT_DORMANT unless the caller passes wake.
 * Runtime deliveries (system-authored or internal sends) keep their existing wake policy.
 */
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)
app.route('/api/inbox', inboxRouter)

const rbacPrefix = `dormant-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
})

afterAll(async () => {
  await cleanupTestRbac(rbacPrefix)
})

describe('dormant recipient guard', () => {
  let typeId: string
  let squadId: string
  let sender: Agent
  let recipient: Agent
  let senderToken: string

  beforeEach(async () => {
    const agentWarmup = await import('../services/sandbox/agent-warmup')
    spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    typeId = `${rbacPrefix}-type-${Math.random().toString(36).slice(2, 8)}`
    await AgentType.create({
      id: typeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Guard Test',
      systemPrompt: 'Test',
    })
    squadId = (await Squad.create({ name: `${typeId}-squad`, purpose: 'test' })).id
    sender = await Agent.create({ agentTypeId: typeId, squadId, metadata: { name: 'Sender' } })
    recipient = await Agent.create({ agentTypeId: typeId, squadId, metadata: { name: 'Finished Worker' } })
    senderToken = (await createTestAgentToken({ agentId: sender.id, squadId })).token
  })

  afterEach(async () => {
    mock.restore()
    setSendMessageLockedHookForTests(undefined)
    setBeforeRecipientLifecycleLockHookForTest(undefined)
    const ids = [sender.id, recipient.id]
    await db.delete(messages).where(inArray(messages.agentId, ids))
    await db.delete(executions).where(inArray(executions.agentId, ids))
    await db.delete(inbox).where(inArray(inbox.recipientId, ids))
    await db.delete(agents).where(inArray(agents.id, ids))
    await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  const post = (path: string, token: string, body: Record<string, unknown>) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify(body),
    })

  const inboxRows = () => db.select().from(inbox).where(eq(inbox.recipientId, recipient.id))
  const status = async () => (await Agent.mustFind(recipient.id)).status

  async function expectRefused(response: Response) {
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('AGENT_DORMANT')
    expect(body.error).toContain(`Agent ${recipient.id.slice(0, 8)} is dormant`)
    expect(body.error).toContain('wake')
    // The error names only the id the caller supplied.
    expect(body.error).not.toContain('Finished Worker')
    expect(await status()).toBe('dormant')
    expect(await db.select().from(executions).where(eq(executions.agentId, recipient.id))).toHaveLength(0)
    expect(await db.select().from(messages).where(eq(messages.agentId, recipient.id))).toHaveLength(0)
  }

  describe('POST /api/inbox', () => {
    it('refuses an agent sender without wake and persists nothing', async () => {
      await makeDormant(recipient)
      await expectRefused(
        await post('/api/inbox', senderToken, { recipientType: 'agent', recipientId: recipient.id, content: 'merged' })
      )
      expect(await inboxRows()).toHaveLength(0)
    })

    it('refuses a human sender without wake', async () => {
      await makeDormant(recipient)
      await expectRefused(
        await post('/api/inbox', admin.token, { recipientType: 'agent', recipientId: recipient.id, content: 'hello' })
      )
      expect(await inboxRows()).toHaveLength(0)
    })

    it('sends and wakes the agent with wake: true', async () => {
      await makeDormant(recipient)
      const response = await post('/api/inbox', senderToken, {
        recipientType: 'agent',
        recipientId: recipient.id,
        content: 'more work',
        wake: true,
      })
      expect(response.status).toBe(201)
      expect(await inboxRows()).toHaveLength(1)
      expect(await status()).toBe('idle')
      expect(await db.select().from(executions).where(eq(executions.agentId, recipient.id))).toHaveLength(1)
    })

    it('keeps system-authored sends on their own wake policy', async () => {
      await makeDormant(recipient)
      const response = await post('/api/inbox', admin.token, {
        recipientType: 'agent',
        recipientId: recipient.id,
        content: 'automation notice',
        asSystem: true,
      })
      expect(response.status).toBe(201)
      const [row] = await inboxRows()
      expect(row?.metadata).toMatchObject({ wakeEligible: false })
      expect(row?.deliveredAt).toBeNull()
      expect(await status()).toBe('dormant')
    })

    it('leaves sends to a live agent unchanged', async () => {
      const response = await post('/api/inbox', senderToken, {
        recipientType: 'agent',
        recipientId: recipient.id,
        content: 'still working?',
      })
      expect(response.status).toBe(201)
      expect(await inboxRows()).toHaveLength(1)
      expect(await db.select().from(executions).where(eq(executions.agentId, recipient.id))).toHaveLength(1)
    })

    it('ignores a forged metadata.wakeEligible from the client', async () => {
      await makeDormant(recipient)
      await expectRefused(
        await post('/api/inbox', senderToken, {
          recipientType: 'agent',
          recipientId: recipient.id,
          content: 'sneaky',
          metadata: { wakeEligible: true },
        })
      )
    })

    it('refuses under the recipient lock when the agent goes dormant after the request started', async () => {
      // The route resolved a live recipient; dormancy lands before the locked insert.
      setBeforeRecipientLifecycleLockHookForTest(async () => {
        setBeforeRecipientLifecycleLockHookForTest(undefined)
        await makeDormant(recipient)
      })
      await expectRefused(
        await post('/api/inbox', senderToken, { recipientType: 'agent', recipientId: recipient.id, content: 'late' })
      )
      expect(await inboxRows()).toHaveLength(0)
    })
  })

  describe('internal runtime deliveries', () => {
    it('still wake a dormant agent through InboxMessage.send (no refusal requested)', async () => {
      await makeDormant(recipient)
      await InboxMessage.send({
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'system',
        content: 'flow handoff',
        wakeEligible: true,
      })
      expect(await status()).toBe('idle')
    })

    it('still wake a dormant agent through Agent.sendMessage (no refusal requested)', async () => {
      await makeDormant(recipient)
      await (await Agent.mustFind(recipient.id)).sendMessage('question answer')
      expect(await status()).toBe('idle')
    })

    it('Agent.sendMessage refuses under its row lock when dormancy wins the race', async () => {
      // Live when the send begins; dormant by the time the locked status read runs.
      setSendMessageLockedHookForTests(async (tx, agentId) => {
        await tx.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agentId))
      })
      const live = await Agent.mustFind(recipient.id)
      await expect(live.sendMessage('late', { refuseIfDormant: true })).rejects.toBeInstanceOf(AgentDormantError)
      expect(await db.select().from(messages).where(eq(messages.agentId, recipient.id))).toHaveLength(0)
    })
  })

  for (const route of ['message', 'steer', 'follow-up'] as const) {
    describe(`POST /api/agents/:id/${route}`, () => {
      const body = (extra: Record<string, unknown> = {}) =>
        route === 'message' ? { content: 'hello', ...extra } : { message: 'hello', ...extra }

      it('refuses a dormant agent without wake', async () => {
        await makeDormant(recipient)
        await expectRefused(await post(`/api/agents/${recipient.id}/${route}`, admin.token, body()))
      })

      it('sends and wakes the agent with wake: true', async () => {
        await makeDormant(recipient)
        const response = await post(`/api/agents/${recipient.id}/${route}`, admin.token, body({ wake: true }))
        expect(response.status).toBe(200)
        expect(await status()).toBe('idle')
        expect(await db.select().from(executions).where(eq(executions.agentId, recipient.id))).toHaveLength(1)
      })

      it('leaves sends to a live agent unchanged', async () => {
        const response = await post(`/api/agents/${recipient.id}/${route}`, admin.token, body())
        expect(response.status).toBe(200)
        expect(await db.select().from(executions).where(eq(executions.agentId, recipient.id))).toHaveLength(1)
      })
    })
  }
})
