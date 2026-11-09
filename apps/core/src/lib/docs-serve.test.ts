import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { coreGetPath } from './app-base-path'
import { mountCoreDocs } from './docs-serve'

test('Core docs serve on hosted and self-hosted origins without falling into the SPA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-core-docs-'))
  try {
    for (const [path, body] of Object.entries({
      'index.html': 'docs home',
      'guide/index.html': 'guide',
      '404.html': 'docs missing',
      'pagefind/pagefind.js': 'search asset',
    })) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), body)
    }
    const app = new Hono()
    app.get('/api/health', (c) => c.json({ ok: true }))
    mountCoreDocs(app, root)
    app.get('*', (c) => c.text('SPA'))
    for (const origin of ['https://tenant.ficus.sh', 'http://localhost:3000']) {
      const redirect = await app.request(`${origin}/docs?mode=cloud`)
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('location')).toBe('docs/?mode=cloud')
      expect(await (await app.request(`${origin}/docs/`)).text()).toBe('docs home')
      expect(await (await app.request(`${origin}/docs/guide/`)).text()).toBe('guide')
      expect(await (await app.request(`${origin}/docs/pagefind/pagefind.js`)).text()).toBe('search asset')
      expect((await app.request(`${origin}/docs/`, { method: 'HEAD' })).status).toBe(200)
      expect((await app.request(`${origin}/docs/`, { method: 'POST' })).status).toBe(405)
      const missing = await app.request(`${origin}/docs/missing/`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toBe('docs missing')
    }
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true })
    expect(await (await app.request('/elsewhere')).text()).toBe('SPA')
    const absent = new Hono()
    mountCoreDocs(absent, join(root, 'absent'))
    absent.get('*', (c) => c.text('SPA'))
    expect((await absent.request('/docs/')).status).toBe(503)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Core docs serve under a configured base path forwarded unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tau-core-docs-prefix-'))
  const saved = { APP_URL: process.env.APP_URL, APP_BASE_PATH: process.env.APP_BASE_PATH }
  process.env.APP_URL = 'https://team.example.com/ficus'
  delete process.env.APP_BASE_PATH
  try {
    await writeFile(join(root, 'index.html'), 'docs home')
    const app = new Hono({ getPath: coreGetPath })
    mountCoreDocs(app, root)
    app.get('*', (c) => c.text('SPA'))
    expect(await (await app.request('https://team.example.com/ficus/docs/')).text()).toBe('docs home')
    expect(await (await app.request('http://localhost:3000/docs/')).text()).toBe('docs home')
    for (const path of ['/ficus/docs?mode=cloud', '/docs?mode=cloud']) {
      const redirect = await app.request(`https://team.example.com${path}`)
      expect(redirect.status).toBe(308)
      // Relative: the browser resolves it against /ficus/docs or /docs.
      expect(redirect.headers.get('location')).toBe('docs/?mode=cloud')
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
