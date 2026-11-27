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
let toolAgent: Agent

function toolUse(toolCallId: string, toolName: string, args: unknown, result: string) {
  return {
    type: 'tool_use',
    id: toolCallId,
    toolCall: { toolCallId, toolName, args: JSON.stringify(args), result, isError: false },
  }
}

async function searchBody(agentId: string, params: Record<string, string>) {
  const res = await search(agentId, admin.token, params)
  expect(res.status).toBe(200)
  return (await res.json()) as MessageSearchResponse
}
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

  // A conversation with tool calls, oldest first: newerCount 4, 3, 2, 1, 0.
  toolAgent = await createAgent({ agentTypeId, squadId: squad.id })
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute))
  const toolRows = [
    {
      role: 'human' as const,
      content: 'find the backup path',
      metadata: { sender: { userId: admin.id, name: 'Admin' } },
    },
    {
      role: 'assistant' as const,
      content: 'Checking the disk.',
      metadata: {
        content: [
          { type: 'thinking', id: 'th1', content: 'thinkonlyword' },
          toolUse(
            'call-1',
            'bash',
            { command: 'ls C:\\backups\\50%_off' },
            'found "quoted" archive_v2.tar\nsecond line'
          ),
          toolUse('call-2', 'read', { path: '/etc/argsonlyword.conf' }, 'resultonlyword: 1 GiB used'),
          toolUse('call-4', 'bash', { command: 'git commit -m "fix it"' }, ''),
        ],
      },
    },
    { role: 'human' as const, content: 'Is archive_v2 the newest?', metadata: { source: 'inbox' } },
    {
      role: 'assistant' as const,
      content: 'Yes, archive_v2 is newest.',
      metadata: { content: [toolUse('call-3', 'memory_search', { query: 'retention' }, 'archive_v2 kept 30 days')] },
    },
    { role: 'assistant' as const, content: 'Done.', metadata: { content: [] } },
  ]
  for (const [minute, row] of toolRows.entries()) {
    const message = await toolAgent.recordMessage(row as unknown as Parameters<Agent['recordMessage']>[0])
    await db
      .update(messages)
      .set({ createdAt: at(minute) })
      .where(eq(messages.id, message.id))
  }
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
    // Postgres text cannot hold NUL; control characters are refused, while tab and line breaks are allowed.
    expect((await search(squadAgent.id, admin.token, { q: 'a\u0000b', in: 'all' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'a\u007fb' })).status).toBe(400)
    expect((await search(squadAgent.id, admin.token, { q: 'a\tb\nc', in: 'all' })).status).toBe(200)
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

