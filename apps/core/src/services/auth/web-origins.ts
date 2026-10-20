import { describePublicAppUrl, type PublicAppUrlState } from '../../lib/public-app-url'

type UrlState = Pick<PublicAppUrlState, 'url' | 'localUrl'>

/**
 * The browser app's origin(s). One source of truth that drives the WebAuthn RP
 * origin, the CORS allowlist, the WebSocket-handshake Origin check, and the
 * session-cookie SameSite/Secure decision.
 *
 * Configured via FICUS_WEB_ORIGIN (comma-separated; the first entry is canonical).
 * Falls back to the legacy WEBAUTHN_ORIGIN, then the effective public application
 * URL (APP_URL env → Settings public address → FICUS_LOCAL_APP_URL), so existing
 * deployments keep working and an admin-set address applies without a restart.
 * Everything is read per call — never from the request.
 */
function configuredWebOrigins(state: UrlState = describePublicAppUrl()): string[] {
  const explicit = process.env.FICUS_WEB_ORIGIN ?? process.env.WEBAUTHN_ORIGIN
  if (explicit)
    return explicit
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return state.url ? [state.url] : []
}

/** Whether any configuration (env, the public address setting, or the launcher default) names the browser origin. */
export function hasConfiguredWebOrigin(state: UrlState = describePublicAppUrl()): boolean {
  return configuredWebOrigins(state).length > 0
}

/** Canonicalize an origin for comparison: scheme+host lowercased, no trailing slash. */
export function normalizeOrigin(origin: string | undefined | null): string | undefined {
  if (!origin) return undefined
  const trimmed = origin.trim().replace(/\/+$/, '')
  if (!trimmed) return undefined
  try {
    const u = new URL(trimmed)
    return `${u.protocol}//${u.host}`.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

/**
 * Canonical web origin (bare: scheme://host, no path) — the WebAuthn RP origin and the
 * basis for cookie site detection. Normalized so an APP_URL carrying a base path (e.g.
 * https://host/ficus) can't leak that path into the WebAuthn ceremony (which rejects it).
 */
export function primaryWebOrigin(state: UrlState = describePublicAppUrl()): string {
  return normalizeOrigin(configuredWebOrigins(state)[0]) ?? 'http://localhost:5173'
}

/**
 * The web app's root URL: the primary origin plus APP_BASE_PATH (e.g. https://host/ficus),
 * no trailing slash. Links that land on a WEB route (/settings, /register) must use this;
 * the bare origin is only for WebAuthn and cookies. Built from configuration only, never
 * from the request, so a caller cannot steer the link to another host or path.
 */
export function primaryWebAppUrl(): string {
  const basePath = (process.env.APP_BASE_PATH ?? '').trim().replace(/^\/+|\/+$/g, '')
  return basePath ? `${primaryWebOrigin()}/${basePath}` : primaryWebOrigin()
}

/**
 * Origins allowed to make credentialed cross-origin requests (the CORS allowlist,
 * also used by the CSRF bearer-Origin check and the WebSocket Origin check): the
 * explicit web origins, plus the effective public address and the launcher's local
 * address, so setting a public address never locks out localhost access. All are
 * configuration, never request-derived.
 */
export function corsAllowOrigins(state: UrlState = describePublicAppUrl()): string[] {
  const configured = [...configuredWebOrigins(state), state.url, state.localUrl]
    .map((o) => normalizeOrigin(o))
    .filter((o): o is string => !!o)
  // Localhost is a dev convenience only — NEVER auto-allowlist it (credentialed) in
  // production, where a malicious local origin could otherwise ride the session cookie.
  const dev = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']
  return [...new Set([...configured, ...dev])]
}

/**
 * Whether a WebSocket handshake's Origin is allowed. Browsers ALWAYS send Origin on
 * a WS upgrade, so a cross-site attacker page is rejected here (the canonical CSWSH
 * defense — CORS does not gate WS handshakes). A missing Origin means a non-browser
 * client (agent ?token=), which cannot carry a victim's ambient cookie, so it's allowed.
 */
export function isAllowedWsOrigin(origin: string | undefined | null): boolean {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return true
  return corsAllowOrigins().includes(normalized)
}

/**
 * The origin a WebAuthn ceremony is verified against: the request's Origin when it
 * is one of ours (so passkeys registered on localhost keep working there and those
 * registered on the public host work there), else the primary origin. A spoofed
 * Origin cannot widen verification: the chosen origin is always allowlisted, and the
 * browser-signed clientDataJSON.origin must equal it.
 */
export function rpOriginForRequest(
  requestOrigin: string | undefined | null,
  state: UrlState = describePublicAppUrl()
): string {
  const normalized = normalizeOrigin(requestOrigin)
  return normalized && corsAllowOrigins(state).includes(normalized) ? normalized : primaryWebOrigin(state)
}
