/**
 * The base path the web app is served under (`/` or `/ficus/`), read at
 * runtime instead of being compiled into the bundle.
 *
 * Core renders index.html per request and fills
 * `<meta name="ficus-base-path" content="…">` with the base the browser used,
 * so one build works at the server's local root address and behind a reverse
 * proxy at `https://host/ficus` at the same time. Without a usable meta (the
 * Vite dev server, `vite preview`, tests) the build-time
 * `import.meta.env.BASE_URL` applies, then `/`.
 */

const META_SELECTOR = 'meta[name="ficus-base-path"]'
const PLACEHOLDER = '__FICUS_BASE_PATH__'

const cache = new WeakMap<Document, string>()

/** `/x/` form, or null when the value is not a safe same-origin path. */
function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === PLACEHOLDER || !trimmed.startsWith('/')) return null
  if (trimmed.includes('//') || /[\s"'<>\\]/.test(trimmed)) return null
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/** Read the base path from a document, uncached: `/` or `/ficus/` (leading and trailing slash). */
export function readAppBasePath(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): string {
  const meta = doc?.querySelector(META_SELECTOR)?.getAttribute('content')
  return normalize(meta) ?? normalize(import.meta.env?.BASE_URL) ?? '/'
}

/** The app's base path with leading and trailing slash: `/` or `/ficus/`. */
export function appBasePath(): string {
  if (typeof document === 'undefined') return readAppBasePath(undefined)
  let value = cache.get(document)
  if (value === undefined) {
    value = readAppBasePath(document)
    cache.set(document, value)
  }
  return value
}

/** The base path as a prefix to join with `/path`: `''` at the root, else `/ficus`. */
export function appBasePrefix(): string {
  return appBasePath().replace(/\/$/, '')
}
