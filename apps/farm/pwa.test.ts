import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import { FARM_MANIFEST_FILE, farmManifest } from './pwa'

const farmIcons = path.resolve(import.meta.dir, '../../brand/generated/farm')

describe('farm manifest', () => {
  it('is its own app, scoped to the farm by relative URLs', () => {
    const manifest = farmManifest()
    // Relative to the manifest at <base>/farm/, so it holds for any instance base path.
    expect(manifest).toMatchObject({ id: './', start_url: './', scope: './', display: 'standalone' })
    expect(manifest.short_name).toBe('Farm')
  })

  it('points at icons the farm ships', () => {
    const manifest = farmManifest()
    expect(manifest.icons.map((icon) => icon.purpose)).toEqual(['any', 'any', 'maskable', 'maskable'])
    for (const icon of manifest.icons) {
      expect(icon.src).not.toStartWith('/')
      expect(existsSync(path.join(farmIcons, icon.src))).toBe(true)
    }
    expect(existsSync(path.join(farmIcons, 'apple-touch-icon.png'))).toBe(true)
  })

  it('is emitted beside index.html, which links it under the base path', async () => {
    const result = await build({
      root: import.meta.dir,
      configFile: false,
      logLevel: 'silent',
      base: '/ficus/farm/',
      plugins: [(await import('./pwa')).farmManifestPlugin()],
      build: { write: false, rollupOptions: { input: path.join(import.meta.dir, 'index.html') } },
    })
    const output = (Array.isArray(result) ? result[0] : result) as { output: { fileName: string; source?: unknown }[] }
    const files = new Map(output.output.map((file) => [file.fileName, file]))
    expect(JSON.parse(String(files.get(FARM_MANIFEST_FILE)?.source))).toEqual(farmManifest())
    expect(String(files.get('index.html')?.source)).toContain(
      `<link rel="manifest" href="/ficus/farm/${FARM_MANIFEST_FILE}">`
    )
  }, 60_000)
})
