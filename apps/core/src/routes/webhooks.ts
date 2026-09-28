import { firstPartyIntegrationPlugin } from '../services/integrations/first-party-plugins'
import { isIntegrationEnabled } from '../services/integrations/provider-state'
/**
 * Webhook Routes
 *
 * Handles incoming webhooks from external providers.
 *
 * Routes:
 * - POST /webhooks/trigger/:scheduleId - Trigger a schedule via webhook
 * - POST /webhooks/channels/:provider - Channel webhooks (Discord, Slack, Telegram)
 *   Handles both slash commands and events (single URL for both)
 * - POST /webhooks/:provider - Standard webhooks (GitHub, Linear, etc.)
 */

import { Hono } from 'hono'
import {
  webhookRegistry,
  dispatchVerifiedWebhookContext,
  storeWebhookEvent,
  markWebhookProcessed,
  markWebhookError,
} from '../services/webhooks'
import { getProvider, hasProvider, InteractionResponseType } from '../channels'
import { handleDiscordInteraction } from '../channels/discord/interactions'
import { dispatchParsedChannelEvent } from '../channels/handler'
import type { ChannelProvider } from '../channels/provider'
import type { Context } from 'hono'
import { Schedule } from '../entities/Schedule'
import { createLogger } from '../lib/infra/logger'
import { requirePermission } from '../middleware/require-permission'
import type { WebhookTriggerRequest, WebhookTriggerResult } from '@ficus/shared'
import { ScheduleExecutionError } from '../services/scheduling/failure-classifier'
import { materializeGitHubWebhook, materializeWebhookActivity } from '../services/squad-activity/materialize'
import { DbEventPollingDispatchStore } from '../services/integrations/db-event-polling-dispatch-store'

const log = createLogger('webhooks')
// Durable receipts shared with the hosted Slack relay dispatcher (see
// services/integrations/relay/slack-runtime.ts): `webhook:<team>:<event>` for
// deliveries retried by Slack itself, `relay:<connectionId>:<deliveryId>` for
// deliveries retried by the platform relay. Different key prefixes, one table.
const channelWebhookReceipts = new DbEventPollingDispatchStore()

export const webhooksRouter = new Hono()
export const webhooksStatusRouter = new Hono()

// =============================================================================
// Schedule Trigger Webhooks
// =============================================================================

/**
 * Extract bearer token from Authorization header or query param.
 */
