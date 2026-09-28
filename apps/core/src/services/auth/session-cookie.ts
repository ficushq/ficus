import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { primaryWebOrigin } from './web-origins'

export const SESSION_COOKIE_NAME = 'ficus_session'
// Matches the session row TTL (User.createSession default of 30 days).
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60

/**
 * Read the session token from a request: an explicit bearer header wins (CLI,
 * agents, legacy), then the browser's HttpOnly session cookie.
 */
export function extractSessionToken(c: Context): string | undefined {
  const authHeader = c.req.header('Authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  return c.req.header('X-Auth-Token') ?? getCookie(c, SESSION_COOKIE_NAME)
}

export function getSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME)
}

// Best-effort registrable domain (eTLD+1) via the last two labels. Good enough to
// distinguish "same site, different subdomain" (e.g. noah / api-noah .ficus.sh)
// from a genuinely different site; PSL edge cases (e.g. *.co.uk) can be overridden
// by deploying web + API on the same host.
function registrableDomain(host: string): string {
  const h = host.split(':')[0]
  const parts = h.split('.')
  return parts.length <= 2 ? h : parts.slice(-2).join('.')
}

function requestIsHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim()
  if (proto) return proto === 'https'
  try {
    return new URL(c.req.url).protocol === 'https:'
  } catch {
    return false
  }
}

function requestHost(c: Context): string {
  const h = c.req.header('host')
  if (h) return h
  try {
    return new URL(c.req.url).host
  } catch {
    return ''
  }
}

/**
 * Cookie attributes derived from how the browser app is deployed relative to the
 * API. Same-site (same-origin, or cross-subdomain like noah / api-noah): SameSite=Lax
 * — CSRF-safe and works on http localhost. Genuinely cross-site: SameSite=None, which
 * mandates Secure. CSRF middleware is the cross-origin defense layered on top.
 */
function cookieOptions(c: Context, maxAge: number) {
  const apiHost = requestHost(c)
  let webHost = ''
  let webHttps = false
  try {
    const u = new URL(primaryWebOrigin())
    webHost = u.host
    webHttps = u.protocol === 'https:'
  } catch {
    /* ignore malformed origin → treat as same-site */
  }
  const crossSite = !!webHost && !!apiHost && registrableDomain(webHost) !== registrableDomain(apiHost)
  const sameSite: 'None' | 'Lax' = crossSite ? 'None' : 'Lax'
  // SameSite=None mandates Secure. Otherwise prefer Secure whenever the deployment is
  // https — by the live request (incl. x-forwarded-proto) OR the configured web origin —
  // so a proxy that drops x-forwarded-proto can't silently downgrade to an insecure cookie.
  const secure = sameSite === 'None' ? true : requestIsHttps(c) || webHttps
  return { httpOnly: true, path: '/', sameSite, secure, maxAge }
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE_NAME, token, cookieOptions(c, SESSION_MAX_AGE_S))
}

export function clearSessionCookie(c: Context): void {
  // Re-issue with the same attributes and Max-Age=0 so the browser drops it.
  setCookie(c, SESSION_COOKIE_NAME, '', cookieOptions(c, 0))
}
