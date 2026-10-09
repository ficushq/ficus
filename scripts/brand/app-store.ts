/**
 * Ficus App Store promotional art generator.
 *
 * Builds the SVG sources in `brand/app-store/` from the templates below and
 * renders each to an opaque sRGB PNG in `brand/generated/app-store/` with
 * headless Chrome (playwright-core, `channel: 'chrome'`):
 *
 * - Product page header art, 5244×2950 and 3840×1646: the hero plant and the
 *   "ficus" wordmark as one centered lockup in a linen scene. No other text.
 * - Search result art, 3840×2560 and 1920×1280: the card's headline and
 *   supporting line beside an iPhone showing the Ficus mobile Feed.
 *
 * The phone screen is a capture of the interactive demo at ficus.sh/mobile/,
 * committed as `brand/app-store/feed-screen.png` so rendering works offline.
 *
 * Usage: bun run brand:app-store              (build the SVGs, render the PNGs)
 *        bun run brand:app-store --capture    (recapture the phone screen first)
 *        bun run brand:generate               (icons, cards, then this)
 *
 * Building the SVGs is pure and deterministic (see app-store.test.ts); only
 * rendering and capturing need Chrome.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { BRAND_DIR, balanceLines, fontFaces, HEADLINE, LEAF_PATH, REPO_ROOT, SUPPORTING_LINE } from './social-preview'

export const APP_STORE_SOURCE_DIR = join(BRAND_DIR, 'app-store')
export const APP_STORE_OUT_DIR = join(BRAND_DIR, 'generated', 'app-store')

/**
 * A real Ficus app screenshot of the Feed (iPhone 17 Pro Max simulator, 440×956 pt at 3x, seeded
 * demonstration data). It already includes the status bar and Dynamic Island.
 */
export const SCREEN_FILE = 'brand/app-store/feed-screen.png'
export const SCREEN_SIZE = { width: 440, height: 956, scale: 3 } as const
export const DEMO_URL = 'https://ficus.sh/mobile/'

export type ArtKind = 'header' | 'search'

export interface ArtSource {
  kind: ArtKind
  /** The SVG source, relative to the repo root. */
  svg: string
  width: number
  height: number
  /** Every PNG rendered from this source, relative to the repo root. */
  renders: Array<{ png: string; width: number; height: number }>
}

export const ART: readonly ArtSource[] = [
  {
    kind: 'header',
    svg: 'brand/app-store/header-5244x2950.svg',
    width: 5244,
    height: 2950,
    renders: [{ png: 'brand/generated/app-store/header-5244x2950.png', width: 5244, height: 2950 }],
  },
  {
    kind: 'header',
    svg: 'brand/app-store/header-3840x1646.svg',
    width: 3840,
    height: 1646,
    renders: [{ png: 'brand/generated/app-store/header-3840x1646.png', width: 3840, height: 1646 }],
  },
  {
    kind: 'search',
    svg: 'brand/app-store/search-3840x2560.svg',
    width: 3840,
    height: 2560,
    renders: [
      { png: 'brand/generated/app-store/search-3840x2560.png', width: 3840, height: 2560 },
      { png: 'brand/generated/app-store/search-1920x1280.png', width: 1920, height: 1280 },
    ],
  },
]

/** The font families each kind of art sets text in (and so embeds). */
export const ART_FONTS: Record<ArtKind, readonly string[]> = {
  header: ['Fraunces'],
  search: ['Fraunces', 'Instrument Sans'],
}

const C = {
  linen: '#f1e9db',
  linenLight: '#f6f1e7',
  paper: '#fbf7ef',
  soil: '#1c1a17',
  leaf: '#3f6b4f',
  moss: '#8a9a5b',
  stem: '#31533e',
  pot: '#b0582f',
  potLip: '#873f25',
  sage: '#9fb57f',
  glowSage: '#e1e5d2',
  glowClay: '#eddbc9',
  muted: '#53584c',
}

const num = (n: number) => Number(n.toFixed(2)).toString()

