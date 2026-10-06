import { z } from 'zod'
import { relayRoutingSchema, pushAlertText, type RelayRouting } from '@ficus/shared/push-relay'
import { platformRequest } from '../platform/instance-client'
import { isPlatformManaged } from '../secrets/managed'
import { sendApnsNotification, type ApnsEnvironment } from './apns'
import { randomUUID } from 'node:crypto'

const activationChallengeSchema = z.object({
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  origin: z.string().url(),
  nonce: z.string().min(32).max(128),
  expiresAt: z.string().datetime(),
})
const configSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    instanceId: z.string().uuid(),
    delivery: z.literal('direct'),
    liveActivities: z.boolean().optional(),
  }),
])
export async function managedCloudProConfig(request = platformRequest) {
  if (!isPlatformManaged()) return { enabled: false as const }
  const config = await request({
    path: '/api/cloud-mobile-pro/config',
    body: {},
    schema: configSchema,
    timeoutMs: 20000,
  })
  return config.enabled
    ? {
        ...config,
        liveActivities: config.liveActivities === true && process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED === 'true',
      }
    : config
}
export async function enrollManagedCloudPro(input: { publicKey: string; label: string }) {
  if (!isPlatformManaged()) throw new Error('Managed Cloud coverage unavailable')
  return platformRequest({
    path: '/api/cloud-mobile-pro/enroll',
    body: input,
    schema: activationChallengeSchema,
    timeoutMs: 20000,
  })
}
const notificationSchema = relayRoutingSchema.extend({ type: z.literal('open'), origin: z.string().url() })
const admissionSchema = z.object({
  accepted: z.boolean(),
  suppressed: z.boolean().optional(),
  duplicate: z.boolean().optional(),
  reason: z.string().optional(),
  notification: notificationSchema.optional(),
})
/** New policy-bound Cloud devices keep direct APNs transport. Denial never falls back to an unfiltered send. */
export async function sendManagedCloudAlert(
  input: { bindingToken: string; deviceToken: string; environment: ApnsEnvironment; routing: RelayRouting },
  deps = { request: platformRequest, send: sendApnsNotification }
) {
  const admitted = await deps.request({
    path: '/api/cloud-mobile-pro/notifications/admit',
    body: {
      version: 1,
      bindingToken: input.bindingToken,
      eventId: randomUUID(),
      routing: relayRoutingSchema.parse(input.routing),
    },
    schema: admissionSchema,
  })
  if (!admitted.accepted || !admitted.notification) return { ok: admitted.accepted, status: 0, reason: admitted.reason }
  const data = admitted.notification
  const alert = pushAlertText(data)
  return deps.send(
    input.deviceToken,
    {
      ...alert,
      ...(data.preview?.subtitle ? { subtitle: data.preview.subtitle } : {}),
      ...(data.threadKey ? { threadId: data.threadKey } : {}),
      ...(data.collapseKey ? { collapseId: data.collapseKey } : {}),
      ...(data.interruptionLevel ? { interruptionLevel: data.interruptionLevel } : {}),
      data: { ...data, workStreamId: data.workStreamNumber ? String(data.workStreamNumber) : data.workStreamId },
    },
    input.environment
  )
}
