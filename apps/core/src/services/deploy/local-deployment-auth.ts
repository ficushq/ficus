/**
 * Browser authentication for the local-app proxy.
 *
 * The tokenized URL carries `?_ficus_token=<token>`, which authenticates the
 * DOCUMENT request. It cannot authenticate anything the document then loads:
 * the browser issues subresource requests (`/api/app/<id>/assets/index-*.js`)
 * with no query string of their own, so every script, stylesheet and fetch
 * from a deployed app used to come back 401 even once the app was reachable.
 *
 * So a successful token request also drops a cookie scoped to that ONE
 * deployment's proxy path, and the proxy accepts either credential.
 *
 * `Path` is the whole security boundary here and is why this is safe:
 *   - the browser sends it only to `/api/app/<id>/…`, never to Ficus's own API,
 *     and never to another deployment's prefix;
 *   - deployment ids are fixed-length uuids, so one prefix can never be a path
 *     prefix of another (a cookie path matches only on a `/` boundary);
 *   - the proxy never forwards it to the deployed app itself: the path mount
 *     forwards no cookies at all, and a per-app origin drops this one (and
 *     every other Ficus cookie) by exact name.
 */
import type { LocalDeployment } from '@ficus/shared'
import { isTrustedProxyPeer } from '../../lib/client-address'
import {
  getLocalDeployment,
  getLocalDeploymentAliasHost,
  getLocalDeploymentByAlias,
  isValidLocalDeploymentBrowserToken,
} from './local-deployment-service'

const TOKEN_QUERY_PARAM = '_ficus_token'
const LOCAL_DEPLOYMENT_UUID_PREFIX =
  /^[0-9a-f]{1,8}(?:-[0-9a-f]{0,4}(?:-[0-9a-f]{0,4}(?:-[0-9a-f]{0,4}(?:-[0-9a-f]{0,12})?)?)?)?$/

/** Reject wildcard/metacharacter input before the UUID-prefix database query. */
export function isValidLocalDeploymentRouteParameter(value: string): boolean {
  return value.length <= 36 && LOCAL_DEPLOYMENT_UUID_PREFIX.test(value)
}

/** Per-deployment name so two open apps cannot overwrite each other's credential. */
export function localDeploymentCookieName(localDeploymentId: string): string {
  return `ficus_app_${localDeploymentId}`
}

export function localDeploymentProxyPath(localDeploymentId: string): string {
  return `/api/app/${localDeploymentId}/`
}

/** Parse one cookie value out of a raw `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    // Values are token-shaped (base64url); tolerate the quoted form anyway.
    return decodeURIComponent(value.replace(/^"|"$/g, ''))
  }
  return null
}

export interface PresentedLocalDeploymentToken {
  token: string | null
  /** True when it arrived in the URL — the only case that needs a cookie set. */
  fromQuery: boolean
}

export function presentedLocalDeploymentToken(
  request: Request,
  localDeploymentId: string
): PresentedLocalDeploymentToken {
  const query = new URL(request.url).searchParams.get(TOKEN_QUERY_PARAM)
  if (query) return { token: query, fromQuery: true }
  return {
    token: readCookie(request.headers.get('cookie'), localDeploymentCookieName(localDeploymentId)),
    fromQuery: false,
  }
}

/**
 * Marks an alias in the route parameter: `/api/app/~<alias>/`. `~` is never in
 * a uuid prefix or a DNS label, so an alias can never be read as an id prefix
 * (an all-hex alias such as `cafe` would otherwise be one).
 */
export const LOCAL_DEPLOYMENT_ALIAS_ROUTE_MARKER = '~'

/**
 * The deployment a `/api/app/<parameter>/` route names: a uuid prefix, or
 * `~<alias>`. An alias resolves ONLY for the request the hosted Platform bridge
 * forwards from that alias's own host: a trusted proxy peer naming exactly
 * `<tenant>--<alias>.<apps domain>` in X-Forwarded-Host (see
 * local-deployment-proxy.ts perAppOrigin for why that header is believable
 * from that peer). Anywhere else, on the Ficus host or without an apps domain,
 * an alias is not a route at all.
 */
export async function resolveLocalDeploymentRouteParameter(
  request: Request,
  routeParameter: string
): Promise<LocalDeployment | null> {
  if (routeParameter.startsWith(LOCAL_DEPLOYMENT_ALIAS_ROUTE_MARKER)) {
    const alias = routeParameter.slice(LOCAL_DEPLOYMENT_ALIAS_ROUTE_MARKER.length)
    const aliasHost = getLocalDeploymentAliasHost(alias)
    if (!aliasHost || !isTrustedProxyPeer(request)) return null
    if (request.headers.get('x-forwarded-host')?.trim().toLowerCase() !== aliasHost) return null
    return getLocalDeploymentByAlias(alias)
  }
  if (!isValidLocalDeploymentRouteParameter(routeParameter)) return null
  return getLocalDeployment(routeParameter)
}

/** Resolve a route prefix or alias before validating the token against the exact deployment id. */
export async function authenticateLocalDeploymentBrowserRequest(
  request: Request,
  routeParameter: string
): Promise<string | null> {
  const localDeployment = await resolveLocalDeploymentRouteParameter(request, routeParameter)
  if (!localDeployment) return null
  const { token } = presentedLocalDeploymentToken(request, localDeployment.id)
  return (await isValidLocalDeploymentBrowserToken(localDeployment.id, token)) ? localDeployment.id : null
}

/**
 * `Secure` is omitted on plain http so a self-hosted instance served over
 * http://localhost still works — the browser would silently drop a Secure
 * cookie there, which presents as "assets 401 on localhost only".
 */
export function localDeploymentCookieHeader(input: {
  localDeploymentId: string
  token: string
  requestUrl: string
  maxAgeSeconds?: number
}): string {
  const secure = new URL(input.requestUrl).protocol === 'https:'
  const attributes = [
    `${localDeploymentCookieName(input.localDeploymentId)}=${encodeURIComponent(input.token)}`,
    `Path=${localDeploymentProxyPath(input.localDeploymentId)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${input.maxAgeSeconds ?? 12 * 60 * 60}`,
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}
