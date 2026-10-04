import { z } from 'zod'
import { apnsTokenSchema } from './push-relay'
import type { LiveActivityState } from './live-activity'

/** Separate from alert relay: an alert capability never authorizes ActivityKit. */
export const LIVE_ACTIVITY_RELAY_PROTOCOL = 1 as const
export const LIVE_ACTIVITY_RELAY_MAX_BODY_BYTES = 8192
export const liveActivityBindingTokenSchema = z.string().regex(/^ficus_pla_[A-Za-z0-9_-]{43}$/)
const uuid = z.string().uuid()
const sequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const count = z.number().int().nonnegative().max(2147483647)

export const relayLiveActivityStateSchema = z
  .object({
    activeCount: count,
    needsYouCount: count,
    top: z
      .array(
        z
          .object({
            id: uuid,
            number: z.number().int().positive().max(2147483647).optional(),
            title: z.string().max(200),
            bucket: z.enum(['needsYou', 'running', 'blocked', 'queued', 'paused', 'externalWait']),
            squadId: uuid,
            agentId: uuid.optional(),
          })
          .strict()
      )
      .max(3),
  })
  .strict() satisfies z.ZodType<LiveActivityState>

/** Device-signed registration, sent directly to the relay, never authenticated by Core alone.
 * activityKey is carried in immutable native attributes for both remote and local starts.
 * ActivityKit activityId is opaque and distinct from our lifecycle UUID. */
export const relayLiveActivityRegistrationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      version: z.literal(LIVE_ACTIVITY_RELAY_PROTOCOL),
      activationId: uuid,
      bindingToken: liveActivityBindingTokenSchema,
      deviceToken: apnsTokenSchema,
      environment: z.enum(['production', 'sandbox']),
      previews: z.boolean().optional(),
      kind: z.literal('start'),
    })
    .strict(),
  z
    .object({
      version: z.literal(LIVE_ACTIVITY_RELAY_PROTOCOL),
      activationId: uuid,
      bindingToken: liveActivityBindingTokenSchema,
      deviceToken: apnsTokenSchema,
      environment: z.enum(['production', 'sandbox']),
      previews: z.boolean().optional(),
      kind: z.literal('update'),
      activityKey: uuid,
      activityId: z.string().min(1).max(256),
    })
    .strict(),
])
export type RelayLiveActivityRegistration = z.infer<typeof relayLiveActivityRegistrationSchema>

/** Digest this canonical payload in the existing short-lived installation proof challenge.
 * Changing destination, environment, lifecycle or capability requires a new device signature. */
export function liveActivityRegistrationPayload(value: RelayLiveActivityRegistration): string {
  const input = relayLiveActivityRegistrationSchema.parse(value)
  return JSON.stringify([
    'ficus-live-activity-registration-v1',
    input.activationId,
    input.bindingToken,
    input.deviceToken.toLowerCase(),
    input.environment,
    input.kind,
    input.kind === 'update' ? input.activityKey : null,
    input.kind === 'update' ? input.activityId : null,
    input.previews === true,
  ])
}

const envelope = {
  version: z.literal(LIVE_ACTIVITY_RELAY_PROTOCOL),
  bindingToken: liveActivityBindingTokenSchema,
  activityKey: uuid,
  eventId: uuid,
  // Persist before I/O; retries keep all fields. Never derive ordering from an in-memory counter.
  sequence,
}
export const relayLiveActivitySendSchema = z.discriminatedUnion('event', [
  z.object({ ...envelope, event: z.literal('start'), contentState: relayLiveActivityStateSchema }).strict(),
  z.object({ ...envelope, event: z.literal('update'), contentState: relayLiveActivityStateSchema }).strict(),
  // Cleanup carries no content. The relay constructs an empty state and immediate dismissal.
  z.object({ ...envelope, event: z.literal('end') }).strict(),
])
export type RelayLiveActivitySend = z.infer<typeof relayLiveActivitySendSchema>

export const relayLiveActivityResponseSchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('sent') }).strict(),
  // Duplicate means the original provider acceptance is recorded, not merely admission.
  z.object({ version: z.literal(1), status: z.literal('duplicate') }).strict(),
  z.object({ version: z.literal(1), status: z.literal('superseded') }).strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('rejected'),
      reason: z.enum([
        'unauthorized',
        'pro_required',
        'destination_revoked',
        'conflict',
        'rate_limited',
        'in_flight',
        'provider_unavailable',
        'delivery_unknown',
      ]),
    })
    .strict(),
])
export type RelayLiveActivityResponse = z.infer<typeof relayLiveActivityResponseSchema>

export interface LiveActivityDeliveryHead {
  sequence: number
  eventId: string | null
  /** Relay-owned digest of the validated canonical request, including its binding. */
  payloadHash: string | null
  ended: boolean
  /** Delivery state is durable; admission does not imply provider acceptance. */
  outcome: 'registered' | 'in_flight' | 'sent' | 'failed' | 'unknown'
}

/** Evaluate under the installation/lifecycle lock. Caller first authenticates instance,
 * capability, current device coverage and token kind. This function alone grants no authority. */
export function orderLiveActivityDelivery(
  previous: LiveActivityDeliveryHead | null,
  input: RelayLiveActivitySend,
  payloadHash: string
): 'admit' | 'duplicate' | 'superseded' | 'conflict' | 'in_flight' | 'delivery_unknown' {
  if (!previous) return input.event === 'start' ? 'admit' : 'conflict'
  if (input.sequence === previous.sequence) {
    if (input.eventId !== previous.eventId || payloadHash !== previous.payloadHash) return 'conflict'
    if (previous.outcome === 'sent') return 'duplicate'
    if (previous.outcome === 'in_flight') return 'in_flight'
    if (previous.outcome === 'unknown') return 'delivery_unknown'
    // A definitely failed provider attempt can retry the exact event, including an end.
    return previous.outcome === 'failed' ? 'admit' : 'conflict'
  }
  if (input.eventId === previous.eventId) return 'conflict'
  if (input.sequence < previous.sequence || previous.ended) return 'superseded'
  // Never race a newer provider call against one whose completion has not been fenced.
  if (previous.outcome === 'in_flight') return 'in_flight'
  if (previous.outcome === 'unknown') return 'delivery_unknown'
  if (input.event === 'start') return 'conflict'
  return 'admit'
}

