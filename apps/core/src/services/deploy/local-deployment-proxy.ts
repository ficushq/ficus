import { Squad } from '../../entities/Squad'
import { getClientAddress, isTrustedProxyPeer } from '../../lib/client-address'
import { SESSION_COOKIE_NAME } from '../auth/session-cookie'
import { ensureSquadSandbox } from '../sandbox/ensure'
import {
  getLocalDeployment,
  getLocalDeploymentPublicHost,
  isValidLocalDeploymentBrowserToken,
} from './local-deployment-service'
import { resolveLocalDeploymentTarget } from './local-deployment-target'
import {
  localDeploymentCookieHeader,
  localDeploymentCookieName,
  presentedLocalDeploymentToken,
} from './local-deployment-auth'
import { localDeploymentProxyError, stripLocalDeploymentProxyErrorMarker } from './local-deployment-proxy-response'
import {
  isAllowedLocalAppWebSocketOrigin,
  isWebSocketUpgradeRequest,
  proxyLocalAppWebSocket,
  type WebSocketUpgradeServer,
} from './local-deployment-websocket'

/** The app-proxy token's query name before the Ficus rename (stripped, never accepted). */
const LEGACY_TOKEN_QUERY_PARAM = '_tau_token' // ficus-p5-bridge

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SENSITIVE_AUTH_HEADERS = ['authorization', 'x-auth-token', 'cookie']

/**
 * Ficus's own cookies, by exact name, that never reach an app even on its own
 * origin: the Core session, the per-deployment access cookie, and the Platform
 * bridge's credential cookie (plus their pre-Ficus names). Exact names only: a
 * pattern could eat an app cookie that happens to look similar.
 */
function ficusCookieNames(localDeploymentId: string): Set<string> {
  return new Set([
    SESSION_COOKIE_NAME,
    'tau_session', // ficus-p5-bridge
    localDeploymentCookieName(localDeploymentId),
    `tau_app_${localDeploymentId}`, // ficus-p5-bridge
    'ficus_app',
    '__Host-ficus_app',
    '__Host-tau_app', // ficus-p5-bridge
  ])
}

/** The browser's Cookie header minus Ficus's own cookies, or null when nothing is left. */
function appCookieHeader(cookieHeader: string | null, localDeploymentId: string): string | null {
  if (!cookieHeader) return null
  const ficusNames = ficusCookieNames(localDeploymentId)
  const kept = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !ficusNames.has(part.split('=', 1)[0]!.trim()))
  return kept.length > 0 ? kept.join('; ') : null
}

/**
 * The app's Set-Cookie headers as they may reach the browser from its own
 * origin. The apps domain is not a public suffix, so a `Domain=<apps domain>`
 * cookie from one app would be sent to every app of every tenant: the Domain
 * attribute is removed, making every app cookie host-only (a cookie for the
 * app's own host means the same thing without it). A cookie under a Ficus
 * cookie name is dropped: it would shadow Ficus's own and never reach the app.
 */
function hostOnlyAppSetCookies(setCookies: string[], localDeploymentId: string): string[] {
  const ficusNames = ficusCookieNames(localDeploymentId)
  const kept: string[] = []
  for (const setCookie of setCookies) {
    const [pair = '', ...attributes] = setCookie.split(';')
    if (ficusNames.has(pair.split('=', 1)[0]!.trim())) continue
    const hostOnly = attributes.filter((attribute) => attribute.split('=', 1)[0]!.trim().toLowerCase() !== 'domain')
    kept.push([pair, ...hostOnly].join(';'))
  }
  return kept
}

/**
 * The app's own public host when this request arrived through its per-app
 * origin (`<tenant>--<id>.<apps domain>`), else null (the path mount).
 *
 * The Platform bridge re-sends a per-app-origin request to the tenant host and
 * names the app host in X-Forwarded-Host; the tenant Caddy keeps that header
 * only from the bridge (scripts/setup/lib.sh render_caddyfile) and pins it to
 * the tenant host for everyone else. Core believes it only from a trusted peer
 * (the caller checks) and only when it is exactly this deployment's host, so a
 * forged value can at most name the host the app already has.
 */
function perAppOriginHost(request: Request, localDeploymentId: string): string | null {
  const expected = getLocalDeploymentPublicHost(localDeploymentId)
  const forwarded = request.headers.get('x-forwarded-host')?.trim().toLowerCase()
  return expected && forwarded === expected ? expected : null
}

/**
 * Headers that claim to name the visitor's address. Any of them can be written
 * by a client that reaches the origin without going through Cloudflare, so none
 * is passed on; the app gets one X-Forwarded-For that Core computed itself.
 */
const CLIENT_ADDRESS_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-original-forwarded-for',
  'x-envoy-external-address',
  'true-client-ip',
  'fastly-client-ip',
  'cf-connecting-ip',
  'cf-connecting-ipv6',
  'cf-pseudo-ipv4',
]

