import { describe, expect, it, mock } from 'bun:test'
import {
  classifySandboxTransportError,
  SandboxClient,
  SandboxHttpError,
  type SandboxTransportKind,
} from './http-client'

describe('SandboxClient unary RPC errors (post)', () => {
  async function withFetch(response: Response, fn: (client: SandboxClient) => Promise<void>) {
    const previousFetch = globalThis.fetch
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch
    try {
      await fn(new SandboxClient('127.0.0.1:1234'))
    } finally {
      globalThis.fetch = previousFetch
    }
  }

  it('throws a SandboxHttpError carrying the status and the JSON error message', async () => {
    await withFetch(Response.json({ error: 'path escapes the allowed roots' }, { status: 400 }), async (client) => {
      const err = await client.mkdir({ path: '/etc/evil' }).catch((e) => e)
      expect(err).toBeInstanceOf(SandboxHttpError)
      expect((err as SandboxHttpError).status).toBe(400)
      expect((err as SandboxHttpError).message).toBe('path escapes the allowed roots')
    })
  })

  it('handles a non-JSON error body (old bundle plain-text 404) without a SyntaxError', async () => {
    // A pre-mkdir-RPC box bundle answers unknown routes with plain text
    // `Not found` — the parse guard must surface the 404, not a JSON crash.
    await withFetch(new Response('Not found', { status: 404 }), async (client) => {
      const err = await client.mkdir({ path: '/home/x/dir' }).catch((e) => e)
      expect(err).toBeInstanceOf(SandboxHttpError)
      expect((err as SandboxHttpError).status).toBe(404)
      expect((err as SandboxHttpError).message).toBe('Request failed: 404')
    })
  })

  it('returns the parsed body on success', async () => {
    await withFetch(Response.json({ ok: true }), async (client) => {
      await expect(client.mkdir({ path: '/home/x/dir' })).resolves.toEqual({ ok: true })
    })
  })
})

describe('SandboxClient auth token', () => {
  it('sends Authorization: Bearer on requests when constructed with a token', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') })
      return Response.json({ exists: true })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234', 'tok-abc')
      await client.stat({ path: '/tmp' })
      await client.health()
      expect(seen.length).toBe(2)
      for (const call of seen) expect(call.auth).toBe('Bearer tok-abc')
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('sends no Authorization header without a token (k8s pods, legacy boxes)', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<string | null> = []
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ exists: true })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      await client.stat({ path: '/tmp' })
      expect(seen).toEqual([null])
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

describe('SandboxClient watch errors', () => {
  it('includes sanitized response body when starting watch fails', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = mock(
      async () =>
        new Response('Invalid watch config: include must not be empty; Authorization: Bearer super-secret', {
          status: 400,
        })
    ) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')

      await expect(client.startWatch({ include: [], exclude: [], squadId: 'squad-1' })).rejects.toThrow(
        'Failed to start watch: 400 Invalid watch config: include must not be empty; Authorization: Bearer [REDACTED]'
      )
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

describe('sandbox transport error classification', () => {
  const cases: Array<[unknown, SandboxTransportKind]> = [
    [Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'connection_reset'],
    [new Error('The socket connection was closed unexpectedly'), 'socket_closed'],
    [Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), 'connection_reset'],
    [Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }), 'connection_refused'],
    [Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), 'timeout'],
  ]
  it.each(cases)('classifies transport failure %# without exposing its message', (error, kind) => {
    expect(classifySandboxTransportError(error)?.kind).toBe(kind)
  })

  it('does not classify caller aborts as infrastructure failures', () => {
    expect(classifySandboxTransportError(new DOMException('aborted', 'AbortError'))).toBeNull()
  })
})

describe('SandboxClient bounded health probes', () => {
  it('classifies a black-holed health probe as a transport timeout', async () => {
    const fetchMock = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        )
    )
    const client = new SandboxClient('box.test:123', undefined, { fetch: fetchMock, healthTimeoutMs: 1 })
    await expect(client.health()).rejects.toMatchObject({ code: 'SANDBOX_TRANSPORT', kind: 'timeout' })
  })

  it('aborts an in-flight health probe when the client closes', async () => {
    let aborted = false
    const fetchMock = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(init.signal?.reason)
            },
            { once: true }
          )
        )
    )
    const client = new SandboxClient('box.test:123', undefined, { fetch: fetchMock, healthTimeoutMs: 60_000 })
    const probe = client.health().catch(() => undefined)
    client.close()
    await probe
    expect(aborted).toBe(true)
  })
})

