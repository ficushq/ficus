import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// The app shell advertises a link-preview card whose absolute URLs the server
// fills in from __FICUS_ORIGIN__ (apps/core/src/lib/web-serve.ts). Pinned so a
// head rewrite cannot drop the card or hard-code one deployment's origin.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

function meta(attr: 'property' | 'name', key: string): string | undefined {
  return html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`))?.[1]
}

describe('social preview metadata', () => {
  test('carries the Open Graph and Twitter card against the origin placeholder', () => {
    expect(meta('property', 'og:image')).toBe('__FICUS_ORIGIN__/social-preview.png')
    expect(meta('property', 'og:url')).toBe('__FICUS_ORIGIN__/')
    expect(meta('property', 'og:image:width')).toBe('1280')
    expect(meta('property', 'og:image:height')).toBe('640')
    // Describes what the card (brand/social-preview.svg) actually says.
    expect(meta('property', 'og:image:alt')).toBe(
      'Ficus: Keep work moving while you’re away. Self-organizing agents that check in when they need you.'
    )
    expect(meta('property', 'og:title')).toBe('Ficus')
    expect(meta('name', 'twitter:card')).toBe('summary_large_image')
    expect(meta('name', 'twitter:image')).toBe('__FICUS_ORIGIN__/social-preview.png')
    expect(html).not.toMatch(/https?:\/\/[^"]*social-preview\.png/)
  })

  test('the image exists in public/ at exactly 1280×640', () => {
    const png = readFileSync(new URL('../public/social-preview.png', import.meta.url))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(1280)
    expect(png.readUInt32BE(20)).toBe(640)
  })
})
