import { describe, expect, mock, test } from 'bun:test'
import { BashCleanupUnprovenError, BashOutcomeUnknownError, SandboxClient } from './http-client'

describe('SandboxClient public bash cancellation', () => {
  test('proves cleanup for an invocation independently of the original stream', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ remainingPids: [] })
    )
    const client = new SandboxClient('box.test:123', undefined, { fetch: fetchMock })

    await client.cancelBashInvocation('stable', 'transport-loss')

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      invocationId: 'stable',
      reason: 'transport-loss',
    })
  })
})

describe('SandboxClient bash cancellation', () => {
  test('bounds a hanging cancellation request and remains single flight', async () => {
    let releaseTransport: (() => void) | undefined
    let abortSeen = false
    const fetchMock = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          releaseTransport = () => resolve(new Response(null, { status: 204 }))
          init?.signal?.addEventListener(
            'abort',
            () => {
              abortSeen = true
              reject(init.signal?.reason)
            },
            { once: true }
          )
        })
    )
    const client = new SandboxClient('box.test:123', 'token', { fetch: fetchMock, cancelTimeoutMs: 1 })
    const stream = client.bash({ command: 'sleep', invocationId: 'stable' })
    const first = stream.cancelAndWait('transport-loss')
    expect(stream.cancelAndWait('transport-loss')).toBe(first)

    const settled = first.then(
      () => 'resolved' as const,
      (error) => ({ error })
    )
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      settled,
      new Promise<'watchdog'>((resolve) => {
        watchdog = setTimeout(() => {
          releaseTransport?.()
          resolve('watchdog')
        }, 100)
      }),
    ])
    if (watchdog) clearTimeout(watchdog)
    if (outcome === 'watchdog') {
      await settled
      throw new Error('cancel request did not settle before test watchdog')
    }
    expect(outcome).toEqual({ error: expect.any(BashCleanupUnprovenError) })
    expect(abortSeen).toBe(true)
    const cancelCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/bash/cancel'))
    expect(cancelCall?.[1]?.headers).toMatchObject({ authorization: 'Bearer token' })
    expect(JSON.parse(String(cancelCall?.[1]?.body))).toMatchObject({ invocationId: 'stable' })
  })
})

describe('SandboxClient ambiguous bash outcomes', () => {
  test.each(['clean-eof', 'reader-reset'] as const)(
    '%s fails closed and cancels the stable invocation without replay',
    async (mode) => {
      const previousFetch = globalThis.fetch
      const calls: Array<{ url: string; body?: string }> = []
      globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
        if (url.endsWith('/bash/cancel')) return Response.json({ remainingPids: [] })
        if (!url.endsWith('/bash')) throw new Error(`unexpected URL ${url}`)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"stdout":"aGk="}\n\n'))
            if (mode === 'clean-eof') controller.close()
            else controller.error(new Error('The socket connection was closed unexpectedly'))
          },
        })
        return new Response(body)
      }) as unknown as typeof fetch

      try {
        const client = new SandboxClient('box.test:123')
        const stream = client.bash({ command: 'devbox install', invocationId: 'stable' })
        expect(stream.invocationId).toBe('stable')
        const error = await new Promise<Error>((resolve) => stream.once('error', resolve))
        expect(error).toBeInstanceOf(BashOutcomeUnknownError)
        expect((error as BashOutcomeUnknownError).invocationId).toBe('stable')
        await stream.cancelAndWait('transport-loss')

        expect(calls.filter(({ url }) => url.endsWith('/bash'))).toHaveLength(1)
        const cancel = calls.find(({ url }) => url.endsWith('/bash/cancel'))
        expect(JSON.parse(cancel?.body ?? '{}')).toMatchObject({ invocationId: 'stable' })
      } finally {
        globalThis.fetch = previousFetch
      }
    }
  )
})
