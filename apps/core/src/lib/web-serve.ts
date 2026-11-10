import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from 'hono/bun'
import type { Hono } from 'hono'
import { resolveFarmDist, resolveWebDist } from './web-dist'
import { resolveRequestBasePath } from './app-base-path'
import { publicAppUrlForRequest } from './request-app-url'

type Log = { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }

function envFlag(value: string | undefined): 'on' | 'off' | 'auto' {
  if (value === undefined || value === '') return 'auto'

  const lower = value.toLowerCase()
  if (lower === '1' || lower === 'true' || lower === 'yes') return 'on'
  if (lower === '0' || lower === 'false' || lower === 'no') return 'off'

  return 'auto'
}

/**
 * A content-hashed build asset, safe to cache forever: Vite's `index-C2ucfeeU.js`
 * (a dash, then an 8+ character base64url hash) or an older `name.abc12345.js`.
 */
const HASHED_ASSET = /\/assets\/[^/]+(?:-[A-Za-z0-9_-]{8,}|\.[0-9a-f]{8,})\.[a-z0-9]+$/i

/**
 * The placeholder apps/web/index.html uses for absolute, self-referencing
 * URLs (og:url, og:image): link crawlers ignore relative ones, and a built
 * index.html cannot know which origin it will be served from.
 */
export const ORIGIN_PLACEHOLDER = '__FICUS_ORIGIN__'

/**
 * The placeholder `<meta name="ficus-base-path" content="__FICUS_BASE_PATH__">`
 * in apps/web/index.html and apps/farm/index.html: the base path the browser
 * used (`/` or `/ficus/`), read by the web app and the farm at runtime.
 */
export const BASE_PATH_PLACEHOLDER = '__FICUS_BASE_PATH__'

