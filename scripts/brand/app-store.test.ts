import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ART, ART_FONTS, buildArtSvg, makeScreenOpaque, SCREEN_FILE, SCREEN_SIZE } from './app-store'
import { EMBEDDED_FONTS, FONT_SUBSET_DIR, HEADLINE, REPO_ROOT, SUPPORTING_LINE } from './social-preview'

// These compare committed files only. Rendering needs Chrome, which CI may not
// have; `bun run brand:app-store` regenerates everything checked here.

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel))

/** Every <text> element's content, in document order. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
}

describe('App Store art', () => {
  for (const source of ART) {
    for (const render of source.renders) {
      it(`${render.png} is an opaque sRGB ${render.width}x${render.height} PNG`, async () => {
        const png = read(render.png)
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
        // IHDR: exact size, 8-bit truecolor RGB (color type 2), so no alpha and no palette.
        expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([render.width, render.height])
        expect(png[24]).toBe(8)
        expect(png[25]).toBe(2)
        const meta = await sharp(png).metadata()
        expect(meta.channels).toBe(3)
        expect(meta.hasAlpha).toBe(false)
        expect(meta.space).toBe('srgb')
        // No tRNS chunk sneaking transparency back in.
        expect(png.includes(Buffer.from('tRNS'))).toBe(false)
      })
    }

    it(`${source.svg} matches its template (no hand edits, no stale fonts, copy or screen)`, async () => {
      const committed = read(source.svg).toString('utf8')
      if (committed !== (await buildArtSvg(source))) {
        throw new Error(`${source.svg} is stale; run bun run brand:app-store`)
      }
    })

    it(`${source.svg} embeds its fonts as WOFF2 and loads nothing from the network`, () => {
      const svg = read(source.svg).toString('utf8')
      expect(svg).toContain(`width="${source.width}" height="${source.height}"`)
      for (const font of EMBEDDED_FONTS) {
        const data = readFileSync(join(FONT_SUBSET_DIR, font.file)).toString('base64')
        const wanted = ART_FONTS[source.kind].includes(font.family)
        expect(svg.includes(`font-family: '${font.family}';`)).toBe(wanted)
        expect(svg.includes(`url(data:font/woff2;base64,${data})`)).toBe(wanted)
      }
      expect(svg).not.toMatch(/url\((?!data:|#)/)
      expect(svg).not.toMatch(/href="(?!data:|#)/)
    })

    it(`${source.svg} carries no URLs or prices (App Store art rules)`, () => {
      for (const text of texts(read(source.svg).toString('utf8'))) {
        expect(text).not.toMatch(/https?:|www\.|\.(sh|com|app|io|dev)\b|[$€£¥]|\bfree\b/i)
      }
    })
  }

  it('the header art is the wordmark alone: no taglines', () => {
    for (const source of ART.filter((a) => a.kind === 'header')) {
      expect(texts(read(source.svg).toString('utf8'))).toEqual(['ficus'])
    }
  })

  it('the search art sets the shared headline and supporting line', () => {
    const search = ART.find((a) => a.kind === 'search')!
    const words = texts(read(search.svg).toString('utf8')).join(' ')
    expect(words).toBe(`${HEADLINE.join(' ')} ${SUPPORTING_LINE}`)
  })

  it('the search art embeds the committed phone screen', async () => {
    const screen = read(SCREEN_FILE)
    const meta = await sharp(screen).metadata()
    expect([meta.width, meta.height]).toEqual([
      SCREEN_SIZE.width * SCREEN_SIZE.scale,
      SCREEN_SIZE.height * SCREEN_SIZE.scale,
    ])
    expect(meta.hasAlpha).toBe(false)
    const search = ART.find((a) => a.kind === 'search')!
    expect(read(search.svg).toString('utf8')).toContain(`data:image/png;base64,${screen.toString('base64')}`)
  })
})

describe('makeScreenOpaque', () => {
  // A 2x2 screen in the app's dark background with one leaf-green pixel.
  const pixels = (alpha: number) => Buffer.from([28, 26, 23, 255, 63, 107, 79, 255, 28, 26, 23, 255, 28, 26, 23, alpha])
  const png = (alpha: number) =>
    sharp(pixels(alpha), { raw: { width: 2, height: 2, channels: 4 } })
      .png()
      .toBuffer()
  const rgb = async (file: string) => (await sharp(file).removeAlpha().raw().toBuffer()).toString('hex')

  let dir = ''
  const fixture = async (name: string, data: Buffer | Promise<Buffer>) => {
    dir ||= mkdtempSync(join(tmpdir(), 'ficus-brand-screen-'))
    const file = join(dir, name)
    writeFileSync(file, await data)
    return file
  }
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('drops a fully opaque alpha channel, keeping every visible pixel', async () => {
    const file = await fixture('opaque-alpha.png', png(255))
    const before = await rgb(file)
    expect(await makeScreenOpaque(file)).toBe(true)
    const meta = await sharp(file).metadata()
    expect([meta.width, meta.height, meta.channels, meta.hasAlpha, meta.space]).toEqual([2, 2, 3, false, 'srgb'])
    expect(await rgb(file)).toBe(before)
  })

  it('leaves an already opaque screen byte for byte', async () => {
    const opaque = await sharp(await png(255))
      .removeAlpha()
      .png()
      .toBuffer()
    const file = await fixture('opaque.png', opaque)
    expect(await makeScreenOpaque(file)).toBe(false)
    expect(readFileSync(file).equals(opaque)).toBe(true)
  })

  it('refuses a screen with translucent pixels', async () => {
    const file = await fixture('translucent.png', png(128))
    const before = readFileSync(file)
    await expect(makeScreenOpaque(file)).rejects.toThrow(/translucent pixels/)
    expect(readFileSync(file).equals(before)).toBe(true)
  })
})
