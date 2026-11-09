import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * The web app's base path is chosen per request by Core, which fills
 * `<meta name="ficus-base-path" content="__FICUS_BASE_PATH__">` into
 * index.html and rebases its asset URLs (apps/core/src/lib/web-serve.ts), so
 * one bundle serves at `/` and under any prefix. A bundle built before that
 * has no placeholder: it only works at the base it was built for, and a
 * restart never rebuilds it. Detect that before it reaches a browser.
 */

const BASE_PATH_PLACEHOLDER = '__FICUS_BASE_PATH__'

/**
 * A one-line warning when apps/web/dist predates runtime base paths; null when
 * the bundle is current or nothing has been built yet (a missing bundle is a
 * different, louder failure).
 */
export function staleWebDistWarning(root: string): string | null {
  const indexPath = join(root, 'apps', 'web', 'dist', 'index.html')
  if (!existsSync(indexPath)) return null
  if (readFileSync(indexPath, 'utf8').includes(BASE_PATH_PLACEHOLDER)) return null
  return `apps/web/dist predates runtime base paths: it only works at the path it was built for. Run \`bun run build:web\` in ${root} — a restart does not rebuild the web app.`
}
