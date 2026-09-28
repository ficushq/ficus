import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { PlatformRequestError, platformRequest } from './instance-client'
import { getSecretStore, resetSecretStore } from '../secrets'

const originalFetch = globalThis.fetch
const originalEnv = {
  baseUrl: process.env.FICUS_PLATFORM_BASE_URL,
  token: process.env.FICUS_PLATFORM_INSTANCE_TOKEN,
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEnv.baseUrl === undefined) delete process.env.FICUS_PLATFORM_BASE_URL
  else process.env.FICUS_PLATFORM_BASE_URL = originalEnv.baseUrl
  if (originalEnv.token === undefined) delete process.env.FICUS_PLATFORM_INSTANCE_TOKEN
  else process.env.FICUS_PLATFORM_INSTANCE_TOKEN = originalEnv.token
})

function configure() {
  process.env.FICUS_PLATFORM_BASE_URL = 'https://platform.example/'
  process.env.FICUS_PLATFORM_INSTANCE_TOKEN = 'instance-token-SENTINEL'
}

const responseSchema = z.object({ ok: z.literal(true) }).strict()

describe('platformRequest', () => {
  test('uses the configured origin, bearer token, JSON body, and forbids redirects', async () => {
    configure()
    const seen: Array<{ request: Request; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ request: new Request(input, init), init })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    expect(
      await platformRequest({ path: '/api/oauth-broker/notion/start', body: { flow: 'one' }, schema: responseSchema })
    ).toEqual({ ok: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.request.url).toBe('https://platform.example/api/oauth-broker/notion/start')
    expect(seen[0]!.request.headers.get('authorization')).toBe('Bearer instance-token-SENTINEL')
    expect(seen[0]!.request.headers.get('content-type')).toBe('application/json')
    expect(seen[0]!.init?.redirect).toBe('error')
    expect(await seen[0]!.request.json()).toEqual({ flow: 'one' })
  })

  test('allows an HTTP platform origin on IPv6 loopback', async () => {
    process.env.FICUS_PLATFORM_BASE_URL = 'http://[::1]:8080/'
    process.env.FICUS_PLATFORM_INSTANCE_TOKEN = 'instance-token'
    let requestedUrl = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      requestedUrl = new Request(input).url
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    expect(await platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).toEqual({ ok: true })
    expect(requestedUrl).toBe('http://[::1]:8080/api/test')
  })

  test('prefers the singleton secret store token over the environment fallback', async () => {
    const priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
    const priorManagedKeys = process.env.FICUS_MANAGED_SECRET_KEYS
    process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey ?? '0'.repeat(64)
    delete process.env.FICUS_MANAGED_SECRET_KEYS
    process.env.FICUS_PLATFORM_BASE_URL = 'https://platform.example'
    process.env.FICUS_PLATFORM_INSTANCE_TOKEN = 'environment-token-SENTINEL'
    resetSecretStore()
    const store = getSecretStore()
    await store.initialize()
    await store.set('FICUS_PLATFORM_INSTANCE_TOKEN', 'secret-store-token-SENTINEL', 'test')
    const authorizations: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Request(input, init).headers.get('authorization') ?? '')
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    try {
      expect(await platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).toEqual({ ok: true })
      expect(authorizations).toEqual(['Bearer secret-store-token-SENTINEL'])
      expect(authorizations[0]).not.toContain('environment-token-SENTINEL')
    } finally {
      await store.delete('FICUS_PLATFORM_INSTANCE_TOKEN')
      resetSecretStore()
      if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
      if (priorManagedKeys === undefined) delete process.env.FICUS_MANAGED_SECRET_KEYS
      else process.env.FICUS_MANAGED_SECRET_KEYS = priorManagedKeys
    }
  })

  test('rejects a non-conforming response body', async () => {
    configure()
    globalThis.fetch = (async () => Response.json({ ok: false, token: 'response-secret' })) as unknown as typeof fetch

    await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
      status: 200,
    })
  })

  test('errors never carry the request body, response body, or instance token', async () => {
    configure()
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 'bad code response-secret-SENTINEL' }), {
        status: 500,
      })) as unknown as typeof fetch

    const error = await platformRequest({
      path: '/api/test',
      body: { refreshToken: 'request-secret-SENTINEL' },
      schema: responseSchema,
    }).then(
      () => {
        throw new Error('expected platform request to fail')
      },
      (value) => value as PlatformRequestError
    )
    const observable = JSON.stringify({ message: error.message, code: error.code, status: error.status })
    expect(observable).not.toContain('request-secret-SENTINEL')
    expect(observable).not.toContain('response-secret-SENTINEL')
    expect(observable).not.toContain('instance-token-SENTINEL')
  })

  test('maps authentication and scope failures to fixed non-retryable codes and cancels their bodies', async () => {
    configure()
    for (const [status, code] of [
      [401, 'broker_unauthorized'],
      [403, 'insufficient_scope'],
    ] as const) {
      let cancelled = false
      const responseBody = new ReadableStream({
        cancel() {
          cancelled = true
          throw new Error('cancellation-body-SENTINEL')
        },
      })
      globalThis.fetch = (async () => new Response(responseBody, { status })) as unknown as typeof fetch
      const error = await platformRequest({ path: '/api/test', body: {}, schema: responseSchema }).then(
        () => {
          throw new Error('expected platform request to fail')
        },
        (value) => value as PlatformRequestError
      )
      expect(error).toMatchObject({ code, retryable: false, status })
      expect(cancelled).toBe(true)
      expect(JSON.stringify({ message: error.message, code: error.code })).not.toContain('cancellation-body-SENTINEL')
    }
  })

  test('maps a safe 409 broker code without exposing its raw body', async () => {
    configure()
    globalThis.fetch = (async () =>
      Response.json({ code: 'invalid_grant' }, { status: 409 })) as unknown as typeof fetch

    await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
      code: 'invalid_grant',
      retryable: false,
      status: 409,
    })
  })

  test('only operation_in_flight is retryable among sanitized 409 outcomes', async () => {
    configure()
    for (const [code, retryable] of [
      ['operation_in_flight', true],
      ['operation_key_conflict', false],
    ] as const) {
      globalThis.fetch = (async () => Response.json({ code }, { status: 409 })) as unknown as typeof fetch
      await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
        code,
        retryable,
        status: 409,
      })
    }
  })

  test('maps rate limits, server failures, and network failures to retryable codes', async () => {
    configure()
    const cases: Array<[() => Promise<Response>, string]> = [
      [async () => Response.json({ code: 'rate_limited' }, { status: 429 }), 'rate_limited'],
      [async () => new Response('untrusted', { status: 503 }), 'broker_unavailable'],
      [async () => Promise.reject(new Error('network body SENTINEL')), 'broker_unavailable'],
    ]
    for (const [fetcher, code] of cases) {
      globalThis.fetch = fetcher as unknown as typeof fetch
      await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
        code,
        retryable: true,
      })
    }
  })

  test('oversized error bodies cannot change retryability derived from status', async () => {
    configure()
    for (const [status, code] of [
      [429, 'rate_limited'],
      [503, 'broker_unavailable'],
    ] as const) {
      globalThis.fetch = (async () => new Response('x'.repeat(65_537), { status })) as unknown as typeof fetch
      await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
        code,
        retryable: true,
        status,
      })
    }
  })

  test('cancels a declared-oversize response before rejecting it', async () => {
    configure()
    let cancelled = false
    const responseBody = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    globalThis.fetch = (async () =>
      new Response(responseBody, { headers: { 'content-length': '65537' } })) as unknown as typeof fetch

    await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
      status: 200,
    })
    expect(cancelled).toBe(true)
  })

  test('uses a 15 second timeout by default', async () => {
    configure()
    let delay: number | undefined
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      delay = ms
      callback()
      return 1
    }) as typeof setTimeout)
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      throw new Error('expected an aborted request')
    }) as unknown as typeof fetch

    try {
      await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
        code: 'broker_timeout',
        retryable: true,
      })
      expect(delay).toBe(15_000)
    } finally {
      timeout.mockRestore()
    }
  })

  test('timeout wins when response headers arrive before a stalled 503 body', async () => {
    configure()
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        },
      })
      return new Response(body, { status: 503 })
    }) as unknown as typeof fetch

    await expect(
      platformRequest({ path: '/api/test', body: {}, schema: responseSchema, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'broker_timeout', retryable: true, status: 503 })
  })

  test('times out bounded requests and caps response bodies at 64 KiB', async () => {
    configure()
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })) as unknown as typeof fetch
    await expect(
      platformRequest({ path: '/api/test', body: {}, schema: responseSchema, timeoutMs: 5 })
    ).rejects.toMatchObject({ code: 'broker_timeout', retryable: true })

    globalThis.fetch = (async () => new Response('x'.repeat(65_537))) as unknown as typeof fetch
    await expect(platformRequest({ path: '/api/test', body: {}, schema: responseSchema })).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
    })
  })
})

test('relay payload allowance is explicit and bounded; broker defaults remain small', async () => {
  configure()
  const content = 'a'.repeat(70_000)
  globalThis.fetch = (async () => Response.json({ content })) as unknown as typeof fetch
  const input = { path: '/api/integration-relay/github/pull', body: {}, schema: z.object({ content: z.string() }) }
  await expect(platformRequest(input)).rejects.toThrow('invalid_response')
  expect((await platformRequest({ ...input, maxResponseBytes: 128 * 1024 })).content).toBe(content)
  for (const maxResponseBytes of [NaN, Infinity, 0, 13 * 1024 * 1024])
    await expect(platformRequest({ ...input, maxResponseBytes })).rejects.toThrow('invalid_response_limit')
})
