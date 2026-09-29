import type { Plugin } from 'vite'

/**
 * The farm's web app manifest, so it installs to a home screen as its own
 * app beside Ficus. Every URL is relative to the manifest, which sits at the
 * farm's base (`<APP_BASE_PATH>/farm/`): the app's id, start and scope are
 * the farm, whatever the instance base path, and its icons are the farm set
 * in the farm's public dir (brand/generated/farm).
 */
export const FARM_MANIFEST_FILE = 'manifest.webmanifest'

// The meadow the farm is drawn on (skins' --g-page), for the launch screen and title bar.
const MEADOW = '#a3bb5d'

export function farmManifest() {
  return {
    // Distinct from the web app's id (its own start URL), so both install side by side.
    id: './',
    name: 'Ficus farm',
    short_name: 'Farm',
    description: 'Your Ficus squads, tended as a farm.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: MEADOW,
    theme_color: MEADOW,
    icons: [
      { src: 'icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icon-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/** Serves the manifest in development, emits it in builds, and links it from index.html. */
export function farmManifestPlugin(): Plugin {
  const json = `${JSON.stringify(farmManifest(), null, 2)}\n`
  let base = '/'
  return {
    name: 'ficus-farm-manifest',
    configResolved(config) {
      base = config.base
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${base}${FARM_MANIFEST_FILE}`) return next()
        res.setHeader('Content-Type', 'application/manifest+json')
        res.end(json)
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FARM_MANIFEST_FILE, source: json })
    },
    transformIndexHtml() {
      return [{ tag: 'link', attrs: { rel: 'manifest', href: `${base}${FARM_MANIFEST_FILE}` }, injectTo: 'head' }]
    },
  }
}
