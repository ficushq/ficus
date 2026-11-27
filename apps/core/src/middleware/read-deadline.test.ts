import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  CORE_IDLE_TIMEOUT_SECONDS,
  READ_DEADLINE_CODE,
  READ_DEADLINE_SECONDS,
  exemptFromReadDeadline,
  extendIdleTimeout,
  readDeadline,
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
