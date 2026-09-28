import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { db, secrets } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { resetSecretGroups } from '../services/secrets/groups'
import * as secretValidators from '../services/secrets/validators'
import { validateGitHubToken } from '../services/secrets/validators/github'
import {
  assignRole,
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestRole,
  createTestUser,
  type TestUser,
} from '../test-utils'
import secretsRouter from './secrets'

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/secrets', secretsRouter)

const prefix = `secrets-validation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const encryptionKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const getValidator = secretValidators.getSecretValidator
const originalGitHubToken = process.env.VALIDATION_TEST_KEY
let admin: TestUser
let unprivileged: TestUser
let writeOnlyOperator: TestUser
let githubResponse: () => Response
let validatorSpy: ReturnType<typeof spyOn> | undefined
const fetchCalls: { url: string; authorization: string | undefined }[] = []

function req(body: unknown, token = admin.token) {
  return {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

const classicWithScopes = (scopes: string) => () =>
  new Response(JSON.stringify({ login: 'octocat' }), { status: 200, headers: { 'x-oauth-scopes': scopes } })

describe('Secret save validation with an injected validator', () => {
  beforeAll(async () => {
    admin = await createTestAdmin({ prefix, canonicalAdmin: true })
    unprivileged = await createTestUser({ prefix })
    writeOnlyOperator = await createTestUser({ prefix })
    const role = await createTestRole({ prefix, permissions: ['secrets:write:integration'] })
    await assignRole({ userId: writeOnlyOperator.id, roleId: role.id, scope: 'system' })
  })

  afterAll(async () => {
    if (originalGitHubToken === undefined) delete process.env.VALIDATION_TEST_KEY
    else process.env.VALIDATION_TEST_KEY = originalGitHubToken
    await cleanupTestRbac(prefix)
  })

  beforeEach(async () => {
    process.env.FICUS_ENCRYPTION_KEY = encryptionKey
    delete process.env.VALIDATION_TEST_KEY
    await db.delete(secrets)
    resetSecretGroups()
    resetSecretStore()
    await getSecretStore().initialize()
    githubResponse = () => Response.json({ login: 'octocat' })
    fetchCalls.length = 0
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), authorization: (init?.headers as Record<string, string>)?.authorization })
      if (String(input).startsWith('https://api.github.com/')) return githubResponse()
      throw new Error(`Unexpected validation request: ${String(input)}`)
    }) as unknown as typeof fetch
    // Inject at the validator boundary. Process-wide fetch replacement counted
    // unrelated local-event traffic as validation and failed depending on timing.
    validatorSpy = spyOn(secretValidators, 'getSecretValidator').mockImplementation((key: string) => {
      const validator = key === 'VALIDATION_TEST_KEY' ? validateGitHubToken : getValidator(key)
      return validator === validateGitHubToken
        ? (candidate: string) => validateGitHubToken(candidate, { fetchImpl })
        : validator
    })
  })

  afterEach(() => {
    validatorSpy?.mockRestore()
    validatorSpy = undefined
    mock.restore()
  })

  test('GitHub webhook material is inaccessible through legacy secret APIs', async () => {
    for (const key of ['GITHUB_WEBHOOK_SECRET', '__integration-webhook:github']) {
      await getSecretStore().set(key, 'hidden-webhook-material')
      expect((await app.request(`/secrets/${key}`, { headers: authHeaders(admin.token) })).status).toBe(404)
      expect((await app.request(`/secrets/${key}`, req({ value: 'replacement' }))).status).toBe(
        key.startsWith('__') ? 404 : 400
      )
      expect(
        (await app.request(`/secrets/${key}`, { method: 'DELETE', headers: authHeaders(admin.token) })).status
      ).toBe(404)
      expect(getSecretStore().get(key)).toBe('hidden-webhook-material')
    }
    const list = await app.request('/secrets', { headers: authHeaders(admin.token) })
    expect(JSON.stringify(await list.json())).not.toContain('webhook')
  })

  test('valid classic token saves with identity and scopes', async () => {
    githubResponse = classicWithScopes('repo, gist')
    const response = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: 'candidate' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      key: 'VALIDATION_TEST_KEY',
      updated: true,
      validation: { status: 'valid', login: 'octocat', tokenType: 'classic', scopes: ['repo', 'gist'], warnings: [] },
    })
    expect(getSecretStore().get('VALIDATION_TEST_KEY')).toBe('candidate')
  })

  test('401 rejects even with force and does not call the store', async () => {
    githubResponse = () => new Response('', { status: 401 })
    const store = getSecretStore()
    const set = spyOn(store, 'set')
    for (const body of [{ value: 'bad' }, { value: 'bad', force: true }]) {
      const response = await app.request('/secrets/VALIDATION_TEST_KEY', req(body))
      expect(response.status).toBe(409)
      const payload = (await response.json()) as { error: string; validation: { status: string } }
      expect(payload.error).toContain('NOT saved')
      expect(payload.validation.status).toBe('invalid')
    }
    expect(set).not.toHaveBeenCalled()
    expect(store.get('VALIDATION_TEST_KEY')).toBeUndefined()
  })

  test('missing repo scope requires strict force true', async () => {
    githubResponse = classicWithScopes('gist')
    for (const force of [undefined, false, 1, 'true']) {
      const response = await app.request(
        '/secrets/VALIDATION_TEST_KEY',
        req({ value: 'narrow', ...(force === undefined ? {} : { force }) })
      )
      expect(response.status).toBe(409)
      expect(((await response.json()) as { validation: { status: string } }).validation.status).toBe('valid')
      expect(getSecretStore().get('VALIDATION_TEST_KEY')).toBeUndefined()
    }
    const forced = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: 'narrow', force: true }))
    expect(forced.status).toBe(200)
    expect(getSecretStore().get('VALIDATION_TEST_KEY')).toBe('narrow')
  })

  test('network failures save as unverified', async () => {
    githubResponse = () => {
      throw new TypeError('fetch failed')
    }
    const response = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: 'candidate' }))
    expect(response.status).toBe(200)
    expect(((await response.json()) as { validation: { status: string } }).validation.status).toBe('unverified')
    expect(getSecretStore().get('VALIDATION_TEST_KEY')).toBe('candidate')
  })

  test('only exact empty values skip validation and whitespace is passed unchanged', async () => {
    const empty = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: '' }))
    expect(empty.status).toBe(200)
    expect('validation' in ((await empty.json()) as object)).toBe(false)
    expect(fetchCalls).toHaveLength(0)

    const whitespace = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: '  ' }))
    expect(whitespace.status).toBe(200)
    expect(fetchCalls[0].authorization).toBe('Bearer   ')
  })

  test('unrelated HTTP traffic does not count as secret validation', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unrelated') })
    try {
      const unrelated = await fetch(server.url)
      expect(await unrelated.text()).toBe('unrelated')
      const response = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: '' }))
      expect(response.status).toBe(200)
      expect(fetchCalls).toHaveLength(0)
    } finally {
      await server.stop(true)
    }
  })

  test('non-GitHub keys skip validation', async () => {
    const response = await app.request('/secrets/DEPLOY_TEST_TOKEN', req({ value: 'x' }))
    expect(response.status).toBe(200)
    expect('validation' in ((await response.json()) as object)).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  test('validates candidate and leaves stored value on rejection', async () => {
    await getSecretStore().set('VALIDATION_TEST_KEY', 'old-value', 'test')
    githubResponse = () => new Response('', { status: 401 })
    const response = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: 'candidate' }))
    expect(response.status).toBe(409)
    expect(fetchCalls[0].authorization).toBe('Bearer candidate')
    expect(getSecretStore().get('VALIDATION_TEST_KEY')).toBe('old-value')
  })

  test('retired GitHub tokens cannot be configured through secrets', async () => {
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN_PERSONAL', 'GITHUB_USER', 'DEPLOY_GITHUB_PAGES_TOKEN']) {
      const response = await app.request(`/secrets/${key}`, req({ value: 'candidate' }))
      expect(response.status).toBe(400)
      expect(getSecretStore().get(key)).toBeUndefined()
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('authorization runs before validation', async () => {
    const response = await app.request('/secrets/VALIDATION_TEST_KEY', req({ value: 'candidate' }, unprivileged.token))
    expect(response.status).toBe(403)
    expect(fetchCalls).toHaveLength(0)
  })
})
