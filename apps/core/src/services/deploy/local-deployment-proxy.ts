import { Squad } from '../../entities/Squad'
import { ensureSquadSandbox } from '../sandbox/ensure'
import { getLocalDeployment, isValidLocalDeploymentBrowserToken } from './local-deployment-service'
import { resolveLocalDeploymentTarget } from './local-deployment-target'
import { localDeploymentCookieHeader, presentedLocalDeploymentToken } from './local-deployment-auth'
import { localDeploymentProxyError, stripLocalDeploymentProxyErrorMarker } from './local-deployment-proxy-response'

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

interface LocalDeploymentProxyDependencies {
  ensureSquadSandbox: typeof ensureSquadSandbox
  resolveLocalDeploymentTarget: typeof resolveLocalDeploymentTarget
  fetch: typeof fetch
}

let dependencyOverrides: Partial<LocalDeploymentProxyDependencies> = {}

function getDependencies(): LocalDeploymentProxyDependencies {
  return {
    ensureSquadSandbox: dependencyOverrides.ensureSquadSandbox ?? ensureSquadSandbox,
    resolveLocalDeploymentTarget: dependencyOverrides.resolveLocalDeploymentTarget ?? resolveLocalDeploymentTarget,
    fetch: dependencyOverrides.fetch ?? fetch,
  }
}

export function configureLocalDeploymentProxyDependencies(
  overrides: Partial<LocalDeploymentProxyDependencies> = {}
): void {
  dependencyOverrides = overrides
}

export async function proxyLocalDeploymentRequest(
  localDeploymentId: string,
  request: Request,
  path: string
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
  // Only the URL-token request needs to mint the cookie; a request already carrying it re-sends nothing.
  if (presented.fromQuery) {
    // append: the app may set cookies of its own, and they must survive.
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