function extractToken(c: {
  req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined }
}): string | null {
  // Check Authorization header first
  const authHeader = c.req.header('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  // Fall back to query parameter
  return c.req.query('token') || null
}

/**
 * POST /webhooks/trigger/:scheduleId
 * Trigger a schedule via webhook with token authentication.
 *
 * Authentication: Bearer token in Authorization header or ?token= query param
 * Body (optional): { context: { ... } }
 */
webhooksRouter.post('/trigger/:scheduleId', async (c) => {
  const scheduleId = c.req.param('scheduleId')
  log.info(`Webhook trigger request for schedule: ${scheduleId.slice(0, 8)}`)

  // Find the schedule
  const schedule = await Schedule.find(scheduleId)
  if (!schedule) {
    return c.json({ error: 'Schedule not found' }, 404)
  }

  // Check if webhook is enabled
  if (!schedule.webhookEnabled) {
    return c.json({ error: 'Webhook not enabled for this schedule' }, 400)
  }

  // Extract and verify token
  const token = extractToken(c)
  if (!token) {
    return c.json({ error: 'Missing authentication token' }, 401)
  }

  if (!schedule.verifyToken(token)) {
    log.warn(`Invalid webhook token for schedule ${scheduleId.slice(0, 8)}`)
    return c.json({ error: 'Invalid token' }, 401)
  }

  // Intentional compatibility exception: after token verification, invalid or absent JSON means no context.
  let context: Record<string, unknown> | undefined
  try {
    const body = await c.req.json<WebhookTriggerRequest>()
    context = body.context
  } catch {
    // Invalid or absent JSON is accepted here only; context remains undefined.
  }

  // Trigger the schedule
  try {
    const result = await schedule.triggerViaWebhook(context)
    log.info(`Webhook triggered schedule ${scheduleId.slice(0, 8)} successfully`)
    return c.json(result satisfies WebhookTriggerResult)
  } catch (error) {
    log.error(`Webhook trigger failed for ${scheduleId.slice(0, 8)}:`, error)
    const message =
      error instanceof ScheduleExecutionError
        ? error.safeSummary
        : 'Scheduled action failed. Inspect Core logs for details.'
    return c.json({ error: message }, 500)
  }
})

// =============================================================================
// Channel Webhooks (Discord, Slack, Telegram → Consultant)
// =============================================================================

/**
 * POST /webhooks/channels/:provider
 * Handles slash commands, events, and mentions for all channel providers.
 */
webhooksRouter.post('/channels/:provider', async (c) => {
  const providerName = c.req.param('provider')
  log.info(`Received channel webhook from provider: ${providerName}`)

  // Get raw body for signature verification
  const rawBody = await c.req.text()
  let payload: Record<string, unknown>

  // Parse payload based on content type
  const contentType = c.req.header('content-type') || ''

  if (contentType.includes('application/x-www-form-urlencoded')) {
    // Slack slash commands
    const params = new URLSearchParams(rawBody)
    payload = Object.fromEntries(params.entries())
  } else {
    try {
      payload = JSON.parse(rawBody)
    } catch (e) {
      log.error(`[${providerName}] Failed to parse JSON: ${e}`)
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }
  }

  // Extract headers
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  // Try new provider abstraction first
  const provider = getProvider(providerName)

  if (provider) {
    // Verify signature
    const verified = await provider.verifySignature(rawBody, headers)
    if (!verified) {
      log.warn(`[${providerName}] Invalid signature`)
      return c.json({ error: 'Invalid signature' }, 401)
    }

    // Slack retries an Events API delivery (same event_id) on anything but a
    // fast 2xx. Dedup so a retry can never run the handler — and any agent
    // work it queues — a second time. Slash commands are not retried by
    // Slack and go through the ordinary path below unchanged.
    if (providerName === 'slack' && payload.type === 'event_callback') {
      const teamId = payload.team_id
      const eventId = payload.event_id
      if (typeof teamId === 'string' && typeof eventId === 'string') {
        // Parse before claiming: every channel message the bot sees would
        // otherwise insert a durable receipt row, even the vast majority
        // `parseWebhook` filters out as non-actionable. Claim only once there
        // is real handler work to dedup.
        const parsed = await provider.parseWebhook(payload, headers)
        if (!parsed || ('type' in parsed && (parsed.type === 'pong' || parsed.type === 'challenge'))) {
          return respondToParsedChannelWebhook(c, provider, providerName, payload, parsed)
        }
        const key = `webhook:${teamId}:${eventId}`
        const claim = await channelWebhookReceipts.claim('slack', key, 120_000)
        if (claim.status === 'completed') return c.json({ ok: true })
        // The first delivery is still in flight; Slack does not need another
        // retry queued behind it, and this 200 does not affect that attempt.
        if (claim.status === 'busy') return c.json({ ok: true })
        try {
          const response = await respondToParsedChannelWebhook(c, provider, providerName, payload, parsed)
          await channelWebhookReceipts.complete('slack', key, claim.leaseToken)
          return response
        } catch (error) {
          // A transient handler failure must not strand the claim for the rest
          // of its 120s lease: Slack's own retry (same event_id) needs to see
          // this as reclaimable, or the event is silently lost forever.
          await channelWebhookReceipts.release('slack', key, claim.leaseToken)
          throw error
        }
      }
    }

    return dispatchChannelWebhook(c, provider, providerName, payload, headers)
  }

  // Unknown provider
  log.warn(`Unknown channel provider: ${providerName}`)
  return c.json({ error: 'Unknown channel provider' }, 404)
})

/** The verified-webhook pipeline shared by every provider: parse, handle provider-specific acks, then dispatch the event. */
async function dispatchChannelWebhook(
  c: Context,
  provider: ChannelProvider,
  providerName: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>
) {
  const parsed = await provider.parseWebhook(payload, headers)
  return respondToParsedChannelWebhook(c, provider, providerName, payload, parsed)
}

/** Provider-specific acks (pong/challenge/Discord slash) plus the actual dispatch, given an already-parsed event. */
async function respondToParsedChannelWebhook(
  c: Context,
  provider: ChannelProvider,
  providerName: string,
  payload: Record<string, unknown>,
  parsed: Awaited<ReturnType<ChannelProvider['parseWebhook']>>
) {
  if (!parsed) {
    log.info(`[${providerName}] Non-actionable event, ignoring`)
    return c.json({ ok: true })
  }

  // Handle pong (Discord ping verification)
  if ('type' in parsed && parsed.type === 'pong') {
    log.info(`[${providerName}] Responding to PING`)
    return c.json({ type: InteractionResponseType.PONG })
  }

  // Handle challenge (Slack URL verification)
  if ('type' in parsed && parsed.type === 'challenge') {
    log.info(`[${providerName}] URL verification challenge`)
    return c.json({ challenge: parsed.value })
  }

  if (providerName === 'discord' && parsed.type === 'slash_command') {
    await handleDiscordInteraction(payload, parsed)
    return c.body(null, 202)
  }

  const result = await dispatchParsedChannelEvent(provider, payload, parsed)

  if (result.emptyResponse) {
    return c.body(null, 200)
  }

  return c.json(result.response)
}

/**
 * GET /webhooks/channels/:provider/status
 */
webhooksStatusRouter.get('/channels/:provider/status', requirePermission('webhooks:read'), async (c) => {
  const providerName = c.req.param('provider')

  if (!hasProvider(providerName)) {
    return c.json({ error: 'Unknown channel provider' }, 404)
  }

  return c.json({
    provider: providerName,
    type: 'channel',
    registered: true,
  })
})

// =============================================================================
// Standard Webhooks (GitHub, Linear, etc.)
// =============================================================================

webhooksRouter.post('/:provider', async (c) => {
  const provider = c.req.param('provider')
  log.info(`Received webhook from provider: ${provider}`)

  const rawBody = await c.req.text()
  let payload: Record<string, unknown>

  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  const processor = webhookRegistry.getProcessor(provider)
  if (!processor) {
    return c.json({ error: 'Unknown webhook provider' }, 404)
  }

  const preliminaryCtx = { provider, eventType: '', payload, headers, rawBody }
  const eventType = processor.getEventType(preliminaryCtx)
  const ctx = { ...preliminaryCtx, eventType }

  const secret = processor.getSecret()
  if (!secret) {
    // No secret configured => the sender cannot be authenticated. Record the
    // attempt but never run handlers on an unverifiable payload (fail closed).
    // This router is mounted before identity middleware, so there is no other
    // backstop — previously a missing secret was treated as "verified".
    await storeWebhookEvent({
      provider,
      eventType,
      payload,
      headers,
      signature: headers['x-hub-signature-256'] || headers['x-signature'] || null,
      verified: false,
      error: 'No webhook secret configured',
    })
    return c.json({ error: 'Webhook secret not configured' }, 503)
  }

  const verified = await processor.verifySignature(ctx, secret)
  if (!verified) {
    await storeWebhookEvent({
      provider,
      eventType,
      payload,
      headers,
      signature: headers['x-hub-signature-256'] || headers['x-signature'] || null,
      verified: false,
      error: 'Signature verification failed',
    })
    return c.json({ error: 'Invalid signature' }, 401)
  }

  if (firstPartyIntegrationPlugin(provider) && !(await isIntegrationEnabled(provider)))
    return c.json({ received: true, ignored: 'integration_disabled' })

  const eventId = await storeWebhookEvent({
    provider,
    eventType,
    payload,
    headers,
    signature: headers['x-hub-signature-256'] || headers['x-signature'] || null,
    verified: true,
  })

  const materializeActivity = () => {
    // GitHub keeps its own named entry point; both project through one engine.
    const project =
      provider === 'github'
        ? () => materializeGitHubWebhook(eventId)
        : provider === 'linear'
          ? () => materializeWebhookActivity('linear', eventId)
          : null
    if (!project) return
    queueMicrotask(() => {
      void project().catch((error) => log.error(`Activity materialization failed for ${provider}:${eventType}:`, error))
    })
  }

  // Projection is queued immediately after the verified durable row commits.
  // It is independent of handler success and never delays this response path.
  materializeActivity()

  const handlers = webhookRegistry.getHandlers(provider, eventType)
  log.info(`${provider}:${eventType} - ${handlers.length} handler(s) registered`)

  if (handlers.length === 0) {
    await markWebhookProcessed(eventId)
    return c.json({ received: true, eventType, handlers: 0 })
  }

  // Process asynchronously through the same trusted dispatch path used by
  // transport-authenticated synthetic ingress.
  ;(async () => {
    try {
      await dispatchVerifiedWebhookContext(ctx)
      await markWebhookProcessed(eventId)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      log.error(`Handler error for ${provider}:${eventType}:`, error)
      await markWebhookError(eventId, errorMsg)
    }
  })()

  return c.json({ received: true, eventType, handlers: handlers.length })
})

webhooksStatusRouter.get('/:provider/status', requirePermission('webhooks:read'), async (c) => {
  const provider = c.req.param('provider')
  const processor = webhookRegistry.getProcessor(provider)

  if (!processor) {
    return c.json({ error: 'Unknown webhook provider' }, 404)
  }

  return c.json({
    provider,
    type: 'standard',
    registered: true,
    secretConfigured: !!processor.getSecret(),
  })
})
