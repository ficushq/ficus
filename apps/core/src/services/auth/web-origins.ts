/**
 * The browser app's origin(s). One source of truth that drives the WebAuthn RP
 * origin, the CORS allowlist, the WebSocket-handshake Origin check, and the
 * session-cookie SameSite/Secure decision.
 *
 * Configured via FICUS_WEB_ORIGIN (comma-separated; the first entry is canonical).
 * Falls back to the legacy WEBAUTHN_ORIGIN, then APP_URL, so existing deployments
 * keep working without changing env.
 */
function configuredWebOrigins(): string[] {
  const raw = process.env.FICUS_WEB_ORIGIN ?? process.env.WEBAUTHN_ORIGIN ?? process.env.APP_URL
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
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
export function primaryWebOrigin(): string {
  return normalizeOrigin(configuredWebOrigins()[0]) ?? 'http://localhost:5173'
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

/** Origins allowed to make credentialed cross-origin requests (the CORS allowlist). */
export function corsAllowOrigins(): string[] {
  const configured = configuredWebOrigins()
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
