import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { isGrantablePermission } from '@ficus/shared'
import {
  db,
  secrets,
  settings,
  agents,
  squads,
  agentExtraScopes,
  decisionLog,
  inferenceUsage,
  systemTokens,
} from '../db'
import { Agent } from '../entities/Agent'
import { Squad } from '../entities/Squad'
import { identityMiddleware } from '../middleware/identity'
import { jsonBodyErrorHandler, jsonBodyErrorMiddleware } from '../middleware/json-body-errors'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { getSettingsStore, resetSettingsStore } from '../services/settings'
import {
  DECISION_PROVIDERS_KEY,
  DECISION_ROUTING_KEY,
  addDecisionProvider,
  updateDecisionProvider,
  setDecisionRouting,
  getDecisionRouting,
} from '../services/decisions/store'
import { flushInferenceUsage, setInferenceUsageSinkForTest } from '../services/inference-usage'
import type { InferenceUsageEvent } from '../services/inference-usage/types'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  createTestAgentToken,
  type TestUser,
} from '../test-utils'
import { hasPermission } from '../services/rbac'
import { createSystemToken } from '../services/auth/system-tokens'
import decisions from './decisions'
import secretsRouter from './secrets'

const app = new Hono()
app.use('*', jsonBodyErrorMiddleware)
app.onError(jsonBodyErrorHandler)
app.use('*', identityMiddleware)
app.route('/api/decisions', decisions)
app.route('/api/secrets', secretsRouter)
const prefix = `decision-eval-${crypto.randomUUID()}`
let evaluator: TestUser
let unprivileged: TestUser
let operator: TestUser
let admin: TestUser
let squadId: string
let agent: Agent
let agentToken: string
let providerId: string
let disabledId: string
let server: ReturnType<typeof Bun.serve>
let mode: 'ok' | 'error' | 'hold' = 'ok'
let ready: (() => void) | undefined
const unblock: Array<() => void> = []
const systemTokenIds: string[] = []
let calls = 0
const usage: InferenceUsageEvent[] = []
let priorSecrets: (typeof secrets.$inferSelect)[] = []
let priorSettings: (typeof settings.$inferSelect)[] = []
const encryptionKey = process.env.FICUS_ENCRYPTION_KEY

const requestBody = () => ({
  providerId,
  purpose: 'tool-results',
  state: 'case',
  questions: { yes: { type: 'yesno', instructions: 'Yes?' } },
})
const ask = (token: string, body: unknown = requestBody(), path = '/evaluate', method = 'POST') =>
  app.request(`/api/decisions${path}`, {
    method,
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  })

beforeAll(async () => {
  admin = await createTestAdmin({ prefix })
  evaluator = await createTestUser({ prefix })
  unprivileged = await createTestUser({ prefix })
  operator = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['decisions:evaluate'] })
  await assignRole({ userId: evaluator.id, roleId: role.id, scope: 'system' })
  const operatorRole = await createTestRole({ prefix, permissions: ['provider-auth:read', 'provider-auth:write'] })
  await assignRole({ userId: operator.id, roleId: operatorRole.id, scope: 'system' })
  const squad = await Squad.create({ name: prefix, purpose: 'evaluation test' })
  squadId = squad.id
  agent = await Agent.create({ agentTypeId: 'worker', squadId })
  agentToken = (await createTestAgentToken({ agentId: agent.id, squadId })).token
  process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  priorSecrets = await db.select().from(secrets).where(eq(secrets.key, DECISION_PROVIDERS_KEY))
  priorSettings = await db.select().from(settings).where(eq(settings.key, DECISION_ROUTING_KEY))
  await db.delete(secrets).where(eq(secrets.key, DECISION_PROVIDERS_KEY))
  await db.delete(settings).where(eq(settings.key, DECISION_ROUTING_KEY))
  resetSecretStore()
  resetSettingsStore()
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      calls++
      if (mode === 'hold') {
        const blocked = new Promise<void>((resolve) => unblock.push(resolve))
        if (unblock.length === 4) ready?.()
        await blocked
      }
      if (mode === 'error') return new Response('fixture-provider-secret account-id private-host', { status: 429 })
      return Response.json({
        model: 'clef',
        answers: { yes: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 100 },
      })
    },
  })
  providerId = (
    await addDecisionProvider({
      kind: 'systemone',
      baseUrl: `http://127.0.0.1:${server.port}`,
      apiKey: 'fixture-provider-secret',
      accountId: 'private-account',
    })
  ).id
  disabledId = (await addDecisionProvider({ kind: 'systemone', baseUrl: `http://127.0.0.1:${server.port}` })).id
  await updateDecisionProvider(disabledId, { enabled: false })
})