// ---------------------------------------------------------------------------
// The hero plant (ficus.sh `.grow-art`), drawn in its own units: stem at x 166,
// pot standing on y 316, top leaf tip near y 48. The pot body starts 0.75
// units up under the rim so the two shapes overlap, as in the card.
// ---------------------------------------------------------------------------

const HERO_STEM_X = 166
const HERO_GROUND_Y = 316

interface PlantOptions {
  /** Canvas x of the stem and y of the ground the pot stands on. */
  x: number
  groundY: number
  scale: number
  /** The sage sun behind the plant, in hero units. */
  sun?: { cx: number; cy: number; r: number }
}

function heroPlant({ x, groundY, scale, sun }: PlantOptions): string {
  const tx = x - HERO_STEM_X * scale
  const ty = groundY - HERO_GROUND_Y * scale
  const sunMarkup = sun ? `<circle cx="${sun.cx}" cy="${sun.cy}" r="${sun.r}" fill="url(#sun)"/>` : ''
  return `<g transform="translate(${num(tx)} ${num(ty)}) scale(${num(scale)})">
    ${sunMarkup}
    <ellipse cx="166" cy="316" rx="72" ry="7" fill="url(#pot-shadow)"/>
    <path d="M166 262 C165 230 168.5 186 167 138" fill="none" stroke="${C.stem}" stroke-width="3.5" stroke-linecap="round"/>
    <g transform="translate(165.6 220) rotate(-56)">
      <use href="#leaf" transform="scale(2.5 2.6)" fill="${C.moss}"/>
      <path class="rib" d="M0 -4 L0 -60"/>
    </g>
    <g transform="translate(167.2 182) rotate(54)">
      <use href="#leaf" transform="scale(2.4 2.5)" fill="${C.moss}"/>
      <path class="rib" d="M0 -4 L0 -57"/>
    </g>
    <g transform="translate(167 138) rotate(4)">
      <use href="#leaf" transform="scale(2.9 3)" fill="${C.leaf}"/>
      <path class="rib" d="M0 -4 L0 -70"/>
    </g>
    <rect x="121" y="249" width="90" height="16" rx="8" fill="${C.pot}"/>
    <path d="M127 264.25 H205 L197.6 312 Q197 316 193 316 H139 Q135 316 134.4 312 Z" fill="${C.pot}"/>
    <path d="M127 265 H205 L204.2 270 H127.8 Z" fill="${C.potLip}" fill-opacity="0.35"/>
  </g>`
}

/** A small two-leaf sprout standing on the ground at (x, groundY), `size` px tall. */
function sprout(x: number, groundY: number, size: number, opacity: number, lean: number): string {
  const s = size / 30
  return `<g transform="translate(${num(x)} ${num(groundY)})" opacity="${opacity}">
    <path d="M0 0 C${num(-0.06 * size)} ${num(-0.3 * size)} ${num(0.04 * size)} ${num(-0.55 * size)} ${num(lean * size * 0.1)} ${num(-0.62 * size)}" fill="none" stroke="${C.stem}" stroke-width="${num(0.05 * size)}" stroke-linecap="round"/>
    <use href="#leaf" transform="translate(0 ${num(-0.3 * size)}) rotate(${-58 + lean * 6}) scale(${num(s * 0.62)} ${num(s * 0.66)})" fill="${C.moss}"/>
    <use href="#leaf" transform="translate(${num(lean * size * 0.06)} ${num(-0.5 * size)}) rotate(${50 + lean * 6}) scale(${num(s * 0.55)} ${num(s * 0.6)})" fill="${C.moss}"/>
    <use href="#leaf" transform="translate(${num(lean * size * 0.1)} ${num(-0.6 * size)}) rotate(${4 + lean * 8}) scale(${num(s * 0.62)} ${num(s * 0.68)})" fill="${C.leaf}"/>
  </g>`
}

