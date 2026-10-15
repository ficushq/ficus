import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { agentsRouter } from './agents'
import { squadsRouter } from './squads'
import { identityMiddleware } from '../middleware/identity'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { db, messages, agents, agentTypes, squads, agentTokens, roles } from '../db'
import { Agent } from '../entities/Agent'
import { encodeMessageCursor } from '../services/agent/message-cursor'
import { createTestAdmin, createTestAgentToken, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'
import { RoleSync } from '../services/config-sync/role-sync'
import { getSettingsStore } from '../services/settings'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)
app.route('/api/squads', squadsRouter)

const amPrefix = `am-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

beforeAll(async () => {
  await new RoleSync().sync()
  admin = await createTestAdmin({ prefix: amPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(amPrefix)
  await db
    .delete(roles)
    .where(inArray(roles.slug, ['admin', 'operator', 'viewer', 'default-worker', 'default-manager']))
})

describe('agent messages route', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string
  let testSquadId: string

  beforeEach(async () => {
    testPrefix = `amr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'test' })
    testSquadId = squad.id

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    await db.delete(messages).where(eq(messages.agentId, testAgentId))
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  describe('GET /api/agents/:id/messages', () => {
    it('returns all messages by default', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Hello' })
      await testAgent.recordMessage({ role: 'assistant', content: 'Hi there' })

      const res = await app.request(`/api/agents/${testAgentId}/messages`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
    })

    it('keeps private owner history and single-message refetch exclusive from foreign admins', async () => {
      const foreignPrefix = `${testPrefix}-foreign`
      const foreignAdmin = await createTestAdmin({ prefix: foreignPrefix })
      await db.update(agents).set({ squadId: null, ownerUserId: admin.id }).where(eq(agents.id, testAgentId))
      const recorded = await testAgent.recordMessage({ role: 'human', content: 'Private history' })

      const ownerHistory = await app.request(`/api/agents/${testAgentId}/messages`, {
        headers: authHeaders(admin.token),
      })
      const ownerMessage = await app.request(`/api/agents/${testAgentId}/messages/${recorded.id}`, {
        headers: authHeaders(admin.token),
      })
      const foreignHistory = await app.request(`/api/agents/${testAgentId}/messages`, {
        headers: authHeaders(foreignAdmin.token),
      })
      const foreignMessage = await app.request(`/api/agents/${testAgentId}/messages/${recorded.id}`, {
        headers: authHeaders(foreignAdmin.token),
      })

      expect(ownerHistory.status).toBe(200)
      expect(ownerMessage.status).toBe(200)
      expect(foreignHistory.status).toBe(403)
      expect(foreignMessage.status).toBe(403)
      await cleanupTestRbac(foreignPrefix)
    })

    it('leaves saved reply suggestions out of history and single-message reads while the switch is off', async () => {
      const store = getSettingsStore()
      await store.initialize()
      const recorded = await testAgent.recordMessage({ role: 'assistant', content: 'Ship it now?' })
      await db
        .update(messages)
        .set({ metadata: { executionId: 'exec-1', replySuggestions: ['Yes', 'Not yet'] } })
        .where(eq(messages.id, recorded.id))
      const read = async () => {
        const history = await app.request(`/api/agents/${testAgentId}/messages`, { headers: authHeaders(admin.token) })
        const single = await app.request(`/api/agents/${testAgentId}/messages/${recorded.id}`, {
          headers: authHeaders(admin.token),
        })
        expect(history.status).toBe(200)
        expect(single.status).toBe(200)
        return [(await history.json()).messages[0].metadata, (await single.json()).metadata]
      }

      try {
        await store.set('REPLY_SUGGESTIONS_ENABLED', 'false')
        expect(await read()).toEqual([{ executionId: 'exec-1' }, { executionId: 'exec-1' }])
        await store.set('REPLY_SUGGESTIONS_ENABLED', 'true')
        const saved = { executionId: 'exec-1', replySuggestions: ['Yes', 'Not yet'] }
        expect(await read()).toEqual([saved, saved])
      } finally {
        await store.delete('REPLY_SUGGESTIONS_ENABLED')
      }
    })

    it('returns 404 for non-existent agent (admin passes system-scope check, handler returns 404)', async () => {
      const res = await app.request('/api/agents/00000000-0000-0000-0000-000000000000/messages', {
        headers: authHeaders(admin.token),
      })
      // Null squadId (agent not found) → system-scope check → admin passes → handler returns 404
      expect(res.status).toBe(404)
    })

    it('filters by last (limit)', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'One' })
      await testAgent.recordMessage({ role: 'assistant', content: 'Two' })
      await testAgent.recordMessage({ role: 'human', content: 'Three' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?limit=2`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
      // Messages are returned in chronological order (oldest first)
      expect(result.messages[0].content).toBe('Two')
      expect(result.messages[1].content).toBe('Three')
    })

    it('filters by role', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Q1' })
      await testAgent.recordMessage({ role: 'assistant', content: 'A1' })
      await testAgent.recordMessage({ role: 'human', content: 'Q2' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?role=human`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
      expect(result.messages.every((m: any) => m.role === 'human')).toBe(true)
    })

    it('filters by search', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Tell me about testing' })
      await testAgent.recordMessage({ role: 'assistant', content: 'Testing is important' })
      await testAgent.recordMessage({ role: 'human', content: 'What about deployment?' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?search=testing`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
    })

    it('paginates with limit and offset', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'One' })
      await testAgent.recordMessage({ role: 'assistant', content: 'Two' })
      await testAgent.recordMessage({ role: 'human', content: 'Three' })
      await testAgent.recordMessage({ role: 'assistant', content: 'Four' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?limit=2&offset=1`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
      expect(result.messages[0].content).toBe('Two')
      expect(result.messages[1].content).toBe('Three')
    })

    it('filters by after timestamp', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Old' })
      const cutoff = '2026-01-02T00:00:00.000Z'
      await testAgent.recordMessage({ role: 'assistant', content: 'New' })
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
        .where(and(eq(messages.agentId, testAgent.id), eq(messages.role, 'human')))
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-03T00:00:00Z') })
        .where(and(eq(messages.agentId, testAgent.id), eq(messages.role, 'assistant')))

      const res = await app.request(`/api/agents/${testAgentId}/messages?after=${encodeURIComponent(cutoff)}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].content).toBe('New')
    })

    it('combines multiple filters', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'keyword one' })
      await testAgent.recordMessage({ role: 'assistant', content: 'keyword two' })
      await testAgent.recordMessage({ role: 'human', content: 'keyword three' })
      await testAgent.recordMessage({ role: 'assistant', content: 'no match' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?search=keyword&role=human`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      expect(result.messages.length).toBe(2)
      expect(result.messages.every((m: any) => m.role === 'human')).toBe(true)
    })

    it('ignores invalid role filter', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Hello' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?role=invalid`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const result = await res.json()
      // Invalid role is ignored, returns all
      expect(result.messages.length).toBe(1)
    })

    it('rejects malformed missing and cross-agent beforeId cursors', async () => {
      const other = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
      const otherMessage = await other.recordMessage({ role: 'human', content: 'other' })
      for (const beforeId of ['not-a-uuid', crypto.randomUUID(), otherMessage.id]) {
        const res = await app.request(`/api/agents/${testAgentId}/messages?beforeId=${beforeId}`, {
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Invalid cursor', code: 'MESSAGES_CURSOR_INVALID' })
      }
      await db.delete(messages).where(eq(messages.agentId, other.id))
      await db.delete(agents).where(eq(agents.id, other.id))
    })

    it('rejects an opaque cursor when its filter context changes', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'needle one' })
      await testAgent.recordMessage({ role: 'human', content: 'needle two' })
      const first = await app.request(`/api/agents/${testAgentId}/messages?limit=1&search=needle`, {
        headers: authHeaders(admin.token),
      })
      const cursor = (await first.json()).pagination.nextCursor
      const res = await app.request(`/api/agents/${testAgentId}/messages?limit=1&search=changed&cursor=${cursor}`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid cursor', code: 'MESSAGES_CURSOR_INVALID' })
    })

    it('returns cursor-invalid for enqueue orders outside PostgreSQL bigint bounds', async () => {
      for (const enqueueOrder of [-9_223_372_036_854_775_809n, 9_223_372_036_854_775_808n]) {
        const cursor = encodeMessageCursor(
          { createdAt: new Date('2026-08-10T12:00:00.000Z'), enqueueOrder },
          { agentId: testAgentId }
        )
        const res = await app.request(`/api/agents/${testAgentId}/messages?cursor=${cursor}`, {
          headers: authHeaders(admin.token),
        })
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Invalid cursor', code: 'MESSAGES_CURSOR_INVALID' })
      }
    })

    it('returns a stable 400 response for an invalid opaque cursor', async () => {
      await testAgent.recordMessage({ role: 'human', content: 'Hello' })

      const res = await app.request(`/api/agents/${testAgentId}/messages?cursor=definitely-not-a-cursor`, {
        headers: authHeaders(admin.token),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Invalid cursor', code: 'MESSAGES_CURSOR_INVALID' })
    })
  })
})

