import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { db, squads, workStreams, agents, assistantConversations, assistantEntries, messages } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authzSentinel } from '../middleware/authz-sentinel'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestRole,
  createTestUser,
  createTestAgentToken,
} from '../test-utils'
import { searchRouter } from './search'

const prefix = `search-${randomUUID()}`
const squadIds: string[] = [],
  agentIds: string[] = []
const app = new Hono().use('*', identityMiddleware).use('/api/*', authzSentinel).route('/api/search', searchRouter)
async function squad(name: string) {
  const [row] = await db.insert(squads).values({ name, purpose: 'Search fixture' }).returning()
  squadIds.push(row.id)
  return row
}
async function consultant(
  squadId: string,
  purpose: string,
  status: 'idle' | 'dormant' | 'terminated' = 'idle',
  ownerUserId?: string
) {
  const [row] = await db
    .insert(agents)
    .values({ squadId, agentTypeId: 'consultant', metadata: { purpose, name: 'Robin' }, status, ownerUserId })
    .returning()
  agentIds.push(row.id)
  return row
}
async function fixture() {
  const user = await createTestUser({ prefix }),
    other = await createTestUser({ prefix })
  const a = await squad(`${prefix} allowed`),
    b = await squad(`${prefix} secret`)
  const reader = await createTestRole({ prefix, permissions: ['squads:read', 'workstreams:read', 'agents:read'] })
  const chat = await createTestRole({ prefix, permissions: ['chat:send'] })
  await assignRole({ userId: user.id, roleId: reader.id, scope: 'squad', squadId: a.id })
  await assignRole({ userId: user.id, roleId: chat.id, scope: 'system' })
  const search = async (q: string, options: Record<string, string> = {}, token = user.token) => {
    const response = await app.request(`/api/search?${new URLSearchParams({ q, ...options })}`, {
      headers: authHeaders(token),
    })
    expect(response.status).toBe(200)
    return (await response.json()).results as Array<{
      id: string
      kind: string
      squadId: string | null
      label: string
      score: number
      agentId: string | null
    }>
  }
  return { user, other, a, b, reader, search }
}
afterEach(async () => {
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds.splice(0)))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds.splice(0)))
  await cleanupTestRbac(prefix)
})

test('search filters every entity by permission and owner before the shared limit', async () => {
  const { a, b, user, other, search } = await fixture()
  const allowed = await consultant(a.id, `${prefix} consultant`)
  const privateAgent = await consultant(a.id, `${prefix} private`, 'idle', other.id)
  await consultant(a.id, prefix, 'dormant')
  await consultant(a.id, prefix, 'terminated')
  await consultant(b.id, prefix)
  const [work] = await db
    .insert(workStreams)
    .values({ squadId: a.id, title: `${prefix} work` })
    .returning()
  await db.insert(workStreams).values({ squadId: b.id, title: prefix })
  const [own] = await db
    .insert(assistantConversations)
    .values({ ownerUserId: user.id, title: `${prefix} assistant` })
    .returning()
  await db.insert(assistantConversations).values({ ownerUserId: other.id, title: prefix })
  await db.insert(assistantEntries).values({
    conversationId: own.id,
    clientId: 'history',
    position: 1,
    entry: { id: 'history', role: 'user', text: 'Hello', final: true },
  })
  await db.insert(assistantConversations).values([
    { ownerUserId: user.id, title: `${prefix} empty` },
    { ownerUserId: user.id, title: `${prefix} editor`, kind: 'page-editor' },
  ])
  const results = await search(prefix)
  expect(new Set(results.map((row) => row.id))).toEqual(new Set([a.id, allowed.id, work.id, own.id]))
  expect(results.find((row) => row.id === privateAgent.id)).toBeUndefined()
  expect(await search(prefix, { limit: '1' })).toHaveLength(1)
  expect(await search(prefix, { squadId: b.id })).toEqual([])
  expect((await search(prefix, { kind: 'work_stream' })).map((row) => row.id)).toEqual([work.id])
  expect((await search(prefix, { squadId: a.id })).every((row) => row.squadId === a.id)).toBe(true)
  expect(await search(prefix, {}, other.token)).toEqual([])
})

