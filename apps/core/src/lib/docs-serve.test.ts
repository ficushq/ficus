import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Hono } from 'hono'
import { coreGetPath } from './app-base-path'
import { mountCoreDocs, rebaseDocsScript, renderDocsHtml } from './docs-serve'

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

describe('embedded docs under a base path', () => {
  const PAGE =
    '<html><head><meta name="ficus-docs-base" content="__FICUS_DOCS_BASE__"><link rel="stylesheet" href="/docs/_astro/a.css"><script>const p = "/docs"</script></head>' +
    '<body><a href="/docs/guide/">Guide</a><img src="/docs/_astro/i.svg"><a href="/docsearch">x</a><a href="https://e.example/docs/x">ext</a></body></html>'
  const SEARCH =
    'n=function(e){return"/docs/"+e};new t({baseUrl:`/docs/`,bundlePath:`/docs/`.replace(/\\/$/,``)+`/pagefind/`,o:`/pagefind/`})'
  const keys = ['APP_URL', 'APP_BASE_PATH', 'FICUS_LOCAL_APP_URL', 'FICUS_WEB_ORIGIN', 'WEBAUTHN_ORIGIN'] as const
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  let root: string
  let app: Hono

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-core-docs-base-'))
    for (const [path, body] of Object.entries({
      'index.html': PAGE,
      'guide/index.html': PAGE,
      '404.html': PAGE.replace('Guide', 'Missing'),
      '_astro/search.js': SEARCH,
      '_astro/a.css': 'body{}',
      'pagefind/pagefind.js': 'import("./x.js");const b="/docs/"',
    })) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), body)
    }
    for (const k of keys) delete process.env[k]
    process.env.APP_URL = 'https://h.example/ficus'
    process.env.FICUS_LOCAL_APP_URL = 'http://localhost:3000'
    app = new Hono({ getPath: coreGetPath })
    mountCoreDocs(app, root)
    app.get('*', (c) => c.text('SPA'))
  })
  afterAll(async () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(root, { recursive: true, force: true })
  })

  const get = (url: string, host: string) => app.request(url, { headers: { host } })

  test('a page behind a stripping proxy is rendered for the public base', async () => {
    const html = await (await get('http://127.0.0.1:3000/docs/', 'h.example')).text()
    expect(html).toContain('href="/ficus/docs/guide/"')
    expect(html).toContain('href="/ficus/docs/_astro/a.css"')
    expect(html).toContain('src="/ficus/docs/_astro/i.svg"')
    expect(html).toContain('name="ficus-docs-base" content="/ficus/docs/"')
    // Only attribute values rooted at /docs are rebased.
    expect(html).toContain('href="/docsearch"')
    expect(html).toContain('href="https://e.example/docs/x"')
    expect(html).toContain('const p = "/docs"')
  })

  test('a pass-through request renders the same page', async () => {
    const strip = await (await get('http://127.0.0.1:3000/docs/guide/', 'h.example')).text()
    const pass = await (await get('http://127.0.0.1:3000/ficus/docs/guide/', '127.0.0.1:3000')).text()
    expect(pass).toBe(strip)
  })

  test('the local root keeps /docs and only fills the placeholder', async () => {
    const html = await (await get('http://localhost:3000/docs/', 'localhost:3000')).text()
    expect(html).toBe(PAGE.replace('__FICUS_DOCS_BASE__', '/docs/'))
  })

  test('the search script follows the base; the file is untouched at the root', async () => {
    const prefixed = await get('http://127.0.0.1:3000/ficus/docs/_astro/search.js', '127.0.0.1:3000')
    expect(prefixed.headers.get('content-type')).toContain('javascript')
    const js = await prefixed.text()
    expect(js).toContain('return"/ficus/docs/"+e')
    expect(js).toContain('baseUrl:`/ficus/docs/`')
    expect(js).toContain('bundlePath:`/ficus/docs/`')
    expect(js.match(/["'`]\/docs\//g)).toBeNull()
    expect(await (await get('http://localhost:3000/docs/_astro/search.js', 'localhost:3000')).text()).toBe(SEARCH)
  })

  test('the 404 page is rendered for the base, and Pagefind and stylesheets are served as built', async () => {
    const missing = await get('http://127.0.0.1:3000/ficus/docs/missing/', '127.0.0.1:3000')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('href="/ficus/docs/guide/"')
    const pagefind = await get('http://127.0.0.1:3000/ficus/docs/pagefind/pagefind.js', '127.0.0.1:3000')
    expect(await pagefind.text()).toBe('import("./x.js");const b="/docs/"')
    expect(await (await get('http://127.0.0.1:3000/ficus/docs/_astro/a.css', '127.0.0.1:3000')).text()).toBe('body{}')
  })

  test('HEAD and other methods behave as before; paths cannot escape the build', async () => {
    expect((await app.request('http://h.example/ficus/docs/', { method: 'HEAD' })).status).toBe(200)
    expect((await app.request('http://h.example/ficus/docs/', { method: 'POST' })).status).toBe(405)
    // URL parsing folds a dot-segment out of /docs entirely; an encoded slash reaches the docs app and stays inside it.
    expect(await (await get('http://localhost:3000/docs/%2e%2e/%2e%2e/etc/passwd', 'localhost:3000')).text()).toBe('SPA')
    const encoded = await get('http://localhost:3000/docs/..%2f..%2f..%2fetc%2fhostname', 'localhost:3000')
    expect(encoded.status).toBe(404)
  })

  test('renderDocsHtml rebases before filling the placeholder', () => {
    expect(renderDocsHtml('<meta content="__FICUS_DOCS_BASE__"><a href="/docs">x</a>', '/ficus')).toBe(
      '<meta content="/ficus/docs/"><a href="/ficus/docs">x</a>'
    )
    expect(rebaseDocsScript('a="/docs/";b=`/docs/x`', '/ficus')).toBe('a="/ficus/docs/";b=`/docs/x`')
  })
})
