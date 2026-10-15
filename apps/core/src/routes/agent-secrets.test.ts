/**
 * Per-agent secrets routes: authorization and names-only responses.
 * Synthetic keys and values only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Hono } from 'hono'
import { inArray } from 'drizzle-orm'
import { agentExtraScopes, agents, db, squads } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler } from '../middleware/json-body-errors'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { agentSecretsHostPath } from '../services/sandbox/agent-secrets-file'
import { agentSecretsRouter } from './agent-secrets'

const app = new Hono()
app.use('*', identityMiddleware)
app.onError(jsonBodyErrorHandler)
app.route('/api/agents', agentSecretsRouter)

const prefix = `agent-secrets-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const KEY = `SYNTH_ROUTE_SECRET_${Math.random().toString(36).slice(2, 8).toUpperCase()}`
const VALUE = `synthetic-route-value-${crypto.randomUUID()}`
const originalHome = process.env.HOME_DIR
const originalRuntime = process.env.FICUS_SANDBOX_RUNTIME
const originalEncryptionKey = process.env.FICUS_ENCRYPTION_KEY

let admin: TestUser
let home: string
let squadId: string
let agentA: string
let agentB: string

const json = (token: string) => ({ 'Content-Type': 'application/json', ...authHeaders(token) })

beforeAll(async () => {
  admin = await createTestAdmin({ prefix, canonicalAdmin: true })
  process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey ?? '0'.repeat(64)
  resetSecretStore()
  await getSecretStore().initialize()
  await getSecretStore().set(KEY, VALUE, 'test')
})

afterAll(async () => {
  await getSecretStore()
    .delete(KEY)
    .catch(() => {})
  if (originalEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = originalEncryptionKey
  resetSecretStore()
  await cleanupTestRbac(prefix)
})

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agent-secrets-route-'))
  process.env.HOME_DIR = home
  process.env.FICUS_SANDBOX_RUNTIME = 'docker'
  ;[{ id: squadId }] = await db
    .insert(squads)
    .values({ name: `${prefix} squad`, purpose: 'test', status: 'active' })
    .returning({ id: squads.id })
  ;[{ id: agentA }, { id: agentB }] = await db
    .insert(agents)
    .values([
      { agentTypeId: 'engineer', squadId },
      { agentTypeId: 'engineer', squadId },
    ])
    .returning({ id: agents.id })
})

afterEach(async () => {
  await db.delete(agents).where(inArray(agents.id, [agentA, agentB]))
  await db.delete(squads).where(inArray(squads.id, [squadId]))
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.HOME_DIR
  else process.env.HOME_DIR = originalHome
  if (originalRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
  else process.env.FICUS_SANDBOX_RUNTIME = originalRuntime
})

describe('per-agent secrets routes', () => {
  it('requires authentication', async () => {
    expect((await app.request(`/api/agents/${agentA}/secrets`)).status).toBe(401)
  })

  it('denies people without env permissions', async () => {
    const user = await createTestUser({ prefix })
    expect((await app.request(`/api/agents/${agentA}/secrets`, { headers: authHeaders(user.token) })).status).toBe(403)
    const put = await app.request(`/api/agents/${agentA}/secrets`, {
      method: 'PUT',
      headers: json(user.token),
      body: JSON.stringify({ keys: [KEY] }),
    })
    expect(put.status).toBe(403)
    expect(existsSync(agentSecretsHostPath(`agent_${agentA}`))).toBe(false)
  })

  it('lets env:read list names but not change them', async () => {
    const user = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['env:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'squad', squadId })

    expect((await app.request(`/api/agents/${agentA}/secrets`, { headers: authHeaders(user.token) })).status).toBe(200)
    const put = await app.request(`/api/agents/${agentA}/secrets`, {
      method: 'PUT',
      headers: json(user.token),
      body: JSON.stringify({ keys: [KEY] }),
    })
    expect(put.status).toBe(403)
  })

  it('exposes to one agent and answers with names only', async () => {
    const put = await app.request(`/api/agents/${agentA}/secrets`, {
      method: 'PUT',
      headers: json(admin.token),
      body: JSON.stringify({ keys: [KEY] }),
    })
    expect(put.status).toBe(200)
    const putText = await put.text()
    expect(putText).not.toContain(VALUE)
    expect(JSON.parse(putText).exposedSecretKeys).toEqual([KEY])

    const listA = await app.request(`/api/agents/${agentA}/secrets`, { headers: authHeaders(admin.token) })
    const listAText = await listA.text()
    expect(listAText).not.toContain(VALUE)
    const bodyA = JSON.parse(listAText)
    expect(bodyA.exposedSecretKeys).toEqual([KEY])
    expect(bodyA.secrets.find((s: { key: string }) => s.key === KEY)).toMatchObject({ isSet: true, exposed: true })

    // The teammate holds nothing.
    const listB = await (
      await app.request(`/api/agents/${agentB}/secrets`, { headers: authHeaders(admin.token) })
    ).json()
    expect(listB.exposedSecretKeys).toEqual([])
    expect(existsSync(agentSecretsHostPath(`agent_${agentB}`))).toBe(false)

    const del = await app.request(`/api/agents/${agentA}/secrets`, {
      method: 'DELETE',
      headers: json(admin.token),
      body: JSON.stringify({ keys: [KEY] }),
    })
    expect(del.status).toBe(200)
    expect((await del.json()).exposedSecretKeys).toEqual([])
    expect(existsSync(agentSecretsHostPath(`agent_${agentA}`))).toBe(false)
  })

  it('refuses agent identities even when they hold env:write', async () => {
    // Agent B is given env:write explicitly; it must still not grant itself (or A) a secret.
    await db.insert(agentExtraScopes).values({ agentId: agentB, permission: 'env:write' })
    const { token } = await createTestAgentToken({ agentId: agentB, squadId })
    for (const target of [agentA, agentB]) {
      const res = await app.request(`/api/agents/${target}/secrets`, {
        method: 'PUT',
        headers: json(token),
        body: JSON.stringify({ keys: [KEY] }),
      })
      expect(res.status).toBe(403)
      expect((await res.json()).error).toMatch(/Only a person/)
    }
    expect(existsSync(agentSecretsHostPath(`agent_${agentA}`))).toBe(false)
    expect(existsSync(agentSecretsHostPath(`agent_${agentB}`))).toBe(false)
  })

  it('answers 404 for an unknown agent and 400 for a subagent', async () => {
    const missing = await app.request('/api/agents/00000000-0000-4000-8000-000000000000/secrets', {
      headers: authHeaders(admin.token),
    })
    expect(missing.status).toBe(404)

    const [{ id: child }] = await db
      .insert(agents)
      .values({ agentTypeId: 'subagent', squadId, parentAgentId: agentA })
      .returning({ id: agents.id })
    const res = await app.request(`/api/agents/${child}/secrets`, {
      method: 'PUT',
      headers: json(admin.token),
      body: JSON.stringify({ keys: [KEY] }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/parent agent/)
  })

  it('rejects keys that are not environment variable names', async () => {
    const res = await app.request(`/api/agents/${agentA}/secrets`, {
      method: 'PUT',
      headers: json(admin.token),
      body: JSON.stringify({ keys: ['BAD; echo leaked'] }),
    })
    expect(res.status).toBe(400)
  })
})