describe('SandboxClient browser methods', () => {
  it('browserOpen POSTs /browser/open with runId and url, and sends auth header', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown; auth: string | null }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: headers.get('authorization'),
      })
      return Response.json({ title: 'Example Page', screenshotBase64: 'abc123' })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234', 'tok-xyz')
      const result = await client.browserOpen('run-123', 'https://example.com')
      expect(seen.length).toBe(1)
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/open')
      expect(seen[0].body).toEqual({ runId: 'run-123', url: 'https://example.com' })
      expect(seen[0].auth).toBe('Bearer tok-xyz')
      expect(result).toEqual({ title: 'Example Page', screenshotBase64: 'abc123' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserClick POSTs /browser/click with runId and options', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ ok: true, screenshotBase64: 'def456' })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserClick('run-123', { selector: '.button', returnScreenshot: true })
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/click')
      expect(seen[0].body).toEqual({ runId: 'run-123', selector: '.button', returnScreenshot: true })
      expect(result).toEqual({ ok: true, screenshotBase64: 'def456' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserType POSTs /browser/type with runId, text, and options', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      await client.browserType('run-123', { text: 'hello', selector: '#input' })
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/type')
      expect(seen[0].body).toEqual({ runId: 'run-123', text: 'hello', selector: '#input' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserScroll POSTs /browser/scroll with direction and amount', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ ok: true, deltaPx: 100 })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserScroll('run-123', { direction: 'down', amount: 100 })
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/scroll')
      expect(seen[0].body).toEqual({ runId: 'run-123', direction: 'down', amount: 100 })
      expect(result).toEqual({ ok: true, deltaPx: 100 })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserScreenshot POSTs /browser/screenshot with runId', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ screenshotBase64: 'ghi789' })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserScreenshot('run-123')
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/screenshot')
      expect(seen[0].body).toEqual({ runId: 'run-123' })
      expect(result).toEqual({ screenshotBase64: 'ghi789' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserRead POSTs /browser/read with runId and optional selector', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ text: 'Page content' })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserRead('run-123', '.content')
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/read')
      expect(seen[0].body).toEqual({ runId: 'run-123', selector: '.content' })
      expect(result).toEqual({ text: 'Page content' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserRead POSTs /browser/read without selector when not provided', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ text: 'Page content' })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      await client.browserRead('run-123')
      expect(seen[0].body).toEqual({ runId: 'run-123' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserConsole POSTs /browser/console with runId', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ entries: [{ type: 'log', text: 'hello' }] })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserConsole('run-123')
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/console')
      expect(seen[0].body).toEqual({ runId: 'run-123' })
      expect(result).toEqual({ entries: [{ type: 'log', text: 'hello' }] })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserClose POSTs /browser/close with runId', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      })
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const result = await client.browserClose('run-123')
      expect(seen[0].url).toBe('http://127.0.0.1:1234/browser/close')
      expect(seen[0].body).toEqual({ runId: 'run-123' })
      expect(result).toEqual({ ok: true })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('browserOpen rejects with SandboxHttpError on 503 BROWSER_UNAVAILABLE', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      Response.json({ error: 'Browser not available', code: 'BROWSER_UNAVAILABLE' }, { status: 503 })
    ) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234')
      const err = await client.browserOpen('run-123', 'https://example.com').catch((e) => e)
      expect(err).toBeInstanceOf(SandboxHttpError)
      expect((err as SandboxHttpError).status).toBe(503)
      expect((err as SandboxHttpError).code).toBe('BROWSER_UNAVAILABLE')
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

describe('SandboxClient close lifecycle', () => {
  it('aborts unary response consumption and rejects new work through the injected transport', async () => {
    let fetchCalls = 0
    let bodyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bodyStarted = resolve
    })
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      fetchCalls++
      const signal = init?.signal
      const body = new ReadableStream({
        start(controller) {
          bodyStarted()
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    })
    const client = new SandboxClient('box.test:123', undefined, { fetch: fetchMock, unaryTimeoutMs: 60_000 })
    const request = client.stat({ path: '/tmp/file' })
    await started
    client.close()
    await expect(request).rejects.toMatchObject({ name: 'SandboxClientClosedError', code: 'SANDBOX_CLIENT_CLOSED' })
    await expect(client.stat({ path: '/tmp/other' })).rejects.toMatchObject({ code: 'SANDBOX_CLIENT_CLOSED' })
    expect(fetchCalls).toBe(1)
    client.close()
  })

  it('closes connecting shells, drops queued writes, and rejects shells after close', () => {
    class FakeWebSocket {
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: (() => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      sent: string[] = []
      closeCalls = 0
      send(value: string) {
        this.sent.push(value)
      }
      close() {
        this.closeCalls++
      }
    }
    const socket = new FakeWebSocket()
    let factoryCalls = 0
    const client = new SandboxClient('box.test:123', 'token', {
      webSocketFactory: (url, headers) => {
        factoryCalls++
        expect(url).toBe('ws://box.test:123/shell')
        expect(headers.authorization).toBe('Bearer token')
        return socket as unknown as WebSocket
      },
    })
    const shell = client.shell()
    let ends = 0
    shell.on('end', () => ends++)
    expect(shell.write({ spawn: { cols: 80, rows: 24 } })).toBe(true)
    client.close()
    expect(socket.closeCalls).toBe(1)
    socket.onopen?.()
    expect(socket.sent).toEqual([])
    expect(shell.write({ data: 'Zm9v' })).toBe(false)
    socket.onclose?.()
    socket.onclose?.()
    expect(ends).toBe(1)
    expect(() => client.shell()).toThrow('Sandbox client is closed')
    expect(factoryCalls).toBe(1)
  })
})

describe('SandboxClient.upload (raw-body transport)', () => {
  it('POSTs raw bytes as octet-stream with params in the query string and auth header', async () => {
    const previousFetch = globalThis.fetch
    const seen: Array<{ url: string; contentType: string | null; auth: string | null; body: Uint8Array }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        contentType: new Headers(init?.headers).get('content-type'),
        auth: new Headers(init?.headers).get('authorization'),
        body: new Uint8Array(init?.body as Uint8Array),
      })
      return Response.json({ bytesWritten: 3, sha256: 'x'.repeat(64) })
    }) as unknown as typeof fetch

    try {
      const client = new SandboxClient('127.0.0.1:1234', 'tok-up')
      const bytes = new Uint8Array([1, 2, 3])
      const result = await client.upload({
        path: '/workspace/dir/a b.bin',
        content: bytes,
        createDirs: true,
        mode: '0600',
      })
      expect(result.bytesWritten).toBe(3)
      expect(seen).toHaveLength(1)
      const url = new URL(seen[0].url)
      expect(url.pathname).toBe('/upload')
      expect(url.searchParams.get('path')).toBe('/workspace/dir/a b.bin')
      expect(url.searchParams.get('createDirs')).toBe('true')
      expect(url.searchParams.get('mode')).toBe('0600')
      expect(seen[0].contentType).toBe('application/octet-stream')
      expect(seen[0].auth).toBe('Bearer tok-up')
      expect(Array.from(seen[0].body)).toEqual([1, 2, 3])
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  it('surfaces a 404 from an old box bundle as SandboxHttpError with status 404 (callers fall back to write())', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response('Not found', { status: 404 })) as unknown as typeof fetch
    try {
      const client = new SandboxClient('127.0.0.1:1234')
      await expect(client.upload({ path: '/workspace/x', content: new Uint8Array([1]) })).rejects.toMatchObject({
        name: 'SandboxHttpError',
        status: 404,
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})

describe('SandboxClient legacy env overrides (one release)', () => {
  it('sends a TAU_ alias for every FICUS_ per-command override, for executors started before the rename', async () => {
    const previousFetch = globalThis.fetch
    let body: { env?: Record<string, string> } | undefined
    const called = new Promise<void>((resolve) => {
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body))
        resolve()
        return new Response('', { status: 500 })
      }) as unknown as typeof fetch
    })

    try {
      const client = new SandboxClient('127.0.0.1:1234', 'tok-xyz')
      const stream = client.bash({
        command: 'ficus whoami',
        env: { FICUS_API_URL: 'http://core:3000', FICUS_TOKEN: 't' },
      })
      stream.on('error', () => {})
      await called
      expect(body?.env).toEqual({
        FICUS_API_URL: 'http://core:3000',
        FICUS_TOKEN: 't',
        TAU_API_URL: 'http://core:3000',
        TAU_TOKEN: 't',
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
