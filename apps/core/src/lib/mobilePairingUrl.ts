import { resolvePublicAppUrl } from './public-app-url'

interface BuildMobilePairingServerUrlInput {
  requestUrl: string
  originHeader?: string | null
}

function normalizeBasePath(path: string | undefined | null): string {
  const trimmed = path?.trim()
  if (!trimmed || trimmed === '/') return ''
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function basePathFromRequestUrl(requestUrl: string): string {
  try {
    const { pathname } = new URL(requestUrl)
    const apiIndex = pathname.indexOf('/api/')
    if (apiIndex <= 0) return ''
    return normalizeBasePath(pathname.slice(0, apiIndex))
  } catch {
    return ''
  }
}

/**
 * Build the web/API base URL encoded in mobile pairing QRs.
 *
 * The configured public address (APP_URL, then PUBLIC_URL) wins when set. Otherwise the
 * browser origin is used; the Origin header is only scheme/host/port, so deployments hosted under
 * an app base path (for example /ficus) need that path added explicitly. Prefer the
 * configured APP_BASE_PATH, and fall back to the request URL path before /api when
 * a reverse proxy forwards the base path through to the core server.
 */
export function buildMobilePairingServerUrl({ requestUrl, originHeader }: BuildMobilePairingServerUrlInput): string {
  // A configured public address (APP_URL) is what phones can reach, even when the browser
  // opened this server through localhost or a LAN address.
  const configured = resolvePublicAppUrl()
  if (configured) return configured
  const origin = originHeader ?? new URL(requestUrl).origin
  const basePath = normalizeBasePath(process.env.APP_BASE_PATH) || basePathFromRequestUrl(requestUrl)
  return `${origin.replace(/\/+$/, '')}${basePath}`
}
