import { expect, test } from 'bun:test'
import { activationActionSchema, activationOperationPayload, relayPairingSchema } from './push-relay'
const token = 'AbCdEf0123456789:APA91bCaseSensitive_FcmToken'
const bind = {
  action: 'bind' as const,
  activationId: crypto.randomUUID(),
  deviceToken: token,
  transport: 'fcm' as const,
  environment: 'production' as const,
  bindingToken: `ficus_prd_${'x'.repeat(43)}`,
}
test('FCM bindings preserve token case and authenticate transport in the installation proof', () => {
  expect(activationActionSchema.parse(bind)).toEqual(bind)
  expect(activationOperationPayload(bind)).not.toBe(activationOperationPayload({ ...bind, transport: 'apns' }))
  expect(
    relayPairingSchema.parse({
      instanceId: crypto.randomUUID(),
      deviceToken: token,
      transport: 'fcm',
      environment: 'production',
    }).deviceToken
  ).toBe(token)
})
test('legacy APNs proof bytes are unchanged and FCM cannot masquerade as an APNs token', () => {
  const { transport: _, ...legacy } = { ...bind, deviceToken: 'a'.repeat(64) }
  expect(activationOperationPayload(legacy)).toBe(
    JSON.stringify(['bind', legacy.activationId, legacy.deviceToken, 'production', legacy.bindingToken])
  )
  expect(activationActionSchema.safeParse({ ...bind, transport: undefined }).success).toBe(false)
  expect(activationActionSchema.safeParse({ ...bind, environment: 'sandbox' }).success).toBe(false)
  expect(activationActionSchema.safeParse({ ...bind, deviceToken: 'token with spaces' }).success).toBe(false)
})
