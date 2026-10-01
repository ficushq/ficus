import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import sharp from 'sharp'
import { COLORS, generate, OUT_DIR } from './generate'

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out.sort()
}

function hex(color: string): [number, number, number] {
  const n = Number.parseInt(color.replace('#', ''), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

/**
 * Scans every pixel of a rendered PNG and returns the farthest "content"
 * pixel's distance from the canvas center, as a fraction of the canvas
 * diameter (`2 * maxRadius / width`) — the same measure a circular OS mask
 * or safe-zone spec cares about, computed straight from rendered pixels
 * rather than from the generator's own placement math.
 */
async function measureRadialDiameterFraction(
  path: string,
  isContentPixel: (r: number, g: number, b: number, a: number) => boolean
): Promise<number> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const cx = info.width / 2
  const cy = info.height / 2
  let maxRadiusSq = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * info.channels
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const a = data[idx + 3]
      if (!isContentPixel(r, g, b, a)) continue
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      const distSq = dx * dx + dy * dy
      if (distSq > maxRadiusSq) maxRadiusSq = distSq
    }
  }
  return (2 * Math.sqrt(maxRadiusSq)) / info.width
}

let tmpRoot: string
let tmpDir: string

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ficus-brand-generate-'))
  tmpDir = join(tmpRoot, 'first')
  await generate(tmpDir)
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('brand icon generator', () => {
  it('is byte-for-byte deterministic across fresh renders', async () => {
    const secondDir = join(tmpRoot, 'second')
    await generate(secondDir)

    const firstFiles = listFiles(tmpDir).map((f) => relative(tmpDir, f))
    expect(listFiles(secondDir).map((f) => relative(secondDir, f))).toEqual(firstFiles)
    for (const rel of firstFiles) {
      expect(readFileSync(join(secondDir, rel)).equals(readFileSync(join(tmpDir, rel)))).toBe(true)
    }
  })

  it('preserves every committed pixel and SVG without depending on PNG compression versions', async () => {
    const committedFiles = listFiles(OUT_DIR).map((f) => relative(OUT_DIR, f))
    expect(listFiles(tmpDir).map((f) => relative(tmpDir, f))).toEqual(committedFiles)

    // PNG encoders can produce different bytes for identical pixels after a
    // native-library upgrade. Keep the goldens, compare every decoded channel
    // exactly (no tolerance), and separately enforce same-runtime byte determinism.
    for (const rel of committedFiles) {
      const committed = join(OUT_DIR, rel)
      const fresh = join(tmpDir, rel)
      if (rel.endsWith('.png')) {
        const decode = (path: string) => sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const [expected, actual] = await Promise.all([decode(committed), decode(fresh)])
        expect(actual.info).toEqual(expected.info)
        if (!actual.data.equals(expected.data)) throw new Error(`${rel} has changed pixels`)
        const [expectedMetadata, actualMetadata] = await Promise.all([
          sharp(committed).metadata(),
          sharp(fresh).metadata(),
        ])
        // Preserve dimensions, alpha, palette, depth and color interpretation too.
        expect(actualMetadata).toEqual(expectedMetadata)
        expect(actualMetadata.isPalette).toBe(true)
      } else {
        expect(readFileSync(fresh).equals(readFileSync(committed))).toBe(true)
      }
    }
  })

  describe('expected dimensions', () => {
    const cases: Array<[string, number, number]> = [
      ['web/favicon-16x16.png', 16, 16],
      ['web/favicon-32x32.png', 32, 32],
      ['web/apple-touch-icon.png', 180, 180],
      ['web/icon-72x72.png', 72, 72],
      ['web/icon-96x96.png', 96, 96],
      ['web/icon-128x128.png', 128, 128],
      ['web/icon-144x144.png', 144, 144],
      ['web/icon-152x152.png', 152, 152],
      ['web/icon-192x192.png', 192, 192],
      ['web/icon-384x384.png', 384, 384],
      ['web/icon-512x512.png', 512, 512],
      ['web/icon-maskable-192x192.png', 192, 192],
      ['web/icon-maskable-512x512.png', 512, 512],
      ['web/shortcut-chat.png', 96, 96],
      ['web/shortcut-tasks.png', 96, 96],
      ['web/dark/favicon-16x16.png', 16, 16],
      ['web/dark/favicon-32x32.png', 32, 32],
      ['web/dark/apple-touch-icon.png', 180, 180],
      ['web/dark/icon-512x512.png', 512, 512],
      ['web/dark/icon-maskable-512x512.png', 512, 512],
      ['desktop/icon-1024.png', 1024, 1024],
      ['desktop/icon-1024-dark.png', 1024, 1024],
      ['mobile/icon.png', 1024, 1024],
      ['mobile/adaptive-icon.png', 1024, 1024],
      ['mobile/adaptive-background.png', 1024, 1024],
      ['mobile/splash-icon.png', 1024, 1024],
      ['mobile/notification-icon.png', 96, 96],
    ]

    for (const [rel, width, height] of cases) {
      it(`${rel} is ${width}x${height}`, async () => {
        const meta = await sharp(join(tmpDir, rel)).metadata()
        expect(meta.width).toBe(width)
        expect(meta.height).toBe(height)
      })
    }
  })

  it('web/favicon.svg and docs/favicon.svg match the ficus-favicon-16 source', () => {
    const webFavicon = readFileSync(join(tmpDir, 'web', 'favicon.svg'), 'utf8')
    const docsFavicon = readFileSync(join(tmpDir, 'docs', 'favicon.svg'), 'utf8')
    expect(docsFavicon).toBe(webFavicon)
    expect(webFavicon).toContain('viewBox="0 0 64 64"')
  })

  it('mobile/icon.png (iOS) has no alpha channel', async () => {
    const meta = await sharp(join(tmpDir, 'mobile', 'icon.png')).metadata()
    expect(meta.hasAlpha).toBe(false)
    expect(meta.channels).toBe(3)
  })

  it('web/apple-touch-icon.png has no alpha channel (no transparency)', async () => {
    const meta = await sharp(join(tmpDir, 'web', 'apple-touch-icon.png')).metadata()
    expect(meta.hasAlpha).toBe(false)
  })

  it('desktop/icon-1024.png keeps transparency outside the rounded tile', async () => {
    const meta = await sharp(join(tmpDir, 'desktop', 'icon-1024.png')).metadata()
    expect(meta.hasAlpha).toBe(true)
    const { data, info } = await sharp(join(tmpDir, 'desktop', 'icon-1024.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // The corner pixel must be fully transparent: it's outside the 824x824
    // rounded tile centered in the 1024 canvas.
    const idx = (0 * info.width + 0) * info.channels
    expect(data[idx + 3]).toBe(0)
  })

  it('mobile/notification-icon.png contains only pure white or fully-transparent pixels', async () => {
    const { data, info } = await sharp(join(tmpDir, 'mobile', 'notification-icon.png'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)

    let sawOpaquePixel = false
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (a === 0) continue
      sawOpaquePixel = true
      expect([r, g, b]).toEqual([255, 255, 255])
    }
    expect(sawOpaquePixel).toBe(true)
  })

  describe('circular safe zones: content stays within the platform circle, measured radially from rendered pixels', () => {
    it("mobile/adaptive-icon.png (Android foreground) stays under Android's 66.67% (72dp/108dp) safe-zone diameter", async () => {
      const fraction = await measureRadialDiameterFraction(
        join(tmpDir, 'mobile', 'adaptive-icon.png'),
        (_r, _g, _b, a) => a > 0
      )
      const pixelMargin = 2 / 1024 // a couple of px of antialiasing bleed beyond the exact vector edge
      // The real constraint is Android's hard limit; our own target (0.64)
      // keeps a deliberate margin under it.
      expect(fraction).toBeLessThan(72 / 108)
      expect(fraction).toBeLessThanOrEqual(0.64 + pixelMargin)
    })

    const maskableCases = [
      { rel: 'web/icon-maskable-192x192.png', background: COLORS.linen, size: 192 },
      { rel: 'web/icon-maskable-512x512.png', background: COLORS.linen, size: 512 },
      { rel: 'web/dark/icon-maskable-192x192.png', background: COLORS.soil, size: 192 },
      { rel: 'web/dark/icon-maskable-512x512.png', background: COLORS.soil, size: 512 },
    ] as const

    for (const { rel, background, size } of maskableCases) {
      it(`${rel} stays under the W3C 80% maskable safe-zone diameter`, async () => {
        const [br, bg, bb] = hex(background)
        const threshold = 6
        const fraction = await measureRadialDiameterFraction(
          join(tmpDir, rel),
          (r, g, b) =>
            !(Math.abs(r - br) <= threshold && Math.abs(g - bg) <= threshold && Math.abs(b - bb) <= threshold)
        )
        const pixelMargin = 2 / size
        expect(fraction).toBeLessThan(0.8)
        expect(fraction).toBeLessThanOrEqual(0.76 + pixelMargin)
      })
    }
  })
})