const SHARED_DEFS = `<radialGradient id="sun" cx="0.42" cy="0.4" r="0.62">
      <stop offset="0" stop-color="${C.sage}" stop-opacity="0.46"/>
      <stop offset="1" stop-color="${C.sage}" stop-opacity="0.34"/>
    </radialGradient>
    <radialGradient id="pot-shadow">
      <stop offset="0" stop-color="${C.soil}" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="${C.soil}" stop-opacity="0.1"/>
      <stop offset="1" stop-color="${C.soil}" stop-opacity="0"/>
    </radialGradient>
    <path id="leaf" d="${LEAF_PATH}"/>`

function svgOpen(width: number, height: number, label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
  <!-- Generated by scripts/brand/app-store.ts (bun run brand:app-store). Edit the template there, not this file. -->`
}

// ---------------------------------------------------------------------------
// Product page header. Laid out at a reference height of 2950 (the 5244×2950
// canvas) in a coordinate system centered on x = 0, then scaled to the
// canvas height, so every size keeps the lockup centered at the same size
// relative to its height; wider canvases only reveal more scene.
// ---------------------------------------------------------------------------

const HEADER_REF_HEIGHT = 2950
/** The horizon: the ground line the pot and the wordmark stand on. */
const HEADER_GROUND_Y = 2250
const HEADER_PLANT_SCALE = 4.3
/** The sun behind the plant, in hero units, centered on the stem. */
const HEADER_SUN = { cx: 166, cy: 176, r: 118 }
const WORDMARK_SIZE = 760
/** "ficus" advance at 1px: Chrome's measured width at 600 weight, opsz 56, -0.055em tracking. */
const WORDMARK_ADVANCE = 1.936
const WORDMARK_GAP = 40

/** Distant rolling hills along the horizon, lowest behind the lockup and rising toward the edges. */
function hills(
  halfWidth: number,
  groundY: number,
  layer: { base: number; rise: number; wave: number; phase: number }
): string {
  const step = layer.wave / 4
  const start = -Math.ceil((halfWidth + layer.wave) / step) * step
  const points: Array<[number, number]> = []
  for (let x = start; x <= halfWidth + layer.wave; x += step) {
    const edge = Math.min(1, Math.abs(x) / 2600)
    const amp = layer.base + layer.rise * edge * edge
    const y = groundY - amp * (0.55 + 0.45 * Math.sin((x / layer.wave) * Math.PI * 2 + layer.phase))
    points.push([x, y])
  }
  // A smooth curve through the samples: quadratic segments between midpoints.
  let d = `M${num(points[0][0])} ${groundY + 2} L${num(points[0][0])} ${num(points[0][1])}`
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i]
    const [nx, ny] = points[i + 1]
    d += ` Q${num(x)} ${num(y)} ${num((x + nx) / 2)} ${num((y + ny) / 2)}`
  }
  const last = points[points.length - 1]
  d += ` L${num(last[0])} ${num(last[1])} L${num(last[0])} ${groundY + 2} Z`
  return d
}

/** Sprouts along the ground, mirrored, kept clear of the lockup. */
const HEADER_SPROUTS: Array<{ x: number; size: number; opacity: number; lean: number }> = [
  { x: 1560, size: 132, opacity: 0.5, lean: 0.4 },
  { x: 1700, size: 78, opacity: 0.38, lean: -0.6 },
  { x: 2310, size: 104, opacity: 0.42, lean: 0.1 },
  { x: 2980, size: 120, opacity: 0.4, lean: -0.3 },
  { x: 3110, size: 70, opacity: 0.32, lean: 0.7 },
  { x: 3620, size: 96, opacity: 0.36, lean: -0.2 },
]

export async function buildHeaderSvg(width: number, height: number): Promise<string> {
  const k = height / HEADER_REF_HEIGHT
  const half = width / 2 / k
  const g = HEADER_GROUND_Y
  const sunDiameter = 2 * HEADER_SUN.r * HEADER_PLANT_SCALE
  const lockupWidth = sunDiameter + WORDMARK_GAP + WORDMARK_ADVANCE * WORDMARK_SIZE
  const stemX = -lockupWidth / 2 + sunDiameter / 2
  const wordX = -lockupWidth / 2 + sunDiameter + WORDMARK_GAP
  const sprouts = HEADER_SPROUTS.filter((s) => s.x < half + 200)
    .flatMap((s) => [sprout(s.x, g, s.size, s.opacity, s.lean), sprout(-s.x, g, s.size, s.opacity, -s.lean)])
    .join('\n    ')

  return `${svgOpen(width, height, 'ficus')}
  <!-- Embedded font: Fraunces, SIL Open Font License 1.1; see brand/fonts/. -->
  <style>
    ${await fontFaces(ART_FONTS.header)}
    .wordmark { font: 600 ${WORDMARK_SIZE}px 'Fraunces', Georgia, serif; letter-spacing: -0.055em; font-variation-settings: 'opsz' 56; }
    .rib { fill: none; stroke: ${C.linen}; stroke-width: 1.1; stroke-linecap: round; opacity: 0.3; }
  </style>
  <defs>
    ${SHARED_DEFS}
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.linenLight}"/>
      <stop offset="${num(g / HEADER_REF_HEIGHT)}" stop-color="${C.linen}"/>
      <stop offset="1" stop-color="#ebe0cd"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ede3d1"/>
      <stop offset="1" stop-color="#e6d9c3"/>
    </linearGradient>
    <radialGradient id="glow-sage" cx="0" cy="1550" r="1900" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.glowSage}"/>
      <stop offset="1" stop-color="${C.glowSage}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-clay" cx="0" cy="0" r="1" gradientTransform="translate(0 ${g}) scale(${num(Math.max(half, 2622) * 1.25)} 900)" gradientUnits="userSpaceOnUse">
      <stop offset="0.55" stop-color="${C.glowClay}" stop-opacity="0"/>
      <stop offset="1" stop-color="${C.glowClay}"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <g transform="translate(${num(width / 2)} 0) scale(${num(k)})">
    <rect x="${num(-half)}" y="0" width="${num(2 * half)}" height="${HEADER_REF_HEIGHT}" fill="url(#glow-clay)"/>
    <rect x="${num(-half)}" y="0" width="${num(2 * half)}" height="${HEADER_REF_HEIGHT}" fill="url(#glow-sage)"/>
    <path d="${hills(half, g, { base: 120, rise: 330, wave: 1700, phase: 0.6 })}" fill="#dfe3cb" fill-opacity="0.7"/>
    <path d="${hills(half, g, { base: 70, rise: 190, wave: 1050, phase: 2.1 })}" fill="#d2d9b8" fill-opacity="0.55"/>
    <rect x="${num(-half)}" y="${g}" width="${num(2 * half)}" height="${HEADER_REF_HEIGHT - g}" fill="url(#ground)"/>
    <path d="M${num(-half)} ${g} H${num(half)}" stroke="${C.soil}" stroke-opacity="0.2" stroke-width="7"/>
    ${sprouts}
    ${heroPlant({ x: stemX, groundY: g, scale: HEADER_PLANT_SCALE, sun: HEADER_SUN })}
    <text class="wordmark" x="${num(wordX)}" y="${g}" fill="${C.soil}">ficus</text>
  </g>
