/**
 * Ficus social preview card generator.
 *
 * Builds `brand/social-preview.svg` (light, the published card) and
 * `brand/social-preview-dark.svg` from the template below, embedding the
 * committed font subsets in `brand/fonts/subset/` and the mark from
 * `brand/ficus-mark{,-dark}.svg`, then renders each to a 1280×640 PNG in
 * headless Chrome (playwright-core, `channel: 'chrome'`) and writes every
 * published copy of the light PNG.
 *
 * Usage: bun run brand:social      (just the card)
 *        bun run brand:generate    (icons, then the card)
 *
 * Building the SVGs is pure and deterministic (see social-preview.test.ts);
 * only the PNG step needs Chrome.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

export const REPO_ROOT = join(import.meta.dir, '..', '..')
export const BRAND_DIR = join(REPO_ROOT, 'brand')
export const FONT_SUBSET_DIR = join(BRAND_DIR, 'fonts', 'subset')

export const CARD_WIDTH = 1280
export const CARD_HEIGHT = 640

export type CardVariant = 'light' | 'dark'

/** The card each variant's SVG and PNG are written to, relative to the repo root. */
export const CARD_FILES: Record<CardVariant, { svg: string; png: string }> = {
  light: { svg: 'brand/social-preview.svg', png: 'brand/social-preview.png' },
  dark: { svg: 'brand/social-preview-dark.svg', png: 'brand/social-preview-dark.png' },
}

/**
 * Byte-for-byte copies of the light PNG that other places publish. Platform's
 * `apps/platform/web/public/social-preview.{png,svg}` (private repo) is copied
 * from `brand/` by hand; see brand/README.md.
 */
export const PUBLISHED_COPIES = ['.github/social-preview.png', 'apps/web/public/social-preview.png'] as const

export const HEADLINE = ['Keep work moving', 'while you’re away.'] as const
/**
 * The supporting line under the headline, shared by every generated piece of
 * art that carries it (this card and the App Store search art in
 * app-store.ts). Edit it here; `bun run brand:generate` re-renders them all.
 */
export const SUPPORTING_LINE = 'Self-organizing agents that check in when they need you.'
export const CARD_ALT = `Ficus: ${HEADLINE.join(' ')} ${SUPPORTING_LINE}`

/** The embedded font subsets: built by scripts/brand/subset-fonts.sh from brand/fonts/. */
export const EMBEDDED_FONTS = [
  { family: 'Fraunces', file: 'fraunces.woff2', weight: '600' },
  { family: 'Instrument Sans', file: 'instrument-sans.woff2', weight: '400 700' },
] as const

interface Palette {
  background: string
  /** Top-right and left glows over the background, after the site's hero backdrop. */
  glowSage: string
  glowClay: string
  ink: string
  green: string
  muted: string
  url: string
  rule: string
  ruleOpacity: number
  sun: string
  sunOpacity: [number, number]
  shadow: string
  moss: string
  leaf: string
  stem: string
  pot: string
  potLip: string
  potLipOpacity: number
  rib: string
  leader: string
  leaderOpacity: number
  anchorFill: string
  chipFill: string
  chipStroke: string
  chipText: string
  check: string
  ping: string
  pingText: string
}

const PALETTES: Record<CardVariant, Palette> = {
  light: {
    background: '#f1e9db',
    glowSage: '#e1e5d2',
    glowClay: '#eddbc9',
    ink: '#1c1a17',
    green: '#3f6b4f',
    muted: '#53584c',
    url: '#3f6b4f',
    rule: '#1c1a17',
    ruleOpacity: 0.2,
    sun: '#9fb57f',
    sunOpacity: [0.46, 0.34],
    shadow: '#1c1a17',
    moss: '#8a9a5b',
    leaf: '#3f6b4f',
    stem: '#31533e',
    pot: '#b0582f',
    potLip: '#873f25',
    potLipOpacity: 0.35,
    rib: '#f1e9db',
    leader: '#1c1a17',
    leaderOpacity: 0.4,
    anchorFill: '#fbf7ef',
    chipFill: '#fbf7ef',
    chipStroke: '#d4cabc',
    chipText: '#1c1a17',
    check: '#3f6b4f',
    ping: '#b0582f',
    pingText: '#fbf7ef',
  },
  dark: {
    background: '#1c1a17',
    glowSage: '#272a21',
    glowClay: '#29221c',
    ink: '#f1e9db',
    green: '#9fb57f',
    muted: '#bfb9b2',
    url: '#9fb57f',
    rule: '#f1e9db',
    ruleOpacity: 0.2,
    sun: '#9fb57f',
    sunOpacity: [0.2, 0.13],
    shadow: '#000000',
    moss: '#87945a',
    leaf: '#5e7f4e',
    stem: '#4f6d43',
    pot: '#c46a3c',
    potLip: '#6e3219',
    potLipOpacity: 0.35,
    rib: '#f1e9db',
    leader: '#f1e9db',
    leaderOpacity: 0.42,
    anchorFill: '#2b2825',
    chipFill: '#2b2825',
    chipStroke: '#46433f',
    chipText: '#f1e9db',
    check: '#9fb57f',
    ping: '#c46a3c',
    pingText: '#fbf7ef',
  },
}

