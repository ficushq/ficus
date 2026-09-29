import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { HtmlTagDescriptor, Plugin } from 'vite'

/**
 * The farm's web app manifest and icons, so it installs to a home screen as
 * its own app beside Ficus. Every URL is relative to the farm's base
 * (`<APP_BASE_PATH>/farm/`): the app's id, start and scope are the farm,
 * whatever the instance base path, and its icons are the farm set in the
 * farm's public dir (brand/generated/farm).
 *
 * Icon URLs carry a content hash (`?v=`). Core serves them `no-cache`, but a
 * CDN in front (Cloudflare caches images for hours) and iOS's home-screen icon
 * cache key on the URL, so without it a changed icon keeps showing the old one.
 */
export const FARM_MANIFEST_FILE = 'manifest.webmanifest'

export const FARM_APP_NAME = 'Ficus Farm'

// The meadow the farm is drawn on (skins' --g-page), for the launch screen and title bar.
const MEADOW = '#a3bb5d'

/** `file` with a short hash of its contents, so the URL changes whenever the icon does. */
export function versionedIcon(iconDir: string, file: string): string {
  const hash = createHash('sha256')
    .update(readFileSync(path.join(iconDir, file)))
    .digest('hex')
    .slice(0, 10)
  return `${file}?v=${hash}`
}

export function farmManifest(iconDir: string) {
  const icon = (file: string, size: number, purpose: 'any' | 'maskable') => ({
    src: versionedIcon(iconDir, file),
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  })
  return {
    // Distinct from the web app's id (its own start URL), so both install side by side.
    id: './',
    name: FARM_APP_NAME,
    short_name: FARM_APP_NAME,
    description: 'Your Ficus squads, tended as a farm.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: MEADOW,
    theme_color: MEADOW,
    icons: [
      icon('icon-192x192.png', 192, 'any'),
      icon('icon-512x512.png', 512, 'any'),
      icon('icon-maskable-192x192.png', 192, 'maskable'),
      icon('icon-maskable-512x512.png', 512, 'maskable'),
    ],
  }
}

/** The manifest, favicon and home-screen icon links for index.html. */
export function farmHeadTags(base: string, iconDir: string): HtmlTagDescriptor[] {
  const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({ tag: 'link', attrs, injectTo: 'head' })
  return [
    link({ rel: 'manifest', href: `${base}${FARM_MANIFEST_FILE}` }),
    link({
      rel: 'icon',
      type: 'image/png',
      sizes: '32x32',
      href: `${base}${versionedIcon(iconDir, 'favicon-32x32.png')}`,
    }),
    link({
      rel: 'icon',
      type: 'image/png',
      sizes: '16x16',
      href: `${base}${versionedIcon(iconDir, 'favicon-16x16.png')}`,
    }),
    link({ rel: 'apple-touch-icon', href: `${base}${versionedIcon(iconDir, 'apple-touch-icon.png')}` }),
  ]
}

/**
 * Serves the manifest in development, emits it in builds, and links it and
 * the icons from index.html. `iconDir` is the farm's public dir.
 */
export function farmManifestPlugin(iconDir: string): Plugin {
  const json = () => `${JSON.stringify(farmManifest(iconDir), null, 2)}\n`
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
        res.end(json())
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FARM_MANIFEST_FILE, source: json() })
    },
    transformIndexHtml() {
      return farmHeadTags(base, iconDir)
    },
  }
}
