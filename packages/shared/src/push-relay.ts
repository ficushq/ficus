import { z } from 'zod'

export const PUSH_RELAY_PROTOCOL = 1 as const
export const PUSH_RELAY_BASE_URL = 'https://ficus.sh'
export const relayInstanceTokenPattern =
  /^ficus_pri_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/
export const relayBindingTokenSchema = z.string().regex(/^ficus_prd_[A-Za-z0-9_-]{43}$/)
export const apnsTokenSchema = z.string().regex(/^(?:[0-9a-f]{2}){16,256}$/i)
export const relayPairingSchema = z
  .object({
    instanceId: z.string().uuid(),
    deviceToken: apnsTokenSchema,
    environment: z.enum(['production', 'sandbox']),
  })
  .strict()
// No arbitrary aps keys or caller-chosen origin/URL. Content previews are opt-in;
// otherwise only event type and a numeric work reference describe the update.
// Grouping (threadKey), replacement (collapseKey), and urgency (interruptionLevel) are
// structure rather than content, so they travel outside the preview.
export const relayRoutingSchema = z
  .object({
    eventType: z.enum(['question', 'review', 'blocked', 'done', 'canceled', 'created', 'message', 'update']).optional(),
    workStreamNumber: z.number().int().positive().max(2147483647).optional(),
    preview: z
      .object({ title: z.string().max(200), body: z.string().max(500), subtitle: z.string().max(80).optional() })
      .strict()
      .optional(),
    collapseKey: z.string().min(1).max(64).optional(),
    threadKey: z.string().min(1).max(64).optional(),
    interruptionLevel: z.enum(['passive', 'active', 'time-sensitive']).optional(),
    squadId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    workStreamId: z.string().uuid().optional(),
    waitId: z.string().uuid().optional(),
    questionId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    actionId: z.string().uuid().optional(),
  })
  .strict()
export const relaySendSchema = z
  .object({
    version: z.literal(PUSH_RELAY_PROTOCOL),
    bindingToken: relayBindingTokenSchema,
    eventId: z.string().uuid(),
    routing: relayRoutingSchema,
  })
  .strict()
export type RelayRouting = z.infer<typeof relayRoutingSchema>
export type RelaySend = z.infer<typeof relaySendSchema>

export const installationKeySchema = z.string().regex(/^[0-9a-f]{64}$/)
export const instanceEnrollmentSchema = z
  .object({ publicKey: installationKeySchema, label: z.string().trim().min(1).max(60) })
  .strict()
export const activationActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('refresh'), activationId: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('bind'),
      activationId: z.string().uuid(),
      deviceToken: apnsTokenSchema,
      environment: z.enum(['sandbox', 'production']),
      bindingToken: relayBindingTokenSchema,
    })
    .strict(),
])
export const activationProofSchema = z
  .object({ challengeId: z.string().uuid(), signature: z.string().regex(/^[0-9a-f]{128}$/) })
  .strict()
export type ActivationOperation = { action: 'activate'; label: string } | ActivationAction
export function activationOperationPayload(operation: ActivationOperation): string {
  return JSON.stringify(
    operation.action === 'activate'
      ? [operation.action, operation.label]
      : operation.action === 'refresh'
        ? [operation.action, operation.activationId]
        : [
            operation.action,
            operation.activationId,
            operation.deviceToken,
            operation.environment,
            operation.bindingToken,
          ]
  )
}
export interface ActivationChallenge {
  operationDigest: string
  id: string
  instanceId: string
  origin: string
  nonce: string
  expiresAt: string
}
export interface InstanceProLease {
  activationId: string
  instanceId: string
  origin: string
  pro: true
  expiresAt: string
}
export function activationProofMessage(challenge: ActivationChallenge): string {
  return JSON.stringify([
    'tau-instance-pro-v1',
    challenge.id,
    challenge.instanceId,
    challenge.origin,
    challenge.nonce,
    challenge.expiresAt,
  ])
}
export type ActivationAction = z.infer<typeof activationActionSchema>

/** Closed vocabulary: an instance cannot supply arbitrary text unless previews were requested. */
export function pushEventType(
  type: string = ''
): 'question' | 'review' | 'blocked' | 'done' | 'canceled' | 'created' | 'message' | 'update' {
  if (type === 'agent-question.created') return 'question'
  if (type === 'inbox.messageReceived') return 'message'
  if (type.startsWith('workStream.')) {
    const event = type.slice('workStream.'.length)
    if (event === 'review' || event === 'blocked' || event === 'done' || event === 'canceled' || event === 'created')
      return event
  }
  return 'update'
}
export function pushAlertText(input: Pick<RelayRouting, 'eventType' | 'workStreamNumber' | 'preview'>) {
  if (input.preview) return input.preview
  const work = input.workStreamNumber ? `Work #${input.workStreamNumber}` : 'Ficus'
  const text: Record<NonNullable<RelayRouting['eventType']>, string> = {
    question: 'needs your answer',
    review: 'is ready for review',
    blocked: 'is blocked',
    done: 'completed',
    canceled: 'was canceled',
    created: 'was created',
    message: 'has a new message',
    update: 'has an update',
  }
  return {
    title: input.workStreamNumber
      ? `${work} ${text[input.eventType ?? 'update']}`
      : {
          question: 'Question needs your answer',
          review: 'Work is ready for review',
          blocked: 'Work is blocked',
          done: 'Work completed',
          canceled: 'Work canceled',
          created: 'Work created',
          message: 'New inbox message',
          update: 'Ficus update',
        }[input.eventType ?? 'update'],
    body: 'Open Ficus to see details.',
  }
}