beforeEach(() => {
  mode = 'ok'
  calls = 0
  usage.length = 0
  setInferenceUsageSinkForTest((event) => {
    usage.push(event)
  })
})
afterEach(async () => {
  await flushInferenceUsage()
  setInferenceUsageSinkForTest(undefined)
})
afterAll(async () => {
  for (const release of unblock.splice(0)) release()
  await server?.stop(true)
  if (systemTokenIds.length) await db.delete(systemTokens).where(inArray(systemTokens.id, systemTokenIds))
  await db.delete(agentExtraScopes).where(eq(agentExtraScopes.agentId, agent.id))
  await db.delete(agents).where(eq(agents.id, agent.id))
  await db.delete(squads).where(eq(squads.id, squadId))
  await db.delete(secrets).where(eq(secrets.key, DECISION_PROVIDERS_KEY))
  await db.delete(settings).where(eq(settings.key, DECISION_ROUTING_KEY))
  if (priorSecrets.length) await db.insert(secrets).values(priorSecrets)
  if (priorSettings.length) await db.insert(settings).values(priorSettings)
  await db
    .delete(decisionLog)
    .where(
      or(
        inArray(decisionLog.providerId, [providerId, disabledId]),
        sql`${decisionLog.errors} @> ${JSON.stringify([{ providerId }])}::jsonb`
      )
    )
  await db.delete(inferenceUsage).where(inArray(inferenceUsage.accountId, [providerId, disabledId]))
  if (encryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = encryptionKey
  resetSecretStore()
  resetSettingsStore()
  await cleanupTestRbac(prefix)
})

test('the new capability is grantable, but unauthenticated and unauthorized calls never reach a provider', async () => {
  expect(isGrantablePermission('decisions:evaluate')).toBe(true)
  for (const method of ['GET', 'POST']) {
    expect((await app.request('/api/decisions/evaluate', { method })).status).toBe(401)
    expect((await ask(unprivileged.token, requestBody(), '/evaluate', method)).status).toBe(403)
  }
  expect((await ask('invalid-token')).status).toBe(401)
  expect(calls).toBe(0)
})

test('evaluation-only access receives minimal enabled metadata and real answers attributed to the caller and feature', async () => {
  const listing = await ask(evaluator.token, null, '/evaluate', 'GET')
  expect(listing.status).toBe(200)
  expect(await listing.json()).toEqual({
    providers: [
      {
        id: providerId,
        label: 'Local decision model',
        kind: 'systemone',
        model: 'clef',
        enabled: true,
        effectivePricePerMillionInput: 0,
      },
    ],
  })
  const response = await ask(evaluator.token)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ok: true,
    result: { providerId, answers: { yes: { type: 'yesno', probability: 0.9 } } },
  })
  await flushInferenceUsage()
  expect(usage).toHaveLength(1)
  expect(usage[0]).toMatchObject({
    feature: 'decision:tool-results',
    accountId: providerId,
    attribution: { userId: evaluator.id },
    source: { kind: 'eval', actor: `user:${evaluator.id}` },
  })
})

test('eval-only cannot manage providers, routing, capture, feature switches, use Settings try or read secrets', async () => {
  for (const [method, path] of [
    ['GET', ''],
    ['GET', '/spend'],
    ['POST', '/try'],
    ['POST', '/providers'],
    ['POST', '/providers/detect'],
    ['PATCH', `/providers/${providerId}`],
    ['DELETE', `/providers/${providerId}`],
    ['PUT', '/routing'],
    ['PUT', '/eval-capture'],
    ['PUT', '/features/tool-results'],
  ] as const) {
    expect((await ask(evaluator.token, {}, path, method)).status).toBe(403)
  }
  expect((await app.request('/api/secrets', { headers: authHeaders(evaluator.token) })).status).toBe(403)
  for (const permission of ['agents:scopes:manage', 'roles:create', 'roles:update', 'system-tokens:manage']) {
    expect(await hasPermission({ type: 'user', userId: evaluator.id }, permission)).toBe(false)
  }
  expect(calls).toBe(0)
})

test('disabled and unknown providers are indistinguishable and cannot be invoked; overrides and missing feature are rejected', async () => {
  for (const id of [disabledId, 'unknown'])
    expect((await ask(evaluator.token, { ...requestBody(), providerId: id })).status).toBe(404)
  for (const extra of [
    { baseUrl: 'http://other-host' },
    { source: 'settings-try' },
    { squadId },
    { apiKey: 'override' },
    { purpose: undefined },
    { purpose: 'not-a-feature' },
  ]) {
    expect((await ask(evaluator.token, { ...requestBody(), ...extra })).status).toBe(400)
  }
  expect(calls).toBe(0)
})

