import { getSettingsStore } from '../services/settings'
import { listDesktopNotifications } from '../services/push/desktop'
import { pushRelayConfig, enrollInstancePro } from '../services/push/relay'
import { relayBindingTokenSchema, instanceEnrollmentSchema } from '@ficus/shared/push-relay'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getVapidContactSubject, getVapidKeys } from '../services/push/vapid'
import {
  registerPushSubscription,
  deletePushSubscriptionForUser,
  getPushSubscriptionsByUser,
} from '../services/push/subscriptions'
import { registerApnsDevice, deleteApnsDeviceForUser, getApnsDevicesByUser } from '../services/push/apns-devices'
import { loadWorkInterestSnapshot } from '../services/push/work-interest'
import {
  deleteLiveActivityTokenForUser,
  registerLiveActivityToken,
  type LiveActivityTokenKind,
} from '../services/push/live-activity-tokens'

export const pushRouter = new Hono()

pushRouter.get('/desktop', async (c) => {
  const identity = c.get('identity')
  if (identity?.type !== 'user') return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  c.header('Cache-Control', 'no-store')
  return c.json({ userId: identity.userId, notifications: await listDesktopNotifications(identity.userId) })
})

function getPushUserId(c: Context): string | null {
  const identity = c.get('identity')
  if (identity?.type === 'user') return identity.userId
  if (identity?.type === 'agent' && identity.userId) return identity.userId
  return null
}

// Authenticated discovery exposes only the relay identity, never its credential.
pushRouter.get('/relay-config', (c) => {
  if (!getPushUserId(c)) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  try {
    const config = pushRelayConfig()
    return c.json(config ? { enabled: true, instanceId: config.instanceId } : { enabled: false })
  } catch {
    return c.json({ error: 'Relay configuration is invalid' }, 503)
  }
})

// Authenticated human users may enroll their own installation. The cloud owns
// capacity; neither an agent identity nor a caller-supplied plan flag grants it.
pushRouter.post('/instance-pro/enroll', async (c) => {
  if (c.get('identity')?.type !== 'user') return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const input = instanceEnrollmentSchema.safeParse(await c.req.json())
  if (!input.success) return c.json({ error: 'Invalid enrollment' }, 400)
  try {
    return c.json(await enrollInstancePro(input.data), 201)
  } catch {
    return c.json({ error: 'Cloud enrollment is unavailable' }, 503)
  }
})

// GET /api/push/work-interest — the privacy-scoped Widget/Live Activity aggregate.
pushRouter.get('/work-interest', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  return c.json(await loadWorkInterestSnapshot(userId))
})

// GET /api/push/vapid-public-key
pushRouter.get('/vapid-public-key', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  if (getSettingsStore().getStoredValue('__integration-enabled:web-push') === 'false')
    return c.json({ error: 'Enable Web Push in Settings → Integrations.' }, 503)
  if (!getVapidContactSubject())
    return c.json({ error: 'Set a contact address in Settings → Integrations → Web Push.' }, 503)
  const keys = await getVapidKeys()
  return c.json({ publicKey: keys.publicKey })
})

// POST /api/push/subscribe
pushRouter.post('/subscribe', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const body = await c.req.json()
  const { endpoint, keys, userAgent } = body

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const subscription = await registerPushSubscription({
    endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    userAgent,
    userId,
  })

  return c.json(subscription, 201)
})

// DELETE /api/push/subscribe/:id
pushRouter.delete('/subscribe/:id', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const { id } = c.req.param()
  const deleted = await deletePushSubscriptionForUser(id, userId)
  if (!deleted) return c.json({ error: 'Subscription not found' }, 403)
  return c.json({ success: true })
})

// GET /api/push/subscriptions
pushRouter.get('/subscriptions', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const subscriptions = await getPushSubscriptionsByUser(userId)
  return c.json(subscriptions)
})

// GET /api/push/device — list this user's native APNs/FCM device registrations.
pushRouter.get('/device', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const devices = await getApnsDevicesByUser(userId)
  return c.json(
    devices.map((device) => ({
      id: device.id,
      platform: device.platform,
      environment: device.environment,
      createdAt: device.createdAt.toISOString(),
    }))
  )
})

// POST /api/push/device — register a native (APNs/FCM) device token for the mobile app.
pushRouter.post('/device', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const body = await c.req.json<{
    apnsToken?: string
    platform?: string
    environment?: string
    relayBindingToken?: string
  }>()
  if (!body.apnsToken) return c.json({ error: 'apnsToken required' }, 400)
  const platform = body.platform === 'android' ? 'android' : 'ios'
  const environment = body.environment === 'sandbox' ? 'sandbox' : 'production'
  if (body.relayBindingToken !== undefined && !relayBindingTokenSchema.safeParse(body.relayBindingToken).success)
    return c.json({ error: 'Invalid relay binding' }, 400)
  const row = await registerApnsDevice({
    userId,
    apnsToken: body.apnsToken,
    platform,
    environment,
    relayBindingToken: body.relayBindingToken,
  })
  return c.json(row, 201)
})

// POST /api/push/live-activity — register a Live Activity APNs token.
//
// Separate from /push/device on purpose: these are not device tokens. `update` tokens are minted
// per activity and die with it (~8h, or on dismissal/reboot), so this endpoint is called often and
// must be idempotent by token — registerLiveActivityToken upserts.
pushRouter.post('/live-activity', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const body = await c.req.json<{
    apnsToken?: string
    kind?: string
    activityId?: string
    environment?: string
  }>()
  if (!body.apnsToken) return c.json({ error: 'apnsToken required' }, 400)
  if (body.kind !== 'start' && body.kind !== 'update') {
    return c.json({ error: "kind must be 'start' or 'update'" }, 400)
  }
  // An update token that names no activity can never be targeted at one, so reject it here rather
  // than storing a row the fan-out would have to skip.
  if (body.kind === 'update' && !body.activityId) {
    return c.json({ error: "activityId required for kind 'update'" }, 400)
  }
  const row = await registerLiveActivityToken({
    userId,
    apnsToken: body.apnsToken,
    kind: body.kind as LiveActivityTokenKind,
    activityId: body.activityId,
    environment: body.environment,
  })
  return c.json(row, 201)
})

// DELETE /api/push/live-activity — unregister a Live Activity token.
//
// Keyed by the token in the BODY rather than an id in the path: the app knows the token it was
// given by ActivityKit, not the row id the server assigned.
pushRouter.delete('/live-activity', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const body = await c.req.json<{ apnsToken?: string }>()
  if (!body.apnsToken) return c.json({ error: 'apnsToken required' }, 400)
  const deleted = await deleteLiveActivityTokenForUser(body.apnsToken, userId)
  if (!deleted) return c.json({ error: 'Live Activity token not found' }, 404)
  return c.json({ success: true })
})

// DELETE /api/push/device/:id — unregister a native device token.
pushRouter.delete('/device/:id', async (c) => {
  const userId = getPushUserId(c)
  if (!userId) return c.json({ error: 'User identity required' }, 401)
  c.set('authzChecked', true)
  const deleted = await deleteApnsDeviceForUser(c.req.param('id'), userId)
  if (!deleted) return c.json({ error: 'Device not found' }, 404)
  return c.json({ success: true })
})
