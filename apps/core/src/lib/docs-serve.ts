import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { Hono, type Context } from 'hono'
import { serveStatic } from 'hono/bun'
import { coreGetPath, resolveRequestBasePath } from './app-base-path'
import { resolveCoreDocsDist } from './web-dist'

/**
 * The placeholder apps/docs/src/components/Head.astro emits in embedded builds:
 * `<meta name="ficus-docs-base" content="__FICUS_DOCS_BASE__">`, filled with
 * the documentation's base for the request (`/docs/` or `/ficus/docs/`).
 */
export const DOCS_BASE_PLACEHOLDER = '__FICUS_DOCS_BASE__'

/** Attribute values the embedded build roots at `/docs` (`href="/docs/…"`, `src="/docs/_astro/…"`). */
const DOCS_ATTRIBUTE = /\b(href|src|srcset|content|action|value|data-[a-z-]+)="\/docs(\/|")/g

/** Quoted `/docs/` literals: Astro's compiled BASE_URL (Vite preload helper, Pagefind baseUrl and bundlePath). */
const DOCS_SCRIPT_LITERAL = /(["'`])\/docs\/\1/g

/**
 * Render an embedded documentation page for a base path (`''` or `/ficus`):
 * rebase the attribute values the build roots at `/docs` first, then fill the
 * docs base meta (so the filled value is never rebased twice).
 */
export function renderDocsHtml(html: string, basePath: string): string {
  const rebased = basePath ? html.replace(DOCS_ATTRIBUTE, `$1="${basePath}/docs$2`) : html
  return rebased.replaceAll(DOCS_BASE_PLACEHOLDER, `${basePath}/docs/`)
}

/** Rebase the `/docs/` literals in an embedded docs script for a base path; unchanged at the root. */
export function rebaseDocsScript(js: string, basePath: string): string {
  return basePath ? js.replace(DOCS_SCRIPT_LITERAL, `$1${basePath}/docs/$1`) : js
}

const MAX_CACHE_ENTRIES = 512
const rendered = new Map<string, string>()

/** Read a docs file and transform it for a base path, memoized per (file, size, mtime, base). */
async function renderedFile(path: string, basePath: string, transform: (text: string) => string): Promise<string> {
  const stat = statSync(path)
  const key = `${path}\0${stat.size}\0${stat.mtimeMs}\0${basePath}`
  const cached = rendered.get(key)
  if (cached !== undefined) return cached
  const text = transform(await Bun.file(path).text())
  if (rendered.size >= MAX_CACHE_ENTRIES) rendered.clear()
  rendered.set(key, text)
  return text
}

/** The file under `dist` a docs request path names, or null when it escapes the root or does not exist. */
function docsFile(dist: string, requestPath: string): string | null {
  let relative: string
  try {
    relative = decodeURIComponent(requestPath.slice('/docs'.length) || '/')
  } catch {
    return null
  }
  if (relative.endsWith('/')) relative += 'index.html'
  else if (!/\.[^/]+$/.test(relative)) relative += '/index.html'
  const path = normalize(join(dist, relative))
  if (path !== dist && !path.startsWith(dist.endsWith(sep) ? dist : `${dist}${sep}`)) return null
  return existsSync(path) && statSync(path).isFile() ? path : null
}

function requestBasePath(c: Context): string {
  return resolveRequestBasePath(c.req).basePath
}

/**
 * Static product documentation is available on every Core, independent of SPA serving.
 *
 * The nested app strips a configured base path like the main app does, so
 * `/ficus/docs/…` forwarded unchanged by a reverse proxy serves the same file
 * as `/docs/…`. Pages and the scripts that carry the docs base are rendered
 * for the base path the request used, so the same build works at `/docs/` and
 * `/ficus/docs/` at once.
 */
export function mountCoreDocs(app: Hono, dist = resolveCoreDocsDist()) {
  const docs = new Hono({ getPath: coreGetPath })
  docs.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cache-Control', 'no-cache')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      c.header('Allow', 'GET, HEAD')
      return c.text('Method not allowed', 405)
    }
    if (!dist || !existsSync(join(dist, 'index.html')))
      return c.text('Documentation is not available in this release.', 503)
    return next()
  })
  if (dist) {
    const root = normalize(dist)
    docs.get('*', async (c, next) => {
      const path = docsFile(root, c.req.path)
      if (!path) return next()
      const basePath = requestBasePath(c)
      if (path.endsWith('.html')) return c.html(await renderedFile(path, basePath, (h) => renderDocsHtml(h, basePath)))
      if (basePath && path.startsWith(join(root, '_astro') + sep) && path.endsWith('.js')) {
        c.header('Content-Type', 'text/javascript; charset=utf-8')
        return c.body(await renderedFile(path, basePath, (js) => rebaseDocsScript(js, basePath)))
      }
      return next()
    })
    docs.use('*', serveStatic({ root: dist, rewriteRequestPath: (path) => path.slice('/docs'.length) || '/' }))
  }
  docs.notFound(async (c) => {
    const page = dist && join(dist, '404.html')
    if (page && existsSync(page)) {
      const basePath = requestBasePath(c)
      return c.html(await renderedFile(page, basePath, (h) => renderDocsHtml(h, basePath)), 404)
    }
    return c.text('Documentation page not found', 404)
  })
  app.all('/docs', (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD')
      return c.text('Method not allowed', 405, { Allow: 'GET, HEAD' })
    // Relative, so `/ficus/docs` lands on `/ficus/docs/` through any proxy.
    return c.redirect(`docs/${new URL(c.req.url).search}`, 308)
  })
  app.all('/docs/*', (c) => docs.fetch(c.req.raw))
}