// ---------------------------------------------------------------------------
// Layout (card px). The plant is the ficus.sh hero illustration, drawn in its
// own units and placed with PLANT_SCALE so the pot stands on the ground rule.
// ---------------------------------------------------------------------------

const MARGIN_X = 80
const GROUND_Y = 548
const PLANT_SCALE = 1.5
/** Card x of the plant's stem (hero x 166). */
const PLANT_X = 838
const HERO_STEM_X = 166
const HERO_GROUND_Y = 316

/** Maps a point in the hero illustration's units to card px. */
function plantPoint(x: number, y: number): [number, number] {
  return [PLANT_X + (x - HERO_STEM_X) * PLANT_SCALE, GROUND_Y - (HERO_GROUND_Y - y) * PLANT_SCALE]
}

/** Baseline-to-baseline distance of the two supporting lines (30px type). */
const SUPPORT_LEADING = 40

const CHIP_HEIGHT = 52
/** Chip widths fit their 24px Instrument Sans 600 labels (checked against Chrome renders). */
const CHECKS_CHIP_WIDTH = 248
const READY_CHIP_WIDTH = 320

const num = (n: number) => Number(n.toFixed(2)).toString()

/**
 * Splits copy into `count` lines at word breaks, choosing the breaks that keep
 * the longest line shortest (by character count), so wrapped copy stays
 * balanced whatever the wording.
 */
export function balanceLines(text: string, count: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (count <= 1 || words.length <= 1) return [words.join(' ')]
  let best: string[] = [words.join(' ')]
  let bestLongest = Number.POSITIVE_INFINITY
  for (let i = 1; i < words.length; i++) {
    const rest = balanceLines(words.slice(i).join(' '), count - 1)
    const lines = [words.slice(0, i).join(' '), ...rest]
    const longest = Math.max(...lines.map((line) => line.length))
    if (longest < bestLongest) {
      best = lines
      bestLongest = longest
    }
  }
  return best
}

function innerMarkup(svg: string): string {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
  if (!match) throw new Error('source SVG did not match the expected <svg>...</svg> shape')
  return match[1].trim()
}

async function fontFaces(): Promise<string> {
  const faces: string[] = []
  for (const font of EMBEDDED_FONTS) {
    const data = (await readFile(join(FONT_SUBSET_DIR, font.file))).toString('base64')
    faces.push(
      `@font-face { font-family: '${font.family}'; font-style: normal; font-weight: ${font.weight}; ` +
        `src: url(data:font/woff2;base64,${data}) format('woff2'); }`
    )
  }
  return faces.join('\n    ')
}

const LEAF_PATH =
  'M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z'

function plant(p: Palette): string {
  const tx = PLANT_X - HERO_STEM_X * PLANT_SCALE
  const ty = GROUND_Y - HERO_GROUND_Y * PLANT_SCALE
  // Hero geometry (ficus.sh `.grow-art`), less its animation, "Plan ready" and
  // caption. The pot body starts 0.75 units up under the rim so the two
  // shapes overlap instead of meeting on an antialiased hairline.
  return `<g transform="translate(${num(tx)} ${num(ty)}) scale(${PLANT_SCALE})">
    <circle cx="262" cy="140" r="112" fill="url(#sun)"/>
    <ellipse cx="166" cy="316" rx="72" ry="7" fill="url(#pot-shadow)"/>
    <path d="M166 262 C165 230 168.5 186 167 138" fill="none" stroke="${p.stem}" stroke-width="3.5" stroke-linecap="round"/>
    <g transform="translate(165.6 220) rotate(-56)">
      <use href="#leaf" transform="scale(2.5 2.6)" fill="${p.moss}"/>
      <path class="rib" d="M0 -4 L0 -60"/>
    </g>
    <g transform="translate(167.2 182) rotate(54)">
      <use href="#leaf" transform="scale(2.4 2.5)" fill="${p.moss}"/>
      <path class="rib" d="M0 -4 L0 -57"/>
    </g>
    <g transform="translate(167 138) rotate(4)">
      <use href="#leaf" transform="scale(2.9 3)" fill="${p.leaf}"/>
      <path class="rib" d="M0 -4 L0 -70"/>
    </g>
    <rect x="121" y="249" width="90" height="16" rx="8" fill="${p.pot}"/>
    <path d="M127 264.25 H205 L197.6 312 Q197 316 193 316 H139 Q135 316 134.4 312 Z" fill="${p.pot}"/>
    <path d="M127 265 H205 L204.2 270 H127.8 Z" fill="${p.potLip}" fill-opacity="${p.potLipOpacity}"/>
  </g>`
}

