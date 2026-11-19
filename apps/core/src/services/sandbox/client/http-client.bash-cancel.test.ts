import { describe, expect, jest, mock, test } from 'bun:test'
import {
  bashOutcomeUnknownForError,
  BashCleanupUnprovenError,
  BashOutcomeUnknownError,
  SandboxClient,
} from './http-client'

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
  test.each(['clean-eof', 'reader-reset', 'reader-timeout'] as const)(
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
            else if (mode === 'reader-timeout')
              controller.error(new DOMException('The operation timed out', 'TimeoutError'))
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
        expect((error as BashOutcomeUnknownError).failureClass).toBe(
          mode === 'clean-eof' ? 'protocol_truncated' : mode === 'reader-timeout' ? 'timeout' : 'socket_closed'
        )
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

test('restart cancellation sends the same reason, id and time to the registry endpoint', async () => {
  const requests: RequestInit[] = []
  const client = new SandboxClient('box.test:123', undefined, {
    fetch: async (_url, init) => {
      requests.push(init!)
      return Response.json({ remainingPids: [] })
    },
  })
  const restart = { restartId: 'restart-1', restartedAt: '2026-10-28T21:32:00.000Z' }
  await client.cancelBashInvocation('stable', 'core_restart', restart)
  expect(JSON.parse(String(requests[0]?.body))).toEqual({ invocationId: 'stable', reason: 'core_restart', restart })
})

test('records the restart cancellation before disconnecting the stream, avoiding transport-loss winning the registry race', async () => {
  let streamSignal: AbortSignal | undefined
  let releaseCancel!: () => void
  const client = new SandboxClient('box.test:123', undefined, {
    fetch: async (url, init) => {
      if (String(url).endsWith('/bash/cancel')) {
        expect(streamSignal?.aborted).toBe(false)
        await new Promise<void>((resolve) => {
          releaseCancel = resolve
        })
        return Response.json({ remainingPids: [] })
      }
      streamSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream({
          start(controller) {
            streamSignal?.addEventListener('abort', () => controller.close(), { once: true })
          },
        })
      )
    },
  })
  const stream = client.bash({ command: 'sleep 60', invocationId: 'restart-race' })
  const cancelled = stream.cancelAndWait('core_restart', { restartId: 'r', restartedAt: '2026-10-28T21:32:00.000Z' })
  // Avoid leaving an unresolved stream on assertion failure.
  await Promise.resolve()
  releaseCancel?.()
  await cancelled
  expect(streamSignal?.aborted).toBe(true)
})

test('a silent foreground stream has no unary or output-idle deadline and accepts split SSE after a long quiet interval', async () => {
  jest.useFakeTimers()
  let body!: ReadableStreamDefaultController<Uint8Array>
  let requestSignal: AbortSignal | undefined
  let terminal = false
  const errors: Error[] = []
  const calls: string[] = []
  const encoder = new TextEncoder()
  const client = new SandboxClient('quiet.test', undefined, {
    unaryTimeoutMs: 1,
    fetch: async (url, init) => {
      calls.push(String(url))
      requestSignal = init?.signal ?? undefined
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
          },
        })
      )
    },
  })
  try {
    const stream = client.bash({ command: 'quiet-command', invocationId: 'quiet', timeoutSeconds: 3600 })
    const ended = new Promise<void>((resolve) => stream.on('end', resolve))
    stream.on('data', (data) => {
      if (data.exitCode === 0) terminal = true
    })
    stream.on('error', (error) => errors.push(error))
    // No output, heartbeat or terminal frame is required just to keep the reader alive.
    await Promise.resolve()
    jest.advanceTimersByTime(10 * 60 * 1000)
    await Promise.resolve()
    expect(requestSignal?.aborted).toBe(false)
    expect(terminal).toBe(false)
    expect(errors).toEqual([])
    body.enqueue(encoder.encode(': heartbeat\n\ndata: {"exit'))
    body.enqueue(encoder.encode('Code":0}\n\n'))
    body.close()
    await ended
    expect(terminal).toBe(true)
    expect(errors).toEqual([])
    expect(calls).toHaveLength(1)
  } finally {
    client.close()
    jest.useRealTimers()
  }
})

test('command-loss provenance survives wrappers but cannot be inferred from prose or forged fields', () => {
  const loss = new BashOutcomeUnknownError('stable', 'connection_reset', new Error('PRIVATE_TRANSPORT'))
  const wrapped = new Error('SDK/outage wrapper', { cause: loss })
  expect(bashOutcomeUnknownForError(wrapped)).toBe(loss)
  expect(
    bashOutcomeUnknownForError(
      Object.assign(new Error(loss.message), {
        code: loss.code,
        invocationId: loss.invocationId,
        failureClass: loss.failureClass,
      })
    )
  ).toBeUndefined()
  const cyclic = new Error('cycle')
  cyclic.cause = cyclic
  expect(bashOutcomeUnknownForError(cyclic)).toBeUndefined()
})