/** Safe projection used only when the device has opted into native previews. */
export function projectRelayLiveActivityState(state: LiveActivityState, previews: boolean): LiveActivityState {
  return relayLiveActivityStateSchema.parse({
    activeCount: state.activeCount,
    needsYouCount: state.needsYouCount,
    top: state.top.slice(0, 3).map((row) => ({
      id: row.id,
      ...(row.number ? { number: row.number } : {}),
      title: previews ? [...row.title].slice(0, 100).join('') : row.number ? `Work #${row.number}` : 'Work stream',
      bucket: row.bucket,
      squadId: row.squadId,
      ...(row.agentId ? { agentId: row.agentId } : {}),
    })),
  })
}

/** Provider payload from validated relay admission. `origin`, `timestamp` and coverage expiry
 * must be relay-owned; never pass values copied from an untrusted send request here. */
export function buildRelayLiveActivityPayload(
  request: RelayLiveActivitySend,
  admission: { origin: string; timestamp: number; coverageExpiresAt: number | null; previews: boolean }
): { aps: Record<string, unknown> } {
  const input = relayLiveActivitySendSchema.parse(request)
  const { timestamp, coverageExpiresAt } = admission
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('Invalid relay delivery timestamp')
  const origin = new URL(admission.origin)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash)
    throw new Error('Invalid relay instance origin')
  const content =
    input.event === 'end'
      ? { activeCount: 0, needsYouCount: 0, top: [] }
      : projectRelayLiveActivityState(input.contentState, admission.previews)
  const aps: Record<string, unknown> = { timestamp, event: input.event, 'content-state': content }
  if (input.event === 'end') aps['dismissal-date'] = timestamp
  else {
    if (coverageExpiresAt === null || !Number.isSafeInteger(coverageExpiresAt) || coverageExpiresAt <= timestamp)
      throw new Error('Relay coverage expired')
    // Outdated status is bounded even when coverage lasts longer. This does not replace cleanup.
    aps['stale-date'] = Math.min(coverageExpiresAt, timestamp + 5 * 60)
  }
  if (input.event === 'start') {
    aps['attributes-type'] = 'FicusWorkAttributes'
    aps.attributes = { origin: origin.href.replace(/\/+$/, ''), activityKey: input.activityKey }
    // Apple requires an alert for push-to-start. It contains no work titles or custom sound.
    aps.alert = { title: 'Ficus', body: 'Work is in progress. Open Ficus for details.' }
  }
  const payload = { aps }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 4096)
    throw new Error('Live Activity payload too large')
  return payload
}

/** Separate proof domain from alert/enrollment operations. Verify operationDigest against
 * the locally requested registration before signing; never sign a server-selected operation. */
export const liveActivityRegistrationChallengeSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    instanceId: uuid,
    activationId: uuid,
    origin: z.string().url().max(512),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.string().datetime(),
    operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.number().int().nonnegative().max(2147483646),
  })
  .strict()
export type LiveActivityRegistrationChallenge = z.infer<typeof liveActivityRegistrationChallengeSchema>
export function liveActivityRegistrationProofMessage(value: LiveActivityRegistrationChallenge): string {
  const c = liveActivityRegistrationChallengeSchema.parse(value)
  return JSON.stringify([
    'ficus-live-activity-proof-v1',
    c.id,
    c.instanceId,
    c.activationId,
    c.origin,
    c.nonce,
    c.expiresAt,
    c.operationDigest,
    c.generation,
  ])
}
export const liveActivityRegistrationReceiptSchema = z
  .object({
    version: z.literal(1),
    activationId: uuid,
    destinationId: uuid,
    generation: z.number().int().positive().max(2147483647),
  })
  .strict()
export type LiveActivityRegistrationReceipt = z.infer<typeof liveActivityRegistrationReceiptSchema>

/** Native-to-Core routing metadata. APNs tokens never cross this boundary in relay mode. */
export const coreLiveActivityRegistrationSchema = z.discriminatedUnion('kind', [
  liveActivityRegistrationReceiptSchema
    .extend({
      kind: z.literal('start'),
      bindingToken: liveActivityBindingTokenSchema,
    })
    .strict(),
  liveActivityRegistrationReceiptSchema
    .extend({
      kind: z.literal('update'),
      bindingToken: liveActivityBindingTokenSchema,
      activityKey: uuid,
      activityId: z.string().min(1).max(256),
    })
    .strict(),
])
export type CoreLiveActivityRegistration = z.infer<typeof coreLiveActivityRegistrationSchema>

/** Idempotent revocation is safe to replay indefinitely: a revoked capability cannot be reused. */
export const liveActivityRevocationSchema = z
  .object({
    activationId: uuid,
    bindingToken: liveActivityBindingTokenSchema,
    signature: z.string().regex(/^[a-f0-9]{128}$/i),
  })
  .strict()
export function liveActivityRevocationMessage(input: { activationId: string; bindingToken: string }) {
  return JSON.stringify([
    'ficus-live-activity-revoke-v1',
    uuid.parse(input.activationId),
    liveActivityBindingTokenSchema.parse(input.bindingToken),
  ])
}
