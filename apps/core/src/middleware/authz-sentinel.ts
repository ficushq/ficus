import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('authz-sentinel')

function matchedApplicationRoute(c: Context): boolean {
  if (c.res.status === 404) return false

  return c.req.matchedRoutes.some((route) => {
    // Middleware-only matches include wildcard paths such as `/api/*` or `*`.
    // A concrete route match has its registered route path here.
    if (route.path === '*' || route.path.endsWith('/*')) return false
    return route.path.startsWith('/api/')
  })
}

/** Body for a server error raised before the route recorded its RBAC decision. */
export const PRE_AUTHORIZATION_SERVER_ERROR = 'Internal server error before authorization completed'

/**
 * Runtime RBAC backstop for protected API routes.
 *
 * Mount this after identityMiddleware and before protected `/api/*` routers. If a
 * matched API route completes without either an RBAC guard (`authzChecked`) or an
 * explicit public-route marker (`publicRoute`), replace the response with a 500.
 * This fails closed for accidentally unguarded routes in production.
 *
 * An unmarked 5xx is a server failure that happened before the route reached its
 * authorization decision (for example, a lookup the guard depends on threw). It is
 * still refused: its body is replaced so nothing an unguarded handler produced can
 * leak, but it is reported as a server error with its original 5xx status rather
 * than mislabelled as a missing authorization check.
 */
export const authzSentinel = createMiddleware(async (c, next) => {
  await next()

  if (!matchedApplicationRoute(c)) return
  if (c.get('authzChecked') || c.get('publicRoute')) return

  // Preserve handler-produced client errors (validation, denial, not-found). The
  // sentinel remains a fail-closed backstop for unguarded successful routes.
  if (c.res.status >= 400 && c.res.status < 500) return

  if (c.res.status >= 500) {
    const status = c.res.status as 500
    log.error('API route failed with a server error before its RBAC guard completed', {
      method: c.req.method,
      path: c.req.path,
      routePath: c.req.routePath,
      status,
    })
    c.res = c.json({ error: PRE_AUTHORIZATION_SERVER_ERROR }, status)
    return
  }

  log.error('API route completed without RBAC guard or public-route marker', {
    method: c.req.method,
    path: c.req.path,
    routePath: c.req.routePath,
    status: c.res.status,
  })

  c.res = c.json({ error: 'Authorization check missing' }, 500)
})
