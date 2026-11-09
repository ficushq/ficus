import { hasConfiguredWebOrigin, primaryWebOrigin } from '../services/auth/web-origins'
import { resolveRequestBasePath, type BasePathRequest } from './app-base-path'
import { describePublicAppUrl } from './public-app-url'

type RequestLike = { req: BasePathRequest }

/**
 * The absolute app URL (no trailing slash) for links built while answering a
 * request, such as og:url or a webhook URL shown to a person:
 *
 * 1. The configured public address whole (origin plus its own path), so a
 *    page served at the local root still advertises `https://host/ficus`.
 * 2. Else an explicit FICUS_WEB_ORIGIN / WEBAUTHN_ORIGIN plus the request base.
 * 3. Else the reverse proxy's forwarded headers, else the request URL origin,
 *    plus the request base.
 */
export function publicAppUrlForRequest(
  c: RequestLike,
  basePath: string = resolveRequestBasePath(c.req).basePath
): string {
  const configured = describePublicAppUrl().url
  if (configured) return configured.replace(/\/+$/, '')
  if (hasConfiguredWebOrigin()) return `${primaryWebOrigin()}${basePath}`
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim()
  if (host) {
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || 'https'
    return `${proto}://${host}${basePath}`
  }
  return `${new URL(c.req.url).origin}${basePath}`
}