</svg>
`
}

// ---------------------------------------------------------------------------
// Search result art (3840×2560): the headline and supporting line on the left,
// an iPhone showing the Feed on the right, the plant beside it on the ground.
// ---------------------------------------------------------------------------

const SEARCH_W = 3840
const SEARCH_H = 2560
const SEARCH_MARGIN = 250
const SEARCH_HEADLINE_SIZE = 236
const SEARCH_HEADLINE_LEADING = 252
const SEARCH_SUPPORT_SIZE = 100
const SEARCH_SUPPORT_LEADING = 136
const SEARCH_GROUND_Y = 2290

/** The phone, in screen points (the 440×956 screenshot), scaled by PHONE_SCALE. */
const PHONE_SCALE = 2.157
const PHONE_BEZEL = 13
const PHONE_SCREEN_RADIUS = 62
const PHONE_X = 2590
const PHONE_Y = 190

function phone(screenDataUri: string): string {
  const s = PHONE_SCALE
  const sw = SCREEN_SIZE.width * s
  const sh = SCREEN_SIZE.height * s
  const b = PHONE_BEZEL * s
  const x = PHONE_X
  const y = PHONE_Y
  const bodyW = sw + 2 * b
  const bodyH = sh + 2 * b
  const bodyR = (PHONE_SCREEN_RADIUS + PHONE_BEZEL) * s
  const screenR = PHONE_SCREEN_RADIUS * s
  const sx = x + b
  const sy = y + b
  const home = { w: 140 * s, h: 5 * s, y: sy + sh - 9 * s }
  // Side buttons: action and volume on the left, power on the right.
  const button = (bx: number, by: number, h: number) =>
    `<rect x="${num(bx)}" y="${num(by)}" width="${num(3.2 * s)}" height="${num(h * s)}" rx="${num(1.6 * s)}" fill="#3a3732"/>`
  return `<g>
    <rect x="${num(x + 10)}" y="${num(y + 60)}" width="${num(bodyW - 20)}" height="${num(bodyH - 40)}" rx="${num(bodyR)}" fill="#3b2f20" fill-opacity="0.28" filter="url(#phone-shadow)"/>
    ${button(x - 2.4 * s, y + 118 * s, 30)}
    ${button(x - 2.4 * s, y + 170 * s, 58)}
    ${button(x - 2.4 * s, y + 240 * s, 58)}
    ${button(x + bodyW - 0.8 * s, y + 200 * s, 92)}
    <rect x="${num(x)}" y="${num(y)}" width="${num(bodyW)}" height="${num(bodyH)}" rx="${num(bodyR)}" fill="#2b2925"/>
    <rect x="${num(x + 1.4 * s)}" y="${num(y + 1.4 * s)}" width="${num(bodyW - 2.8 * s)}" height="${num(bodyH - 2.8 * s)}" rx="${num(bodyR - 1.4 * s)}" fill="#0d0c0b" stroke="#5a564e" stroke-width="${num(0.9 * s)}"/>
    <clipPath id="screen-clip"><rect x="${num(sx)}" y="${num(sy)}" width="${num(sw)}" height="${num(sh)}" rx="${num(screenR)}"/></clipPath>
    <image href="${screenDataUri}" x="${num(sx)}" y="${num(sy)}" width="${num(sw)}" height="${num(sh)}" preserveAspectRatio="none" clip-path="url(#screen-clip)"/>
    <rect x="${num(x + bodyW / 2 - home.w / 2)}" y="${num(home.y)}" width="${num(home.w)}" height="${num(home.h)}" rx="${num(home.h / 2)}" fill="#ede6de" fill-opacity="0.9"/>
  </g>`
}

export const SEARCH_ALT = `Ficus: ${HEADLINE.join(' ')} ${SUPPORTING_LINE} An iPhone shows the Ficus Feed.`

export async function buildSearchSvg(): Promise<string> {
  const screen = (await readFile(join(REPO_ROOT, SCREEN_FILE))).toString('base64')
  const support = balanceLines(SUPPORTING_LINE, 2)
  const headlineTop = 1010
  const supportTop = headlineTop + SEARCH_HEADLINE_LEADING + 210
  const phoneCenterX = PHONE_X + ((SCREEN_SIZE.width + 2 * PHONE_BEZEL) * PHONE_SCALE) / 2

  return `${svgOpen(SEARCH_W, SEARCH_H, SEARCH_ALT)}
  <!-- Embedded fonts: Fraunces and Instrument Sans, SIL Open Font License 1.1; see brand/fonts/. -->
  <!-- The phone screen is brand/app-store/feed-screen.png, a real Ficus app screenshot with seeded demonstration data. -->
  <style>
    ${await fontFaces(ART_FONTS.search)}
    .headline { font: 600 ${SEARCH_HEADLINE_SIZE}px 'Fraunces', Georgia, serif; letter-spacing: -0.02em; font-variation-settings: 'opsz' 88; }
    .support { font: 400 ${SEARCH_SUPPORT_SIZE}px 'Instrument Sans', Arial, sans-serif; }
    .rib { fill: none; stroke: ${C.linen}; stroke-width: 1.1; stroke-linecap: round; opacity: 0.3; }
  </style>
  <defs>
    ${SHARED_DEFS}
    <radialGradient id="glow-sage" cx="3650" cy="60" r="1900" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.glowSage}"/>
      <stop offset="1" stop-color="${C.glowSage}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-clay" cx="40" cy="560" r="1600" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${C.glowClay}"/>
      <stop offset="1" stop-color="${C.glowClay}" stop-opacity="0"/>
    </radialGradient>
    <filter id="phone-shadow" x="-30%" y="-20%" width="160%" height="140%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
  </defs>
  <rect width="${SEARCH_W}" height="${SEARCH_H}" fill="${C.linen}"/>
  <rect width="${SEARCH_W}" height="${SEARCH_H}" fill="url(#glow-sage)"/>
  <rect width="${SEARCH_W}" height="${SEARCH_H}" fill="url(#glow-clay)"/>
  <circle cx="${num(phoneCenterX + 120)}" cy="1000" r="820" fill="url(#sun)"/>
  <path d="M${SEARCH_MARGIN} ${SEARCH_GROUND_Y} H${SEARCH_W - SEARCH_MARGIN}" stroke="${C.soil}" stroke-opacity="0.2" stroke-width="6"/>
  ${heroPlant({ x: PHONE_X - 150, groundY: SEARCH_GROUND_Y, scale: 2.7 })}
  ${phone(`data:image/png;base64,${screen}`)}
  <text class="headline" x="${SEARCH_MARGIN - 10}" y="${headlineTop}" fill="${C.soil}">${HEADLINE[0]}</text>
  <text class="headline" x="${SEARCH_MARGIN - 10}" y="${headlineTop + SEARCH_HEADLINE_LEADING}" fill="${C.leaf}">${HEADLINE[1]}</text>
  ${support
    .map(
      (line, i) =>
        `<text class="support" x="${SEARCH_MARGIN}" y="${supportTop + i * SEARCH_SUPPORT_LEADING}" fill="${C.muted}">${line}</text>`
    )
    .join('\n  ')}
