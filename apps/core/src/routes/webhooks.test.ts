import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
import { afterEach, describe, it, expect, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { identityMiddleware } from '../middleware'
import { webhookRegistry } from '../services/webhooks'
import { assignRole, authHeaders, cleanupTestRbac, createTestRole, createTestUser } from '../test-utils/rbac'
import { webhooksRouter, webhooksStatusRouter } from './webhooks'
import { db } from '../db'
import { agents, schedules, squadActivity, squadSourceConfigs, squads, webhookEvents, workStreams } from '../db/schema'
import { Schedule } from '../entities/Schedule'
import { hashWebhookToken } from '../lib/utils'
import { eq, sql } from 'drizzle-orm'
import * as activityMaterialize from '../services/squad-activity/materialize'
import { systemTokens } from '../db/schema'
import { getSecretStore, resetSecretStore } from '../services/secrets'
import { SYSTEM_TOKEN_PREFIX, webhookScriptAuthEnv } from '../services/auth/system-tokens'

function createApp() {
  return new Hono()
    .route('/api/webhooks', webhooksRouter)
    .use('/api/*', identityMiddleware)
    .route('/api/webhooks', webhooksStatusRouter)
}

describe('schedule webhook error boundary', () => {
  const app = createApp()

  it('executes a webhook-enabled schedule that was ordinarily disabled', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `webhook-disabled-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const token = 'whsec_manual-disabled'
    const [row] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: agent.id,
        name: 'Manual disabled webhook',
        enabled: false,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
        webhookEnabled: true,
        webhookTokenHash: hashWebhookToken(token),
      })
      .returning()
    try {
      const response = await app.request(`/api/webhooks/trigger/${row.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status).toBe(200)
      const current = await Schedule.mustFind(row.id)
      expect(current).toMatchObject({ enabled: false, webhookEnabled: true, triggerCount: 1, failureCount: 0 })
      expect(current.lastSuccessAt).toBeInstanceOf(Date)
    } finally {
      await db.delete(schedules).where(eq(schedules.id, row.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })

  it('never returns raw pre-action errors', async () => {
    const [squad] = await db
      .insert(squads)
      .values({ name: `webhook-safe-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    const [agent] = await db.insert(agents).values({ agentTypeId: 'engineer', squadId: squad.id }).returning()
    const token = 'whsec_test-safe-token'
    const [row] = await db
      .insert(schedules)
      .values({
        scopeType: 'agent',
        scopeId: agent.id,
        name: 'Webhook safety',
        enabled: true,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
        webhookEnabled: true,
        webhookTokenHash: hashWebhookToken(token),
      })
      .returning()
    const trigger = spyOn(Schedule.prototype, 'triggerViaWebhook').mockRejectedValueOnce(
      new Error('Bearer webhook-secret postgres://user:password@database/internal')
    )
    try {
      const response = await app.request(`/api/webhooks/trigger/${row.id}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ context: { event: 'test' } }),
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'Scheduled action failed. Inspect Core logs for details.' })
    } finally {
      trigger.mockRestore()
      await db.delete(schedules).where(eq(schedules.id, row.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    }
  })
})

describe('webhooks channel routes', () => {
  const app = createApp()

  afterEach(async () => {
    webhookRegistry.clear()
    await cleanupTestRbac('webhooks-rbac')
  })

  it('refuses to process a standard webhook when the provider has no secret configured', async () => {
    // verifySignature would return true, but with no secret the sender cannot be
    // authenticated — the receiver must fail closed (503), not run handlers.
    webhookRegistry.registerProcessor({
      provider: 'nosecret-provider',
      verifySignature: async () => true,
      getEventType: () => 'ping',
      getSecret: () => null,
    })
    const res = await app.request('/api/webhooks/nosecret-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(res.status).toBe(503)
  })

  it('preserves exact authenticated headers and raw body through shared dispatch', async () => {
    let resolveHandled!: (value: { headers: Record<string, string>; rawBody: string }) => void
    const handled = new Promise<{ headers: Record<string, string>; rawBody: string }>((resolve) => {
      resolveHandled = resolve
    })
    webhookRegistry.registerProcessor({
      provider: 'context-provider',
      verifySignature: async () => true,
      getEventType: () => 'Thing',
      getSecret: () => 'configured',
    })
    webhookRegistry.registerHandler('context-provider', 'Thing', async (ctx) => {
      resolveHandled({ headers: ctx.headers, rawBody: ctx.rawBody })
    })
    const rawBody = '{\n  "hello": "world"\n}'

    const response = await app.request('/api/webhooks/context-provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-linear-event': 'Thing', 'x-custom': 'preserved' },
      body: rawBody,
    })

    expect(response.status).toBe(200)
    const context = await handled
    expect(context.rawBody).toBe(rawBody)
    expect(context.headers).toMatchObject({ 'x-linear-event': 'Thing', 'x-custom': 'preserved' })
  })

  it('queues Activity after verified storage independently of handler failure', async () => {
    const repository = `activity-route-${crypto.randomUUID()}/widgets`
    const [squad] = await db
      .insert(squads)
      .values({ name: `webhook-activity-${crypto.randomUUID()}`, purpose: 'test' })
      .returning()
    await db.insert(squadSourceConfigs).values({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: [repository] } },
    })
    await db.insert(workStreams).values({
      squadId: squad.id,
      title: 'Webhook handler failure',
      metadata: { github: { repo: repository, pr: { number: 42 } } },
    })
    webhookRegistry.registerProcessor({
      provider: 'github',
      verifySignature: async () => true,
      getEventType: () => 'pull_request',
      getSecret: () => 'configured',
    })
    webhookRegistry.registerHandler('github', 'pull_request', async () => {
      throw new Error('unrelated handler failed')
    })
    try {
      const response = await app.request('/api/webhooks/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-delivery': 'route-delivery' },
        body: JSON.stringify({
          action: 'closed',
          number: 42,
          repository: { full_name: repository },
          pull_request: {
            id: 4200,
            number: 42,
            closed_at: '2026-08-27T00:00:00Z',
            html_url: `https://github.com/${repository}/pull/42`,
          },
        }),
      })
      expect(response.status).toBe(200)
      let rows: Array<typeof squadActivity.$inferSelect> = []
      for (let attempt = 0; attempt < 50 && rows.length === 0; attempt++) {
        await Bun.sleep(10)
        rows = await db.select().from(squadActivity).where(eq(squadActivity.squadId, squad.id))
      }
      expect(rows).toHaveLength(1)
      expect(rows[0].sourceGroupId).toStartWith('hook:')
    } finally {
      await db.delete(squadActivity).where(eq(squadActivity.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(webhookEvents).where(sql`${webhookEvents.payload}->'repository'->>'full_name'=${repository}`)
    }
  })

  it('keeps successful GitHub handling and HTTP independent of projection failure', async () => {
    const repository = `activity-projection-failure-${crypto.randomUUID()}/widgets`
    const projection = spyOn(activityMaterialize, 'materializeGitHubWebhook').mockRejectedValueOnce(
      new Error('projection failed')
    )
    let handled = false
    webhookRegistry.registerProcessor({
      provider: 'github',
      verifySignature: async () => true,
      getEventType: () => 'pull_request',
      getSecret: () => 'configured',
    })
    webhookRegistry.registerHandler('github', 'pull_request', async () => {
      handled = true
    })
    try {
      const response = await app.request('/api/webhooks/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-delivery': 'projection-failure' },
        body: JSON.stringify({
          action: 'closed',
          number: 42,
          repository: { full_name: repository },
          pull_request: { id: 4200, number: 42, closed_at: '2026-08-27T00:00:00Z' },
        }),
      })
      expect(response.status).toBe(200)
      for (let attempt = 0; attempt < 50 && (!handled || projection.mock.calls.length === 0); attempt++)
        await Bun.sleep(10)
      expect(handled).toBe(true)
      expect(projection).toHaveBeenCalledTimes(1)
    } finally {
      projection.mockRestore()
      await db.delete(webhookEvents).where(sql`${webhookEvents.payload}->'repository'->>'full_name'=${repository}`)
    }
  })

  it('does not queue GitHub Activity for an unverified request', async () => {
    const projection = spyOn(activityMaterialize, 'materializeGitHubWebhook')
    webhookRegistry.registerProcessor({
      provider: 'github',
      verifySignature: async () => false,
      getEventType: () => 'pull_request',
      getSecret: () => 'configured',
    })
    try {
      const response = await app.request('/api/webhooks/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'closed' }),
      })
      expect(response.status).toBe(401)
      await Bun.sleep(0)
      expect(projection).not.toHaveBeenCalled()
    } finally {
      projection.mockRestore()
    }
  })

  it('an unsigned webhook cannot trigger the webhook-token self-heal; a verified one does', async () => {
    const priorKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorKey ?? '0'.repeat(64)
    resetSecretStore()
    await getSecretStore().initialize()
    const legacy = 'tau_sys_' + 'd'.repeat(43)
    await getSecretStore().set('__SYSTEM_WEBHOOK_TOKEN', legacy, 'system')
    let verified = false
    let handled!: () => void
    const ran = new Promise<void>((resolve) => (handled = resolve))
    let handlerCalls = 0
    webhookRegistry.registerProcessor({
      provider: 'selfheal-provider',
      verifySignature: async () => verified,
      getEventType: () => 'Thing',
      getSecret: () => 'configured',
    })
    // Real handlers reach the self-heal only through webhookScriptAuthEnv().
    webhookRegistry.registerHandler('selfheal-provider', 'Thing', async () => {
      handlerCalls++
      await webhookScriptAuthEnv()
      handled()
    })
    const post = () =>
      app.request('/api/webhooks/selfheal-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      })
    try {
      const unsigned = await post()
      expect(unsigned.status).toBe(401)
      await Bun.sleep(10)
      expect(handlerCalls).toBe(0)
      expect(getSecretStore().get('__SYSTEM_WEBHOOK_TOKEN')).toBe(legacy)

      verified = true
      expect((await post()).status).toBe(200)
      await ran
      expect(getSecretStore().get('__SYSTEM_WEBHOOK_TOKEN')?.startsWith(SYSTEM_TOKEN_PREFIX)).toBe(true)
    } finally {
      await getSecretStore()
        .delete('__SYSTEM_WEBHOOK_TOKEN')
        .catch(() => {})
      await db.delete(systemTokens).where(eq(systemTokens.kind, 'webhook'))
      if (priorKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorKey
      resetSecretStore()
    }
  })

  it('handles Slack channel webhooks at the canonical shared slash/events URL', async () => {
    const res = await app.request('/api/webhooks/channels/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'event_callback', team_id: 'T123', event: { type: 'app_mention' } }),
    })

    // The Slack provider handles this route. Without channel routing, this
    // request would be routed to the generic webhook handler and return 404 as
    // an unknown provider.
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid signature' })
  })

  it('requires webhooks:read for standard webhook status', async () => {
    const noAuth = await app.request('/api/webhooks/github/status')
    expect(noAuth.status).toBe(401)

    webhookRegistry.registerProcessor({
      provider: 'test-provider',
      verifySignature: async () => true,
      getEventType: () => 'test',
      getSecret: () => null,
    })
    const user = await createTestUser({ prefix: 'webhooks-rbac' })
    const role = await createTestRole({ prefix: 'webhooks-rbac', permissions: ['webhooks:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const allowed = await app.request('/api/webhooks/test-provider/status', { headers: authHeaders(user.token) })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ provider: 'test-provider', type: 'standard', registered: true })
  })

  it('requires webhooks:read for channel webhook status', async () => {
    const noAuth = await app.request('/api/webhooks/channels/slack/status')
    expect(noAuth.status).toBe(401)

    const unprivileged = await createTestUser({ prefix: 'webhooks-rbac' })
    const forbidden = await app.request('/api/webhooks/channels/slack/status', {
      headers: authHeaders(unprivileged.token),
    })
    expect(forbidden.status).toBe(403)

    const user = await createTestUser({ prefix: 'webhooks-rbac' })
    const role = await createTestRole({ prefix: 'webhooks-rbac', permissions: ['webhooks:read'] })
    await assignRole({ userId: user.id, roleId: role.id, scope: 'system' })

    const allowed = await app.request('/api/webhooks/channels/slack/status', { headers: authHeaders(user.token) })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ provider: 'slack', type: 'channel', registered: true })
  })
})
