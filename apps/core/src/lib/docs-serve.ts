import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { coreGetPath } from './app-base-path'
import { resolveCoreDocsDist } from './web-dist'

/**
 * Static product documentation is available on every Core, independent of SPA serving.
 *
 * The nested app strips a configured base path like the main app does, so
 * `/ficus/docs/…` forwarded unchanged by a reverse proxy serves the same file
 * as `/docs/…`.
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
  if (dist) docs.use('*', serveStatic({ root: dist, rewriteRequestPath: (path) => path.slice('/docs'.length) || '/' }))
  docs.notFound(async (c) => {
    const page = dist && Bun.file(join(dist, '404.html'))
    if (page && (await page.exists())) return c.html(await page.text(), 404)
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
