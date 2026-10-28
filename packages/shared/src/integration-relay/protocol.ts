import { z } from 'zod'
import { OAUTH_BROKER_SCOPES } from '../oauth-broker/protocol'
import { MANAGED_BIGBRAIN_SCOPES } from '../managed-bigbrain'

export const INTEGRATION_RELAY_SCOPES = ['integrations.events:subscribe', 'integrations.events:consume'] as const
export const INSTANCE_INTEGRATION_SCOPES = [
  ...OAUTH_BROKER_SCOPES,
  ...INTEGRATION_RELAY_SCOPES,
  ...MANAGED_BIGBRAIN_SCOPES,
] as const
export type IntegrationRelayScope = (typeof INTEGRATION_RELAY_SCOPES)[number]
export const RELAY_MAX_PAYLOAD_BYTES = 1024 * 1024
export const RELAY_BATCH_SIZE = 10
export const RELAY_MAX_RESPONSE_BYTES = 12 * 1024 * 1024
export const RELAY_SUBSCRIPTION_TTL_MS = 24 * 60 * 60_000
export const RELAY_EVENT_TTL_MS = 72 * 60 * 60_000
export const RELAY_LEASE_MS = 120_000

export const githubRepositoryKey = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1]!))
  .transform((value) => value.toLowerCase())
const connectionId = z.string().uuid()
const connectionRevision = z.string().uuid()
const accessToken = z.string().min(1).max(16_384)
export const relayStatusRequest = z.object({}).strict()
export const relayStatusResponse = z
  .object({
    enabled: z.boolean(),
    connections: z.array(z.object({ connectionId, connectionRevision }).strict()).max(100),
  })
  .strict()
export const relaySubscribeRequest = z
  .object({
    connectionId,
    connectionRevision,
    accessToken,
    repositories: z.array(githubRepositoryKey).min(1).max(100),
  })
  .strict()
export const relayUnsubscribeRequest = z.object({ connectionId, connectionRevision }).strict()
export const relaySuccessResponse = z.object({ ok: z.literal(true) }).strict()
export const relayPullRequest = z.object({ connectionId, connectionRevision, accessToken }).strict()

/**
 * Shared shape for a leased delivery envelope, parameterized by provider-specific
 * resource identity and event-type schemas. `relayDelivery` (GitHub) and
 * `slackRelayDelivery` are both instances of this factory; every other field
 * (id/leaseToken/connectionId/connectionRevision/deliveryId/payload) is identical
 * across providers.
 */
function relayDeliveryEnvelope<
  ResourceId extends z.ZodTypeAny,
  ResourceKey extends z.ZodTypeAny,
  EventType extends z.ZodTypeAny,
>(resourceId: ResourceId, resourceKey: ResourceKey, eventType: EventType) {
  return z
    .object({
      id: z.string().uuid(),
      leaseToken: z.string().uuid(),
      connectionId,
      connectionRevision,
      deliveryId: z.string().min(1).max(100),
      resourceId,
      resourceKey,
      eventType,
      payload: z.record(z.string(), z.unknown()),
    })
    .strict()
}

export const relayDelivery = relayDeliveryEnvelope(
  z.string().regex(/^[1-9][0-9]{0,19}$/),
  githubRepositoryKey,
  z.string().regex(/^[a-z_]{1,64}$/)
)
export const relayPullResponse = z.object({ deliveries: z.array(relayDelivery).max(RELAY_BATCH_SIZE) }).strict()
export const relayAckRequest = z
  .object({
    connectionId,
    connectionRevision,
    deliveries: z
      .array(z.object({ id: z.string().uuid(), leaseToken: z.string().uuid() }).strict())
      .max(RELAY_BATCH_SIZE),
  })
  .strict()
export type RelayDelivery = z.infer<typeof relayDelivery>

/** Provider keys accepted at `/api/integration-relay/<provider>/...` route paths. */
export const RELAY_PROVIDER_KEYS = ['github', 'slack'] as const
export type RelayProviderKey = (typeof RELAY_PROVIDER_KEYS)[number]

// ---- Slack -----------------------------------------------------------------
//
// Slack workspace ("team") ids, e.g. `T0123ABCD`. Used as both the relay
// resourceId (there is exactly one team per connection) and resourceKey (all
// events for a connection share that team).
export const slackTeamId = z.string().regex(/^T[A-Z0-9]{2,30}$/)

/**
 * The platform derives the team identity from the token itself (via
 * `auth.test`) and proves the token belongs to our app (via `bots.info`)
 * rather than trusting a client-declared team id or repository-style list.
 */
export const slackRelaySubscribeRequest = z.object({ connectionId, connectionRevision, accessToken }).strict()

/** Identical shape to the GitHub pull request; reused rather than duplicated. */
export const slackRelayPullRequest = relayPullRequest

export const SLACK_RELAY_EVENT_TYPES = ['event_callback', 'slash_command', 'app_uninstalled', 'tokens_revoked'] as const
export type SlackRelayEventType = (typeof SLACK_RELAY_EVENT_TYPES)[number]

/**
 * Delivery envelope for Slack events relayed through the platform.
 *
 * - `event_callback`: `payload` is Slack's JSON Events API envelope
 *   (`{type: 'event_callback', event: {...}, ...}`); `deliveryId` is Slack's
 *   `event_id`.
 * - `slash_command`: `payload` is the form-decoded slash command fields as a
 *   string record (command, text, user_id, channel_id, response_url, ...);
 *   `deliveryId` is Slack's `trigger_id`.
 * - `app_uninstalled` / `tokens_revoked`: lifecycle events with no meaningful
 *   payload beyond identifying the team; the relay delivers these so the
 *   tenant disables the connection rather than leaving a dead one active.
 */
export const slackRelayDelivery = relayDeliveryEnvelope(slackTeamId, slackTeamId, z.enum(SLACK_RELAY_EVENT_TYPES))
export const slackRelayPullResponse = z
  .object({ deliveries: z.array(slackRelayDelivery).max(RELAY_BATCH_SIZE) })
  .strict()
export type SlackRelayDelivery = z.infer<typeof slackRelayDelivery>
