import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, sharedPrompts, agentTypes } from '../db'
import { SharedPrompt } from '../entities/SharedPrompt'
import { AgentType } from '../entities/AgentType'
import { sharedPromptsRoutes } from './shared-prompts'
import { sharedPromptSync } from '../services/config-sync'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'

// ── Apps ──────────────────────────────────────────────────────────────────────

/**
 * Functional test app: real identityMiddleware + sharedPromptsRoutes.
 * All functional tests authenticate as admin.
 */
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/shared-prompts', sharedPromptsRoutes)

/**
 * Guard test app: same setup, used for RBAC denial tests.
 */
const guardApp = new Hono()
guardApp.use('*', identityMiddleware)
guardApp.route('/api/shared-prompts', sharedPromptsRoutes)

// ── Shared RBAC state ─────────────────────────────────────────────────────────

const funcPrefix = `shared-prompts-func-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const guardPrefix = `shared-prompts-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let funcAdmin: TestUser
let unprivileged: TestUser

beforeAll(async () => {
  funcAdmin = await createTestAdmin({ prefix: funcPrefix })
  await createTestAdmin({ prefix: guardPrefix, canonicalAdmin: true })
  unprivileged = await createTestUser({ prefix: guardPrefix })
})

afterAll(async () => {
  await cleanupTestRbac(funcPrefix)
  await cleanupTestRbac(guardPrefix)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminJson(method: string, body?: unknown) {
  const headers: Record<string, string> = {
    ...authHeaders(funcAdmin.token),
    'content-type': 'application/json',
  }
  return { method, body: body ? JSON.stringify(body) : undefined, headers }
}

function adminReq(method: string) {
  return { method, headers: authHeaders(funcAdmin.token) }
}

async function guardFetch(
  token: string | null,
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) Object.assign(headers, authHeaders(token))
  if (init?.headers) Object.assign(headers, init.headers)
  return guardApp.fetch(
    new Request(`http://localhost${path}`, {
      method: init?.method ?? 'GET',
      body: init?.body,
      headers,
    })
  )
}

// ── Functional tests ──────────────────────────────────────────────────────────

describe('shared prompt routes', () => {
  beforeEach(async () => {
    await db.delete(sharedPrompts).where(eq(sharedPrompts.id, 'custom-inc'))
    SharedPrompt.invalidateCache()
  })

  test('wrapped database failures in shared prompt create/update responses contain no SQL or parameters', async () => {
    const content = 'PRIVATE_QUERY_PARAMETER_CANARY\0'
    const input = { id: 'custom-inc', name: 'Custom', content }
    const actualFailure = await SharedPrompt.upsert(input).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(actualFailure).toBeInstanceOf(DrizzleQueryError)
    expect((actualFailure as DrizzleQueryError).message).toContain('PRIVATE_QUERY_PARAMETER_CANARY')
    for (const method of ['POST', 'PUT']) {
      if (method === 'PUT') await SharedPrompt.upsert({ ...input, content: 'Valid content' })
      const response = await app.request(
        method === 'POST' ? '/api/shared-prompts' : '/api/shared-prompts/custom-inc',
        adminJson(method, input)
      )
      expect(response.status).toBe(400)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({ error: 'Database query failed' })
      expect(body).not.toContain('PRIVATE_QUERY_PARAMETER_CANARY')
      expect(body).not.toContain('insert into')
      expect(body).not.toContain('params:')
    }
  })

  test('creates, updates, disables, enables and deletes a custom include', async () => {
    let res = await app.request(
      '/api/shared-prompts',
      adminJson('POST', { id: 'custom-inc', name: 'Custom', content: 'Be terse.' })
    )
    expect(res.status).toBe(201)
    res = await app.request(
      '/api/shared-prompts/custom-inc',
      adminJson('PUT', { name: 'Custom', content: 'Be very terse.' })
    )
    expect(res.status).toBe(200)
    expect((await res.json()).content).toBe('Be very terse.')
    res = await app.request('/api/shared-prompts/custom-inc/disable', adminReq('POST'))
    expect(res.status).toBe(200)
    expect((await (await app.request('/api/shared-prompts/custom-inc', adminReq('GET'))).json()).disabled).toBe(true)
    res = await app.request('/api/shared-prompts/custom-inc/enable', adminReq('POST'))
    expect(res.status).toBe(200)
    res = await app.request('/api/shared-prompts/custom-inc', adminReq('DELETE'))
    expect(res.status).toBe(200)
  })

  test('refuses to delete an include an agent type still references', async () => {
    await app.request('/api/shared-prompts', adminJson('POST', { id: 'custom-inc', name: 'Custom', content: 'x' }))
    await AgentType.upsert({ id: 'inc-user', name: 'Inc user', systemPrompt: 'hi', includes: ['custom-inc'] })
    const res = await app.request('/api/shared-prompts/custom-inc', adminReq('DELETE'))
    expect(res.status).toBe(409)
    expect((await res.json()).referencedBy).toEqual(['inc-user'])
    await db.delete(agentTypes).where(eq(agentTypes.id, 'inc-user'))
    AgentType.invalidateCache()
  })

  test('template-diff and revert work for a bundled include', async () => {
    await sharedPromptSync.sync()
    // The bundled `rules` include's template name comes from its markdown heading
    // ("## Operational Rules"), not the id — keep this equal to the template so
    // only `content` drifts, which is what this test is asserting.
    let res = await app.request(
      '/api/shared-prompts/rules',
      adminJson('PUT', { name: 'Operational Rules', content: 'edited' })
    )
    expect(res.status).toBe(200)
    const diff = await (await app.request('/api/shared-prompts/rules/template-diff', adminReq('GET'))).json()
    expect(diff.hasDrift).toBe(true)
    expect(diff.fieldOverrides).toEqual(['content'])
    res = await app.request('/api/shared-prompts/rules/revert-to-template', adminReq('POST'))
    expect(res.status).toBe(200)
    expect((await (await app.request('/api/shared-prompts/rules', adminReq('GET'))).json()).yamlFieldOverrides).toEqual(
      []
    )
  })

  test('PUT omitting name preserves the existing name; an explicit blank name is rejected', async () => {
    await sharedPromptSync.sync()
    // Content-only update: `name` is omitted entirely, so the existing (template)
    // name must survive untouched and only `content` should show as drift.
    let res = await app.request('/api/shared-prompts/rules', adminJson('PUT', { content: 'edited' }))
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('Operational Rules')
    const diff = await (await app.request('/api/shared-prompts/rules/template-diff', adminReq('GET'))).json()
    expect(diff.fieldOverrides).toEqual(['content'])

    res = await app.request('/api/shared-prompts/rules', adminJson('PUT', { name: '   ', content: 'x' }))
    expect(res.status).toBe(400)

    await app.request('/api/shared-prompts/rules/revert-to-template', adminReq('POST'))
  })

  test('denies writes without agent-types:update', async () => {
    const res = await guardFetch(unprivileged.token, '/api/shared-prompts', {
      method: 'POST',
      body: JSON.stringify({ id: 'nope', name: 'n', content: 'c' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(403)
  })
})

// ── RBAC guards ───────────────────────────────────────────────────────────────

/**
 * Shared prompt content lands in every agent's system prompt, so each mutating
 * route must reject an anonymous caller and a caller without
 * `agent-types:update` before it touches the record.
 */
describe('shared prompt RBAC guards', () => {
  const jsonBody = { body: JSON.stringify({ content: 'c' }), headers: { 'content-type': 'application/json' } }

  test('GET /api/shared-prompts → 401 without identity', async () => {
    expect((await guardFetch(null, '/api/shared-prompts')).status).toBe(401)
  })

  test('GET /api/shared-prompts → 403 for unprivileged user', async () => {
    expect((await guardFetch(unprivileged.token, '/api/shared-prompts')).status).toBe(403)
  })

  test('PUT /api/shared-prompts/:id → 401 without identity', async () => {
    const res = await guardFetch(null, '/api/shared-prompts/rules', { method: 'PUT', ...jsonBody })
    expect(res.status).toBe(401)
  })

  test('PUT /api/shared-prompts/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/shared-prompts/rules', { method: 'PUT', ...jsonBody })
    expect(res.status).toBe(403)
  })

  test('DELETE /api/shared-prompts/:id → 401 without identity', async () => {
    expect((await guardFetch(null, '/api/shared-prompts/rules', { method: 'DELETE' })).status).toBe(401)
  })

  test('DELETE /api/shared-prompts/:id → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/shared-prompts/rules', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('POST /api/shared-prompts/:id/disable → 401 without identity', async () => {
    expect((await guardFetch(null, '/api/shared-prompts/rules/disable', { method: 'POST' })).status).toBe(401)
  })

  test('POST /api/shared-prompts/:id/disable → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/shared-prompts/rules/disable', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('POST /api/shared-prompts/:id/enable → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/api/shared-prompts/rules/enable', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})