function chips(p: Palette): string {
  // "Checks passed" hangs off the right leaf's tip on a short horizontal leader.
  const [checksAx, checksAy] = plantPoint(228.4, 138.1)
  const checksX = checksAx + 20
  const checksY = checksAy - CHIP_HEIGHT / 2
  // "Ready for your review" sits above the top leaf's tip on a vertical leader.
  const [readyAx, readyAy] = plantPoint(173.3, 48.2)
  const readyY = readyAy - 28 - CHIP_HEIGHT
  const readyX = readyAx - 38
  const midY = (y: number) => y + CHIP_HEIGHT / 2
  return `<g class="leader">
    <path d="M${num(checksAx + 5)} ${num(checksAy)} H${num(checksX)}"/>
    <path d="M${num(readyAx)} ${num(readyAy - 5)} V${num(readyY + CHIP_HEIGHT)}"/>
    <circle cx="${num(checksAx)}" cy="${num(checksAy)}" r="5" fill="${p.anchorFill}"/>
    <circle cx="${num(readyAx)}" cy="${num(readyAy)}" r="5" fill="${p.anchorFill}"/>
  </g>
  <g>
    <rect x="${num(checksX)}" y="${num(checksY + 3)}" width="${CHECKS_CHIP_WIDTH}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}" fill="#000000" fill-opacity="0.07"/>
    <rect x="${num(checksX)}" y="${num(checksY)}" width="${CHECKS_CHIP_WIDTH}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}" fill="${p.chipFill}" stroke="${p.chipStroke}" stroke-width="2"/>
    <path d="M${num(checksX + 22)} ${num(midY(checksY) + 0.5)} l6.5 6.5 l12.5 -13.5" fill="none" stroke="${p.check}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text class="chip" x="${num(checksX + 54)}" y="${num(midY(checksY) + 8.5)}" fill="${p.chipText}">Checks passed</text>
  </g>
  <g>
    <rect x="${num(readyX)}" y="${num(readyY + 3)}" width="${READY_CHIP_WIDTH}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}" fill="#000000" fill-opacity="0.07"/>
    <rect x="${num(readyX)}" y="${num(readyY)}" width="${READY_CHIP_WIDTH}" height="${CHIP_HEIGHT}" rx="${CHIP_HEIGHT / 2}" fill="${p.ping}"/>
    <circle cx="${num(readyX + 30)}" cy="${num(midY(readyY))}" r="11" fill="${p.pingText}" fill-opacity="0.28"/>
    <circle cx="${num(readyX + 30)}" cy="${num(midY(readyY))}" r="5.5" fill="${p.pingText}"/>
    <text class="chip" x="${num(readyX + 54)}" y="${num(midY(readyY) + 8.5)}" fill="${p.pingText}">Ready for your review</text>
  </g>`
}

/** The supporting line, wrapped to two balanced lines so it clears the pot. */
function supportingLines(p: Palette): string {
  return balanceLines(SUPPORTING_LINE, 2)
    .map(
      (line, i) =>
        `<text class="support" x="${MARGIN_X}" y="${442 + i * SUPPORT_LEADING}" fill="${p.muted}">${line}</text>`
    )
    .join('\n  ')
}