describe('GET /api/agents/:id/messages/search with tool calls', () => {
  it('keeps the default scope on visible text, so tool-only strings are not found', async () => {
    const cases: Array<Record<string, string>> = [
      { q: 'resultonlyword' },
      { q: 'resultonlyword', in: 'text' },
      { q: 'thinkonlyword', in: 'all' },
    ]
    for (const params of cases) {
      expect((await searchBody(toolAgent.id, params)).results).toEqual([])
    }
    const text = await searchBody(toolAgent.id, { q: 'archive_v2' })
    expect(text.results.map((r) => r.match)).toEqual([{ field: 'text' }, { field: 'text' }])
  })

  it('finds a string that only appears in a tool result and names the tool', async () => {
    for (const scope of ['tools', 'all']) {
      const body = await searchBody(toolAgent.id, { q: 'RESULTONLYWORD', in: scope })
      expect(body.results).toHaveLength(1)
      const [hit] = body.results
      expect(hit.role).toBe('assistant')
      expect(hit.match).toEqual({ field: 'tool_result', toolName: 'read', toolCallId: 'call-2' })
      expect(hit.snippet.text).toBe('resultonlyword: 1 GiB used')
      expect(hit.snippet.highlights).toEqual([[0, 14]])
      expect(hit.newerCount).toBe(3)
    }
  })

  it('finds a string that only appears in tool arguments, and a tool by its name', async () => {
    const args = await searchBody(toolAgent.id, { q: 'argsonlyword', in: 'all' })
    expect(args.results.map((r) => r.match)).toEqual([{ field: 'tool_args', toolName: 'read', toolCallId: 'call-2' }])
    expect(args.results[0].snippet.text).toContain('argsonlyword.conf')
    const name = await searchBody(toolAgent.id, { q: 'memory_search', in: 'tools' })
    expect(name.results.map((r) => r.match)).toEqual([
      { field: 'tool_name', toolName: 'memory_search', toolCallId: 'call-3' },
    ])
  })

  it('prefers the visible text for a message that matches in both, and tools-only skips text', async () => {
    const all = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'all' })
    expect(all.results.map((r) => [r.newerCount, r.match.field])).toEqual([
      [1, 'text'],
      [2, 'text'],
      [3, 'tool_result'],
    ])
    const tools = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'tools' })
    expect(tools.results.map((r) => [r.newerCount, r.match])).toEqual([
      [1, { field: 'tool_result', toolName: 'memory_search', toolCallId: 'call-3' }],
      [3, { field: 'tool_result', toolName: 'bash', toolCallId: 'call-1' }],
    ])
  })

  it('matches %, _, \\ and quotes literally in tool content', async () => {
    const literal = async (q: string) => (await searchBody(toolAgent.id, { q, in: 'tools' })).results.length
    expect(await literal('50%_off')).toBe(1)
    expect(await literal('50x_off')).toBe(0)
    expect(await literal('50%xoff')).toBe(0)
    expect(await literal('archive.v2')).toBe(0)
    expect(await literal('"quoted"')).toBe(1)
    expect(await literal('tar\\nsecond')).toBe(0)
    expect(await literal('%')).toBe(1)
    expect(await literal('_')).toBe(2)
    expect(await literal('.*')).toBe(0)
    // Arguments are stored as JSON text; the query matches them as typed and in its JSON-escaped form.
    expect(await literal('C:\\backups\\50%_off')).toBe(1)
    expect(await literal('C:\\\\backups')).toBe(1)
    expect(await literal('C:\\xbackups')).toBe(0)
    const quoted = await searchBody(toolAgent.id, { q: '-m "fix it"', in: 'tools' })
    expect(quoted.results.map((r) => r.match)).toEqual([{ field: 'tool_args', toolName: 'bash', toolCallId: 'call-4' }])
    expect(quoted.results[0].snippet.text).toBe('{"command":"git commit -m \\"fix it\\""}')
    expect(quoted.results[0].snippet.highlights).toEqual([[23, 36]])
  })

  it('filters by role, keeping the requester-identity lookup by human sender working', async () => {
    const human = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'all', role: 'human' })
    expect(human.results.map((r) => [r.role, r.source])).toEqual([['human', 'inbox']])
    const sender = await searchBody(toolAgent.id, { q: 'backup', role: 'human' })
    expect(sender.results.map((r) => r.sender)).toEqual([{ userId: admin.id, name: 'Admin' }])
    const assistant = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'all', role: 'assistant' })
    expect(assistant.results.map((r) => r.role)).toEqual(['assistant', 'assistant'])
    expect((await search(toolAgent.id, admin.token, { q: 'x', role: 'system' })).status).toBe(400)
  })

  it('filters by time range', async () => {
    const body = await searchBody(toolAgent.id, {
      q: 'archive_v2',
      in: 'all',
      after: '2026-11-01T10:01:30.000Z',
      before: '2026-11-01T10:03:30.000Z',
    })
    expect(body.results.map((r) => r.newerCount)).toEqual([1, 2])
    expect((await search(toolAgent.id, admin.token, { q: 'x', before: 'not a date' })).status).toBe(400)
  })

  it('rejects an unknown scope and binds cursors to the scope and filters', async () => {
    expect((await search(toolAgent.id, admin.token, { q: 'x', in: 'thinking' })).status).toBe(400)
    const first = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'all', limit: '1' })
    expect(first.nextCursor).toBeString()
    const next = await searchBody(toolAgent.id, { q: 'archive_v2', in: 'all', limit: '2', cursor: first.nextCursor! })
    expect(next.results.map((r) => r.newerCount)).toEqual([2, 3])
    const changes: Array<Record<string, string>> = [
      { in: 'text' },
      { in: 'all', role: 'assistant' },
      { in: 'all', after: '2026-01-01T00:00:00Z' },
    ]
    for (const changed of changes) {
      const res = await search(toolAgent.id, admin.token, {
        q: 'archive_v2',
        limit: '1',
        cursor: first.nextCursor!,
        ...changed,
      })
      expect(res.status).toBe(400)
    }
  })
})
