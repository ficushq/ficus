import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db, setDatabaseQueryObserverForTest } from '../db'
import { agents, agentTypes, squads, workStreams } from '../db/schema'
import { WorkStream } from '../entities/WorkStream'
import { identityMiddleware } from '../middleware/identity'
import type { Identity } from '../services/rbac'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { workStreamsRouter } from './work-streams'

const prefix = `metadata-boundary-${crypto.randomUUID()}`
const app = new Hono().use('*', identityMiddleware).route('/api/workstreams', workStreamsRouter)
let admin: TestUser
let limited: TestUser
let unprivileged: TestUser
let noSquads: TestUser
let squadOnly: TestUser
let squadIds: string[] = []
let streamIds: string[] = []
let agentIds: string[] = []
const agentTypeId = `${prefix}-type`
const literalPath = "owner's"
const injectionPath = "probe' = 'v' OR true --"
const literalValue = "O'Reilly\\books:α"
const branchPath = "branch' OR true --"
const injectionValue = "' OR true --"

function url(matches: Record<string, string>, status?: string): string {
  const params = new URLSearchParams()
  for (const [path, value] of Object.entries(matches)) params.append('match', `${path}:${value}`)
  if (status) params.set('status', status)
  return `/api/workstreams/by-metadata?${params}`
}

function request(token: string | undefined, matches: Record<string, string>, status?: string) {
  return app.fetch(new Request(`http://localhost${url(matches, status)}`, { headers: token ? authHeaders(token) : {} }))
}

async function ids(response: Response): Promise<string[]> {
  expect(response.status).toBe(200)
  return ((await response.json()) as { id: string }[]).map((row) => row.id).sort()
}

/** Exercise real permission resolution for non-session principals without creating external tokens. */
function asIdentity(identity: Identity) {
  const identityApp = new Hono()
  identityApp.use('*', async (c, next) => {
    c.set('identity', identity)
    await next()
  })
  identityApp.route('/api/workstreams', workStreamsRouter)
  return identityApp
}

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  limited = await createTestUser({ prefix })
  noSquads = await createTestUser({ prefix })
  unprivileged = await createTestUser({ prefix })
  squadOnly = await createTestUser({ prefix })
  const scopeRole = await createTestRole({ prefix, permissions: ['squads:read'] })
  const readRole = await createTestRole({ prefix, permissions: ['workstreams:read'] })
  squadIds = (
    await db
      .insert(squads)
      .values([
        { name: `${prefix}-a`, purpose: 'metadata boundary fixture' },
        { name: `${prefix}-b`, purpose: 'metadata boundary fixture' },
      ])
      .returning()
  ).map((s) => s.id)
  await assignRole({ userId: limited.id, roleId: readRole.id, scope: 'system' })
  await assignRole({ userId: limited.id, roleId: scopeRole.id, scope: 'squad', squadId: squadIds[0] })
  await assignRole({ userId: noSquads.id, roleId: readRole.id, scope: 'system' })
  await assignRole({ userId: squadOnly.id, roleId: readRole.id, scope: 'squad', squadId: squadIds[0] })
  const metadata = {
    marker: prefix,
    github: { pr: { number: 42 }, repo: 'org/repo' },
    scheduleId: prefix,
    [literalPath]: literalValue,
    [injectionPath]: 'x',
    [branchPath]: { 'leaf"': literalValue },
    valueAttack: injectionValue,
    special: { '空 白-"\\[]': '' },
    __proto__: null,
    constructor: 'literal',
    array: ['zero'],
  }
  // JSON.parse ensures __proto__ is a real JSON key, not the JS object-literal prototype setter.
  const withProto = { ...metadata, ...JSON.parse('{"__proto__":"literal"}') }
  streamIds = (
    await db
      .insert(workStreams)
      .values([
        { squadId: squadIds[0], title: `${prefix}-active`, status: 'active', metadata: withProto },
        { squadId: squadIds[0], title: `${prefix}-done`, status: 'done', metadata: withProto },
        { squadId: squadIds[1], title: `${prefix}-hidden`, status: 'active', metadata: withProto },
      ])
      .returning()
  ).map((s) => s.id)
})

afterEach(() => setDatabaseQueryObserverForTest(undefined))
afterAll(async () => {
  setDatabaseQueryObserverForTest(undefined)
  if (streamIds.length) await db.delete(workStreams).where(inArray(workStreams.id, streamIds))
  if (agentIds.length) await db.delete(agents).where(inArray(agents.id, agentIds))
  await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  if (squadIds.length) await db.delete(squads).where(inArray(squads.id, squadIds))
  await cleanupTestRbac(prefix)
})