test('malformed JSON is rejected without exposing input or reaching inference', async () => {
  const response = await app.request('/api/decisions/evaluate', {
    method: 'POST',
    headers: { ...authHeaders(evaluator.token), 'content-type': 'application/json' },
    body: '{"credential":"fixture-secret" BROKEN',
  })
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'Invalid JSON body' })
  expect(calls).toBe(0)
})

test('the evaluation path preserves image validation and refuses text-only providers before inference', async () => {
  const textOnly = await addDecisionProvider({ kind: 'jev', apiKey: 'fixture-unused' })
  try {
    expect(
      (
        await ask(evaluator.token, {
          ...requestBody(),
          providerId: textOnly.id,
          images: [{ mediaType: 'image/png', base64: 'AA==' }],
        })
      ).status
    ).toBe(400)
    expect(
      (await ask(evaluator.token, { ...requestBody(), images: [{ mediaType: 'image/png', base64: 'not base64' }] }))
        .status
    ).toBe(400)
    expect(calls).toBe(0)
  } finally {
    const { removeDecisionProvider } = await import('../services/decisions/store')
    await removeDecisionProvider(textOnly.id)
  }
})

test('provider errors are sanitized, recorded as eval failures and do not leak keys, account IDs or hosts', async () => {
  mode = 'error'
  const response = await ask(evaluator.token)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    ok: false,
    reason: 'unavailable',
    errors: [{ providerId, error: 'Evaluation provider unavailable' }],
  })
  await flushInferenceUsage()
  expect(usage).toHaveLength(0)
  mode = 'ok'
  expect((await ask(evaluator.token)).status).toBe(200)
})

test('a worker requires an explicit per-agent scope, uses its own squad attribution, and revocation takes effect', async () => {
  expect((await ask(agentToken)).status).toBe(403)
  await db.insert(agentExtraScopes).values({ agentId: agent.id, permission: 'decisions:evaluate' })
  try {
    const response = await ask(agentToken)
    expect(response.status).toBe(200)
    await flushInferenceUsage()
    expect(usage[0]).toMatchObject({
      attribution: { agentId: agent.id, squadId },
      source: { kind: 'eval', actor: `agent:${agent.id}` },
    })
    expect((await ask(agentToken, { ...requestBody(), squadId: crypto.randomUUID() })).status).toBe(400)
  } finally {
    await db.delete(agentExtraScopes).where(eq(agentExtraScopes.agentId, agent.id))
  }
  expect((await ask(agentToken)).status).toBe(403)
})

test('squad-only user grants do not become system grants; existing operators retain Settings try and evaluation access', async () => {
  const scoped = await createTestUser({ prefix })
  const role = await createTestRole({ prefix, permissions: ['decisions:evaluate'] })
  await assignRole({ userId: scoped.id, roleId: role.id, scope: 'squad', squadId })
  expect((await ask(scoped.token)).status).toBe(403)
  expect((await ask(operator.token, null, '/evaluate', 'GET')).status).toBe(200)
  expect((await ask(operator.token)).status).toBe(200)
  expect((await ask(operator.token, requestBody(), '/try')).status).toBe(200)
  expect((await ask(admin.token)).status).toBe(200)
})

test('system tokens are checked only against their scopes and remain attributable without a user', async () => {
  const permitted = await createSystemToken({ name: prefix, scopes: ['decisions:evaluate'] })
  const denied = await createSystemToken({ name: prefix, scopes: ['provider-auth:read'] })
  systemTokenIds.push(permitted.record.id, denied.record.id)
  expect((await ask(denied.token)).status).toBe(403)
  expect((await ask(permitted.token)).status).toBe(200)
  expect((await ask(permitted.token, {}, '/try')).status).toBe(403)
  await flushInferenceUsage()
  expect(usage[0]).toMatchObject({ source: { kind: 'eval', actor: `system-token:${permitted.record.id}` } })
})

test('the real route bounds concurrency per caller and releases slots after success and provider failure', async () => {
  const permitted = await createSystemToken({ name: prefix, scopes: ['decisions:evaluate'] })
  systemTokenIds.push(permitted.record.id)
  mode = 'hold'
  const allStarted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const pending = Array.from({ length: 4 }, () => ask(permitted.token))
  try {
    await allStarted
    expect((await ask(permitted.token)).status).toBe(429)
    expect(calls).toBe(4)
  } finally {
    mode = 'ok'
    for (const release of unblock.splice(0)) release()
    await Promise.all(pending)
    ready = undefined
  }
  for (let i = 0; i < 5; i++) {
    mode = 'error'
    expect((await ask(permitted.token)).status).toBe(200)
  }
  mode = 'ok'
  expect((await ask(permitted.token)).status).toBe(200)
})

