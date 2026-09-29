import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from 'hono/bun'
import type { Hono } from 'hono'
import { resolveFarmDist, resolveWebDist } from './web-dist'
import { primaryWebOrigin } from '../services/auth/web-origins'

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

export function renderIndexHtml(html: string, origin: string): string {
  return html.replaceAll(ORIGIN_PLACEHOLDER, origin.replace(/\/+$/, ''))
}

/**
 * This instance's public origin, for the placeholder above. The configured web
 * origin (FICUS_WEB_ORIGIN, the same source WebAuthn trusts) wins; otherwise the
 * reverse proxy's forwarded headers; otherwise the request URL itself.
 */
export function publicOrigin(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  if (process.env.FICUS_WEB_ORIGIN ?? process.env.WEBAUTHN_ORIGIN ?? process.env.APP_URL) return primaryWebOrigin()
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim()
  if (host) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || 'https'
    return `${proto}://${host}`
  }
  return new URL(c.req.url).origin
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
    return c.body(renderIndexHtml(await indexFile.text(), publicOrigin(c)))
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
    if (process.env.FICUS_FARM_DIST) log.warn(`FICUS_FARM_DIST is set but ${dist} has no index.html; /farm is not served`)
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
    return c.body(await indexFile.text())
  }

  // Relative, so the redirect survives a reverse proxy that strips APP_BASE_PATH.
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
