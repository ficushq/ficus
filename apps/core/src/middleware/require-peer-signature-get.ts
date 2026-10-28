import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { amtpEngine } from '../services/amtp/engine'
import { AMTP_HEADER_INSTANCE, AMTP_HEADER_SIGNATURE, AMTP_HEADER_TIMESTAMP } from 'amtp-protocol'

/**
 * Authenticates a peer's bodyless GET via its pinned Ed25519 instance key.
 *
 * The router supplies the exact AMTP route pathname (including /amtp, excluding
 * the host's /api or proxy prefix). The engine verifies that 0.2 signature first,
 * retaining only the observed request path as a bounded 0.1 transition fallback.
 * Freshness, active-peer lookup and signature checks live in amtp-engine; every
 * rejection is a uniform 401 (no oracle). This is the route's sole auth gate.
 */
export function requirePeerSignatureGet(routePath: string | ((c: Context) => string)) {
  return createMiddleware(async (c, next) => {
    const instanceHeader = c.req.header(AMTP_HEADER_INSTANCE)
    const signatureHeader = c.req.header(AMTP_HEADER_SIGNATURE)
    const timestampHeader = c.req.header(AMTP_HEADER_TIMESTAMP)
    if (!instanceHeader || !signatureHeader || !timestampHeader) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const result = await amtpEngine.verifySignedGet({
      method: 'GET',
      path: c.req.path,
      routePath: typeof routePath === 'string' ? routePath : routePath(c),
      instanceHeader,
      signatureHeader,
      timestampHeader,
    })
    if (!result.ok) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    c.set('peerInstanceId', result.peerInstanceId)
    c.set('authzChecked', true)
    return next()
  })
}
