import type { MiddlewareHandler } from 'hono'
import { parseManagedBigbrainOrigin } from '@ficus/shared/managed-bigbrain'

/** Whether a Host header names a managed BigBrain vault (either recorded hostname form). Tenant
 * labels cannot take the `-bb-` vault shape, so no Core host ever matches. */
export function isManagedVaultHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host
    .toLowerCase()
    .replace(/:\d{1,5}$/, '')
    .replace(/\.$/, '')
  return parseManagedBigbrainOrigin(`https://${name}`) !== null
}

/** A vault hostname is served only by its exact Caddy site -> credential-free gateway -> vault
 * socket. Core's own Caddy site matches only Core's host, so a vault host reaching Core is a
 * routing fault. Answer the gateway's own unknown-host refusal before any session, identity or
 * app handling runs, so Core never answers (or authenticates) as a vault. */
export const managedVaultHostGuard: MiddlewareHandler = async (c, next) => {
  if (!isManagedVaultHost(c.req.header('host'))) return next()
  return c.json({ code: 'not_found' }, 404, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
}
