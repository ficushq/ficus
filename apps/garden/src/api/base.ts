/**
 * Where the garden lives relative to the rest of the instance. Core serves it at
 * `<APP_BASE_PATH>/garden/`; the API, WebSocket and web app all sit at the
 * instance root beside it.
 */
const GARDEN_SUFFIX = /\/garden\/?$/

/** The instance base path ('' or e.g. '/ficus'), derived from the garden's own base URL. */
export function instanceBasePath(gardenBaseUrl: string = import.meta.env.BASE_URL ?? '/garden/'): string {
  return gardenBaseUrl.replace(GARDEN_SUFFIX, '').replace(/\/+$/, '')
}

function pageOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin
}

export function apiUrl(path: string, origin = pageOrigin(), gardenBaseUrl?: string): string {
  return `${origin}${instanceBasePath(gardenBaseUrl)}/api${path}`
}

export function wsUrl(path: string, origin = pageOrigin(), gardenBaseUrl?: string): string {
  return `${origin.replace(/^http/, 'ws')}${instanceBasePath(gardenBaseUrl)}${path}`
}

/** The regular web app, for everything the garden links out to (settings, sign-in). */
export function webAppUrl(path = '/', gardenBaseUrl?: string): string {
  return `${instanceBasePath(gardenBaseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}
