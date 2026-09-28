import { createMiddleware } from 'hono/factory'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { getSessionCookie } from '../services/auth/session-cookie'
import { corsAllowOrigins, normalizeOrigin } from '../services/auth/web-origins'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF defense for cookie-authenticated browser requests. The session cookie is
 * sent automatically, so a state-changing request authenticated *by cookie* must
 * also carry a custom header that only first-party JS can attach — a cross-site
 * caller can't set a custom header without a CORS preflight, which the origin
 * allowlist gates.
 *
 * Bearer/header-authenticated requests (CLI, agents) are exempt from the CSRF-header
 * check *only while they carry no Origin*: a plain CLI/agent HTTP client never sends
 * one, so such a request can't be a browser riding an ambient credential. But a bearer
 * can become ambient too — a native shell that injects a device bearer into its web
 * view's requests makes every request from that view carry it, including a cross-origin,
 * no-preflight POST fired by script in an opaque-origin sandboxed iframe (Core renders
 * agent-generated HTML artifacts in `<iframe sandbox="allow-scripts" srcdoc>`, and that
 * sandbox sends `Origin: null`). So a bearer request that DOES carry an Origin is held to
 * the same allowlist CORS uses: an allowed first-party origin passes, anything else —
 * including the literal `null` opaque origin — is rejected. The first-party web app never
 * sends a bearer, so this never fires for it; it only closes the shell/iframe gap.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next()
  const hasBearer = !!c.req.header('Authorization') || !!c.req.header('X-Auth-Token')
  if (hasBearer) {
    const origin = c.req.header('Origin')
    if (!origin) return next()
    const normalized = normalizeOrigin(origin)
    if (normalized && corsAllowOrigins().includes(normalized)) return next()
    return c.json({ error: 'Cross-origin request rejected' }, 403)
  }
  if (!getSessionCookie(c)) return next()
  if (!c.req.header(CSRF_HEADER)) {
    return c.json({ error: 'Missing CSRF token' }, 403)
  }
  return next()
})
