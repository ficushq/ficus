/**
 * Pure canonicalization for the public application URL. Kept free of imports so
 * the settings store can validate with it without importing the resolver
 * (which itself reads the settings store).
 */

export const PUBLIC_APP_URL_SETTING_KEY = 'PUBLIC_APP_URL'
export const PUBLIC_APP_URL_MIGRATED_SETTING_KEY = 'PUBLIC_APP_URL_MIGRATED'
export const LOCAL_APP_URL_ENV = 'FICUS_LOCAL_APP_URL'
export const MAX_PUBLIC_APP_URL_LENGTH = 2048

export const PUBLIC_APP_URL_FORMAT_ERROR =
  'Enter an http(s) URL with a host and an optional port or path, without credentials, query or fragment.'

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
// Percent-encoded C0 controls, DEL, and encoded slashes/backslashes that could
// smuggle path segments past a reverse proxy.
const ENCODED_UNSAFE = /%(?:[01][0-9a-f]|7f|2f|5c)/i
const MALFORMED_ENCODING = /%(?![0-9a-f]{2})/i

/**
 * Canonical `origin + base path` (no trailing slash) for an http(s) URL, or
 * `undefined` for anything unsafe: credentials, query, fragment, control
 * characters, backslashes, malformed or control percent-encodings, empty
 * path segments, a missing host, or more than {@link MAX_PUBLIC_APP_URL_LENGTH}
 * characters. Ports and base paths are preserved.
 */
export function normalizePublicAppUrl(candidate: string | undefined | null): string | undefined {
  const raw = candidate?.trim()
  if (!raw || raw.length > MAX_PUBLIC_APP_URL_LENGTH) return undefined
  if (raw.includes('\\') || CONTROL_CHARACTER.test(raw)) return undefined
  if (MALFORMED_ENCODING.test(raw) || ENCODED_UNSAFE.test(raw)) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  // `new URL` drops an empty `?`/`#`; reject them too so the stored value is exactly what was meant.
  if (raw.includes('?') || raw.includes('#')) return undefined
  if (url.pathname.includes('//')) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(h) || h === '[::1]' || h === '::1'
}