test('client cancellation releases concurrency slots and a successful call persists attributed ledger usage', async () => {
  const permitted = await createSystemToken({ name: prefix, scopes: ['decisions:evaluate'] })
  systemTokenIds.push(permitted.record.id)
  mode = 'hold'
  const allStarted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const pending = controllers.map((controller) =>
    app.request('/api/decisions/evaluate', {
      method: 'POST',
      headers: { ...authHeaders(permitted.token), 'content-type': 'application/json' },
      body: JSON.stringify(requestBody()),
      signal: controller.signal,
    })
  )
  try {
    await allStarted
    for (const controller of controllers) controller.abort()
    const results = await Promise.all(pending)
    for (const response of results) expect(await response.json()).toMatchObject({ ok: false })
  } finally {
    for (const controller of controllers) controller.abort()
    mode = 'ok'
    for (const release of unblock.splice(0)) release()
    await Promise.all(pending)
    ready = undefined
  }
  setInferenceUsageSinkForTest(undefined)
  expect((await ask(permitted.token)).status).toBe(200)
  await flushInferenceUsage()
  const rows = await db.select().from(inferenceUsage).where(eq(inferenceUsage.accountId, providerId))
  expect(
    rows.find((row) => (row.source as { actor?: string })?.actor === `system-token:${permitted.record.id}`)
  ).toMatchObject({
    feature: 'decision:tool-results',
    billing: 'self-hosted',
    source: { kind: 'eval', purpose: 'tool-results' },
  })
})

test('the real route stops at 60 calls per minute and does not invoke inference for rate denials', async () => {
  const permitted = await createSystemToken({ name: prefix, scopes: ['decisions:evaluate'] })
  systemTokenIds.push(permitted.record.id)
  mode = 'error'
  for (let i = 0; i < 60; i++) expect((await ask(permitted.token)).status).toBe(200)
  const denied = await ask(permitted.token)
  expect(denied.status).toBe(429)
  expect(denied.headers.get('retry-after')).toBe('60')
  expect(calls).toBe(60)
})

test('bounded text and raw bodies are refused before inference and the routing timeout remains a cap', async () => {
  expect((await ask(evaluator.token, { ...requestBody(), state: 'x'.repeat(65_537) })).status).toBe(413)
  expect((await ask(evaluator.token, { ...requestBody(), state: 'x'.repeat(12 * 1024 * 1024) })).status).toBe(413)
  expect((await ask(evaluator.token, { ...requestBody(), state: 'é'.repeat(33_000) })).status).toBe(413)
  expect(calls).toBe(0)
  const priorRouting = getDecisionRouting()
  // Do not compare wall-clock latency: a bounded route timeout must return and release its slot.
  const finish: Array<() => void> = []
  const hangingServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async () => {
      await new Promise<void>((resolve) => finish.push(resolve))
      return new Response('finished')
    },
  })
  try {
    await setDecisionRouting({ default: [providerId], purposes: {}, timeoutMs: 250 }, 'test')
    await updateDecisionProvider(providerId, { baseUrl: `http://127.0.0.1:${hangingServer.port}` })
    for (let i = 0; i < 5; i++) {
      const response = await ask(evaluator.token)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: false, reason: 'unavailable' })
    }
  } finally {
    for (const release of finish) release()
    await hangingServer.stop(true)
    await updateDecisionProvider(providerId, { baseUrl: `http://127.0.0.1:${server.port}` })
    await setDecisionRouting(priorRouting, 'test')
  }
})

test('legacy operator evals through Settings try also retain caller attribution', async () => {
  expect((await ask(operator.token, { ...requestBody(), source: 'eval' }, '/try')).status).toBe(200)
  await flushInferenceUsage()
  expect(usage[0]).toMatchObject({
    feature: 'decision:tool-results',
    attribution: { userId: operator.id },
    source: { kind: 'eval', actor: `user:${operator.id}` },
  })
})

test('oversize streaming bodies return a sanitized limit response, not an unhandled server error', async () => {
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  try {
    const response = await ask(evaluator.token, { ...requestBody(), state: 'x'.repeat(12 * 1024 * 1024) })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Evaluation request too large' })
    expect(errorLog).not.toHaveBeenCalled()
  } finally {
    errorLog.mockRestore()
  }
})
