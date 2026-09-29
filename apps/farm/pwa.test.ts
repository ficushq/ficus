import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import { FARM_APP_NAME, FARM_MANIFEST_FILE, farmManifest, farmManifestPlugin, versionedIcon } from './pwa'

const iconDir = path.resolve(import.meta.dir, '../../brand/generated/farm')

function contentHash(file: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(iconDir, file)))
    .digest('hex')
    .slice(0, 10)
}

describe('farm manifest', () => {
  it('is its own app, Ficus Farm, scoped to the farm by relative URLs', () => {
    const manifest = farmManifest(iconDir)
    // Relative to the manifest at <base>/farm/, so it holds for any instance base path.
    expect(manifest).toMatchObject({ id: './', start_url: './', scope: './', display: 'standalone' })
    expect(manifest.name).toBe('Ficus Farm')
    expect(manifest.short_name).toBe('Ficus Farm')
  })

  it('points at icons the farm ships, by content-hashed URLs', () => {
    const manifest = farmManifest(iconDir)
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable', 'maskable'])
    for (const icon of manifest.icons) {
      const [file, query] = icon.src.split('?')
      expect(file).not.toStartWith('/')
      expect(existsSync(path.join(iconDir, file))).toBe(true)
      // A changed icon gets a new URL, past the CDN's and iOS's caches.
      expect(query).toBe(`v=${contentHash(file)}`)
    }
  })

  it('versions an icon by its bytes', () => {
    expect(versionedIcon(iconDir, 'apple-touch-icon.png')).toBe(
      `apple-touch-icon.png?v=${contentHash('apple-touch-icon.png')}`
    )
    expect(contentHash('apple-touch-icon.png')).not.toBe(contentHash('icon-192x192.png'))
  })

  it('is emitted beside index.html, which links it and the icons under the base path', async () => {
    const result = await build({
      root: import.meta.dir,
      configFile: false,
      logLevel: 'silent',
      base: '/ficus/farm/',
      publicDir: false,
      plugins: [farmManifestPlugin(iconDir)],
      build: { write: false, rollupOptions: { input: path.join(import.meta.dir, 'index.html') } },
    })
    const output = (Array.isArray(result) ? result[0] : result) as { output: { fileName: string; source?: unknown }[] }
    const files = new Map(output.output.map((file) => [file.fileName, file]))
    expect(JSON.parse(String(files.get(FARM_MANIFEST_FILE)?.source))).toEqual(farmManifest(iconDir))

    const html = String(files.get('index.html')?.source)
    expect(html).toContain(`<link rel="manifest" href="/ficus/farm/${FARM_MANIFEST_FILE}">`)
    expect(html).toContain(
      `<link rel="apple-touch-icon" href="/ficus/farm/apple-touch-icon.png?v=${contentHash('apple-touch-icon.png')}">`
    )
    expect(html).toContain(`href="/ficus/farm/favicon-32x32.png?v=${contentHash('favicon-32x32.png')}"`)
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${FARM_APP_NAME}" />`)
    expect(html).toContain(`<title>${FARM_APP_NAME}</title>`)
  }, 60_000)
})
