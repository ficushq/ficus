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
  restoreExtendedIdleTimeout,
} from './read-deadline'

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

describe('holdIdleTimerForBodylessWrites', () => {
  function buildWriteApp(options: { failRestore?: boolean } = {}) {
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
      timeout: (request: Request, seconds: number) => {
        timeouts.push([request.method, new URL(request.url).pathname, seconds])
        // Bun can throw here for a request whose client has already gone.
        if (options.failRestore && seconds !== 0) throw new Error('socket already closed')
      },
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

  it('keeps the handler result or error when Bun refuses to restore the timer', async () => {
    const { fetch, timeouts } = buildWriteApp({ failRestore: true })
    const paused = await fetch('/pause', { method: 'POST' })
    expect(paused.status).toBe(200)
    expect(await paused.json()).toEqual({ paused: true })
    const failed = await fetch('/fails', { method: 'POST' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'write failed' })
    expect(timeouts.filter(([, path]) => path !== 'handler').map(([, path, seconds]) => [path, seconds])).toEqual([
      ['/pause', 0],
      ['/pause', 30],
      ['/fails', 0],
      ['/fails', 30],
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

/** A body that sends `first`, goes quiet for `pauseMs`, then sends `last`. */
function pausingBody(first: string, last: string, pauseMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(first))
      await Bun.sleep(pauseMs)
      controller.enqueue(encoder.encode(last))
      controller.close()
    },
  })
}

/**
 * Send one request on a raw keep-alive socket and report when the answer arrived
 * and when the server closed the socket, so a test can see an idle socket that is
 * never closed (closedAt is Infinity once `giveUpMs` has passed).
 */
function keepAliveExchange(
  port: number,
  request: string,
  giveUpMs: number
): Promise<{ response: string; answeredAt: number; closedAt: number }> {
  return new Promise((resolve) => {
    const started = performance.now()
    let client: { end(): void } | undefined
    let response = ''
    let answeredAt = 0
    const giveUp = setTimeout(() => {
      resolve({ response, answeredAt, closedAt: Number.POSITIVE_INFINITY })
      client?.end()
    }, giveUpMs)
    void Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          client = socket
          socket.write(request)
        },
        data(_socket, chunk) {
          response += chunk.toString()
          answeredAt = performance.now() - started
        },
        close() {
          clearTimeout(giveUp)
          resolve({ response, answeredAt, closedAt: performance.now() - started })
        },
      },
    })
  })
}