/** Builds one variant's card SVG. Pure: the same inputs always give the same bytes. */
export async function buildSocialPreviewSvg(variant: CardVariant): Promise<string> {
  const p = PALETTES[variant]
  const markFile = variant === 'light' ? 'ficus-mark.svg' : 'ficus-mark-dark.svg'
  const mark = innerMarkup(await readFile(join(BRAND_DIR, markFile), 'utf8'))
  const faces = await fontFaces()

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" aria-label="${CARD_ALT}">
  <!-- Generated by scripts/brand/social-preview.ts (bun run brand:social). Edit the template there, not this file. -->
  <!-- Embedded fonts: Fraunces and Instrument Sans, SIL Open Font License 1.1; see brand/fonts/. -->
  <style>
    ${faces}
    .wordmark { font: 600 56px 'Fraunces', Georgia, serif; letter-spacing: -0.055em; }
    .headline { font: 600 88px 'Fraunces', Georgia, serif; letter-spacing: -0.02em; }
    .support { font: 400 30px 'Instrument Sans', Arial, sans-serif; }
    .chip { font: 600 24px 'Instrument Sans', Arial, sans-serif; }
    .url { font: 700 26px 'Instrument Sans', Arial, sans-serif; }
    .rib { fill: none; stroke: ${p.rib}; stroke-width: 1.1; stroke-linecap: round; opacity: 0.3; }
    .leader { fill: none; stroke: ${p.leader}; stroke-opacity: ${p.leaderOpacity}; stroke-width: 2; }
  </style>
  <defs>
    <radialGradient id="glow-sage" cx="1216" cy="19" r="560" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${p.glowSage}"/>
      <stop offset="1" stop-color="${p.glowSage}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-clay" cx="13" cy="147" r="460" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${p.glowClay}"/>
      <stop offset="1" stop-color="${p.glowClay}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sun" cx="0.42" cy="0.4" r="0.62">
      <stop offset="0" stop-color="${p.sun}" stop-opacity="${p.sunOpacity[0]}"/>
      <stop offset="1" stop-color="${p.sun}" stop-opacity="${p.sunOpacity[1]}"/>
    </radialGradient>
    <radialGradient id="pot-shadow">
      <stop offset="0" stop-color="${p.shadow}" stop-opacity="0.26"/>
      <stop offset="0.55" stop-color="${p.shadow}" stop-opacity="0.1"/>
      <stop offset="1" stop-color="${p.shadow}" stop-opacity="0"/>
    </radialGradient>
    <path id="leaf" d="${LEAF_PATH}"/>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${p.background}"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-sage)"/>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow-clay)"/>
  <g transform="translate(${MARGIN_X - 13} 56)">
    ${mark}
  </g>
  <text class="wordmark" x="${MARGIN_X + 56}" y="111" fill="${p.ink}">ficus</text>
  <text class="headline" x="${MARGIN_X - 4}" y="276" fill="${p.ink}">${HEADLINE[0]}</text>
  <text class="headline" x="${MARGIN_X - 4}" y="370" fill="${p.green}">${HEADLINE[1]}</text>
  ${supportingLines(p)}
  ${plant(p)}
  <path d="M${MARGIN_X} ${GROUND_Y} H${CARD_WIDTH - MARGIN_X}" stroke="${p.rule}" stroke-opacity="${p.ruleOpacity}" stroke-width="2"/>
  ${chips(p)}
  <text class="url" x="${MARGIN_X}" y="602" fill="${p.url}">ficus.sh</text>
</svg>
`
}

/** Renders card SVGs to 1280×640 PNGs in headless Chrome once their fonts are ready. */
async function renderPngs(jobs: Array<{ svg: string; out: string }>): Promise<void> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await browser.newPage({
      viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
      deviceScaleFactor: 1,
    })
    for (const { svg, out } of jobs) {
      // Inline the SVG so its @font-face rules join the document and
      // document.fonts.ready waits for them.
      await page.setContent(
        `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`
      )
      const loaded = await page.evaluate(async () => {
        await document.fonts.ready
        const families = ['Fraunces', 'Instrument Sans']
        return families.filter((family) =>
          [...document.fonts].some((face) => face.family.replace(/['"]/g, '') === family && face.status === 'loaded')
        )
      })
      if (loaded.length !== EMBEDDED_FONTS.length) {
        throw new Error(`${out}: embedded fonts did not load (loaded: ${loaded.join(', ') || 'none'})`)
      }
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT } })
      const png = await sharp(shot).png({ compressionLevel: 9, effort: 10 }).toBuffer()
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, png)
    }
  } finally {
    await browser.close()
  }
}

/** Writes both card SVGs, renders their PNGs and refreshes every published copy. */
export async function generateSocialPreviews(root: string = REPO_ROOT): Promise<void> {
  const jobs: Array<{ svg: string; out: string }> = []
  for (const variant of ['light', 'dark'] as const) {
    const svg = await buildSocialPreviewSvg(variant)
    await writeFile(join(root, CARD_FILES[variant].svg), svg)
    jobs.push({ svg, out: join(root, CARD_FILES[variant].png) })
  }
  await renderPngs(jobs)
  for (const copy of PUBLISHED_COPIES) {
    await mkdir(dirname(join(root, copy)), { recursive: true })
    await copyFile(join(root, CARD_FILES.light.png), join(root, copy))
  }
  console.log(
    'Ficus social preview cards generated:',
    Object.values(CARD_FILES)
      .flatMap((f) => [f.svg, f.png])
      .join(', ')
  )
}

if (import.meta.main) {
  generateSocialPreviews().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
