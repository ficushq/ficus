import { expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pushRelayConfig, resolvePushRelayBaseUrl, sendRelayAlert } from './relay'
const token = `ficus_pri_${randomUUID()}_${'a'.repeat(43)}`
const config = pushRelayConfig({ FICUS_PUSH_RELAY_TOKEN: token })!

test('relay uses only a push credential and strips content and arbitrary URLs', async () => {
  let captured: RequestInit | undefined
  const fetcher = (async (_url, init) => {
    captured = init
    return Response.json({ accepted: true })
  }) as (url: string, init: RequestInit) => Promise<Response>
  const result = await sendRelayAlert(
    `ficus_prd_${'b'.repeat(43)}`,
    {
      title: 'private chat',
      body: 'private body',
      url: 'https://evil.example',
      origin: 'https://wrong.example',
      squadId: randomUUID(),
    },
    { config, fetch: fetcher }
  )
  expect(result.accepted).toBe(true)
  const payload = JSON.parse(String(captured!.body))
  expect(Object.keys(payload.routing)).toEqual(['squadId'])
  expect(JSON.stringify(payload)).not.toContain('private')
  expect(captured!.redirect).toBe('error')
  expect(captured!.headers).toEqual({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })
})
test('relay forwards the preview subtitle and grouping keys, and drops unknown presentation fields', async () => {
  let captured: RequestInit | undefined
  const fetcher = (async (_url, init) => {
    captured = init
    return Response.json({ accepted: true })
  }) as (url: string, init: RequestInit) => Promise<Response>
  await sendRelayAlert(
    `ficus_prd_${'b'.repeat(43)}`,
    {
      eventType: 'done',
      workStreamNumber: 197,
      preview: { title: 'Completed: #197 · Validate deletion', body: 'ship it', subtitle: 'Platform' },
      collapseKey: 'ws:abc',
      threadKey: 'squad:def',
      interruptionLevel: 'passive',
      sound: 'none',
    },
    { config, fetch: fetcher }
  )
  const payload = JSON.parse(String(captured!.body))
  expect(payload.routing).toEqual({
    eventType: 'done',
    workStreamNumber: 197,
    preview: { title: 'Completed: #197 · Validate deletion', body: 'ship it', subtitle: 'Platform' },
    collapseKey: 'ws:abc',
    threadKey: 'squad:def',
    interruptionLevel: 'passive',
  })
})

test('denial and network errors are redacted and never retry', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls++
    throw new Error(`secret ${token}`)
  }) as (url: string, init: RequestInit) => Promise<Response>
  expect(await sendRelayAlert(`ficus_prd_${'b'.repeat(43)}`, {}, { config, fetch: fetcher })).toEqual({
    accepted: false,
    reason: 'relay_unavailable',
  })
  expect(calls).toBe(1)
  expect(
    await sendRelayAlert(
      `ficus_prd_${'b'.repeat(43)}`,
      {},
      {
        config,
        fetch: (async () => new Response('', { status: 403 })) as (url: string, init: RequestInit) => Promise<Response>,
      }
    )
  ).toEqual({ accepted: false, reason: 'pro_required' })
})
test('account tokens and malformed credentials cannot configure the relay', () => {
  expect(() => pushRelayConfig({ FICUS_PUSH_RELAY_TOKEN: 'ficus_pat_account-token' })).toThrow('push-only')
  expect(pushRelayConfig({})).toBeNull()
  expect(config.instanceId).toHaveLength(36)
})

test('resolvePushRelayBaseUrl prefers FICUS_PUSH_RELAY_URL, then FICUS_PLATFORM_BASE_URL, then the built-in default', () => {
  expect(
    resolvePushRelayBaseUrl({
      FICUS_PUSH_RELAY_URL: 'https://relay.example',
      FICUS_PLATFORM_BASE_URL: 'https://platform.example',
    })
  ).toBe('https://relay.example')
  expect(resolvePushRelayBaseUrl({ FICUS_PLATFORM_BASE_URL: 'https://platform.example' })).toBe(
    'https://platform.example'
  )
  expect(resolvePushRelayBaseUrl({})).toBe('https://ficus.sh')
})

test('resolvePushRelayBaseUrl trims whitespace and a trailing slash', () => {
  expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: '  https://relay.example/  ' })).toBe('https://relay.example')
})

test('resolvePushRelayBaseUrl allows http only for localhost origins', () => {
  expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'http://localhost:4000' })).toBe('http://localhost:4000')
  expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'http://127.0.0.1:4000' })).toBe('http://127.0.0.1:4000')
  expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'http://[::1]:4000' })).toBe('http://[::1]:4000')

  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'http://relay.example' })).toBe('https://ficus.sh')
  } finally {
    warn.mockRestore()
  }
})

test('resolvePushRelayBaseUrl rejects a path, query, fragment, or malformed value and falls back to the default, warning once per distinct bad value', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (const bad of [
      'https://relay.example/api',
      'https://relay.example?x=1',
      'https://relay.example#frag',
      'not a url',
    ]) {
      expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: bad })).toBe('https://ficus.sh')
    }
    expect(warn).toHaveBeenCalledTimes(4)

    warn.mockClear()
    expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'https://relay.example/api' })).toBe('https://ficus.sh')
    expect(resolvePushRelayBaseUrl({ FICUS_PUSH_RELAY_URL: 'https://relay.example/api' })).toBe('https://ficus.sh')
    expect(warn).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

test('sendRelayAlert posts to the resolved base URL, not the built-in default', async () => {
  const overriddenConfig = pushRelayConfig({
    FICUS_PUSH_RELAY_TOKEN: token,
    FICUS_PUSH_RELAY_URL: 'https://relay.example',
  })!
  expect(overriddenConfig.baseUrl).toBe('https://relay.example')

  let requestedUrl = ''
  const fetcher = (async (url, _init) => {
    requestedUrl = url
    return Response.json({ accepted: true })
  }) as (url: string, init: RequestInit) => Promise<Response>
  await sendRelayAlert(`ficus_prd_${'b'.repeat(43)}`, {}, { config: overriddenConfig, fetch: fetcher })
  expect(requestedUrl).toBe('https://relay.example/api/push-relay/send')
})
