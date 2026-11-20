import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, webhookEvents } from '../../../db'
import { webhooksRouter } from '../../../routes/webhooks'
import { getSecretStore } from '../../secrets'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'
import { webhookRegistry } from '../../webhooks'
import type { WebhookContext } from '../../webhooks/types'
import { SELF_HOSTED_OAUTH_APP_KEY } from '../authorization/client-credentials'
import { linearAppProcessor, verifyLinearAppDelivery } from './app-webhook'
import { CLIENT_ID, WEBHOOK_SECRET } from './testing/app-fixtures'
import { agentSessionCreatedPayload, oauthAppRevokedPayload, signedLinearDelivery } from './testing/fake-linear'

const app = new Hono().route('/api/webhooks', webhooksRouter)
const context = { organizationId: randomUUID(), oauthClientId: CLIENT_ID, appUserId: randomUUID() }
const payload = () =>
  agentSessionCreatedPayload(context, { sessionId: randomUUID(), creatorId: randomUUID(), issue: null })

let handled: WebhookContext[] = []
let release: () => void = () => {}
let gate: Promise<void> = Promise.resolve()

beforeAll(async () => {
  await getSecretStore().initialize()
  // Schema push skips partial indexes; delivery deduplication needs the migration's unique index.
  await ensureQueryIndex('uq_webhook_events_provider_delivery')
  webhookRegistry.registerProcessor(linearAppProcessor)
  // Processing is held open: the response must not wait for it.
  webhookRegistry.registerHandler('linear-app', '*', async (ctx) => {
    handled.push(ctx)
    await gate
  })
})
afterAll(() => {
  release()
})
beforeEach(async () => {
  handled = []
  gate = new Promise((resolve) => (release = resolve))
  await getSecretStore().set(
    SELF_HOSTED_OAUTH_APP_KEY.linear,
    JSON.stringify({
      version: 1,
      clientId: CLIENT_ID,
      clientSecret: 'linear-client-secret',
      webhookSecret: WEBHOOK_SECRET,
      capabilitiesAcknowledged: true,
    }),
    'test'
  )
})
afterEach(async () => {
  release()
  await getSecretStore().delete(SELF_HOSTED_OAUTH_APP_KEY.linear)
})

function post(delivery: { body: string; headers: Record<string, string> }) {
  return app.request('/api/webhooks/linear-app', { method: 'POST', body: delivery.body, headers: delivery.headers })
}
async function stored(deliveryId: string) {
  return db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, deliveryId)))
}

describe('POST /api/webhooks/linear-app', () => {
  test('a signed, fresh delivery is stored and answered before processing finishes', async () => {
    const deliveryId = randomUUID()
    const response = await post(signedLinearDelivery(payload(), WEBHOOK_SECRET, { deliveryId }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ received: true, eventType: 'AgentSessionEvent' })
    // The handler started but is still blocked: the 200 did not wait for it.
    await Bun.sleep(10)
    expect(handled).toHaveLength(1)
    expect(await stored(deliveryId)).toHaveLength(1)
    expect((await stored(deliveryId))[0]).toMatchObject({ verified: true, processedAt: null })
  })

  test('a repeated Linear-Delivery is acknowledged without processing it again', async () => {
    const deliveryId = randomUUID()
    const body = payload()
    await post(signedLinearDelivery(body, WEBHOOK_SECRET, { deliveryId }))
    const again = await post(signedLinearDelivery(body, WEBHOOK_SECRET, { deliveryId }))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ received: true, duplicate: true })
    await Bun.sleep(10)
    expect(handled).toHaveLength(1)
    expect(await stored(deliveryId)).toHaveLength(1)
  })

  test('a bad signature is rejected and never processed', async () => {
    const delivery = signedLinearDelivery(payload(), 'another-secret')
    expect((await post(delivery)).status).toBe(401)
    const wrongShape = signedLinearDelivery(payload(), WEBHOOK_SECRET)
    expect((await post({ ...wrongShape, headers: { ...wrongShape.headers, 'linear-signature': 'zz' } })).status).toBe(
      401
    )
    expect(handled).toEqual([])
  })

  test('stale deliveries, mismatched types and other OAuth clients are rejected', async () => {
    const stale = signedLinearDelivery(payload(), WEBHOOK_SECRET, { timestamp: Date.now() - 61_000 })
    expect((await post(stale)).status).toBe(400)
    const retyped = signedLinearDelivery(payload(), WEBHOOK_SECRET, { eventHeader: 'Issue' })
    expect((await post(retyped)).status).toBe(400)
    const foreign = signedLinearDelivery({ ...payload(), oauthClientId: 'another-client' }, WEBHOOK_SECRET)
    expect((await post(foreign)).status).toBe(400)
    const revoked = signedLinearDelivery({ ...oauthAppRevokedPayload(context), oauthClientId: 'x' }, WEBHOOK_SECRET)
    expect((await post(revoked)).status).toBe(400)
    expect(handled).toEqual([])
  })

  test('without a configured app the endpoint fails closed', async () => {
    await getSecretStore().delete(SELF_HOSTED_OAUTH_APP_KEY.linear)
    const response = await post(signedLinearDelivery(payload(), WEBHOOK_SECRET))
    expect(response.status).toBe(503)
    expect(handled).toEqual([])
  })
})

test('delivery checks: freshness window, header and body type, client ID, delivery ID', () => {
  const now = 1_800_000_000_000
  const ctx = (body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
    payload: { type: 'AgentSessionEvent', oauthClientId: CLIENT_ID, webhookTimestamp: now, ...body },
    headers: { 'linear-event': 'AgentSessionEvent', 'linear-delivery': 'd', ...headers },
  })
  expect(verifyLinearAppDelivery(ctx({}), CLIENT_ID, now)).toBeNull()
  expect(verifyLinearAppDelivery(ctx({ webhookTimestamp: now - 60_001 }), CLIENT_ID, now)).toContain('Stale')
  expect(verifyLinearAppDelivery(ctx({ webhookTimestamp: undefined }), CLIENT_ID, now)).toContain('Stale')
  expect(verifyLinearAppDelivery(ctx({ type: 'Issue' }), CLIENT_ID, now)).toContain('type')
  expect(verifyLinearAppDelivery(ctx({ oauthClientId: 'other' }), CLIENT_ID, now)).toContain('OAuth')
  expect(verifyLinearAppDelivery(ctx({}, { 'linear-delivery': '' }), CLIENT_ID, now)).toContain('delivery')
  // Data-change events carry no client ID; the signature and organization still bind them.
  expect(
    verifyLinearAppDelivery(
      ctx({ type: 'Issue', oauthClientId: undefined }, { 'linear-event': 'Issue' }),
      CLIENT_ID,
      now
    )
  ).toBeNull()
})