describe('metadata lookup SQL boundary', () => {
  it('binds every path segment and comparison value; SQL-looking keys cannot change query shape', async () => {
    let lookup: { query: string; params: unknown[] } | undefined
    setDatabaseQueryObserverForTest((query, params) => {
      if (!query.includes('from "work_streams"') || !query.includes('metadata')) return
      // Fail before any unsafe SQL can reach even this disposable database.
      expect(query).not.toContain(injectionPath)
      expect(query).not.toContain(literalValue)
      expect(query).not.toContain('OR true --')
      lookup = { query, params }
    })
    const found = await WorkStream.findByMetadata(
      { [injectionPath]: 'x', [literalPath]: literalValue, marker: prefix },
      { status: 'active', squadIds: [squadIds[0]] }
    )
    expect(found.map((s) => s.id)).toEqual([streamIds[0]])
    expect(lookup!.params).toEqual([
      injectionPath,
      'x',
      literalPath,
      literalValue,
      'marker',
      prefix,
      'active',
      squadIds[0],
    ])
    const firstSql = lookup!.query
    await WorkStream.findByMetadata(
      { harmless: 'x', other: literalValue, marker: prefix },
      { status: 'active', squadIds: [squadIds[0]] }
    )
    expect(lookup!.query).toBe(firstSql)
  })

  it('binds intermediate nested keys and SQL-looking values as well as leaf keys', async () => {
    let params: unknown[] = []
    let query = ''
    setDatabaseQueryObserverForTest((sql, bound) => {
      if (!sql.includes('from "work_streams"') || !sql.includes('metadata')) return
      expect(sql).not.toContain(branchPath)
      expect(sql).not.toContain(injectionValue)
      params = bound
      query = sql
    })
    const matches = { [`${branchPath}.leaf"`]: literalValue, valueAttack: injectionValue, marker: prefix }
    expect((await WorkStream.findByMetadata(matches)).map((s) => s.id).sort()).toEqual([...streamIds].sort())
    expect(params).toEqual([branchPath, 'leaf"', literalValue, 'valueAttack', injectionValue, 'marker', prefix])
    const shape = query
    await WorkStream.findByMetadata({ 'safe.leaf': 'safe', safeValue: 'safe', marker: prefix })
    expect(query).toBe(shape)
  })

  it('looks up quotes, backslashes, Unicode and empty values as literal keys/data', async () => {
    expect(
      await ids(await request(admin.token, { marker: prefix, [literalPath]: literalValue, 'special.空 白-"\\[]': '' }))
    ).toEqual([...streamIds].sort())
  })

  it('preserves nested numeric-text matches, AND criteria and canonical/legacy status filters', async () => {
    for (const status of ['active', 'in_progress']) {
      expect(
        await ids(
          await request(admin.token, { marker: prefix, 'github.pr.number': '42', 'github.repo': 'org/repo' }, status)
        )
      ).toEqual([streamIds[0], streamIds[2]].sort())
    }
    expect(await ids(await request(admin.token, { marker: prefix, 'github.pr.number': '43' }))).toEqual([])
    expect(await ids(await request(admin.token, { marker: prefix }, 'done'))).toEqual([streamIds[1]])
  })

  it('preserves text-key operator semantics (numeric keys do not become array subscripts)', async () => {
    expect(await WorkStream.findByMetadata({ marker: prefix, 'array.0': 'zero' })).toEqual([])
  })

  it('accepts prototype-named JSON keys without losing match criteria', async () => {
    expect(
      await ids(
        await request(admin.token, { marker: prefix, ...JSON.parse('{"__proto__":"literal","constructor":"literal"}') })
      )
    ).toEqual([...streamIds].sort())
    expect(await ids(await request(admin.token, { marker: prefix, ...JSON.parse('{"__proto__":"wrong"}') }))).toEqual(
      []
    )
  })

  it('keeps trusted scheduler lookups unscoped when no squad restriction is supplied', async () => {
    expect((await WorkStream.findByMetadata({ scheduleId: prefix })).map((s) => s.id).sort()).toEqual(
      [...streamIds].sort()
    )
  })

  it('rejects empty or malformed dot paths and NUL before querying', async () => {
    const queries: string[] = []
    setDatabaseQueryObserverForTest((query) => queries.push(query))
    for (const path of ['', '.', '.key', 'key.', 'key..child', 'key\0child']) {
      expect((await request(admin.token, { [path]: 'x' })).status).toBe(400)
      await expect(WorkStream.findByMetadata({ [path]: 'x' })).rejects.toThrow('Invalid metadata path')
    }
    expect((await request(admin.token, { marker: 'x\0' })).status).toBe(400)
    await expect(WorkStream.findByMetadata({ marker: 'x\0' })).rejects.toThrow('Invalid metadata value')
    await expect(WorkStream.findByMetadata({})).rejects.toThrow('At least one metadata match')
    expect(queries.some((query) => query.includes('from "work_streams"'))).toBe(false)
  })

  it('retains missing-match and missing-delimiter 400 responses', async () => {
    for (const query of ['', '?match=invalid']) {
      const response = await app.fetch(
        new Request(`http://localhost/api/workstreams/by-metadata${query}`, { headers: authHeaders(admin.token) })
      )
      expect(response.status).toBe(400)
    }
  })
})

