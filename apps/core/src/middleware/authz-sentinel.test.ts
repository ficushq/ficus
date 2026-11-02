import { describe, expect, test, spyOn, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { authzSentinel, PRE_AUTHORIZATION_SERVER_ERROR } from './authz-sentinel'

describe('authzSentinel', () => {
  afterEach(() => {
    // Restore any console spies installed by tests.
    ;(console.error as any).mockRestore?.()
  })

  function appWithSentinel() {
    const app = new Hono()
    app.use('/api/*', authzSentinel)
    return app
  }

  test('allows a guarded matched api route', async () => {
    const app = appWithSentinel()
    app.get('/api/guarded', (c) => {
      c.set('authzChecked', true)
      return c.json({ ok: true })
    })

    const response = await app.request('/api/guarded')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('allows an explicitly public matched api route', async () => {
    const app = appWithSentinel()
    app.get('/api/public', (c) => {
      c.set('publicRoute', true)
      return c.json({ ok: true })
    })

    const response = await app.request('/api/public')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test('fails closed when a matched api route runs without an authz marker', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const app = appWithSentinel()
    app.get('/api/unguarded', (c) => c.json({ leaked: true }))

    const response = await app.request('/api/unguarded')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authorization check missing' })
    expect(errorSpy).toHaveBeenCalled()
  })

  test('still reports a missing check when an unguarded route redirects', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const app = appWithSentinel()
    app.get('/api/unguarded-redirect', (c) => c.redirect('/elsewhere'))

    const response = await app.request('/api/unguarded-redirect')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Authorization check missing' })
  })

  test('reports a synthetic failure thrown before the authz marker as a server error', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    const app = appWithSentinel()
    // Mirrors production: the app error handler turns the throw into a plain 500.
    app.onError((_error, c) => c.text('Internal Server Error', 500))
    app.post('/api/items/:id/read', async (c) => {
      await Promise.reject(new Error('Synthetic pre-authorization lookup failure'))
      c.set('authzChecked', true)
      return c.json({ success: true })
    })

    const response = await app.request('/api/items/synthetic/read', { method: 'POST' })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: PRE_AUTHORIZATION_SERVER_ERROR })
    expect(errorSpy).toHaveBeenCalled()
  })

  test('keeps an unmarked 5xx status but never forwards its body', async () => {
    spyOn(console, 'error').mockImplementation(() => {})
    const app = appWithSentinel()
    app.get('/api/unavailable', (c) => {
      c.header('Retry-After', '5')
      return c.json({ error: 'busy', leaked: 'synthetic-private-value' }, 503)
    })

    const response = await app.request('/api/unavailable')

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('5')
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: PRE_AUTHORIZATION_SERVER_ERROR })
    expect(text).not.toContain('synthetic-private-value')
  })

  test('preserves a server error raised after the authz marker', async () => {
    const app = appWithSentinel()
    app.get('/api/guarded-failure', (c) => {
      c.set('authzChecked', true)
      return c.json({ error: 'Synthetic post-authorization failure' }, 500)
    })

    const response = await app.request('/api/guarded-failure')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Synthetic post-authorization failure' })
  })

  test('preserves handler-produced 4xx responses without an authz marker', async () => {
    const app = appWithSentinel()
    app.get('/api/invalid', (c) => c.json({ error: 'Invalid input' }, 400))

    const response = await app.request('/api/invalid')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid input' })
  })

  test('does not rewrite unmatched api 404s', async () => {
    const app = appWithSentinel()

    const response = await app.request('/api/missing')

    expect(response.status).toBe(404)
  })
})