interface LocalDeploymentProxyDependencies {
  ensureSquadSandbox: typeof ensureSquadSandbox
  resolveLocalDeploymentTarget: typeof resolveLocalDeploymentTarget
  fetch: typeof fetch
  /** How long the app gets to accept a WebSocket upgrade. */
  webSocketConnectTimeoutMs?: number
}

let dependencyOverrides: Partial<LocalDeploymentProxyDependencies> = {}

function getDependencies(): LocalDeploymentProxyDependencies {
  return {
    ensureSquadSandbox: dependencyOverrides.ensureSquadSandbox ?? ensureSquadSandbox,
    resolveLocalDeploymentTarget: dependencyOverrides.resolveLocalDeploymentTarget ?? resolveLocalDeploymentTarget,
    fetch: dependencyOverrides.fetch ?? fetch,
    webSocketConnectTimeoutMs: dependencyOverrides.webSocketConnectTimeoutMs,
  }
}

export function configureLocalDeploymentProxyDependencies(
  overrides: Partial<LocalDeploymentProxyDependencies> = {}
): void {
  dependencyOverrides = overrides
}

/**
 * Proxy one request to a local app. `server` is Bun's server (Hono's `c.env`),
 * needed only to accept a WebSocket upgrade: an upgrade is authorized and gets
 * the same cookie, host and client-address headers as HTTP, then is relayed as
 * a socket (local-deployment-websocket.ts) instead of fetched.
 */
