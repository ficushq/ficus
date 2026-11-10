/**
 * The web app's base path (for example `/ficus` when Ficus is served at
 * `https://host.example.com/ficus`), resolved at runtime instead of being
 * compiled into the web bundle.
 *
 * Every base comes from configuration: the public address (APP_URL, the
 * Settings public address or FICUS_LOCAL_APP_URL) carries its own path, the
 * launcher's local address carries its own (normally root), and explicit
 * FICUS_WEB_ORIGIN / WEBAUTHN_ORIGIN origins use the legacy APP_BASE_PATH.
 * Request headers only ever SELECT one of those configured bases; they never
 * introduce a new one (see {@link resolveRequestBasePath}).
 */
import { getPath as honoGetPath } from 'hono/utils/url'
import { WEB_APP_ROUTE_SEGMENTS } from '@ficus/shared/web-routes'
import { describePublicAppUrl, type PublicAppUrlState } from './public-app-url'

export type BasePathState = Pick<PublicAppUrlState, 'url' | 'localUrl'>
type Env = Record<string, string | undefined>

/** A browser address this server is configured to answer at, with the base path the web app has there. */
export interface KnownAppAddress {
  /** `scheme://host[:port]`, lowercased. */
  origin: string
  /** `host[:port]`, lowercased, without a default port. */
  host: string
  /** `''` at the root, else `/seg[/seg]` with no trailing slash. */
  basePath: string
  source: 'public' | 'local' | 'explicit'
}

/** The parts of a request the resolver reads: Hono's `c.req` satisfies it. */
export interface BasePathRequest {
  url: string
  header: (name: string) => string | undefined
}

export interface ResolvedRequestBasePath {
  basePath: string
  matchedBy: 'path' | 'host' | 'fallback'
}

/**
 * First segments Core itself serves at the root. A base starting with one of
 * these (or with a web app route, {@link WEB_APP_ROUTE_SEGMENTS}) is never
 * stripped from request paths, or it would shadow that route at the local root.
 */
export const CORE_ROOT_SEGMENTS: readonly string[] = [
  'api',
  'ws',
  'docs',
  'farm',
  'assets',
  'icons',
  'voice',
  'social-preview.png',
  'sw.js',
  'manifest.webmanifest',
  'index.html',
  'internal',
  'health',
  'ready',
]

const NEVER_STRIPPED_SEGMENTS = new Set([...CORE_ROOT_SEGMENTS, ...WEB_APP_ROUTE_SEGMENTS])

/** `''` for the root, else `/seg[/seg]` with a leading and no trailing slash. */
export function normalizeBasePath(path: string | undefined | null): string {
  const trimmed = (path ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}` : ''
}

function legacyBasePath(env: Env): string {
  return normalizeBasePath(env.APP_BASE_PATH)
}

function stripDefaultPort(host: string): string {
  return host.toLowerCase().replace(/:(80|443)$/, '')
}

function parseAddress(url: string | undefined): { origin: string; host: string; path: string } | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return {
      origin: parsed.origin.toLowerCase(),
      host: stripDefaultPort(parsed.host),
      path: normalizeBasePath(parsed.pathname),
    }
  } catch {
    return undefined
  }
}

/**
 * The addresses this server is configured to answer at, highest precedence
 * first: the public address, the launcher's local address, then each explicit
 * FICUS_WEB_ORIGIN / WEBAUTHN_ORIGIN origin. A repeated origin keeps its first
 * entry. Built from configuration only.
 *
 * The public address uses its own path; when it has none, the legacy
 * APP_BASE_PATH (deployments that set `APP_URL=https://host` plus
 * `APP_BASE_PATH=/tau` keep serving at `/tau`).
 */
export function knownAppAddresses(
  state: BasePathState = describePublicAppUrl(),
  env: Env = process.env
): KnownAppAddress[] {
  const addresses: KnownAppAddress[] = []
  const add = (url: string | undefined, source: KnownAppAddress['source'], basePath?: string) => {
    const parsed = parseAddress(url)
    if (!parsed || addresses.some((a) => a.origin === parsed.origin)) return
    addresses.push({ origin: parsed.origin, host: parsed.host, basePath: basePath ?? parsed.path, source })
  }
  const publicAddress = parseAddress(state.url)
  if (publicAddress) add(state.url, 'public', publicAddress.path || legacyBasePath(env))
  add(state.localUrl, 'local')
  const explicit = env.FICUS_WEB_ORIGIN ?? env.WEBAUTHN_ORIGIN
  for (const origin of (explicit ?? '').split(',').map((s) => s.trim())) {
    if (origin) add(origin, 'explicit', legacyBasePath(env))
  }
  return addresses
}

/** False when the base's first segment is a Core or web app route: such a base is honored by host match only. */
export function isStrippableBasePath(basePath: string): boolean {
  const first = normalizeBasePath(basePath).split('/')[1]
  return !!first && !NEVER_STRIPPED_SEGMENTS.has(first.toLowerCase())
}