describe('metadata lookup authorization boundary', () => {
  it('requires identity and the existing unscoped workstreams:read permission', async () => {
    expect((await request(undefined, { marker: prefix })).status).toBe(401)
    expect((await request(unprivileged.token, { marker: prefix })).status).toBe(403)
    // Do not expand the route to admit squad-only grants.
    expect((await request(squadOnly.token, { marker: prefix })).status).toBe(403)
  })

  it('restricts accessible squads in SQL before fetching, including SQL-looking match keys', async () => {
    let observed = false
    setDatabaseQueryObserverForTest((query, params) => {
      if (!query.includes('from "work_streams"') || !query.includes('metadata')) return
      expect(query).toMatch(/"work_streams"\."squad_id" in \(\$\d+\)/)
      expect(params).toContain(squadIds[0])
      expect(params).not.toContain(squadIds[1])
      expect(query).not.toContain(injectionPath)
      observed = true
    })
    expect(await ids(await request(limited.token, { marker: prefix, [injectionPath]: 'x' }))).toEqual(
      [streamIds[0], streamIds[1]].sort()
    )
    expect(observed).toBe(true)
  })

  it('fails closed with no accessible squads and never executes a work-stream query', async () => {
    const queries: string[] = []
    setDatabaseQueryObserverForTest((query) => queries.push(query))
    expect(await ids(await request(noSquads.token, { marker: prefix }))).toEqual([])
    expect(queries.some((query) => query.includes('from "work_streams"'))).toBe(false)
    expect(await WorkStream.findByMetadata({ marker: prefix }, { squadIds: [] })).toEqual([])
    expect(queries.some((query) => query.includes('from "work_streams"'))).toBe(false)
  })

  it('preserves privileged admin, legacy and scoped-system visibility without bypassing action scopes', async () => {
    expect(await ids(await request(admin.token, { marker: prefix }))).toEqual([...streamIds].sort())
    for (const identity of [
      { type: 'legacy' },
      { type: 'system', systemTokenId: crypto.randomUUID(), name: prefix, scopes: ['workstreams:read'] },
    ] as Identity[]) {
      const response = await asIdentity(identity).fetch(new Request(`http://localhost${url({ marker: prefix })}`))
      expect(await ids(response)).toEqual([...streamIds].sort())
    }
    const denied = await asIdentity({
      type: 'system',
      systemTokenId: crypto.randomUUID(),
      name: prefix,
      scopes: [],
    }).fetch(new Request(`http://localhost${url({ marker: prefix })}`))
    expect(denied.status).toBe(403)
  })

  it('keeps shared agents squad-bound and user-backed agents within the owning user scope', async () => {
    await db.insert(agentTypes).values({
      id: agentTypeId,
      name: prefix,
      model: 'test-model',
      systemPrompt: 'test',
      extraScopes: ['workstreams:read'],
    })
    agentIds = (
      await db
        .insert(agents)
        .values([
          { agentTypeId, squadId: squadIds[0] },
          { agentTypeId, squadId: null, ownerUserId: limited.id },
          { agentTypeId, squadId: squadIds[0], status: 'terminated' },
        ])
        .returning()
    ).map((a) => a.id)
    for (const identity of [
      { type: 'agent', agentId: agentIds[0], squadId: squadIds[0] },
      { type: 'agent', agentId: agentIds[1], squadId: null },
    ] as Identity[]) {
      const response = await asIdentity(identity).fetch(new Request(`http://localhost${url({ marker: prefix })}`))
      expect(await ids(response)).toEqual([streamIds[0], streamIds[1]].sort())
    }
    for (const identity of [
      { type: 'agent', agentId: agentIds[0], squadId: squadIds[1] },
      { type: 'agent', agentId: agentIds[2], squadId: squadIds[0] },
    ] as Identity[]) {
      const response = await asIdentity(identity).fetch(new Request(`http://localhost${url({ marker: prefix })}`))
      expect(response.status).toBe(403)
    }
  })

  it('denies an agent whose authority is absent', async () => {
    const response = await asIdentity({ type: 'agent', agentId: crypto.randomUUID(), squadId: squadIds[0] }).fetch(
      new Request(`http://localhost${url({ marker: prefix })}`)
    )
    expect(response.status).toBe(403)
  })
})
