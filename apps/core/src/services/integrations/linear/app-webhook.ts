import { createHmac, timingSafeEqual } from 'crypto'
import type { WebhookContext, WebhookHandler, WebhookProcessor } from '../../webhooks/types'
import { getSecretStore } from '../../secrets'
import { resolveLinearAppWebhookSettings } from '../authorization/client-credentials'
import { processLinearAppEvent } from './app-ingress'

/** Linear recommends rejecting deliveries whose `webhookTimestamp` is more than a minute from now. */
export const LINEAR_WEBHOOK_MAX_AGE_MS = 60_000
/** App webhook categories whose payloads name the OAuth client they were sent for. */
const CLIENT_SCOPED_EVENTS = new Set(['AgentSessionEvent', 'AppUserNotification', 'PermissionChange', 'OAuthApp'])

/** Checks a signature-verified app delivery: freshness, header and body type agreement, and client ID. */
export function verifyLinearAppDelivery(
  ctx: Pick<WebhookContext, 'headers' | 'payload'>,
  clientId: string,
  now = Date.now()
): string | null {
  const timestamp = ctx.payload.webhookTimestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Math.abs(now - timestamp) > LINEAR_WEBHOOK_MAX_AGE_MS)
    return 'Stale or missing webhook timestamp'
  const eventType = ctx.headers['linear-event']
  if (!eventType || ctx.payload.type !== eventType) return 'Event type does not match the signed body'
  if (CLIENT_SCOPED_EVENTS.has(eventType) && ctx.payload.oauthClientId !== clientId)
    return 'Delivery is for another OAuth application'
  if (!ctx.headers['linear-delivery']) return 'Missing delivery ID'
  return null
}

/**
 * The Linear agent app's webhook (`POST /api/webhooks/linear-app`), for self-hosted instances with
 * their own Linear OAuth application. Its secret, replay policy and authority stay separate from
 * the organization webhook at `/api/webhooks/linear`.
 */
export const linearAppProcessor: WebhookProcessor = {
  provider: 'linear-app',
  integration: 'linear',

  async verifySignature(ctx, secret) {
    const signature = ctx.headers['linear-signature']
    if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false
    const computed = createHmac('sha256', secret).update(ctx.rawBody).digest()
    return timingSafeEqual(computed, Buffer.from(signature, 'hex'))
  },

  getEventType(ctx) {
    return ctx.headers['linear-event'] || 'unknown'
  },

  // Fails closed: without a configured self-hosted app (and always on hosted instances) nothing verifies.
  getSecret() {
    return resolveLinearAppWebhookSettings(getSecretStore())?.webhookSecret ?? null
  },

  verifyDelivery(ctx) {
    const settings = resolveLinearAppWebhookSettings(getSecretStore())
    return settings ? verifyLinearAppDelivery(ctx, settings.clientId) : 'Linear app is not configured'
  },

  getDeliveryId(ctx) {
    return ctx.headers['linear-delivery']?.slice(0, 200) || undefined
  },
}

/** Runs off the response path, after the verified delivery row has committed. */
export const handleLinearAppEvent: WebhookHandler = async (ctx) => {
  await processLinearAppEvent({ type: ctx.eventType, payload: ctx.payload })
}
