/**
 * Where the farm lives relative to the rest of the instance. Core serves it at
 * `<base path>/farm/`; the API, WebSocket and web app all sit at the instance
 * base beside it.
 *
 * The base path is chosen per request: Core fills
 * `<meta name="ficus-base-path" content="/ficus/">` into the farm's index.html
 * (apps/core/src/lib/web-serve.ts), so one build serves at the local root and
 * behind a `/ficus` reverse proxy at once. Without a usable meta (the dev
 * server, tests) the farm's build-time base applies.
 */
const FARM_SUFFIX = /\/farm\/?$/
const PLACEHOLDER = '__FICUS_BASE_PATH__'

/** The instance base path Core rendered (`''` or `/ficus`), or null without a usable meta. */
export function runtimeInstanceBasePath(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): string | null {
  const content = doc?.querySelector('meta[name="ficus-base-path"]')?.getAttribute('content')?.trim()
  if (!content || content === PLACEHOLDER || !content.startsWith('/')) return null
  if (content.includes('//') || /[\s"'<>\\]/.test(content)) return null
  return content.replace(/\/+$/, '')
}

/**
 * The instance base path (`''` or for example `/ficus`): from an explicit farm
 * base URL when given, else the one Core rendered, else the build-time base.
 */
export function instanceBasePath(farmBaseUrl?: string): string {
  if (farmBaseUrl === undefined) {
    const runtime = runtimeInstanceBasePath()
    if (runtime !== null) return runtime
  }
  return (farmBaseUrl ?? import.meta.env.BASE_URL ?? '/farm/').replace(FARM_SUFFIX, '').replace(/\/+$/, '')
}

/** Where the farm itself is served for this page: `/farm/` or `/ficus/farm/`. */
export function farmBasePath(): string {
  return `${instanceBasePath()}/farm/`
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