/**
 * Characters a base path may contain to be used in a cookie `Path` attribute or
 * an app's URLs: unreserved characters and percent-encoded bytes, in `/`-separated
 * segments. Public address validation allows more (for example `;`), which would
 * end or widen a cookie Path, so such a base is never used for local apps.
 */
const COOKIE_SAFE_BASE_PATH = /^(?:\/(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})+)+$/

/** Whether a non-empty base path can be used in a cookie Path (see {@link localAppsBasePath}). */
export function isCookieSafeBasePath(basePath: string): boolean {
  return COOKIE_SAFE_BASE_PATH.test(basePath)
}

/**
 * The base path path-mounted local apps are served under: the public base when it
 * is cookie-safe, else the root (`''`), so an unusual address path never reaches a
 * `Set-Cookie` attribute or an app's FICUS_APP_BASE_PATH.
 */
export function localAppsBasePath(publicBase: string = publicBasePath()): string {
  return publicBase && isCookieSafeBasePath(publicBase) ? publicBase : ''
}

/** The distinct, non-empty, strippable configured base paths, longest first. */
export function strippableBasePaths(state: BasePathState = describePublicAppUrl(), env: Env = process.env): string[] {
  const bases = new Set([...knownAppAddresses(state, env).map((a) => a.basePath), legacyBasePath(env)])
  return [...bases].filter((b) => b && isStrippableBasePath(b)).sort((a, b) => b.length - a.length)
}

/**
 * The single configured base used where no request is involved: links,
 * callbacks, local-app paths and cookies. The public address's path, else
 * APP_BASE_PATH, else the root.
 */
export function publicBasePath(state: BasePathState = describePublicAppUrl(), env: Env = process.env): string {
  return parseAddress(state.url)?.path || legacyBasePath(env)
}

/** The base of the configured address with this origin, else the APP_BASE_PATH fallback. */
export function basePathForOrigin(
  origin: string,
  state: BasePathState = describePublicAppUrl(),
  env: Env = process.env
): string {
  const normalized = parseAddress(origin)?.origin
  const match = normalized && knownAppAddresses(state, env).find((a) => a.origin === normalized)
  return match ? match.basePath : legacyBasePath(env)
}

function matchingPrefix(path: string, bases: readonly string[]): string | undefined {
  return bases.find((base) => path === base || path.startsWith(`${base}/`))
}

/**
 * Remove a configured base from the front of a request path, segment-aligned:
 * `/ficus` → `/`, `/ficus/api/x` → `/api/x`; `/ficusx/a` is untouched.
 */
export function stripKnownBasePath(path: string, bases: readonly string[]): string {
  const base = matchingPrefix(path, bases)
  return base ? path.slice(base.length) || '/' : path
}

/**
 * Hono `getPath` for Core: routing, middleware and static serving see the
 * path without a configured prefix, so a reverse proxy may either strip the
 * prefix or forward it unchanged. Only configured prefixes are removed; no
 * header is consulted. The Request itself is untouched.
 */
export function coreGetPath(request: Request): string {
  return stripKnownBasePath(honoGetPath(request), strippableBasePaths())
}

function rawPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return '/'
  }
}

/**
 * The base path the browser used for this request:
 *
 * 1. Path prefix: the raw path starts with a configured, strippable base (a
 *    proxy that forwards the prefix unchanged, or `http://localhost:3000/ficus/`).
 * 2. Host match: the first of X-Forwarded-Host, Host and the URL host that is
 *    the host of a configured address selects that address's base (a proxy
 *    that strips the prefix and preserves Host or sends X-Forwarded-Host).
 * 3. Fallback: APP_BASE_PATH, else the root.
 *
 * Headers can only choose among configured addresses, which are already
 * allowed browser origins, so a forged header can at most render the
 * attacker's own page with another configured base.
 */
export function resolveRequestBasePath(
  req: BasePathRequest,
  state: BasePathState = describePublicAppUrl(),
  env: Env = process.env
): ResolvedRequestBasePath {
  const byPath = matchingPrefix(rawPath(req.url), strippableBasePaths(state, env))
  if (byPath) return { basePath: byPath, matchedBy: 'path' }

  const addresses = knownAppAddresses(state, env)
  let urlHost: string | undefined
  try {
    urlHost = new URL(req.url).host
  } catch {
    urlHost = undefined
  }
  const candidates = [req.header('x-forwarded-host')?.split(',')[0], req.header('host'), urlHost]
  for (const candidate of candidates) {
    const host = candidate?.trim()
    if (!host) continue
    const match = addresses.find((a) => a.host === stripDefaultPort(host))
    if (match) return { basePath: match.basePath, matchedBy: 'host' }
  }
  return { basePath: legacyBasePath(env), matchedBy: 'fallback' }
}