const ASSET_URL_RE = /(?:src|href)="([^"]*?\/)assets\/[^"]+"/

/**
 * The base a built index.html was produced for (`/` for a root build,
 * `/farm/` for the farm, `/tau/` for a legacy `APP_BASE_PATH=/tau` build),
 * read from its first built asset URL; null without built assets.
 */
export function builtWebBase(indexHtml: string): string | null {
  const match = ASSET_URL_RE.exec(indexHtml)
  return match ? match[1] : null
}

export { publicAppUrlForRequest } from './request-app-url'

export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface RenderIndexHtmlOptions {
  /** The base the HTML was built for, with leading and trailing slash ({@link builtWebBase}). */
  builtBase: string
  /** Where this document's own URLs live for this request: `/ficus/` for the web app, `/ficus/farm/` for the farm. */
  runtimeBase: string
  /** The instance base path for the meta tag: `''` at the root or `/ficus`. */
  basePath: string
  /** Absolute public app URL for og:url and og:image, no trailing slash. */
  publicAppUrl: string
}

/**
 * Render a built index.html for one request, in this order:
 *
 * 1. Rebase every `src`/`href`/`content` attribute value that begins with the
 *    built base onto the runtime base. This must come first: for a root build
 *    every value beginning with `/` is rebased, so a meta already filled with
 *    `/ficus/` would become `/ficus/ficus/`. The placeholders begin with `_`,
 *    so this step never touches them.
 * 2. Fill the base path meta with the instance base (`/` or `/ficus/`).
 * 3. Fill the origin placeholder with the public app URL.
 */
export function renderIndexHtml(html: string, options: RenderIndexHtmlOptions): string {
  let rendered = html
  if (options.builtBase !== options.runtimeBase) {
    // `(?!/)` keeps protocol-relative `//cdn…` values out of a root build's rewrite.
    const pattern = new RegExp(`\\b(src|href|content)="${escapeRegExp(options.builtBase)}(?!/)`, 'g')
    const runtime = escapeHtmlAttribute(options.runtimeBase)
    rendered = rendered.replace(pattern, (_match, attribute: string) => `${attribute}="${runtime}`)
  }
  // Function replacers: a `$` in an address path must not be read as a replacement pattern.
  const basePath = escapeHtmlAttribute(`${options.basePath}/`)
  const publicAppUrl = escapeHtmlAttribute(options.publicAppUrl.replace(/\/+$/, ''))
  rendered = rendered.replaceAll(BASE_PATH_PLACEHOLDER, () => basePath)
  return rendered.replaceAll(ORIGIN_PLACEHOLDER, () => publicAppUrl)
}

type RequestLike = { req: { url: string; header: (name: string) => string | undefined } }

/** Render a built index.html (web app or farm) for the base path this request used. */
async function renderIndexForRequest(
  c: RequestLike,
  file: ReturnType<typeof Bun.file>,
  app: 'web' | 'farm'
): Promise<string> {
  const html = await file.text()
  const { basePath } = resolveRequestBasePath(c.req)
  const suffix = app === 'farm' ? 'farm/' : ''
  return renderIndexHtml(html, {
    builtBase: builtWebBase(html) ?? `/${suffix}`,
    runtimeBase: `${basePath}/${suffix}`,
    basePath,
    publicAppUrl: publicAppUrlForRequest(c, basePath),
  })
}

/**
 * Mounts static-file serving and SPA fallback for the built web UI.
 *
 * Must be called after all `/api/*` and `/ws*` routes are registered so API and
 * WebSocket routes win before static serving is considered.
 *
 * Returns true when static handlers were mounted.
 */
export function maybeMountWebUi(app: Hono, log: Log): boolean {
  const mode = envFlag(process.env.FICUS_SERVE_WEB)
  if (mode === 'off') return false

  const dist = resolveWebDist()
  const hasIndex = !!dist && existsSync(join(dist, 'index.html'))

  if (mode === 'on' && !hasIndex) {
    log.warn(
      `FICUS_SERVE_WEB is enabled but no built web UI was found` +
        (dist ? ` at ${dist}` : '') +
        `. Run \`bun run build:web\` or unset FICUS_SERVE_WEB.`
    )
    return false
  }
  if (mode === 'auto' && !hasIndex) return false

  const distPath = dist!

  // Never serve API or WebSocket paths from the static root. The authzSentinel
  // ignores wildcard-matched routes, so a file resolvable at `dist/api/<name>`
  // would otherwise be served unauthenticated. API/WS routes are registered
  // before this; if one reached here unmatched it should 404, not hit the disk.
  const isReservedApiPath = (p: string) => p === '/api' || p.startsWith('/api/') || p === '/ws' || p.startsWith('/ws/')

  const staticHandler = serveStatic({
    root: distPath,
    rewriteRequestPath: (path) => (path === '/' ? '/index.html' : path),
    onFound: (path, c) => {
      if (HASHED_ASSET.test(path)) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (path.endsWith('/index.html') || path.endsWith('/sw.js') || path.endsWith('.webmanifest')) {
        // The service worker script and manifest must revalidate on every
        // fetch, or PWA update checks can be served a heuristically-cached
        // stale copy and never see new deploys.
        c.header('Cache-Control', 'no-cache')
      }
    },
  })

  const indexFile = Bun.file(join(distPath, 'index.html'))
  const serveIndex = async (c: Parameters<typeof staticHandler>[0]) => {
    c.header('Cache-Control', 'no-cache')
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(await renderIndexForRequest(c, indexFile, 'web'))
  }

  const farm = maybeMountFarmUi(app, log)
  if (farm) log.info(`Serving farm UI from ${farm} at /farm`)

  // index.html is rendered, not streamed from disk, so the origin placeholder
  // never reaches a browser or a crawler. Registered ahead of serveStatic,
  // which would otherwise serve the raw file for '/' and '/index.html'.
  app.get('/', (c) => serveIndex(c))
  app.get('/index.html', (c) => serveIndex(c))

  app.use('*', async (c, next) => {
    if (isReservedApiPath(c.req.path)) return next()
    return staticHandler(c, next)
  })

  app.get('*', async (c, next) => {
    if (isReservedApiPath(c.req.path)) return next()
    const accept = c.req.header('accept') ?? ''
    if (!accept.includes('text/html')) return next()

    if (!(await indexFile.exists())) return next()
    return serveIndex(c)
  })

  log.info(`Serving web UI from ${distPath}`)
  return true
}

/**
 * Mounts the farm UI (`apps/farm`) at `/farm` when a build exists. Only
 * called from {@link maybeMountWebUi}, ahead of the web UI's static handler and
 * SPA fallback, so `/farm/*` never falls through to the web app's index.
 *
 * Returns the served directory, or undefined when there is no farm build.
 */
function maybeMountFarmUi(app: Hono, log: Log): string | undefined {
  const dist = resolveFarmDist()
  if (!dist || !existsSync(join(dist, 'index.html'))) {
    // Set by hand but pointing at no build: say so, rather than serve the web build's own farm copy unannounced.
    if (process.env.FICUS_FARM_DIST)
      log.warn(`FICUS_FARM_DIST is set but ${dist} has no index.html; /farm is not served`)
    return undefined
  }

  const staticHandler = serveStatic({
    root: dist,
    rewriteRequestPath: (path) => path.replace(/^\/farm/, '') || '/',
    onFound: (path, c) => {
      if (HASHED_ASSET.test(path)) c.header('Cache-Control', 'public, max-age=31536000, immutable')
    },
  })
  const indexFile = Bun.file(join(dist, 'index.html'))
  const serveIndex = async (c: Parameters<typeof staticHandler>[0]) => {
    c.header('Cache-Control', 'no-cache')
    c.header('Content-Type', 'text/html; charset=utf-8')
    return c.body(await renderIndexForRequest(c, indexFile, 'farm'))
  }

  // Relative, so the redirect survives a reverse proxy that strips the base path.
  app.get('/farm', (c) => c.redirect('farm/', 301))
  app.get('/farm/', (c) => serveIndex(c))
  app.get('/farm/index.html', (c) => serveIndex(c))
  app.use('/farm/*', (c, next) => staticHandler(c, next))
  app.get('/farm/*', async (c, next) => {
    if (!(c.req.header('accept') ?? '').includes('text/html')) return next()
    return serveIndex(c)
  })
  return dist
}