export async function proxyLocalDeploymentRequest(
  localDeploymentId: string,
  request: Request,
  path: string,
  server?: WebSocketUpgradeServer
): Promise<Response> {
  const localDeployment = await getLocalDeployment(localDeploymentId)
  if (!localDeployment || localDeployment.status === 'stopped')
    return localDeploymentProxyError('LocalDeployment not found', 404)
  if (localDeployment.visibility !== 'private')
    return localDeploymentProxyError('Unsupported localDeployment visibility', 403)

  const deps = getDependencies()
  let target: { host: string; port: number }
  try {
    target = await deps.resolveLocalDeploymentTarget(localDeployment.sandboxId, localDeployment.port)
  } catch (err) {
    if (!(err as Error).message.includes('Sandbox not found')) throw err
    await deps.ensureSquadSandbox(localDeployment.squadId, { restartManagedLocalDeployments: false })
    target = await deps.resolveLocalDeploymentTarget(Squad.getSandboxId(localDeployment.squadId), localDeployment.port)
  }
  const sourceUrl = new URL(request.url)
  // Query token (the shared URL) or the path-scoped cookie it set. The cookie is
  // what lets the app's OWN subresource requests through: the browser sends no
  // query string of its own for `/assets/index-*.js`, so before this every
  // script and stylesheet a deployed app loaded came back 401.
  const presented = presentedLocalDeploymentToken(request, localDeployment.id)
  // Always require a valid per-deployment browser token, even when the request
  // carries a Ficus session/agent identity. Otherwise any logged-in principal
  // (including a wrong-squad agent) could proxy into any squad's deployed app.
  // Inbound auth headers are stripped before forwarding (stripUnsafeProxyHeaders).
  if (!(await isValidLocalDeploymentBrowserToken(localDeployment.id, presented.token))) {
    return localDeploymentProxyError('Unauthorized', 401)
  }
  const normalizedPath = path.replace(/^\/+/, '')
  const targetUrl = new URL(`http://${target.host}:${target.port}/${normalizedPath}`)
  sourceUrl.searchParams.delete('_ficus_token')
  // The name before the Ficus rename: while the Platform bridge forwards the credential under both
  // names, it must never reach the app either.
  sourceUrl.searchParams.delete(LEGACY_TOKEN_QUERY_PARAM)
  targetUrl.search = sourceUrl.search

  const headers = new Headers(request.headers)
  stripUnsafeProxyHeaders(headers)
  setClientAddressHeaders(headers, getClientAddress(request))
  // Cookies and host, by mount:
  //   - per-app origin: the app owns its origin, so its cookies go to it (minus
  //     Ficus's own), the ones it sets reach the browser host-only (no Domain),
  //     and it sees its own public host;
  //   - path mount (/api/app/<id>/ on the Ficus host): the origin is shared with
  //     Ficus and every other app, so no cookie reaches the app (it would get
  //     the Ficus session and other apps' cookies) and none it sets reaches the
  //     browser (it could overwrite Ficus's or another app's). Host stays the
  //     Ficus host; X-Forwarded-Host is the trusted proxy's, else that Host.
  const trustedPeer = isTrustedProxyPeer(request)
  const publicHost = trustedPeer ? perAppOriginHost(request, localDeployment.id) : null
  if (publicHost) {
    const cookie = appCookieHeader(request.headers.get('cookie'), localDeployment.id)
    if (cookie) headers.set('cookie', cookie)
    headers.set('host', publicHost)
    headers.set('x-forwarded-host', publicHost)
    headers.set('x-forwarded-proto', 'https')
  } else if (!trustedPeer || !headers.has('x-forwarded-host')) {
    headers.set('x-forwarded-host', request.headers.get('host') ?? sourceUrl.host)
  }

  if (isWebSocketUpgradeRequest(request)) {
    if (!isAllowedLocalAppWebSocketOrigin(request.headers.get('origin'), publicHost)) {
      return localDeploymentProxyError('Forbidden', 403)
    }
    if (!server) return localDeploymentProxyError('WebSocket upgrades are not available on this route', 501)
    return proxyLocalAppWebSocket({
      server,
      request,
      targetUrl,
      headers,
      connectTimeoutMs: deps.webSocketConnectTimeoutMs,
    })
  }

  const upstream = stripLocalDeploymentProxyErrorMarker(
    await deps.fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      // Byte-transparent: the browser's Accept-Encoding is forwarded, so the app
      // may answer gzip/br/deflate/zstd. Bun's fetch would decode that body yet
      // keep the upstream Content-Encoding/Content-Length, and the browser would
      // then fail to decode plain bytes (ERR_CONTENT_DECODING_FAILED). Passing
      // the encoded bytes through keeps body and headers consistent.
      decompress: false,
    })
  )

  const responseHeaders = new Headers(upstream.headers)
  keepOutOfSharedCaches(responseHeaders)
  const appSetCookies = publicHost ? hostOnlyAppSetCookies(upstream.headers.getSetCookie(), localDeployment.id) : []
  responseHeaders.delete('set-cookie')
  for (const setCookie of appSetCookies) responseHeaders.append('set-cookie', setCookie)
  // Only the URL-token request needs to mint the cookie; a request already carrying it re-sends nothing.
  // The per-app origin needs none: the Platform bridge holds that credential in its own cookie.
  if (presented.fromQuery && !publicHost) {
    responseHeaders.append(
      'set-cookie',
      localDeploymentCookieHeader({
        localDeploymentId: localDeployment.id,
        token: presented.token!,
        requestUrl: request.url,
      })
    )
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

/** CDN cache headers Cloudflare honors over Cache-Control and CDN-Cache-Control. */
const CDN_OVERRIDE_HEADERS = ['cloudflare-cdn-cache-control', 'surrogate-control'] as const

/** Cache-Control directives that only speak to shared caches (a CDN or proxy), dropped with `public`. */
const SHARED_CACHE_DIRECTIVES = new Set(['public', 's-maxage', 'proxy-revalidate'])

/**
 * A deployed app is private: every response needs the deployment's token, so a
 * shared cache must never keep one. An app marks its hashed assets `public,
 * max-age=31536000, immutable` (Next.js, Vite), and the CDN in front of the
 * instance (Cloudflare) then served them to anyone with the URL, token or not,
 * and kept serving whatever it had stored for a year, broken bodies included.
 * The browser's own caching is kept (`private` plus the app's max-age), and
 * CDN-Cache-Control tells the CDN outright not to store it.
 */
export function keepOutOfSharedCaches(headers: Headers): void {
  const directives = (headers.get('cache-control') ?? '')
    .split(',')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !SHARED_CACHE_DIRECTIVES.has(directive.split('=')[0]!.trim().toLowerCase()))
  const has = (name: string) => directives.some((directive) => directive.toLowerCase() === name)
  headers.set(
    'cache-control',
    has('no-store') || has('private') ? directives.join(', ') : ['private', ...directives].join(', ')
  )
  headers.set('cdn-cache-control', 'no-store')
  // Cloudflare reads these ahead of both headers above: Cloudflare-CDN-Cache-Control
  // outranks CDN-Cache-Control, and with Surrogate-Control present Cache-Control
  // is ignored. An app sending either could still have its private responses
  // stored at the edge and served without a token.
  for (const name of CDN_OVERRIDE_HEADERS) headers.delete(name)
}

/**
 * Replace every client-address header with a single X-Forwarded-For naming
 * the address Core resolved for this request. That address honors an incoming
 * X-Forwarded-For only from a trusted peer (the same-host reverse proxy), so the
 * app can trust its one entry. An unknown address sends no header at all.
 */
function setClientAddressHeaders(headers: Headers, clientAddress: string): void {
  for (const name of CLIENT_ADDRESS_HEADERS) headers.delete(name)
  if (clientAddress !== 'unknown') headers.set('x-forwarded-for', clientAddress)
}

function stripUnsafeProxyHeaders(headers: Headers): void {
  const connection = headers.get('connection')
  if (connection) {
    for (const token of connection.split(',')) {
      const header = token.trim().toLowerCase()
      if (header) headers.delete(header)
    }
  }

  for (const h of HOP_BY_HOP) headers.delete(h)
  for (const h of SENSITIVE_AUTH_HEADERS) headers.delete(h)
}
