import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { MessageSearchResponse } from '@ficus/shared'
import { agentsRouter } from './agents'
import { identityMiddleware } from '../middleware/identity'
import { AgentType } from '../entities/AgentType'
import { Squad } from '../entities/Squad'
import { Agent } from '../entities/Agent'
import { agentTypes, agents, db, messages, squads } from '../db'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agents', agentsRouter)

const prefix = `msg-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const agentTypeId = `${prefix}-type`
let admin: TestUser
let squad: Squad
let otherSquad: Squad
let squadAgent: Agent
let otherAgent: Agent
const createdAgentIds: string[] = []

async function search(agentId: string, token: string, params: Record<string, string>) {
  const query = new URLSearchParams(params).toString()
  return app.request(`/api/agents/${agentId}/messages/search?${query}`, { headers: authHeaders(token) })
}

async function createAgent(input: Parameters<typeof Agent.create>[0]) {
  const agent = await Agent.create(input)
  createdAgentIds.push(agent.id)
  return agent
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  await AgentType.create({ id: agentTypeId, model: 'anthropic:claude-sonnet-4-5', name: 'Search', systemPrompt: 'T' })
  squad = await Squad.create({ name: `${prefix}-squad`, purpose: 'test' })
  otherSquad = await Squad.create({ name: `${prefix}-other`, purpose: 'test' })
  squadAgent = await createAgent({ agentTypeId, squadId: squad.id })
  otherAgent = await createAgent({ agentTypeId, squadId: squad.id })

  await squadAgent.recordMessage({
    role: 'human',
    content: 'Please check the Deploy pipeline',
    metadata: { sender: { userId: admin.id, name: 'Admin' } },
  })
  await squadAgent.recordMessage({
    role: 'assistant',
    content: 'The deploy pipeline is green.',
    // Tool output and thinking live in metadata and are not searched.
    metadata: { content: [{ type: 'text', id: 'b1', text: 'hidden toolword' }] as never },
  })
  await squadAgent.recordMessage({ role: 'human', content: '100% done_now', metadata: { source: 'inbox' } })
  await squadAgent.recordMessage({ role: 'assistant', content: 'Unrelated reply' })
  await otherAgent.recordMessage({ role: 'human', content: 'deploy from another conversation' })
})

afterAll(async () => {
  await db.delete(messages).where(inArray(messages.agentId, createdAgentIds))
  await db.delete(agents).where(inArray(agents.id, createdAgentIds))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  await db.delete(squads).where(inArray(squads.id, [squad.id, otherSquad.id]))
  await cleanupTestRbac(prefix)
})

describe('GET /api/agents/:id/messages/search', () => {
  it('finds case-insensitive matches in this conversation only, newest first, with snippet and position', async () => {
    const res = await search(squadAgent.id, admin.token, { q: 'DEPLOY' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MessageSearchResponse
    expect(body.nextCursor).toBeNull()
    expect(body.results.map((r) => r.snippet.text)).toEqual([
      'The deploy pipeline is green.',
      'Please check the Deploy pipeline',
    ])
    const [reply, ask] = body.results
    expect(reply.role).toBe('assistant')
    expect(reply.newerCount).toBe(2)
    expect(reply.snippet.highlights).toEqual([[4, 10]])
    expect(ask.role).toBe('human')
    expect(ask.sender).toEqual({ userId: admin.id, name: 'Admin' })
    expect(ask.newerCount).toBe(3)
    expect(typeof ask.createdAt).toBe('string')
  })

  it('does not search tool output or thinking stored in metadata', async () => {
    const res = await search(squadAgent.id, admin.token, { q: 'toolword' })
    expect(((await res.json()) as MessageSearchResponse).results).toEqual([])
  })

  it('treats LIKE wildcards in the query literally', async () => {
    const percent = (await (await search(squadAgent.id, admin.token, { q: '100%' })).json()) as MessageSearchResponse
    expect(percent.results.map((r) => r.snippet.text)).toEqual(['100% done_now'])
    expect(percent.results[0].source).toBe('inbox')
    const underscore = (await (await search(squadAgent.id, admin.token, { q: 'e_n' })).json()) as MessageSearchResponse
    expect(underscore.results).toHaveLength(1)
    const wildcard = (await (await search(squadAgent.id, admin.token, { q: '%' })).json()) as MessageSearchResponse
    expect(wildcard.results).toHaveLength(1)
  })

  it('paginates with an opaque cursor bound to the conversation and query', async () => {
    const first = (await (
      await search(squadAgent.id, admin.token, { q: 'e', limit: '2' })
    ).json()) as MessageSearchResponse
    expect(first.results).toHaveLength(2)
    expect(first.nextCursor).toBeString()
    const second = (await (
      await search(squadAgent.id, admin.token, { q: 'e', limit: '2', cursor: first.nextCursor! })
    ).json()) as MessageSearchResponse
    expect(second.results).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.results, ...second.results].map((r) => r.id)
    expect(new Set(ids).size).toBe(4)
    expect([...first.results, ...second.results].map((r) => r.newerCount)).toEqual([0, 1, 2, 3])

    const otherQuery = await search(squadAgent.id, admin.token, { q: 'deploy', cursor: first.nextCursor! })
    expect(otherQuery.status).toBe(400)
    expect(((await otherQuery.json()) as { code: string }).code).toBe('MESSAGES_CURSOR_INVALID')
    const otherConversation = await search(otherAgent.id, admin.token, { q: 'e', cursor: first.nextCursor! })
    expect(otherConversation.status).toBe(400)
  })

  it('bounds the query length, page size and cursor', async () => {
    expect((await search(squadAgent.id, admin.token, { q: '' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: '   ' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'x'.repeat(201) })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'x'.repeat(200) })).status).toBe(200)
    expect((await search(squadAgent.id, admin.token, { q: 'e', limit: '51' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'e', limit: '0' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'e', cursor: 'not a cursor' })).status).toBe(400)
  })

  it('returns 404 for a missing agent the caller may otherwise read', async () => {
    expect((await search(crypto.randomUUID(), admin.token, { q: 'e' })).status).toBe(404)
  })

  describe('authorization matches reading the conversation', () => {
    it('allows a squad role with agents:read and denies roles without it or in another squad', async () => {
      const reader = await createTestUser({ prefix })
      const readerRole = await createTestRole({ prefix, permissions: ['agents:read'] })
      await assignRole({ userId: reader.id, roleId: readerRole.id, scope: 'squad', squadId: squad.id })

      const noAgentRead = await createTestUser({ prefix })
      const squadsOnlyRole = await createTestRole({ prefix, permissions: ['squads:read', 'chat:read'] })
      await assignRole({ userId: noAgentRead.id, roleId: squadsOnlyRole.id, scope: 'squad', squadId: squad.id })

      const otherSquadReader = await createTestUser({ prefix })
      await assignRole({ userId: otherSquadReader.id, roleId: readerRole.id, scope: 'squad', squadId: otherSquad.id })

      const noRoles = await createTestUser({ prefix })

      for (const user of [reader, noAgentRead, otherSquadReader, noRoles]) {
        const list = await app.request(`/api/agents/${squadAgent.id}/messages`, { headers: authHeaders(user.token) })
        const found = await search(squadAgent.id, user.token, { q: 'deploy' })
        expect(found.status).toBe(list.status)
      }
      expect((await search(squadAgent.id, reader.token, { q: 'deploy' })).status).toBe(200)
      expect((await search(squadAgent.id, noAgentRead.token, { q: 'deploy' })).status).toBe(403)
      expect((await search(squadAgent.id, otherSquadReader.token, { q: 'deploy' })).status).toBe(403)
      expect((await search(squadAgent.id, noRoles.token, { q: 'deploy' })).status).toBe(403)
    })

    it('keeps a private owned agent searchable only by its owner, even against other admins', async () => {
      const owner = await createTestUser({ prefix })
      const privateAgent = await createAgent({ agentTypeId, ownerUserId: owner.id })
      await privateAgent.recordMessage({ role: 'human', content: 'private secret plan' })
      const foreignAdmin = await createTestAdmin({ prefix: `${prefix}-foreign` })

      const own = await search(privateAgent.id, owner.token, { q: 'secret' })
      expect(own.status).toBe(200)
      expect(((await own.json()) as MessageSearchResponse).results).toHaveLength(1)
      expect((await search(privateAgent.id, foreignAdmin.token, { q: 'secret' })).status).toBe(403)
      expect((await search(privateAgent.id, admin.token, { q: 'secret' })).status).toBe(403)
      await cleanupTestRbac(`${prefix}-foreign`)
    })

    it('keeps an Assistant conversation searchable only by its owner', async () => {
      const owner = await createTestUser({ prefix })
      const other = await createTestUser({ prefix })
      const assistant = await createAgent({ agentTypeId: 'system-manager', ownerUserId: owner.id, context: {} })
      await assistant.recordMessage({ role: 'human', content: 'remind me about taxes' })

      const own = await search(assistant.id, owner.token, { q: 'TAXES' })
      expect(own.status).toBe(200)
      expect(((await own.json()) as MessageSearchResponse).results).toHaveLength(1)
      expect((await search(assistant.id, other.token, { q: 'taxes' })).status).toBe(403)
      expect((await search(assistant.id, admin.token, { q: 'taxes' })).status).toBe(403)
    })
  })
})
