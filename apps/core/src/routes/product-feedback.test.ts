import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { PLACEHOLDER_OWNER_EMAIL } from '@ficus/shared'
import type { Identity } from '../services/rbac'
import { createProductFeedbackRouter } from './product-feedback'
import { ProductFeedbackService } from '../services/platform/product-feedback'

const RELAY_TOKEN = `ficus_pri_00000000-0000-4000-8000-000000000002_${'r'.repeat(43)}`
const CLOUD_TOKEN = 'synthetic-cloud-tenant-credential'
const REPORT_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'

function setup(
  options: {
    identity?: Identity
    managed?: boolean
    relay?: { baseUrl: string; token: string } | null
    user?: { displayName: string | null; email: string } | null
    respond?: () => Response
  } = {}
) {
  const sent: unknown[] = []
  const authorizations: string[] = []
  const lookups: string[] = []
  const service = new ProductFeedbackService({
    managed: () => options.managed ?? false,
    cloudConfig: () => ({ baseUrl: 'https://platform.example.test', token: CLOUD_TOKEN }),
    relayConfig: () =>
      options.relay === undefined ? { baseUrl: 'https://relay.example.test', token: RELAY_TOKEN } : options.relay,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)))
      authorizations.push(new Headers(init.headers).get('authorization') ?? '')
      return options.respond ? options.respond() : Response.json({ id: REPORT_ID }, { status: 201 })
    },
    coreVersion: '1.2.3-test',
  })
  const app = new Hono()
  app.use('*', async (c, next) => {
    const identity = options.identity === undefined ? { type: 'user' as const, userId: USER_ID } : options.identity
    if (identity) c.set('identity', identity)
    await next()
  })
  app.route(
    '/api/product-feedback',
    createProductFeedbackRouter({
      service,
      findUser: async (userId) => {
        lookups.push(userId)
        return options.user === undefined ? { displayName: 'Ada Example', email: 'ada@example.test' } : options.user
      },
    })
  )
  const post = (body: unknown) =>
    app.request('/api/product-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  return { app, post, sent, authorizations, lookups }
}

const valid = {
  category: 'ai-response',
  message: '  The assistant answered a different question.  ',
  includeSubmitter: true,
  page: '/squads/abc',
}

describe('POST /api/product-feedback', () => {
  test('forwards a trimmed report with the signed-in person and context', async () => {
    const { post, sent, lookups } = setup()
    const response = await post(valid)
    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ id: REPORT_ID })
    expect(lookups).toEqual([USER_ID])
    expect(sent).toEqual([
      {
        category: 'ai-response',
        message: 'The assistant answered a different question.',
        submitter: { name: 'Ada Example', email: 'ada@example.test' },
        context: { coreVersion: '1.2.3-test', page: '/squads/abc' },
      },
    ])
  })

  test('opt-out sends no submitter details and does not read the account', async () => {
    const { post, sent, lookups } = setup()
    expect((await post({ ...valid, includeSubmitter: false })).status).toBe(201)
    expect(lookups).toEqual([])
    expect(sent[0]).not.toHaveProperty('submitter')
    expect(JSON.stringify(sent[0])).not.toContain('ada@example.test')
    expect(JSON.stringify(sent[0])).not.toContain('Ada Example')
  })

  test('leaves out a placeholder email and a missing name', async () => {
    const { post, sent } = setup({ user: { displayName: null, email: PLACEHOLDER_OWNER_EMAIL } })
    expect((await post(valid)).status).toBe(201)
    expect(sent[0]).not.toHaveProperty('submitter')
  })

  test.each([
    ['unknown category', { ...valid, category: 'praise' }],
    ['short message', { ...valid, message: '   too short   ' }],
    ['long message', { ...valid, message: 'x'.repeat(6001) }],
    ['missing opt-in flag', { category: 'bug', message: valid.message }],
    ['page with a query', { ...valid, page: '/settings?token=secret' }],
    ['full URL as page', { ...valid, page: 'https://example.test/settings' }],
    ['unknown key', { ...valid, conversation: 'private content' }],
    ['malformed JSON', '{"category":'],
  ])('rejects %s without contacting the platform', async (_name, body) => {
    const { post, sent } = setup()
    const response = await post(body)
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('invalid_request')
    expect(sent).toHaveLength(0)
  })

  test('uses the self-hosted connection credential and the Cloud tenant credential per mode', async () => {
    const selfHosted = setup()
    await selfHosted.post(valid)
    expect(selfHosted.authorizations).toEqual([`Bearer ${RELAY_TOKEN}`])

    const cloud = setup({ managed: true, relay: null })
    await cloud.post(valid)
    expect(cloud.authorizations).toEqual([`Bearer ${CLOUD_TOKEN}`])
  })

  test('a self-hosted instance without a connection answers not_connected', async () => {
    const { post, sent } = setup({ relay: null })
    const response = await post(valid)
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Connect this server to a Ficus account to send feedback.',
      code: 'not_connected',
    })
    expect(sent).toHaveLength(0)
  })

  test.each([
    [429, 429, 'rate_limited'],
    [401, 409, 'not_connected'],
    [503, 503, 'unavailable'],
    [400, 503, 'unavailable'],
  ])('maps platform %p to %p %p without platform details or the credential', async (status, expected, code) => {
    const { post } = setup({
      respond: () => Response.json({ error: 'internal platform detail', token: RELAY_TOKEN }, { status }),
    })
    const response = await post(valid)
    expect(response.status).toBe(expected)
    const text = await response.text()
    expect(JSON.parse(text).code).toBe(code)
    expect(text).not.toContain('internal platform detail')
    expect(text).not.toContain(RELAY_TOKEN)
  })

  test('requires a signed-in person', async () => {
    const agent = setup({ identity: { type: 'agent', agentId: USER_ID, squadId: null } })
    expect((await agent.post(valid)).status).toBe(403)
    expect(agent.sent).toHaveLength(0)
    const anonymous = setup({ identity: null as unknown as Identity })
    expect((await anonymous.post(valid)).status).toBe(403)
  })
})

describe('GET /api/product-feedback/status', () => {
  test('reports the connection without the credential', async () => {
    for (const [options, expected] of [
      [{}, { connected: true, managed: false }],
      [{ relay: null }, { connected: false, managed: false }],
      [
        { managed: true, relay: null },
        { connected: true, managed: true },
      ],
    ] as const) {
      const { app } = setup(options)
      const response = await app.request('/api/product-feedback/status')
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const text = await response.text()
      expect(JSON.parse(text)).toEqual(expected)
      expect(text).not.toContain(RELAY_TOKEN)
      expect(text).not.toContain(CLOUD_TOKEN)
    }
  })
})
