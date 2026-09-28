import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { ArtifactRequestAction } from '@ficus/shared'
import { createArtifactsRouter } from './artifacts'
import { identityMiddleware } from '../middleware/identity'
import { createTestAdmin, createTestUser, authHeaders, cleanupTestRbac, type TestUser } from '../test-utils'
import type { Identity } from '../services/rbac'

// ── Synthetic legacy identity middleware (for unit tests with mocked service) ──
// Injects a legacy identity that passes all permission checks without hitting DB.

function legacyIdentityMiddleware() {
  const identity: Identity = { type: 'legacy' }
  return createMiddleware(async (c, next) => {
    c.set('identity', identity)
    return next()
  })
}

// ── Test service mock ─────────────────────────────────────────────────────────

const testManifest = {
  id: 'artifact-1',
  title: 'Artifact',
  status: 'working' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
}

const testHistory = { requests: [], questions: [], publishes: [] }

const service = {
  listArtifacts: mock(async (_query?: unknown) => []),
  getArtifactContext: mock(async (_agentId: string, _artifactId: string) => ({
    agentId: 'agent-1',
    artifactId: 'artifact-1',
    artifactPath: '/tmp/artifact-1',
    manifest: testManifest,
    history: { requests: [], questions: [], publishes: [] },
  })),
  listArtifactFiles: mock(async (_agentId: string, _artifactId: string) => ({ files: [] })),
  readArtifactFile: mock(async (input: { path: string }) => ({
    path: input.path,
    content: 'hello',
    unit: 'lines' as const,
    offset: 1,
    limit: 200,
    sizeBytes: 5,
    truncated: false,
  })),
  editArtifactFile: mock(async () => ({ ok: true as const, changed: true, editsApplied: 1, manifest: testManifest })),
  requestArtifact: mock(async (input: { action: ArtifactRequestAction }) => ({
    action: input.action,
    agentId: 'agent-1',
    artifactId: 'artifact-1',
  })),
  prewarmArtifactBuilder: mock(async () => ({ agentId: 'agent-1', sandboxId: 'sandbox-1', reused: false })),
}

// ── App builders ──────────────────────────────────────────────────────────────

/**
 * Unit-test app: mocked service + synthetic legacy identity.
 * All permission checks pass; no DB required.
 */
function buildApp() {
  const app = new Hono()
  app.use('*', legacyIdentityMiddleware())
  app.route('/artifacts', createArtifactsRouter(service))
  return app
}

/**
 * Guard-test app: real identityMiddleware (requires real DB tokens).
 * Used for RBAC guard tests (401/403 checks).
 */
function buildGuardApp() {
  const app = new Hono()
  app.use('*', identityMiddleware)
  app.route('/artifacts', createArtifactsRouter(service))
  return app
}

// ── RBAC guard tests ──────────────────────────────────────────────────────────

