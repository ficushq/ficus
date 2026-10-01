import { describe, test, expect, beforeEach, beforeAll, afterAll } from 'bun:test'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, agentTypes, modelTiers, sharedPrompts, skills } from '../db'
import { AgentType } from '../entities/AgentType'
import { SharedPrompt } from '../entities/SharedPrompt'
import { Skill } from '../entities/Skill'
import { agentTypesRoutes } from './agent-types'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac } from '../test-utils'
import type { TestUser } from '../test-utils/rbac'
import { agentTypeSync, sharedPromptSync, modelTierSync, skillSync } from '../services/config-sync'

// ── Shared app with identity middleware ──
const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/agent-types', agentTypesRoutes)

const validAgentType = {
  id: 'custom-agent',
  name: 'Custom Agent',
  model: 'openai/gpt-4.1',
  systemPrompt: 'You help.',
  skills: ['custom-skill'],
  earlyMarginTokens: 30000,
  inFlightMarginTokens: 8192,
}

// ── Functional tests (use canonical admin for auth) ──────────────────────────

describe('agent type route validation', () => {
  const funcPrefix = `at-func-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let funcAdmin: TestUser

  beforeAll(async () => {
    funcAdmin = await createTestAdmin({ prefix: funcPrefix, canonicalAdmin: true })
  })

  afterAll(async () => {
    await cleanupTestRbac(funcPrefix)
  })

  beforeEach(async () => {
    await db.delete(agentTypes)
    await db.delete(skills)
    AgentType.invalidateCache()
    Skill.invalidateCache()
    await Skill.upsert({ id: 'custom-skill', name: 'Custom Skill', content: '# Custom Skill' })
    await db.delete(sharedPrompts)
    SharedPrompt.invalidateCache()
    await SharedPrompt.upsert({ id: 'shared-block', name: 'Shared Block', content: '# Shared Block' })
  })

  async function current(id: string) {
    const res = await app.request(`/api/agent-types/${id}`, { headers: authHeaders(funcAdmin.token) })
    return res.json()
  }

  test('agent type create conceals actual query failures but preserves validation messages', async () => {
    const response = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { ...authHeaders(funcAdmin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validAgentType, includes: ['AGENT_TYPE_PARAMETER_CANARY\0'] }),
    })
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error: 'Database query failed' })
    expect(body).not.toContain('AGENT_TYPE_PARAMETER_CANARY')
    expect(body).not.toContain('select ')
    const invalid = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { ...authHeaders(funcAdmin.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validAgentType, id: 'invalid id' }),
    })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error).toContain('agent type id')
  })

  test('GET detail includes the resolved tier chain and provenance', async () => {
    const tierSlug = `${funcPrefix}-standard`
    const typeId = `${funcPrefix}-tier-detail-agent`
    const chain = 'openai-codex:gpt-5.6-sol:medium,anthropic:claude-sonnet-5:high,zai:glm-5.3:high'
    await db.insert(modelTiers).values({ slug: tierSlug, label: 'Standard', chain })
    await AgentType.upsert({
      id: typeId,
      name: 'Tier Detail Agent',
      model: '',
      tier: tierSlug,
      systemPrompt: 'Test.',
    })

    try {
      const res = await app.request(`/api/agent-types/${typeId}`, {
        headers: authHeaders(funcAdmin.token),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        id: typeId,
        resolvedChain: chain,
        provenance: `via tier: ${tierSlug}`,
      })
    } finally {
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
      await db.delete(modelTiers).where(eq(modelTiers.slug, tierSlug))
      AgentType.invalidateCache()
    }
  })

  test('rejects missing skill references', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, skills: ['missing'] }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'Skill "missing" does not exist' })
  })

  test('creates agent type with an enabled DB skill reference', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify(validAgentType),
    })
    expect(res.status).toBe(201)
    const created = await res.json()
    expect(created.skills).toEqual(['custom-skill'])
    expect(created.earlyMarginTokens).toBe(30000)
    expect(created.inFlightMarginTokens).toBe(8192)
  })

  test('rejects non-integer earlyMarginTokens with a validation error', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, earlyMarginTokens: 30_000.5 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'earlyMarginTokens must be an integer between 0 and 1000000' })
  })

  test('rejects absurd earlyMarginTokens with a validation error', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, earlyMarginTokens: 1_000_000_000 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'earlyMarginTokens must be an integer between 0 and 1000000' })
  })

  test('rejects invalid inFlightMarginTokens with a validation error', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, inFlightMarginTokens: 8192.5 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'inFlightMarginTokens must be an integer between 0 and 1000000',
    })
  })

  test('rejects unknown and duplicated shared prompts', async () => {
    const post = (includes: unknown) =>
      app.request('/api/agent-types', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
        body: JSON.stringify({ ...validAgentType, includes }),
      })

    let res = await post(['nope'])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "Unknown shared prompt 'nope'" })

    res = await post(['shared-block', 'shared-block'])
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "includes lists 'shared-block' twice" })

    res = await post('shared-block')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'includes must be an array' })
  })

  // A disabled shared prompt contributes nothing at compose time, so letting a
  // type adopt one would silently store a no-op — the skills rule above rejects
  // the same mistake.
  test('PUT rejects a disabled shared prompt', async () => {
    await AgentType.upsert({ ...validAgentType, includes: [] })
    await db.update(sharedPrompts).set({ disabled: true }).where(eq(sharedPrompts.id, 'shared-block'))
    SharedPrompt.invalidateCache()

    const res = await app.request('/api/agent-types/custom-agent', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, includes: ['shared-block'] }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "Shared prompt 'shared-block' is disabled" })
  })

  test('creates an agent type carrying a shared prompt list', async () => {
    const res = await app.request('/api/agent-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...validAgentType, includes: ['shared-block'] }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).includes).toEqual(['shared-block'])
  })

  test('adds and removes one skill without replacing the full list', async () => {
    await Skill.upsert({ id: 'second-skill', name: 'Second Skill', content: '# Second Skill' })
    await AgentType.upsert({ ...validAgentType, includes: ['shared-block'] })

    let res = await app.request('/api/agent-types/custom-agent/add-skill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ skillId: 'second-skill' }),
    })
    expect(res.status).toBe(200)
    const added = await res.json()
    expect(added.skills).toEqual(['custom-skill', 'second-skill'])
    // The skill shortcuts rewrite the whole row; the include list must survive.
    expect(added.includes).toEqual(['shared-block'])
    expect(added.earlyMarginTokens).toBe(30000)
    expect(added.inFlightMarginTokens).toBe(8192)

    res = await app.request('/api/agent-types/custom-agent/remove-skill', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ skillId: 'custom-skill' }),
    })
    expect(res.status).toBe(200)
    const removed = await res.json()
    expect(removed.skills).toEqual(['second-skill'])
    expect(removed.includes).toEqual(['shared-block'])
    expect(removed.earlyMarginTokens).toBe(30000)
    expect(removed.inFlightMarginTokens).toBe(8192)
  })

  test('detail returns the include list and the resolved prompt agents receive', async () => {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    const res = await app.request('/api/agent-types/sysops', {
      headers: authHeaders(funcAdmin.token),
    })
    const body = await res.json()
    expect(body.includes).toEqual(['entity-references', 'rules', 'subagents', 'squad-rules'])
    expect(body.resolvedSystemPrompt).toContain('### Incident Response')
    expect(body.resolvedSystemPrompt).toContain('### Questions, waits, and pause')
    expect(body.systemPrompt).not.toContain('### Questions, waits, and pause')
  })

  test('PUT validates include ids and records an includes override', async () => {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    // sysops carries tier: standard and several bundled skills in its template;
    // PUT re-validates both, so seed model tiers and skills too (the route
    // doesn't sync these itself).
    await modelTierSync.sync()
    await skillSync.sync()
    let res = await app.request('/api/agent-types/sysops', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...(await current('sysops')), includes: ['rules', 'nope'] }),
    })
    expect(res.status).toBe(400)
    res = await app.request('/api/agent-types/sysops', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify({ ...(await current('sysops')), includes: ['rules'] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).yamlFieldOverrides).toContain('includes')
    await agentTypeSync.revertTemplateFields('sysops', ['includes'])
  })

  test('PUT omitting includes preserves the existing list instead of clearing it', async () => {
    await sharedPromptSync.sync()
    await agentTypeSync.sync()
    await modelTierSync.sync()
    await skillSync.sync()
    const { includes: _omitted, ...bodyWithoutIncludes } = await current('sysops')
    const res = await app.request('/api/agent-types/sysops', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders(funcAdmin.token) },
      body: JSON.stringify(bodyWithoutIncludes),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.includes).toEqual(['entity-references', 'rules', 'subagents', 'squad-rules'])
    expect(body.yamlFieldOverrides).not.toContain('includes')
  })
})

// ── RBAC guard tests ──────────────────────────────────────────────────────────

describe('agent-types RBAC guards', () => {
  const rbacPrefix = `at-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let admin: TestUser
  let unprivileged: TestUser

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix: rbacPrefix })
    // Seed a known agent type for read/update/delete tests
    await db.delete(agentTypes)
    AgentType.invalidateCache()
    await Skill.upsert({ id: 'guard-skill', name: 'Guard Skill', content: '# Guard' })
    await AgentType.upsert({
      id: 'guard-agent',
      name: 'Guard Agent',
      model: 'openai/gpt-4.1',
      systemPrompt: 'Guard.',
    })
  })

  afterAll(async () => {
    await cleanupTestRbac(rbacPrefix)
    await db.delete(agentTypes)
    AgentType.invalidateCache()
  })

  async function gfetch(
    token: string | null,
    path: string,
    init?: { method?: string; body?: unknown }
  ): Promise<Response> {
    const headers: Record<string, string> = {}
    if (token) Object.assign(headers, authHeaders(token))
    if (init?.body) headers['content-type'] = 'application/json'
    return app.fetch(
      new Request(`http://localhost${path}`, {
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.stringify(init.body) : undefined,
        headers,
      })
    )
  }

  // GET / — agent-types:read
  test('GET /api/agent-types → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types')
    expect(res.status).toBe(401)
  })
  test('GET /api/agent-types → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types')
    expect(res.status).toBe(403)
  })
  test('GET /api/agent-types → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/agent-types')
    expect(res.status).toBe(200)
  })

  // GET /:id — agent-types:read
  test('GET /api/agent-types/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent')
    expect(res.status).toBe(401)
  })
  test('GET /api/agent-types/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent')
    expect(res.status).toBe(403)
  })
  test('GET /api/agent-types/:id → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/agent-types/guard-agent')
    expect(res.status).toBe(200)
  })

  // POST / — agent-types:create
  test('POST /api/agent-types → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types', {
      method: 'POST',
      body: { id: 'x', name: 'X', model: 'openai/gpt-4.1', systemPrompt: 'x' },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types', {
      method: 'POST',
      body: { id: 'x', name: 'X', model: 'openai/gpt-4.1', systemPrompt: 'x' },
    })
    expect(res.status).toBe(403)
  })

  // PUT /:id — agent-types:update
  test('PUT /api/agent-types/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent', {
      method: 'PUT',
      body: { name: 'G', model: 'openai/gpt-4.1', systemPrompt: 'G.' },
    })
    expect(res.status).toBe(401)
  })
  test('PUT /api/agent-types/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent', {
      method: 'PUT',
      body: { name: 'G', model: 'openai/gpt-4.1', systemPrompt: 'G.' },
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/add-skill — agent-types:update
  test('POST /api/agent-types/:id/add-skill → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/add-skill', {
      method: 'POST',
      body: { skillId: 'guard-skill' },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/add-skill → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/add-skill', {
      method: 'POST',
      body: { skillId: 'guard-skill' },
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/remove-skill — agent-types:update
  test('POST /api/agent-types/:id/remove-skill → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/remove-skill', {
      method: 'POST',
      body: { skillId: 'guard-skill' },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/remove-skill → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/remove-skill', {
      method: 'POST',
      body: { skillId: 'guard-skill' },
    })
    expect(res.status).toBe(403)
  })

  // DELETE /:id — agent-types:delete
  test('DELETE /api/agent-types/:id → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
  test('DELETE /api/agent-types/:id → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  // GET /:id/template-diff — agent-types:read
  test('GET /api/agent-types/:id/template-diff → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/template-diff')
    expect(res.status).toBe(401)
  })
  test('GET /api/agent-types/:id/template-diff → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/template-diff')
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-to-template — agent-types:update
  test('POST /api/agent-types/:id/revert-to-template → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/revert-to-template', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/revert-to-template → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/revert-to-template', {
      method: 'POST',
      body: {},
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/revert-template-fields — agent-types:update
  test('POST /api/agent-types/:id/revert-template-fields → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/revert-template-fields', {
      method: 'POST',
      body: { fields: [] },
    })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/revert-template-fields → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/revert-template-fields', {
      method: 'POST',
      body: { fields: [] },
    })
    expect(res.status).toBe(403)
  })

  // POST /:id/disable — agent-types:update
  test('POST /api/agent-types/:id/disable → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/disable', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/disable → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/disable', { method: 'POST', body: {} })
    expect(res.status).toBe(403)
  })

  // POST /:id/enable — agent-types:update
  test('POST /api/agent-types/:id/enable → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/enable', { method: 'POST', body: {} })
    expect(res.status).toBe(401)
  })
  test('POST /api/agent-types/:id/enable → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/enable', { method: 'POST', body: {} })
    expect(res.status).toBe(403)
  })

  // GET /:id/export — agent-types:read
  test('GET /api/agent-types/:id/export → 401 without identity', async () => {
    const res = await gfetch(null, '/api/agent-types/guard-agent/export')
    expect(res.status).toBe(401)
  })
  test('GET /api/agent-types/:id/export → 403 for unprivileged user', async () => {
    const res = await gfetch(unprivileged.token, '/api/agent-types/guard-agent/export')
    expect(res.status).toBe(403)
  })
  test('GET /api/agent-types/:id/export → 200 for admin', async () => {
    const res = await gfetch(admin.token, '/api/agent-types/guard-agent/export')
    expect(res.status).toBe(200)
  })
})
