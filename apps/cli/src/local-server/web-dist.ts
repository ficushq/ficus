import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Vite bakes `APP_BASE_PATH` into apps/web/dist at BUILD time: every asset URL
 * in index.html starts with it. Restarting the instance re-reads .env for the
 * API but never rebuilds the web app, so a bundle built while .env said one
 * base and an instance configured for another serves a page that 404s on its
 * own JavaScript — with an API that looks perfectly healthy. Detect that
 * before it reaches a browser.
 */

const ASSET_URL_RE = /(?:src|href)="([^"]*?\/)assets\/[^"]+"/

/** The base a built index.html was produced for (`/`, `/ficus/`), or null without built assets. */
export function builtWebBase(indexHtml: string): string | null {
  const match = ASSET_URL_RE.exec(indexHtml)
  return match ? match[1] : null
}

/** `APP_BASE_PATH` normalised the way vite.config.ts does: leading and trailing slash. */
export function expectedWebBase(appBasePath: string | undefined): string {
  const trimmed = (appBasePath ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/**
 * A one-line warning when the built bundle disagrees with the checkout's
 * `APP_BASE_PATH`; null when they agree or nothing has been built yet (a
 * missing bundle is a different, louder failure).
 */
export function webDistWarning(root: string, env: Record<string, string | undefined>): string | null {
  const indexPath = join(root, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(indexPath)) return null
  const built = builtWebBase(readFileSync(indexPath, 'utf8'))
  if (!built) return null
  const expected = expectedWebBase(env.APP_BASE_PATH)
  if (built === expected) return null
  const configured = env.APP_BASE_PATH?.trim() ? `APP_BASE_PATH=${env.APP_BASE_PATH.trim()}` : 'APP_BASE_PATH is unset'
  return `apps/web/dist was built for base "${built}" but .env has ${configured} (base "${expected}"): the web app will 404 on its own assets. Run \`bun run build:web\` in ${root} — a restart does not rebuild the web app.`
}