</svg>
`
}

export async function buildArtSvg(source: ArtSource): Promise<string> {
  return source.kind === 'header' ? buildHeaderSvg(source.width, source.height) : buildSearchSvg()
}

// ---------------------------------------------------------------------------
// Chrome: capture the demo screen, render the art.
// ---------------------------------------------------------------------------

/**
 * Captures the ficus.sh/mobile/ demo's Feed (its default view: "Needs
 * attention" with a question and a "Review needed" card) at the SCREEN_SIZE viewport,
 * 3x, with the demo's own bezel, shadow and zoom removed so the art can draw
 * its phone around it. The status bar is padded to sit beside the Dynamic
 * Island the art draws on top.
 */
export async function captureScreen(out: string = join(REPO_ROOT, SCREEN_FILE)): Promise<void> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: SCREEN_SIZE.scale,
      colorScheme: 'light',
    })
    await page.goto(DEMO_URL, { waitUntil: 'networkidle' })
    await page.locator('.mobile-phone-preview.demo-ready').waitFor()
    // Make sure the Feed is showing.
    await page.locator('.mobile-preview-bottom [data-demo-action="feed"]').click()
    await page.locator('#mobile-demo-screen[data-screen="feed"]').waitFor()
    await page.addStyleTag({
      content: `
        .mobile-phone-preview.demo-ready {
          position: fixed !important; left: 0 !important; top: 0 !important; z-index: 2147483647 !important;
          zoom: 1 !important; margin: 0 !important; box-sizing: border-box !important;
          width: ${SCREEN_SIZE.width}px !important; max-width: none !important;
          height: ${SCREEN_SIZE.height}px !important; aspect-ratio: auto !important;
          border: 0 !important; border-radius: 0 !important; box-shadow: none !important;
          padding: 14px 16px 30px !important;
        }
        .demo-ready .mobile-preview-status { min-height: 40px; padding: 0 30px 0 34px !important; font-size: 16px !important; }
        .demo-ready .mobile-preview-status svg { transform: scale(1.25); transform-origin: right center; }
        .mobile-demo-screen { scrollbar-width: none !important; }
      `,
    })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    const shot = await page.screenshot({
      clip: { x: 0, y: 0, width: SCREEN_SIZE.width, height: SCREEN_SIZE.height },
      animations: 'disabled',
    })
    const png = await sharp(shot)
      .removeAlpha()
      .toColorspace('srgb')
      .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
      .toBuffer()
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, png)
  } finally {
    await browser.close()
  }
}

/**
 * Makes the phone screen PNG at `path` opaque, in place. Simulator screenshots carry an alpha
 * channel even though every pixel is opaque, and App Store art must be opaque, so the channel is
 * dropped and the file re-tagged sRGB; the visible pixels are unchanged. A screen with any
 * translucent pixel is refused rather than guessed onto a background. Returns whether the file
 * was rewritten (a screen that is already opaque is left byte for byte).
 */
export async function makeScreenOpaque(path: string): Promise<boolean> {
  const input = await readFile(path)
  if (!(await sharp(input).metadata()).hasAlpha) return false
  const alpha = (await sharp(input).stats()).channels.at(-1)!
  if (alpha.min < 255) {
    throw new Error(`${path} has translucent pixels; export the screenshot without transparency`)
  }
  const png = await sharp(input)
    .removeAlpha()
    .withIccProfile('srgb')
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toBuffer()
  await writeFile(path, png)
  return true
}

/** Renders each SVG at each of its sizes to an opaque sRGB PNG, once its embedded fonts load. */
async function renderPngs(
  jobs: Array<{ svg: string; families: readonly string[]; out: string; width: number; height: number }>
) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    for (const { svg, families, out, width, height } of jobs) {
      await page.setViewportSize({ width, height })
      // Inline the SVG so its @font-face rules join the document and
      // document.fonts.ready waits for them. Sizing the <svg> scales its
      // viewBox, so one source renders at several sizes.
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}svg{display:block;width:${width}px;height:${height}px}</style></head><body>${svg}</body></html>`
      )
      const loaded = await page.evaluate(async (wanted) => {
        await document.fonts.ready
        await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
        return wanted.filter((family) =>
          [...document.fonts].some((face) => face.family.replace(/['"]/g, '') === family && face.status === 'loaded')
        )
      }, families as string[])
      if (loaded.length !== families.length) {
        throw new Error(`${out}: embedded fonts did not load (loaded: ${loaded.join(', ') || 'none'})`)
      }
      // Give the embedded screen image a frame to decode and paint.
      await page.waitForTimeout(300)
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width, height } })
      const png = await sharp(shot)
        .removeAlpha()
        .toColorspace('srgb')
        .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
        .toBuffer()
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, png)
    }
  } finally {
    await browser.close()
  }
}

/** Writes every App Store SVG source and renders its PNGs. */
export async function generateAppStoreArt(root: string = REPO_ROOT, opts: { capture?: boolean } = {}): Promise<void> {
  if (opts.capture) await captureScreen(join(root, SCREEN_FILE))
  await makeScreenOpaque(join(root, SCREEN_FILE))
  const jobs: Parameters<typeof renderPngs>[0] = []
  for (const source of ART) {
    const svg = await buildArtSvg(source)
    await mkdir(dirname(join(root, source.svg)), { recursive: true })
    await writeFile(join(root, source.svg), svg)
    for (const render of source.renders) {
      jobs.push({ svg, families: ART_FONTS[source.kind], out: join(root, render.png), ...render })
    }
  }
  await renderPngs(jobs)
  console.log('Ficus App Store art generated:', ART.flatMap((a) => a.renders.map((r) => r.png)).join(', '))
}

if (import.meta.main) {
  generateAppStoreArt(REPO_ROOT, { capture: process.argv.includes('--capture') }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
