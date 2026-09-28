/**
 * Where the farm lives relative to the rest of the instance. Core serves it at
 * `<APP_BASE_PATH>/farm/`; the API, WebSocket and web app all sit at the
 * instance root beside it.
 */
const FARM_SUFFIX = /\/farm\/?$/

/** The instance base path ('' or e.g. '/ficus'), derived from the farm's own base URL. */
export function instanceBasePath(farmBaseUrl: string = import.meta.env.BASE_URL ?? '/farm/'): string {
  return farmBaseUrl.replace(FARM_SUFFIX, '').replace(/\/+$/, '')
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}

export function apiUrl(path: string, origin = pageOrigin(), farmBaseUrl?: string): string {
  return `${origin}${instanceBasePath(farmBaseUrl)}/api${path}`
}

export function wsUrl(path: string, origin = pageOrigin(), farmBaseUrl?: string): string {
  return `${origin.replace(/^http/, 'ws')}${instanceBasePath(farmBaseUrl)}${path}`
}

/** The regular web app, for everything the farm links out to (settings, sign-in). */
export function webAppUrl(path = '/', farmBaseUrl?: string): string {
  return `${instanceBasePath(farmBaseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}
