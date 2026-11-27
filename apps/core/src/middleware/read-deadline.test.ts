import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  CORE_IDLE_TIMEOUT_SECONDS,
  READ_DEADLINE_CODE,
  READ_DEADLINE_SECONDS,
  exemptFromReadDeadline,
  extendIdleTimeout,
  holdIdleTimerForBodylessWrites,
  readDeadline,
} from './read-deadline'
import { currentQueryCancellationScope, type QueryCancellationScope } from '../db/query-cancellation'

const DEADLINE_SECONDS = 0.1

function buildApp(timeouts: Array<[Request, number]> = []) {
  const finished: string[] = []
  const slow = async (label: string) => {
    await Bun.sleep(400)
    finished.push(label)
  }
  const app = new Hono()
  app.use('*', readDeadline({ seconds: DEADLINE_SECONDS }))
  app.get('/fast', (c) => c.json({ ok: true }))
  app.get('/slow', async (c) => {
    c.header('X-Handler-Header', 'leaked')
    await slow('read')
    return c.json({ ok: true })
  })
  app.post('/slow', async (c) => {
    await slow('write')
    return c.json({ ok: true })
  })
  app.get('/extended', async (c) => {
    extendIdleTimeout(c, 0)
    await slow('extended')
    return c.json({ ok: true })
  })
  app.get('/proxied', async (c) => {
    exemptFromReadDeadline(c)
    await slow('proxied')
    return c.json({ ok: true })
  })
  app.get('/fails', async () => {
    await Bun.sleep(5)
    throw new Error('read failed')
  })
  const server = { timeout: (request: Request, seconds: number) => timeouts.push([request, seconds]) }
  return { app, finished, fetch: (path: string, init?: RequestInit) => app.request(path, init, server) }
}

describe('readDeadline', () => {
  it('stays under the listener idle timeout it protects against', () => {
    // Bun closes a body-less request about 32 s after it arrives at idleTimeout 30.
    expect(READ_DEADLINE_SECONDS).toBeLessThanOrEqual(CORE_IDLE_TIMEOUT_SECONDS - 5)
  })

  it('passes a read that answers in time through unchanged', async () => {
    const { fetch } = buildApp()
    const response = await fetch('/fast')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('answers a read that runs past its deadline with a 503 it can explain, and lets the handler finish', async () => {
    const { fetch, finished } = buildApp()
    const started = performance.now()
    const response = await fetch('/slow')
    expect(performance.now() - started).toBeLessThan(350)
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    // The abandoned handler's headers do not leak into the deadline answer.
    expect(response.headers.get('X-Handler-Header')).toBeNull()
    const body = (await response.json()) as { error: string; code: string }
    expect(body.code).toBe(READ_DEADLINE_CODE)
    expect(body.error).toBe(
      'Ficus is busy and did not finish this read within 0.1 seconds. Nothing was changed; try again in a few seconds.'
    )
    expect(finished).toEqual([])
    await Bun.sleep(500)
    expect(finished).toEqual(['read'])
  })

  it('never answers for a write, whose result the client needs', async () => {
    const { fetch } = buildApp()
    const response = await fetch('/slow', { method: 'POST' })
    expect(response.status).toBe(200)
  })

  it('leaves routes that set their own idle timeout alone', async () => {
    const timeouts: Array<[Request, number]> = []
    const { fetch } = buildApp(timeouts)
    const extended = await fetch('/extended')
    expect(extended.status).toBe(200)
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0]![1]).toBe(0)
    expect(new URL(timeouts[0]![0].url).pathname).toBe('/extended')
    const proxied = await fetch('/proxied')
    expect(proxied.status).toBe(200)
  })

  it('reports a read that fails before its deadline as before', async () => {
    const { fetch } = buildApp()
    const response = await fetch('/fails')
    expect(response.status).toBe(500)
  })

  it('answers before a real Bun listener idle timer can drop the socket', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = new Hono()
    app.use('*', readDeadline({ seconds: 0.5 }))
    app.get('/slow', async (c) => {
      await held
      return c.json({ ok: true })
    })
    app.get('/unguarded', async (c) => {
      await held
      return c.json({ ok: true })
    })
    const bare = new Hono()
    bare.get('/unguarded', async (c) => {
      await held
      return c.json({ ok: true })
    })
    const guarded = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, server) => app.fetch(request, server) })
    const unguarded = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, server) => bare.fetch(request, server) })
    try {
      const answered = await fetch(`http://127.0.0.1:${guarded.port}/slow`)
      expect(answered.status).toBe(503)
      expect(((await answered.json()) as { code: string }).code).toBe(READ_DEADLINE_CODE)
      // Without the middleware the same listener drops the read.
      const dropped = await fetch(`http://127.0.0.1:${unguarded.port}/unguarded`).catch((error: unknown) => error)
      expect(dropped).toBeInstanceOf(Error)
      expect((dropped as { code?: string }).code).toBe('ECONNRESET')
    } finally {
      release()
      await Promise.all([guarded.stop(true), unguarded.stop(true)])
    }
  }, 20_000)
})

