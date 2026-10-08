import { z } from 'zod'
import { PlatformRequestError } from '../platform/instance-client'
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sendRelayLiveActivity } from './live-activity-relay'
import type { RelayLiveActivitySend } from '@ficus/shared/live-activity-relay'

const config = {
  token: `ficus_pri_${randomUUID()}_${'a'.repeat(43)}`,
  instanceId: randomUUID(),
  baseUrl: 'https://relay.example',
}
const input: RelayLiveActivitySend = {
  version: 1,
  bindingToken: `ficus_pla_${'b'.repeat(43)}`,
  activityKey: randomUUID(),
  eventId: randomUUID(),
  sequence: 12,
  event: 'end',
}
function respond(response: () => Response | Promise<Response>) {
  return async () => response()
}

test('transport uses only the scoped runtime credential, preserving persisted ordering on retry', async () => {
  const requests: RequestInit[] = []
  const urls: string[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    urls.push(url)
    requests.push(init)
    return Response.json({ version: 1, status: requests.length === 1 ? 'sent' : 'duplicate' })
  }
  expect(await sendRelayLiveActivity(input, { config, fetch: fetcher })).toEqual({ ok: true, status: 'sent' })
  expect(await sendRelayLiveActivity(input, { config, fetch: fetcher })).toEqual({ ok: true, status: 'duplicate' })
  expect(urls).toEqual(Array(2).fill('https://relay.example/api/push-relay/live-activities/send'))
  expect(requests[0].body).toBe(requests[1].body)
  expect(JSON.parse(String(requests[0].body))).toEqual(input)
  expect(requests[0].headers).toEqual({ Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' })
  expect(requests[0].redirect).toBe('error')
  expect(requests[0].credentials).toBe('omit')
  expect(requests[0].signal).toBeInstanceOf(AbortSignal)
})

test('malformed requests and missing config never make a request', async () => {
  let calls = 0
  const fetcher = respond(() => {
    calls++
    return Response.json({ version: 1, status: 'sent' })
  })
  expect(await sendRelayLiveActivity(input, { config: null, fetch: fetcher })).toEqual({
    ok: false,
    reason: 'not_configured',
    retryable: false,
  })
  expect(
    await sendRelayLiveActivity({ ...input, topic: 'arbitrary' } as RelayLiveActivitySend, { config, fetch: fetcher })
  ).toEqual({ ok: false, reason: 'invalid_request', retryable: false })
  expect(calls).toBe(0)
})

test('HTTP outcomes remain explicit and terminal denials never retry or fall back', async () => {
  for (const [status, reason, retryable] of [
    [401, 'unauthorized', false],
    [403, 'pro_required', false],
    [409, 'conflict', false],
    [410, 'destination_revoked', false],
    [429, 'rate_limited', true],
    [503, 'relay_unavailable', true],
    [404, 'invalid_request', false],
  ] as const) {
    let calls = 0
    const result = await sendRelayLiveActivity(input, {
      config,
      fetch: respond(() => {
        calls++
        return new Response('secret diagnostics', { status })
      }),
    })
    expect(result).toEqual({ ok: false, reason, retryable })
    expect(calls).toBe(1)
  }
})

test('provider ambiguity is not successful admission and must not be automatically retried', async () => {
  for (const reason of ['delivery_unknown', 'pro_required', 'destination_revoked', 'conflict', 'unauthorized'] as const)
    expect(
      await sendRelayLiveActivity(input, {
        config,
        fetch: respond(() => Response.json({ version: 1, status: 'rejected', reason })),
      })
    ).toEqual({ ok: false, reason, retryable: false })
  expect(
    await sendRelayLiveActivity(input, {
      config,
      fetch: respond(() => Response.json({ version: 1, status: 'rejected', reason: 'in_flight' })),
    })
  ).toEqual({ ok: false, reason: 'in_flight', retryable: true })
})

test('unbounded/malformed/provider error responses never disclose payloads or credentials', async () => {
  for (const response of [
    () => new Response('x'.repeat(1025)),
    () => Response.json({ accepted: true }),
    () => Response.json({ version: 1, status: 'sent', token: 'secret' }),
    () => {
      throw new Error(config.token)
    },
  ]) {
    expect(await sendRelayLiveActivity(input, { config, fetch: respond(response) })).toEqual({
      ok: false,
      reason: 'relay_unavailable',
      retryable: true,
    })
  }
})

test('managed Cloud contributions use the control-plane client and never fall back to direct APNs', async () => {
  const requests: string[] = []
  const result = await sendRelayLiveActivity(input, {
    config: null,
    managed: true,
    request: async <T>(request: { path: string; body: unknown; schema: z.ZodType<T> }): Promise<T> => {
      requests.push(request.path)
      expect(request.body).toEqual(input)
      return request.schema.parse({ version: 1, status: 'queued' })
    },
    fetch: async () => {
      throw new Error('Scoped relay transport must not be used')
    },
  })
  expect(result).toEqual({ ok: true, status: 'queued' })
  expect(requests).toEqual(['/api/cloud-mobile-pro/live-activities/send'])
  for (const [status, reason, retryable] of [
    [401, 'unauthorized', false],
    [403, 'pro_required', false],
    [410, 'destination_revoked', false],
    [429, 'rate_limited', true],
    [503, 'relay_unavailable', true],
  ] as const) {
    expect(
      await sendRelayLiveActivity(input, {
        config: null,
        managed: true,
        request: async () => {
          throw new PlatformRequestError('fixture', retryable, status)
        },
      })
    ).toEqual({ ok: false, reason, retryable })
  }
})
