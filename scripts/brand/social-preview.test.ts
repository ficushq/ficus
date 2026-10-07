import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSocialPreviewSvg,
  CARD_FILES,
  CARD_HEIGHT,
  CARD_WIDTH,
  EMBEDDED_FONTS,
  FONT_SUBSET_DIR,
  PUBLISHED_COPIES,
  REPO_ROOT,
} from './social-preview'

// These compare committed files only. Rendering the PNGs needs Chrome, which
// CI may not have; `bun run brand:social` regenerates everything checked here.

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel))

function pngSize(png: Buffer): [number, number] {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

describe('social preview card', () => {
  it('every published copy is byte-identical to brand/social-preview.png', () => {
    const card = read(CARD_FILES.light.png)
    for (const copy of PUBLISHED_COPIES) {
      if (!read(copy).equals(card)) {
        throw new Error(`${copy} differs from ${CARD_FILES.light.png}; run bun run brand:social`)
      }
    }
  })

  for (const variant of ['light', 'dark'] as const) {
    const files = CARD_FILES[variant]

    it(`${files.png} is ${CARD_WIDTH}x${CARD_HEIGHT}`, () => {
      expect(pngSize(read(files.png))).toEqual([CARD_WIDTH, CARD_HEIGHT])
    })

    it(`${files.svg} matches its template (no hand edits, no stale mark or fonts)`, async () => {
      const committed = read(files.svg).toString('utf8')
      if (committed !== (await buildSocialPreviewSvg(variant))) {
        throw new Error(`${files.svg} is stale; run bun run brand:social`)
      }
    })

    it(`${files.svg} embeds Fraunces and Instrument Sans as WOFF2`, () => {
      const svg = read(files.svg).toString('utf8')
      for (const font of EMBEDDED_FONTS) {
        const data = readFileSync(join(FONT_SUBSET_DIR, font.file)).toString('base64')
        expect(svg).toContain(`font-family: '${font.family}';`)
        expect(svg).toContain(`url(data:font/woff2;base64,${data})`)
      }
      expect(svg).toContain(`width="${CARD_WIDTH}" height="${CARD_HEIGHT}"`)
      // The card must not depend on fonts fetched at render time.
      expect(svg).not.toMatch(/url\((?!data:|#)/)
      expect(svg.length).toBeLessThan(600 * 1024)
    })
  }
})
