import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { maybeMountWebUi } from './web-serve'

function fakeLog() {
  const calls: { level: string; args: unknown[] }[] = []
  return {
    calls,
    info: (...args: unknown[]) => calls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
  }
}

function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tau-web-fixture-'))
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta property="og:image" content="__FICUS_ORIGIN__/social-preview.png" /></head><body>app</body></html>'
  )
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
  writeFileSync(join(dir, 'manifest.webmanifest'), '{"name":"Ficus"}')
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'app.abc12345.js'), 'console.log("ok")')
  writeFileSync(join(dir, 'assets', 'index-C2ucfeeU.js'), 'console.log("vite")')
  return dir
}

describe('maybeMountWebUi', () => {
  const origEnv = process.env.FICUS_SERVE_WEB
  const origDist = process.env.FICUS_WEB_DIST
  const origFarmDist = process.env.FICUS_FARM_DIST
  let dist: string

  beforeEach(() => {
    dist = buildFixture()
    process.env.FICUS_WEB_DIST = dist
    // Never pick up a developer's real apps/farm/dist; farm cases opt in below.
    process.env.FICUS_FARM_DIST = join(dist, '__no_farm__')
  })

  afterEach(() => {
    if (origEnv === undefined) delete process.env.FICUS_SERVE_WEB
    else process.env.FICUS_SERVE_WEB = origEnv
    if (origDist === undefined) delete process.env.FICUS_WEB_DIST
    else process.env.FICUS_WEB_DIST = origDist
    if (origFarmDist === undefined) delete process.env.FICUS_FARM_DIST
    else process.env.FICUS_FARM_DIST = origFarmDist
    rmSync(dist, { recursive: true, force: true })
  })

  function setupApp() {
    const app = new Hono()
    // Pre-registered API route mirrors apps/core/src/index.ts ordering.
    app.get('/api/health', (c) => c.json({ status: 'ok' }))
    const log = fakeLog()
    const mounted = maybeMountWebUi(app, log)
    // Sentinel: anything past static + SPA fallback is a hard 404.
    app.all('*', (c) => c.json({ error: 'not-found' }, 404))
    return { app, log, mounted }
  }

  it('serves index.html at /', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app, mounted } = setupApp()
    expect(mounted).toBe(true)
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
    expect(await res.text()).toContain('app')
  })

  it('serves hashed assets with immutable cache header', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/assets/app.abc12345.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    // Vite's own naming: a dash and a base64url hash.
    const vite = await app.request('/assets/index-C2ucfeeU.js')
    expect(vite.status).toBe(200)
    expect(vite.headers.get('Cache-Control')).toContain('immutable')
  })

  it('serves sw.js with no-cache so update checks always revalidate', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/sw.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  it('serves the web manifest with no-cache', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/manifest.webmanifest')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('no-cache')
  })

  it('falls back to index.html for client routes when Accept includes text/html', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/squads/123', {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  describe('origin placeholder', () => {
    const origOrigin = process.env.FICUS_WEB_ORIGIN
    afterEach(() => {
      if (origOrigin === undefined) delete process.env.FICUS_WEB_ORIGIN
      else process.env.FICUS_WEB_ORIGIN = origOrigin
    })

    it('renders index.html with the request origin at / and /index.html', async () => {
      process.env.FICUS_SERVE_WEB = '1'
      delete process.env.FICUS_WEB_ORIGIN
      const { app } = setupApp()
      for (const path of ['/', '/index.html']) {
        const res = await app.request(`http://ficus.local:8080${path}`)
        expect(res.status).toBe(200)
        const body = await res.text()
        expect(body).toContain('content="http://ficus.local:8080/social-preview.png"')
        expect(body).not.toContain('__FICUS_ORIGIN__')
        expect(res.headers.get('Cache-Control')).toContain('no-cache')
      }
    })

    it('prefers the proxy forwarded headers, then the configured web origin', async () => {
      process.env.FICUS_SERVE_WEB = '1'
      delete process.env.FICUS_WEB_ORIGIN
      const { app } = setupApp()
      const forwarded = await app.request('http://127.0.0.1:3000/', {
        headers: { 'x-forwarded-host': 'team.example.com', 'x-forwarded-proto': 'https' },
      })
      expect(await forwarded.text()).toContain('content="https://team.example.com/social-preview.png"')

      process.env.FICUS_WEB_ORIGIN = 'https://ficus.example.org/'
      const configured = await app.request('http://127.0.0.1:3000/', {
        headers: { 'x-forwarded-host': 'ignored.example.com' },
      })
      expect(await configured.text()).toContain('content="https://ficus.example.org/social-preview.png"')
    })

    it('renders the placeholder on the SPA fallback too', async () => {
      process.env.FICUS_SERVE_WEB = '1'
      delete process.env.FICUS_WEB_ORIGIN
      const { app } = setupApp()
      const res = await app.request('http://ficus.local/squads/123', {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      })
      expect(await res.text()).toContain('content="http://ficus.local/social-preview.png"')
    })
  })

  it('does not fall back for JSON clients', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/agents/123', {
      headers: { Accept: 'application/json' },
    })
    expect(res.status).toBe(404)
  })

  it('does not shadow /api/* routes', async () => {
    process.env.FICUS_SERVE_WEB = '1'
    const { app } = setupApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('FICUS_SERVE_WEB=0 disables even when dist exists', () => {
    process.env.FICUS_SERVE_WEB = '0'
    const { mounted } = setupApp()
    expect(mounted).toBe(false)
  })

  it('auto-enables when dist exists and env is unset', async () => {
    delete process.env.FICUS_SERVE_WEB
    const { app, mounted } = setupApp()
    expect(mounted).toBe(true)
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('warns and stays disabled when FICUS_SERVE_WEB=1 but no dist exists', () => {
    process.env.FICUS_SERVE_WEB = '1'
    process.env.FICUS_WEB_DIST = join(dist, '__missing__')
    const { mounted, log } = setupApp()
    expect(mounted).toBe(false)
    expect(log.calls.some((c) => c.level === 'warn')).toBe(true)
  })

  describe('farm UI at /farm', () => {
    let farm: string

    beforeEach(() => {
      farm = mkdtempSync(join(tmpdir(), 'ficus-farm-fixture-'))
      writeFileSync(join(farm, 'index.html'), '<!doctype html><html><body>farm</body></html>')
      mkdirSync(join(farm, 'assets'), { recursive: true })
      writeFileSync(join(farm, 'assets', 'farm.abc12345.js'), 'console.log("farm")')
      process.env.FICUS_FARM_DIST = farm
      process.env.FICUS_SERVE_WEB = '1'
    })

    afterEach(() => {
      rmSync(farm, { recursive: true, force: true })
    })

    it('serves the farm index at /farm/ with no-cache', async () => {
      const { app } = setupApp()
      const res = await app.request('/farm/')
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toContain('no-cache')
      expect(await res.text()).toContain('farm')
    })

    it('redirects /farm to the trailing-slash path relatively', async () => {
      const { app } = setupApp()
      const res = await app.request('/farm')
      expect(res.status).toBe(301)
      expect(res.headers.get('Location')).toBe('farm/')
    })

    it('serves farm hashed assets as immutable', async () => {
      const { app } = setupApp()
      const res = await app.request('/farm/assets/farm.abc12345.js')
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toContain('immutable')
      expect(await res.text()).toContain('farm')
    })

    it('falls back to the farm index, not the web index, for farm client routes', async () => {
      const { app } = setupApp()
      const res = await app.request('/farm/plot/abc', { headers: { Accept: 'text/html' } })
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('farm')
      expect(body).not.toContain('og:image')
    })

    it('still serves the web UI everywhere else', async () => {
      const { app } = setupApp()
      const res = await app.request('/squads/123', { headers: { Accept: 'text/html' } })
      expect(await res.text()).toContain('app')
    })

    it('mounts nothing at /farm when there is no farm build', async () => {
      process.env.FICUS_FARM_DIST = join(farm, '__missing__')
      const { app } = setupApp()
      const res = await app.request('/farm/', { headers: { Accept: 'text/html' } })
      expect(await res.text()).not.toContain('farm')
    })
  })
})