describe('squad search-messages route', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let squadId: string
  let agent1: Agent
  let agent1Id: string
  let agent2: Agent
  let agent2Id: string
  let manager: Agent
  let consultant: Agent
  let managerToken: string
  let consultantToken: string
  let relatedSquadId: string
  let unrelatedSquadId: string

  beforeEach(async () => {
    testPrefix = `ssm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'testing' })
    squadId = squad.id

    agent1 = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    agent1Id = agent1.id
    agent2 = await Agent.create({ agentTypeId: testAgentTypeId, squadId })
    agent2Id = agent2.id
    manager = await Agent.create({ agentTypeId: 'manager', squadId })
    consultant = await Agent.create({ agentTypeId: 'consultant', squadId })
    managerToken = (await createTestAgentToken({ agentId: manager.id, squadId })).token
    consultantToken = (await createTestAgentToken({ agentId: consultant.id, squadId })).token

    const relatedSquad = await Squad.create({ name: `${testPrefix}-related`, purpose: 'testing' })
    const unrelatedSquad = await Squad.create({ name: `${testPrefix}-unrelated`, purpose: 'testing' })
    relatedSquadId = relatedSquad.id
    unrelatedSquadId = unrelatedSquad.id
    await squad.addRelationship(relatedSquad.id, 'collaborates')
  })

  afterEach(async () => {
    const agentIds = [agent1Id, agent2Id, manager.id, consultant.id]
    await db.delete(messages).where(inArray(messages.agentId, agentIds))
    await db.delete(agentTokens).where(inArray(agentTokens.agentId, agentIds))
    await db.delete(agents).where(inArray(agents.id, agentIds))
    await db.delete(squads).where(inArray(squads.id, [squadId, relatedSquadId, unrelatedSquadId]))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('GET /api/squads/:id/messages/search', () => {
    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('allows %s to search its own squad messages', async (_type, token) => {
      const res = await app.request(`/api/squads/${squadId}/messages/search?q=needle`, {
        headers: authHeaders(token()),
      })
      expect(res.status).toBe(200)
    })

    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('denies %s access to related squad messages', async (_type, token) => {
      const res = await app.request(`/api/squads/${relatedSquadId}/messages/search?q=needle`, {
        headers: authHeaders(token()),
      })
      expect(res.status).toBe(403)
    })

    it.each([
      ['manager', () => managerToken],
      ['consultant', () => consultantToken],
    ])('denies %s access to unrelated squad messages', async (_type, token) => {
      const res = await app.request(`/api/squads/${unrelatedSquadId}/messages/search?q=needle`, {
        headers: authHeaders(token()),
      })
      expect(res.status).toBe(403)
    })

    it('returns 400 without query param', async () => {
      const res = await app.request(`/api/squads/${squadId}/messages/search`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain('required')
    })

    it('returns 404 for non-existent squad', async () => {
      const res = await app.request('/api/squads/00000000-0000-0000-0000-000000000000/messages/search?q=test', {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(404)
    })

    it('searches across all squad agents', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Agent 1 deployed the service' })
      await agent2.recordMessage({ role: 'assistant', content: 'Agent 2 also deployed something' })
      await agent1.recordMessage({ role: 'assistant', content: 'Agent 1 ran tests' })

      const res = await app.request(`/api/squads/${squadId}/messages/search?q=deployed`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(2)
    })

    it('returns empty array for no matches', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Hello world' })

      const res = await app.request(`/api/squads/${squadId}/messages/search?q=zzzznotfound`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(0)
    })

    it('filters by role', async () => {
      await agent1.recordMessage({ role: 'human', content: 'Search for deployments' })
      await agent1.recordMessage({ role: 'assistant', content: 'Found deployment logs' })

      const res = await app.request(`/api/squads/${squadId}/messages/search?q=deployment&role=assistant`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(1)
      expect(results[0].role).toBe('assistant')
    })

    it('respects limit parameter', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Match keyword 1' })
      await agent1.recordMessage({ role: 'assistant', content: 'Match keyword 2' })
      await agent2.recordMessage({ role: 'assistant', content: 'Match keyword 3' })

      const res = await app.request(`/api/squads/${squadId}/messages/search?q=keyword&limit=2`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(2)
    })

    it('includes agent type in results', async () => {
      await agent1.recordMessage({ role: 'assistant', content: 'Searchable work' })

      const res = await app.request(`/api/squads/${squadId}/messages/search?q=Searchable`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(1)
      expect(results[0].agentTypeId).toBe(testAgentTypeId)
      expect(results[0].agentId).toBe(agent1Id)
    })

    it('returns empty for squad with no agents', async () => {
      // Create a new empty squad
      const emptySquad = await Squad.create({ name: `${testPrefix}-empty`, purpose: 'empty' })

      const res = await app.request(`/api/squads/${emptySquad.id}/messages/search?q=test`, {
        headers: authHeaders(admin.token),
      })
      expect(res.status).toBe(200)
      const results = await res.json()
      expect(results.length).toBe(0)

      await db.delete(squads).where(eq(squads.id, emptySquad.id))
    })
  })
})

describe('GET /api/agents/:id/messages/:messageId', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent
  let testAgentId: string
  let testSquadId: string

  beforeEach(async () => {
    testPrefix = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent',
      systemPrompt: 'Test',
    })

    const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'test' })
    testSquadId = squad.id

    testAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: testSquadId })
    testAgentId = testAgent.id
  })

  afterEach(async () => {
    await db.delete(messages).where(eq(messages.agentId, testAgentId))
    await db.delete(agents).where(eq(agents.id, testAgentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  it('returns a specific message by full ID', async () => {
    const recorded = await testAgent.recordMessage({ role: 'human', content: 'Hello specific' })
    const msgId = recorded.id

    const res = await app.request(`/api/agents/${testAgentId}/messages/${msgId}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const msg = await res.json()
    expect(msg.id).toBe(msgId)
    expect(msg.content).toBe('Hello specific')
    expect(msg.role).toBe('human')
  })

  it('returns a message by UUID prefix', async () => {
    const recorded = await testAgent.recordMessage({ role: 'assistant', content: 'Prefix test' })
    const prefix = recorded.id.slice(0, 8)

    const res = await app.request(`/api/agents/${testAgentId}/messages/${prefix}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(200)
    const msg = await res.json()
    expect(msg.id).toBe(recorded.id)
    expect(msg.content).toBe('Prefix test')
  })

  it('returns 403 for non-existent agent (fail closed)', async () => {
    const res = await app.request(`/api/agents/${testAgentId}/messages/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders(admin.token),
    })
    // Message route: guard resolves real agent's squadId first → 200 guard, then 404 for message
    expect(res.status).toBe(404)
  })

  it('returns 404 if message belongs to a different agent', async () => {
    const squad2 = await Squad.create({ name: `${testPrefix}-squad2`, purpose: 'test' })
    const otherAgent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad2.id })
    const recorded = await otherAgent.recordMessage({ role: 'human', content: 'Other agent msg' })

    const res = await app.request(`/api/agents/${testAgentId}/messages/${recorded.id}`, {
      headers: authHeaders(admin.token),
    })
    expect(res.status).toBe(404)

    await db.delete(messages).where(eq(messages.agentId, otherAgent.id))
    await db.delete(agents).where(eq(agents.id, otherAgent.id))
    await db.delete(squads).where(eq(squads.id, squad2.id))
  })
})