describe('artifacts RBAC guards', () => {
  const rbacPrefix = `art-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  let guardAdmin: TestUser
  let unprivileged: TestUser
  let guardApp: Hono

  beforeAll(async () => {
    guardAdmin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix: rbacPrefix })
    guardApp = buildGuardApp()
  })

  afterAll(async () => {
    await cleanupTestRbac(rbacPrefix)
  })

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

  // GET / — filtered-list

  test('GET /artifacts → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts')
    expect(res.status).toBe(401)
  })

  test('GET /artifacts → 403 for unprivileged user (no accessible squads)', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts')
    expect(res.status).toBe(403)
  })

  test('GET /artifacts → 200 for admin, returns filtered artifact list', async () => {
    service.listArtifacts.mockImplementation(async () => [])
    const res = await guardFetch(guardAdmin.token, '/artifacts')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  // GET /:agentId/:artifactId/context — handler-scope (artifacts:read)

  test('GET /artifacts/:agentId/:artifactId/context → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/agent-1/artifact-1/context')
    expect(res.status).toBe(401)
  })

  test('GET /artifacts/:agentId/:artifactId/context → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/agent-1/artifact-1/context')
    expect(res.status).toBe(403)
  })

  test('GET /artifacts/:agentId/:artifactId/context → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/agent-1/artifact-1/context')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).not.toHaveProperty('artifactPath')
  })

  // GET /:agentId/:artifactId/files — handler-scope (artifacts:read)

  test('GET /artifacts/:agentId/:artifactId/files → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/agent-1/artifact-1/files')
    expect(res.status).toBe(401)
  })

  test('GET /artifacts/:agentId/:artifactId/files → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/agent-1/artifact-1/files')
    expect(res.status).toBe(403)
  })

  test('GET /artifacts/:agentId/:artifactId/files → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/agent-1/artifact-1/files')
    expect(res.status).toBe(200)
  })

  // GET /:agentId/:artifactId/file — handler-scope (artifacts:read)

  test('GET /artifacts/:agentId/:artifactId/file → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/agent-1/artifact-1/file?path=foo.json')
    expect(res.status).toBe(401)
  })

  test('GET /artifacts/:agentId/:artifactId/file → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/agent-1/artifact-1/file?path=foo.json')
    expect(res.status).toBe(403)
  })

  test('GET /artifacts/:agentId/:artifactId/file → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/agent-1/artifact-1/file?path=foo.json')
    expect(res.status).toBe(200)
  })

  // PATCH /:agentId/:artifactId/file — handler-scope (artifacts:write)

  test('PATCH /artifacts/:agentId/:artifactId/file → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/agent-1/artifact-1/file', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'foo.json', oldText: 'a', newText: 'b', changeSummary: 'fix' }),
    })
    expect(res.status).toBe(401)
  })

  test('PATCH /artifacts/:agentId/:artifactId/file → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/agent-1/artifact-1/file', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'foo.json', oldText: 'a', newText: 'b', changeSummary: 'fix' }),
    })
    expect(res.status).toBe(403)
  })

  test('PATCH /artifacts/:agentId/:artifactId/file → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/agent-1/artifact-1/file', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'foo.json', oldText: 'a', newText: 'b', changeSummary: 'fix' }),
    })
    expect(res.status).toBe(200)
  })

  // POST /prewarm — requirePermission (artifacts:write)

  test('POST /artifacts/prewarm → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/prewarm', { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('POST /artifacts/prewarm → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/prewarm', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  test('POST /artifacts/prewarm → 200 for admin', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/prewarm', { method: 'POST' })
    expect(res.status).toBe(200)
  })

  // POST /request — requirePermission (artifacts:write)

  test('POST /artifacts/request → 401 without identity', async () => {
    const res = await guardFetch(null, '/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', brief: 'Build it' }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /artifacts/request → 403 for unprivileged user', async () => {
    const res = await guardFetch(unprivileged.token, '/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', brief: 'Build it' }),
    })
    expect(res.status).toBe(403)
  })

  test('POST /artifacts/request → 201 for admin (create)', async () => {
    const res = await guardFetch(guardAdmin.token, '/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', brief: 'Build it' }),
    })
    expect(res.status).toBe(201)
  })
})

// ── Functional unit tests (mocked service + synthetic legacy identity) ─────────

describe('artifacts routes', () => {
  let app: Hono
  let originalConsoleError: typeof console.error

  beforeEach(() => {
    originalConsoleError = console.error
    console.error = mock(() => {}) as typeof console.error
    app = buildApp()
    service.listArtifacts.mockClear()
    service.getArtifactContext.mockClear()
    service.listArtifactFiles.mockClear()
    service.readArtifactFile.mockClear()
    service.editArtifactFile.mockClear()
    service.requestArtifact.mockClear()
    service.prewarmArtifactBuilder.mockClear()
    service.listArtifacts.mockImplementation(async () => [])
    service.getArtifactContext.mockImplementation(async () => ({
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      artifactPath: '/tmp/artifact-1',
      manifest: testManifest,
      history: testHistory,
    }))
    service.listArtifactFiles.mockImplementation(async () => ({ files: [] }))
    service.readArtifactFile.mockImplementation(async (input: { path: string }) => ({
      path: input.path,
      content: 'hello',
      unit: 'lines' as const,
      offset: 1,
      limit: 200,
      sizeBytes: 5,
      truncated: false,
    }))
    service.editArtifactFile.mockImplementation(async () => ({
      ok: true as const,
      changed: true,
      editsApplied: 1,
      manifest: testManifest,
    }))
    service.requestArtifact.mockImplementation(async (input: { action: ArtifactRequestAction }) => ({
      action: input.action,
      agentId: 'agent-1',
      artifactId: 'artifact-1',
    }))
    service.prewarmArtifactBuilder.mockImplementation(async () => ({
      agentId: 'agent-1',
      sandboxId: 'sandbox-1',
      reused: false,
    }))
  })

  afterEach(() => {
    console.error = originalConsoleError
  })

  test('redacts server-side artifact paths from context and request responses', async () => {
    service.getArtifactContext.mockImplementation(async () => ({
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      artifactPath: '/tmp/artifact-1',
      manifest: testManifest,
      history: testHistory,
    }))
    service.requestArtifact.mockImplementation(async (input: { action: ArtifactRequestAction }) => ({
      action: input.action,
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      artifactPath: '/tmp/artifact-1',
      manifest: testManifest,
      history: testHistory,
    }))

    const contextResponse = await app.request('/artifacts/agent-1/artifact-1/context')
    const contextBody = await contextResponse.json()
    expect(contextBody).not.toHaveProperty('artifactPath')
    expect(JSON.stringify(contextBody)).not.toContain('/tmp/artifact-1')

    const requestResponse = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'continue', agentId: 'agent-1', artifactId: 'artifact-1', brief: 'Keep going' }),
    })
    const requestBody = await requestResponse.json()
    expect(requestBody).not.toHaveProperty('artifactPath')
    expect(JSON.stringify(requestBody)).not.toContain('/tmp/artifact-1')
  })

  test('routes artifact file list, read, and edit requests', async () => {
    const listResponse = await app.request('/artifacts/agent-1/artifact-1/files')
    expect(listResponse.status).toBe(200)
    expect(service.listArtifactFiles).toHaveBeenCalledWith('agent-1', 'artifact-1')

    const readResponse = await app.request('/artifacts/agent-1/artifact-1/file?path=presentation.json&offset=2&limit=3')
    expect(readResponse.status).toBe(200)
    expect(service.readArtifactFile).toHaveBeenCalledWith({
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      path: 'presentation.json',
      unit: undefined,
      offset: 2,
      limit: 3,
    })

    const editResponse = await app.request('/artifacts/agent-1/artifact-1/file', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'presentation.json',
        oldText: 'hello',
        newText: 'hi',
        changeSummary: 'Shorten greeting',
      }),
    })
    expect(editResponse.status).toBe(200)
    expect(service.editArtifactFile).toHaveBeenCalledWith({
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      path: 'presentation.json',
      oldText: 'hello',
      newText: 'hi',
      changeSummary: 'Shorten greeting',
    })
  })

  test('direct artifact file routes reject metadata files as bad requests', async () => {
    service.readArtifactFile.mockImplementation(async () => {
      throw new Error('Artifact metadata files cannot be accessed directly')
    })

    const response = await app.request('/artifacts/agent-1/artifact-1/file?path=manifest-v2.jsonl')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Artifact metadata files cannot be accessed directly' })
  })

  test('prewarms artifact builders', async () => {
    const response = await app.request('/artifacts/prewarm', { method: 'POST' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ agentId: 'agent-1', sandboxId: 'sandbox-1', reused: false })
    expect(service.prewarmArtifactBuilder).toHaveBeenCalled()
  })

  test('returns a generic 500 error without exposing internal details', async () => {
    service.getArtifactContext.mockImplementation(async () => {
      throw new Error('EACCES: permission denied, open /Users/noah/private/artifact')
    })

    const response = await app.request('/artifacts/agent-1/artifact-1/context')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
  })

  test('handles list route errors as JSON', async () => {
    service.listArtifacts.mockImplementation(async () => {
      throw new Error('EACCES: permission denied, scandir /Users/noah/private/artifacts')
    })

    const response = await app.request('/artifacts')

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' })
  })

  test('trims request strings before validation and service calls', async () => {
    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: '  Artifact Title  ',
        brief: '  Build it  ',
        displayModeHint: '  dashboard  ',
      }),
    })

    expect(response.status).toBe(201)
    expect(service.requestArtifact.mock.calls[0][0]).toMatchObject({
      title: 'Artifact Title',
      brief: 'Build it',
      displayModeHint: 'dashboard',
    })
  })

  test('passes trimmed structured question answers to request service', async () => {
    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: '  Answer questions  ',
        answers: [
          { questionId: '  q_1  ', answer: '  Dark theme  ' },
          { questionId: 'q_2', answer: '  Revenue and retention  ' },
        ],
      }),
    })

    expect(response.status).toBe(200)
    expect(service.requestArtifact.mock.calls[0][0]).toMatchObject({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      brief: 'Answer questions',
      answers: [
        { questionId: 'q_1', answer: 'Dark theme' },
        { questionId: 'q_2', answer: 'Revenue and retention' },
      ],
    })
  })

  test('rejects structured question answers for non-continue requests', async () => {
    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        title: 'Artifact',
        brief: 'Build it',
        answers: [{ questionId: 'q_1', answer: 'Dark' }],
      }),
    })

    expect(response.status).toBe(400)
    expect(service.requestArtifact).not.toHaveBeenCalled()
  })

  test('maps missing artifact question answer ids to 400', async () => {
    service.requestArtifact.mockImplementation(async () => {
      throw new Error('Artifact question not found: q_missing')
    })

    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Answer questions',
        answers: [{ questionId: 'q_missing', answer: 'Dark' }],
      }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Artifact question not found: q_missing' })
  })

  test('returns continue partial-success delivery failures without mapping them to 500', async () => {
    service.requestArtifact.mockImplementation(async (input: { action: ArtifactRequestAction }) => ({
      action: input.action,
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      inboxDeliveryFailed: true,
      message:
        'Artifact request was recorded, but agent notification failed. Do not retry the full request; check artifact status/context or ask to notify/wake the builder separately.',
    }))

    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'continue',
        agentId: 'agent-1',
        artifactId: 'artifact-1',
        brief: 'Keep going',
      }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      action: 'continue',
      agentId: 'agent-1',
      artifactId: 'artifact-1',
      inboxDeliveryFailed: true,
    })
  })

  test('maps missing artifact delete requests to 404', async () => {
    service.requestArtifact.mockImplementation(async () => {
      throw new Error('Artifact not found: missing-artifact')
    })

    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'delete',
        agentId: 'agent-1',
        artifactId: 'missing-artifact',
        brief: 'Remove typo',
      }),
    })

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Artifact not found: missing-artifact' })
  })

  test('rejects whitespace-only required strings', async () => {
    const response = await app.request('/artifacts/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', title: '   ', brief: '   ' }),
    })

    expect(response.status).toBe(400)
    expect(service.requestArtifact).not.toHaveBeenCalled()
  })
})