test('conversation results name the agent behind them so a caller can read the conversation', async () => {
  const { a, user, search } = await fixture()
  const helper = await consultant(a.id, `${prefix} consultant`)
  const [work] = await db
    .insert(workStreams)
    .values({ squadId: a.id, title: `${prefix} work` })
    .returning()
  const [assistant] = await db
    .insert(agents)
    .values({ agentTypeId: 'assistant', ownerUserId: user.id, metadata: { name: 'Assistant' } })
    .returning()
  agentIds.push(assistant.id)
  const [conversation] = await db
    .insert(assistantConversations)
    .values({ ownerUserId: user.id, title: `${prefix} assistant`, agentId: assistant.id })
    .returning()
  // Listed because its agent has chat history, not because of legacy entries.
  await db.insert(messages).values({ agentId: assistant.id, role: 'human', content: 'can they see the apps?' })
  const byId = new Map((await search(prefix)).map((row) => [row.id, row]))
  expect(byId.get(conversation.id)?.agentId).toBe(assistant.id)
  expect(byId.get(helper.id)?.agentId).toBe(helper.id)
  expect(byId.get(work.id)?.agentId).toBeNull()
  expect(byId.get(a.id)?.agentId).toBeNull()
})

test('squad default overrides cannot leak work through visibility alone; user assistants inherit current scopes', async () => {
  const { a, b, user, reader, search } = await fixture()
  await assignRole({ userId: user.id, roleId: reader.id, scope: 'squad_default' })
  const limited = await createTestRole({ prefix, permissions: ['squads:read'] })
  await assignRole({ userId: user.id, roleId: limited.id, scope: 'squad', squadId: b.id })
  await db.insert(workStreams).values({ squadId: b.id, title: prefix })
  await consultant(b.id, prefix)
  const [agent] = await db.insert(agents).values({ agentTypeId: 'system-manager', ownerUserId: user.id }).returning()
  agentIds.push(agent.id)
  const token = await createTestAgentToken({ agentId: agent.id, squadId: null })
  const rows = await search(prefix, {}, token.token)
  expect(new Set(rows.map((row) => row.id))).toEqual(new Set([a.id, b.id]))
})

test('exact matches lead; similar work prefers active then recently completed, with a database result cap', async () => {
  const { a, search } = await fixture()
  const now = new Date(),
    old = new Date(now.getTime() - 90 * 86400_000)
  const rows = await db
    .insert(workStreams)
    .values([
      { squadId: a.id, title: `${prefix} target`, status: 'done', updatedAt: old },
      { squadId: a.id, title: `${prefix} target extra`, status: 'active', updatedAt: old },
      { squadId: a.id, title: `${prefix} target extra`, status: 'done', updatedAt: now },
      { squadId: a.id, title: `${prefix} target extra`, status: 'done', updatedAt: old },
    ])
    .returning()
  expect((await search(`${prefix} target`, { kind: 'work_stream', limit: '3' })).map((row) => row.id)).toEqual(
    rows.slice(0, 3).map((row) => row.id)
  )
  expect((await search(rows[3].id))[0].id).toBe(rows[3].id)
})

test('wildcards are literal, arguments are bounded, and missing authentication fails closed', async () => {
  const { a, user, search } = await fixture()
  const [row] = await db
    .insert(workStreams)
    .values({ squadId: a.id, title: `${prefix} 100%_ready` })
    .returning()
  expect((await search('%_ready')).map((item) => item.id)).toEqual([row.id])
  expect(await search("' OR true --")).toEqual([])
  for (const query of [
    'q=',
    'q=x&limit=0',
    'q=x&limit=51',
    'q=x&limit=1.5',
    'q=x&kind=agent',
    'q=x&squadId=bad',
    `q=${'a'.repeat(121)}`,
  ]) {
    expect((await app.request(`/api/search?${query}`, { headers: authHeaders(user.token) })).status).toBe(400)
  }
  expect((await app.request('/api/search?q=x')).status).toBe(401)
})