describe('restoreExtendedIdleTimeout', () => {
  function buildExtendedApp(options: { failRestore?: boolean } = {}) {
    const timeouts: Array<[string, number]> = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = new Hono()
    app.use('*', restoreExtendedIdleTimeout({ idleTimeoutSeconds: 30 }))
    app.post('/create', (c) => {
      extendIdleTimeout(c, 0)
      timeouts.push(['handler', -1])
      return c.json({ created: true })
    })
    app.post('/fails', (c) => {
      extendIdleTimeout(c, 0)
      throw new Error('create failed')
    })
    app.get('/download', (c) => {
      extendIdleTimeout(c, 0, { untilBodySent: true })
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('first,'))
          await held
          controller.enqueue(encoder.encode('last'))
          controller.close()
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'application/gzip', 'Content-Length': '10' } })
    })
    app.get('/missing', (c) => {
      extendIdleTimeout(c, 0, { untilBodySent: true })
      return c.json({ error: 'File not found' }, 404)
    })
    app.get('/plain', (c) => c.json({ ok: true }))
    app.get('/proxied', (c) => {
      exemptFromReadDeadline(c)
      return c.json({ ok: true })
    })
    app.onError((error, c) => c.json({ error: error.message }, 500))
    const server = {
      timeout: (request: Request, seconds: number) => {
        timeouts.push([`${request.method} ${new URL(request.url).pathname}`, seconds])
        if (options.failRestore && seconds !== 0) throw new Error('socket already closed')
      },
    }
    return { timeouts, release, fetch: (path: string, init?: RequestInit) => app.request(path, init, server) }
  }

  it('turns the timer back on once an extending handler returns, before it answers', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    const response = await fetch('/create', { method: 'POST', body: '{}' })
    expect(response.status).toBe(200)
    expect(timeouts).toEqual([
      ['POST /create', 0],
      ['handler', -1],
      ['POST /create', 30],
    ])
  })

  it('turns the timer back on when an extending handler fails', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    const response = await fetch('/fails', { method: 'POST', body: '{}' })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'create failed' })
    expect(timeouts).toEqual([
      ['POST /fails', 0],
      ['POST /fails', 30],
    ])
  })

  it('leaves requests that did not extend their timer alone, including the local-app proxy', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    expect((await fetch('/plain')).status).toBe(200)
    expect((await fetch('/proxied')).status).toBe(200)
    expect(timeouts).toEqual([])
  })

  it('keeps the timer off until a streamed body has been sent, then turns it back on', async () => {
    const { fetch, timeouts, release } = buildExtendedApp()
    const response = await fetch('/download')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/gzip')
    expect(response.headers.get('Content-Length')).toBe('10')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toBe('first,')
    expect(timeouts).toEqual([['GET /download', 0]])
    release()
    expect(decoder.decode((await reader.read()).value)).toBe('last')
    expect((await reader.read()).done).toBe(true)
    expect(timeouts).toEqual([
      ['GET /download', 0],
      ['GET /download', 30],
    ])
  })

  it('turns the timer back on when the client stops reading a streamed body', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    const response = await fetch('/download')
    const reader = response.body!.getReader()
    await reader.read()
    expect(timeouts).toEqual([['GET /download', 0]])
    await reader.cancel()
    expect(timeouts).toEqual([
      ['GET /download', 0],
      ['GET /download', 30],
    ])
  })

  it('turns the timer back on at once for a HEAD, whose body Bun never sends', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    const response = await fetch('/download', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(timeouts).toEqual([
      ['HEAD /download', 0],
      ['HEAD /download', 30],
    ])
  })

  it('still sends a short error answer from a route that waits for its body', async () => {
    const { fetch, timeouts } = buildExtendedApp()
    const response = await fetch('/missing')
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'File not found' })
    expect(timeouts).toEqual([
      ['GET /missing', 0],
      ['GET /missing', 30],
    ])
  })

  it('keeps the handler result, error or body when Bun refuses to restore the timer', async () => {
    const { fetch, release } = buildExtendedApp({ failRestore: true })
    const created = await fetch('/create', { method: 'POST', body: '{}' })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ created: true })
    const failed = await fetch('/fails', { method: 'POST', body: '{}' })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'create failed' })
    const download = await fetch('/download')
    release()
    expect(await download.text()).toBe('first,last')
    const cancelled = await fetch('/download')
    await cancelled.body!.cancel()
  })

  it('closes the idle keep-alive socket after an extending route, and keeps a quiet download open until it is sent', async () => {
    // At idleTimeout 1, Bun 1.4.2 closes a socket that has been idle for about 4 s.
    const PAUSE_MS = 6_000
    const GIVE_UP_MS = PAUSE_MS + 12_000
    const app = new Hono()
    app.use('*', restoreExtendedIdleTimeout({ idleTimeoutSeconds: 1 }))
    app.post('/create', async (c) => {
      extendIdleTimeout(c, 0)
      return c.json(await c.req.json())
    })
    app.get('/download', (c) => {
      extendIdleTimeout(c, 0, { untilBodySent: true })
      return new Response(pausingBody('first,', 'last', PAUSE_MS))
    })
    // The same download, with the timer back on as soon as the handler returns.
    app.get('/early', (c) => {
      extendIdleTimeout(c, 0)
      return new Response(pausingBody('first,', 'last', PAUSE_MS))
    })
    const server = Bun.serve({ port: 0, idleTimeout: 1, fetch: (request, bun) => app.fetch(request, bun) })
    try {
      const [created, download, early] = await Promise.all([
        keepAliveExchange(
          server.port!,
          'POST /create HTTP/1.1\r\nHost: core\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
          GIVE_UP_MS
        ),
        keepAliveExchange(server.port!, 'GET /download HTTP/1.1\r\nHost: core\r\n\r\n', GIVE_UP_MS),
        keepAliveExchange(server.port!, 'GET /early HTTP/1.1\r\nHost: core\r\n\r\n', GIVE_UP_MS),
      ])

      expect(created.response.startsWith('HTTP/1.1 200')).toBe(true)
      expect(created.response.endsWith('{}')).toBe(true)
      // Left with the timer off, this socket would stay open until the test gave up.
      expect(created.closedAt - created.answeredAt).toBeLessThan(8_000)

      // The quiet stretch in the body does not cut the download.
      expect(download.response.startsWith('HTTP/1.1 200')).toBe(true)
      expect(download.response).toContain('last')
      expect(download.response.endsWith('0\r\n\r\n')).toBe(true)
      expect(download.answeredAt).toBeGreaterThanOrEqual(PAUSE_MS)
      // Once the body has been sent, the idle socket is closed again.
      expect(download.closedAt - download.answeredAt).toBeLessThan(8_000)

      // Restoring the timer when the handler returns would have cut it mid-body.
      expect(early.response).toContain('first,')
      expect(early.response).not.toContain('last')
      expect(early.closedAt).toBeLessThan(PAUSE_MS)
    } finally {
      await server.stop(true)
    }
  }, 40_000)
})
