import { createMiddleware } from 'hono/factory'
import { resolveTokenContext, type AuthContext } from '../services/auth/resolve-token'
import { extractSessionToken } from '../services/auth/session-cookie'
import { verifyImageUrlSignature } from '../services/images/signing'
import type { Identity } from '../services/rbac'
import { authenticateLocalDeploymentBrowserRequest } from '../services/deploy/local-deployment-auth'
import { AmbiguousPrefixError } from '../db/prefix-match'
import { localDeploymentProxyJsonError } from '../services/deploy/local-deployment-proxy-response'

const AMBIGUOUS_LOCAL_DEPLOYMENT_LINK_ERROR = 'This app link is no longer unique — get a fresh URL.'

declare module 'hono' {
  interface ContextVariableMap {
    identity: Identity
    authContext: AuthContext
    authzChecked?: boolean
    publicRoute?: boolean
    resolvedLocalDeploymentId?: string
  }
}

export const identityMiddleware = createMiddleware(async (c, next) => {
  // Sandbox in-cluster callback (workspace-files) is authenticated by the route's
  // requireSandboxCallback (SANDBOX_CALLBACK_SECRET), not a session identity.
  if (/^\/api\/memory\/[^/]+\/workspace-files$/.test(c.req.path)) {
    return next()
  }

  // Local-deployment browser proxy: /api/app/:id authenticates ONLY by the
  // deployment's browser credential, the URL token or the path-scoped cookie it
  // set (without the cookie arm, a deployed app's own asset requests carry no
  // credential and are rejected). Ficus credentials are never consulted here,
  // and the proxy strips them: on an app's own origin the browser's cookies
  // belong to the app, so a `ficus_session` cookie there (the app's own, or one
  // planted on the apps domain) must not turn every request into a Ficus 401.
  // The route sets no identity and reads none.
  const appMatch = c.req.path.match(/^\/api\/app\/([^/]+)(?:\/|$)/)
  if (appMatch) {
    try {
      const resolvedLocalDeploymentId = await authenticateLocalDeploymentBrowserRequest(c.req.raw, appMatch[1])
      if (resolvedLocalDeploymentId) {
        c.set('resolvedLocalDeploymentId', resolvedLocalDeploymentId)
        return next()
      }
    } catch (error) {
      if (error instanceof AmbiguousPrefixError) {
        return localDeploymentProxyJsonError(AMBIGUOUS_LOCAL_DEPLOYMENT_LINK_ERROR, 409)
      }
      throw error
    }
    return localDeploymentProxyJsonError('Authentication required', 401)
  }

  // Token from the Authorization / X-Auth-Token header (CLI, agents, legacy) or,
  // for the browser, the HttpOnly session cookie.
  const token = extractSessionToken(c)

  if (!token) {
    // Signed-public bypasses (no identity is set — these routes carry no
    // permission guards and remain public):
    //
    // (1. the local-app proxy, handled above for every request.)
    // 2. Signed image URLs: GET /api/images/:id with valid exp + sig.
    const imageMatch = c.req.path.match(/^\/api\/images\/([^/]+)$/)
    if (
      imageMatch &&
      c.req.method === 'GET' &&
      verifyImageUrlSignature(imageMatch[1], c.req.query('exp'), c.req.query('sig'))
    ) {
      return next()
    }

    // 3. Federation public identity bootstrap endpoint — no credentials required
    //    so remote peers can fetch this instance's public key out-of-band.
    if (c.req.path === '/api/amtp/identity' && c.req.method === 'GET') {
      return next()
    }

    // 4. Federation inbox receiver — peer requests are cookieless + token-less and are
    //    authenticated by the instance-signature middleware (requirePeerSignature), not a
    //    session identity. Mirrors the GET /api/amtp/identity bypass; the no-token
    //    branch also avoids tripping CSRF.
    if (c.req.path === '/api/amtp/inbox' && c.req.method === 'POST') {
      return next()
    }

    // 5. Federation attachment serve — cookieless + token-less peer GETs authenticated by
    //    requirePeerSignatureGet (Ed25519 canonical GET signature). Same bypass rationale as #4.
    if (c.req.path.startsWith('/api/amtp/attachments/') && c.req.method === 'GET') {
      return next()
    }

    // 6. Federation agent public-key endpoint — a peer fetches a handle's SPKI public PEM
    //    for first-contact TOFU pinning (no credentials required; data is already public).
    if (/^\/api\/amtp\/agents\/[^/]+\/key$/.test(c.req.path) && c.req.method === 'GET') {
      return next()
    }

    // 7. Federation handle discovery — cookieless + token-less peer GET authenticated by
    //    requirePeerSignatureGet (Ed25519 canonical GET signature). Same rationale as #5.
    if (c.req.path === '/api/amtp/handles' && c.req.method === 'GET') {
      return next()
    }

    // 8. Federation agent card endpoint — a peer (or any consumer) fetches a handle's
    //    published signed card (spec §4.6 Serving). No credentials required: the card is
    //    self-signed by the agent's identity key, so serving it unauthenticated leaks
    //    nothing new beyond what /key already exposes. Same rationale as #6.
    if (/^\/api\/amtp\/agents\/[^/]+\/card$/.test(c.req.path) && c.req.method === 'GET') {
      return next()
    }

    return c.json({ error: 'Authentication required' }, 401)
  }

  const authContext = await resolveTokenContext(token)
  if (!authContext) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('identity', authContext.identity)
  c.set('authContext', authContext)
  return next()
})
