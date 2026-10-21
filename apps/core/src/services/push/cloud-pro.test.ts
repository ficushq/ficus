import { afterEach, expect, test } from 'bun:test'
import { sendManagedCloudAlert, managedCloudProConfig, enrollManagedCloudPro } from './cloud-pro'
import { z } from 'zod'
const oldManaged = process.env.FICUS_MANAGED
const oldActivities = process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED
afterEach(() => {
  if (oldActivities === undefined) delete process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED
  else process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED = oldActivities
  if (oldManaged === undefined) delete process.env.FICUS_MANAGED
  else process.env.FICUS_MANAGED = oldManaged
})
const input = {
  bindingToken: 'fixture',
  deviceToken: 'a'.repeat(64),
  environment: 'sandbox' as const,
  routing: { eventType: 'message' as const, preview: { title: 'Sensitive', body: 'Text' } },
}
function fixture(result: unknown) {
  const calls: unknown[][] = [],
    requests: unknown[] = []
  return {
    calls,
    requests,
    deps: {
      request: async <T>(request: { path: string; body: unknown; schema: z.ZodType<T> }): Promise<T> => {
        requests.push(request.body)
        return request.schema.parse(result)
      },
      send: async (...args: Parameters<typeof import('./apns').sendApnsNotification>) => {
        calls.push(args)
        return { ok: true, status: 200 }
      },
    },
  }
}
test('self-hosted servers do not discover or enroll managed Cloud coverage', async () => {
  delete process.env.FICUS_MANAGED
  expect(await managedCloudProConfig()).toEqual({ enabled: false })
  await expect(enrollManagedCloudPro({ publicKey: 'a'.repeat(64), label: 'Phone' })).rejects.toThrow('unavailable')
})
test('direct Cloud delivery uses only Platform-sanitized notification content and local APNs destination', async () => {
  const f = fixture({
    accepted: true,
    notification: { type: 'open', origin: 'https://cloud.ficus.sh', eventType: 'message', workStreamNumber: 5 },
  })
  expect(await sendManagedCloudAlert(input, f.deps)).toEqual({ ok: true, status: 200 })
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0][0]).toBe(input.deviceToken)
  expect(f.calls[0][2]).toBe('sandbox')
  expect(JSON.stringify(f.calls)).not.toContain('Sensitive')
  expect(f.calls[0][1]).toMatchObject({ data: { origin: 'https://cloud.ficus.sh', workStreamId: '5' } })
  expect(f.requests[0]).toMatchObject({ version: 1, bindingToken: input.bindingToken, routing: input.routing })
})
test('denied, suppressed, duplicate or malformed admissions never fall back to direct push', async () => {
  for (const result of [
    { accepted: false, reason: 'pro_required' },
    { accepted: true, suppressed: true },
    { accepted: true, duplicate: true },
  ]) {
    const f = fixture(result)
    await sendManagedCloudAlert(input, f.deps)
    expect(f.calls).toHaveLength(0)
  }
  const f = fixture({ accepted: true, notification: { type: 'open', origin: 'invalid' } })
  await expect(sendManagedCloudAlert(input, f.deps)).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  await expect(
    sendManagedCloudAlert(input, {
      ...f.deps,
      request: async () => {
        throw new Error('unavailable')
      },
    })
  ).rejects.toThrow('unavailable')
  expect(f.calls).toHaveLength(0)
})
test('approved previews preserve subtitle, urgency and grouping', async () => {
  const notification = {
    type: 'open',
    origin: 'https://cloud.ficus.sh',
    eventType: 'message',
    preview: { title: 'Allowed title', body: 'Allowed body', subtitle: 'Growth' },
    threadKey: 'squad:growth',
    collapseKey: 'work:5',
    interruptionLevel: 'passive',
  }
  const f = fixture({ accepted: true, notification })
  await sendManagedCloudAlert(input, f.deps)
  expect(f.calls[0][1]).toMatchObject({
    title: 'Allowed title',
    body: 'Allowed body',
    subtitle: 'Growth',
    threadId: 'squad:growth',
    collapseId: 'work:5',
    interruptionLevel: 'passive',
  })
})

test('managed discovery advertises aggregate activity transport only with both capability gates', async () => {
  process.env.FICUS_MANAGED = '1'
  const instanceId = crypto.randomUUID()
  for (const enabled of [false, true]) {
    for (const local of [false, true]) {
      process.env.FICUS_LIVE_ACTIVITY_RELAY_ENABLED = String(local)
      const config = await managedCloudProConfig(async <T>(request: { schema: z.ZodType<T> }) =>
        request.schema.parse({ enabled: true, instanceId, delivery: 'direct', liveActivities: enabled })
      )
      expect(config).toEqual({ enabled: true, instanceId, delivery: 'direct', liveActivities: enabled && local })
    }
  }
})

test('Android Cloud push uses authenticated relay delivery and never direct APNs', async () => {
  let path = ''
  const result = await sendManagedCloudAlert(
    { ...input, platform: 'android' },
    {
      request: async <T>(value: { path: string; schema: z.ZodType<T> }) => {
        path = value.path
        return value.schema.parse({ accepted: true })
      },
      send: async () => {
        throw new Error('FCM token must not reach APNs')
      },
    }
  )
  expect(path).toBe('/api/cloud-mobile-pro/notifications/send')
  expect(result.ok).toBe(true)
})
test('the Action Center id travels with a question alert', async () => {
  const questionId = '724713e4-4324-4336-a761-5ec650ae8b5e'
  const actionId = `agent-question:${questionId}`
  const f = fixture({
    accepted: true,
    notification: { type: 'open', origin: 'https://cloud.ficus.sh', eventType: 'question', questionId, actionId },
  })
  const result = await sendManagedCloudAlert(
    { ...input, routing: { eventType: 'question', questionId, actionId } },
    f.deps
  )
  expect(result).toEqual({ ok: true, status: 200 })
  expect(f.requests[0]).toMatchObject({ routing: { eventType: 'question', questionId, actionId } })
  expect(f.calls[0][1]).toMatchObject({ data: { questionId, actionId } })
})

test('a routing field the relay schema rejects is dropped, not fatal: the alert still goes out with the rest', async () => {
  const questionId = '724713e4-4324-4336-a761-5ec650ae8b5e'
  const f = fixture({
    accepted: true,
    notification: { type: 'open', origin: 'https://cloud.ficus.sh', eventType: 'question' },
  })
  const result = await sendManagedCloudAlert(
    {
      ...input,
      routing: { eventType: 'question', questionId, actionId: 'agent-question: approve the refund?' } as never,
    },
    f.deps
  )
  expect(result).toEqual({ ok: true, status: 200 })
  expect(f.requests[0]).toMatchObject({ routing: { eventType: 'question', questionId } })
  expect(JSON.stringify(f.requests[0])).not.toContain('refund')
  expect(f.calls).toHaveLength(1)
})

test('Android admission drops a rejected routing field the same way', async () => {
  const f = fixture({ accepted: true })
  const result = await sendManagedCloudAlert(
    {
      ...input,
      platform: 'android',
      routing: { eventType: 'blocked', waitId: 'not-a-uuid' } as never,
    },
    f.deps
  )
  expect(result).toEqual({ ok: true, status: 0, reason: undefined })
  expect(f.requests[0]).toMatchObject({ routing: { eventType: 'blocked' } })
  expect(JSON.stringify(f.requests[0])).not.toContain('not-a-uuid')
})