describe('readDeadline query cancellation', () => {
  /** A handler that records the cancellation signal its queries would carry, then waits. */
  function signalApp(options: { waitMs?: number; seconds?: number } = {}) {
    const seen: Array<QueryCancellationScope | undefined> = []
    let answered!: () => void
    const handlerAnswered = new Promise<void>((resolve) => {
      answered = resolve
    })
    const app = new Hono()
    app.use('*', readDeadline({ seconds: options.seconds ?? DEADLINE_SECONDS }))
    const handler = async () => {
      seen.push(currentQueryCancellationScope())
      await Bun.sleep(options.waitMs ?? 0)
      // After an await, as a handler's second query would see it.
      seen.push(currentQueryCancellationScope())
      answered()
      return new Response('ok')
    }
    app.get('/read', handler)
    app.post('/write', handler)
    return { app, seen, handlerAnswered }
  }

  it('cancels the database work of a read that passed its deadline', async () => {
    const { app, seen } = signalApp({ waitMs: 300 })
    const response = await app.request('/read')
    expect(response.status).toBe(503)
    expect(seen[0]?.state).toBe('abandoned')
    expect(String(seen[0]!.reason)).toContain('read deadline')
  })

  it('cancels the database work of a read whose client hung up before the answer', async () => {
    const { app, seen } = signalApp({ waitMs: 50, seconds: 10 })
    const client = new AbortController()
    const pending = app.request(new Request('http://localhost/read', { signal: client.signal }))
    await Bun.sleep(10)
    expect(seen[0]!.state).toBe('live')
    client.abort()
    expect(seen[0]!.state).toBe('abandoned')
    expect(String(seen[0]!.reason)).toContain('closed the connection')
    await pending
  })

  it('cancels nothing for a read that answered in time, even if the client leaves afterwards', async () => {
    const { app, seen } = signalApp()
    const client = new AbortController()
    const response = await app.request(new Request('http://localhost/read', { signal: client.signal }))
    expect(response.status).toBe(200)
    client.abort()
    expect(seen).toHaveLength(2)
    // Closed once it answered: a later disconnect cancels nothing, and nothing more is recorded.
    expect(seen[0]).toBe(seen[1])
    expect(seen[0]!.state).toBe('closed')
  })

  it('never ties a write to a cancellation signal', async () => {
    const { app, seen } = signalApp()
    const response = await app.request('/write', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(seen).toEqual([undefined, undefined])
  })

  it('sees a real Bun client disconnect and cancels the read behind it', async () => {
    const { app, seen } = signalApp({ waitMs: 2_000, seconds: 10 })
    const server = Bun.serve({ port: 0, fetch: (request, bunServer) => app.fetch(request, bunServer) })
    try {
      const client = new AbortController()
      const request = fetch(`http://127.0.0.1:${server.port}/read`, { signal: client.signal }).catch(() => undefined)
      for (let i = 0; i < 100 && seen.length === 0; i += 1) await Bun.sleep(10)
      expect(seen[0]!.state).toBe('live')
      client.abort()
      await request
      for (let i = 0; i < 100 && seen[0]!.state === 'live'; i += 1) await Bun.sleep(10)
      expect(seen[0]!.state).toBe('abandoned')
    } finally {
      await server.stop(true)
    }
  }, 10_000)
})

describe('holdIdleTimerForBodylessWrites', () => {
  function buildWriteApp() {
    const timeouts: Array<[string, string, number]> = []
    const app = new Hono()
    app.use('*', holdIdleTimerForBodylessWrites({ idleTimeoutSeconds: 30 }))
    app.post('/pause', (c) => {
      timeouts.push([c.req.method, 'handler', -1])
      return c.json({ paused: true })
    })
    app.delete('/thing', (c) => c.json({ deleted: true }))
    app.post('/json', async (c) => c.json(await c.req.json()))
    app.get('/read', (c) => c.json({ ok: true }))
    app.post('/fails', () => {
      throw new Error('write failed')
    })
    app.post('/extended', (c) => {
      extendIdleTimeout(c, 0)
      return c.json({ ok: true })
    })
    app.onError((error, c) => c.json({ error: error.message }, 500))
    const server = {
      timeout: (request: Request, seconds: number) =>
        timeouts.push([request.method, new URL(request.url).pathname, seconds]),
    }
    return { timeouts, fetch: (path: string, init?: RequestInit) => app.request(path, init, server) }
  }

  it('turns the idle timer off for a body-less write while it runs and back on before it answers', async () => {
    const { fetch, timeouts } = buildWriteApp()
    const response = await fetch('/pause', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(timeouts).toEqual([
      ['POST', '/pause', 0],
      ['POST', 'handler', -1],
      ['POST', '/pause', 30],
    ])
    const deleted = await fetch('/thing', { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(timeouts.slice(3)).toEqual([
      ['DELETE', '/thing', 0],
      ['DELETE', '/thing', 30],
    ])
  })

  it('restores the timer when the handler fails', async () => {
    const { fetch, timeouts } = buildWriteApp()
    const response = await fetch('/fails', { method: 'POST' })
    expect(response.status).toBe(500)
    expect(timeouts).toEqual([
      ['POST', '/fails', 0],
      ['POST', '/fails', 30],
    ])
  })

  it('leaves reads and writes with a body to the listener', async () => {
    const { fetch, timeouts } = buildWriteApp()
    expect((await fetch('/read')).status).toBe(200)
    const json = await fetch('/json', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'Content-Type': 'application/json' },
    })
    expect(await json.json()).toEqual({ a: 1 })
    expect(timeouts).toEqual([])
  })

  it('keeps the idle timeout a route set for itself', async () => {
    const { fetch, timeouts } = buildWriteApp()
    expect((await fetch('/extended', { method: 'POST' })).status).toBe(200)
    expect(timeouts).toEqual([
      ['POST', '/extended', 0],
      ['POST', '/extended', 0],
    ])
  })

  it('lets a slow body-less write on a real Bun listener answer, then still closes its idle socket', async () => {
    // At idleTimeout 1, Bun 1.4.2 drops a body-less request whose handler is silent for about 4 s.
    const HANDLER_MS = 5_000
    const slowPause = async (c: { json: (body: unknown) => Response }) => {
      await Bun.sleep(HANDLER_MS)
      return c.json({ paused: true })
    }
    const app = new Hono()
    app.use('*', holdIdleTimerForBodylessWrites({ idleTimeoutSeconds: 1 }))
    app.post('/pause', slowPause)
    const bare = new Hono()
    bare.post('/pause', slowPause)
    const guarded = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, server) => app.fetch(request, server) })
    const unguarded = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, server) => bare.fetch(request, server) })
    try {
      // A raw keep-alive socket, so the test also sees when the server closes it afterwards.
      let client: { end(): void } | undefined
      const guardedExchange = new Promise<{ response: string; answeredAt: number; closedAt: number }>((resolve) => {
        const started = performance.now()
        let response = ''
        let answeredAt = 0
        // Stop waiting a while after the answer: a socket left with the timer off would never close.
        const giveUp = setTimeout(() => {
          resolve({ response, answeredAt, closedAt: Number.POSITIVE_INFINITY })
          client?.end()
        }, HANDLER_MS + 10_000)
        void Bun.connect({
          hostname: '127.0.0.1',
          port: guarded.port!,
          socket: {
            open(socket) {
              client = socket
              socket.write('POST /pause HTTP/1.1\r\nHost: core\r\nContent-Length: 0\r\n\r\n')
            },
            data(_socket, chunk) {
              response += chunk.toString()
              answeredAt ||= performance.now() - started
            },
            close() {
              clearTimeout(giveUp)
              resolve({ response, answeredAt, closedAt: performance.now() - started })
            },
          },
        })
      })
      // Without the middleware the same listener drops the write while its handler still runs.
      const dropped = await fetch(`http://127.0.0.1:${unguarded.port}/pause`, { method: 'POST' }).catch(
        (error: unknown) => error
      )
      expect(dropped).toBeInstanceOf(Error)
      expect((dropped as { code?: string }).code).toBe('ECONNRESET')

      const { response, answeredAt, closedAt } = await guardedExchange
      expect(response.startsWith('HTTP/1.1 200')).toBe(true)
      expect(response.endsWith('{"paused":true}')).toBe(true)
      expect(answeredAt).toBeGreaterThanOrEqual(HANDLER_MS)
      // The idle keep-alive socket is closed again rather than kept open with the timer off.
      expect(closedAt - answeredAt).toBeLessThan(8_000)
    } finally {
      await Promise.all([guarded.stop(true), unguarded.stop(true)])
    }
  }, 30_000)
})
