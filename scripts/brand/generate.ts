/**
 * Ficus brand icon generator.
 *
 * Renders every icon Core web, Platform web, Core docs, Desktop and Mobile
 * need from the three source SVGs in `brand/` (`ficus-mark.svg`,
 * `ficus-mark-dark.svg`, `ficus-favicon-16.svg`). Outputs are written to
 * `brand/generated/` and are NOT wired into any app by this script — that
 * swap happens in separate, later PRs.
 *
 * Usage: bun run brand:generate   (from repo root)
 *     or: bun run scripts/brand/generate.ts
 *
 * Determinism: every raster target is built by rasterizing a single
 * composite SVG (background shape + the source mark's own path data,
 * positioned with a computed affine transform) in one pass with sharp, then
 * encoded with fixed, explicit PNG options. No timestamps, random ids or
 * host-dependent metadata are written. Running this script twice produces
 * byte-identical files (see scripts/brand/generate.test.ts).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

export const BRAND_DIR = join(import.meta.dir, '..', '..', 'brand')
export const OUT_DIR = join(BRAND_DIR, 'generated')

// ---------------------------------------------------------------------------
// Brand constants (see brand/README.md for the human-readable version)
// ---------------------------------------------------------------------------

export const COLORS = {
  linen: '#f1e9db',
  soil: '#1c1a17',
  leaf: '#3f6b4f',
  moss: '#8a9a5b',
  terracotta: '#b0582f',
  darkSage: '#9fb57f',
  // The farm's sky and meadow (apps/farm skins), behind the farm app's icons.
  farmSky: '#8fd3f2',
  farmMeadow: '#a3bb5d',
} as const

/** Dark-mode recolor mapping, matching brand/ficus-mark-dark.svg's palette swap. */
const DARK_RECOLOR: Record<string, string> = {
  '#3f6b4f': '#5e7f4e', // leaf -> dark leaf
  '#8a9a5b': '#87945a', // moss / side leaves -> dark moss
  '#b0582f': '#c46a3c', // terracotta -> dark terracotta
}

const MARK_VIEWBOX_SIZE = 64

// Fraction of the (effective) canvas that the mark's longest content
// dimension should occupy. Values marked "brief" are given directly by the
// task brief; values marked "chosen" are this generator's own consistent
// default for cases the brief left unspecified (see brand/README.md and the
// task report for the reasoning).
const FILL = {
  webIcon: 0.7, // brief: "mark centered ~70% of the canvas"
  appleTouch: 1 - 2 * 0.12, // brief: "~12% padding" => 0.76
  desktopTile: 0.7, // chosen: same ratio as webIcon, applied to the tile
  mobileIcon: 0.7, // chosen: same ratio as webIcon (iOS full-bleed square)
  mobileSplash: 0.6, // brief: "mark ~60%"
  mobileNotification: 0.7, // chosen: same ratio as webIcon
} as const

// For genuinely *circular* safe zones (an OS/spec crops or masks to a
// circle, not just "somewhere inside a square"), a bbox-fraction fill isn't
// the right measure: it bounds the mark's width/height, not its distance
// from the centre, so an off-centre-heavy shape (like the mark, whose pot
// sits well below its optical centre) can still poke outside a circular
// mask even while comfortably within a square fill fraction. These targets
// instead scale so the mark's measured maximum *radius* from its own centre
// - as a fraction of the canvas diameter - stays under the platform's
// circle, with a deliberate margin:
const RADIAL_DIAMETER_FRACTION = {
  // Android's adaptive-icon foreground safe zone is a 72dp circle inside a
  // 108dp canvas (72/108 = 66.67%); keep a margin under it.
  mobileAdaptive: 0.64,
  // The W3C maskable-icon safe zone is an 80% circle; keep a margin under it.
  webMaskable: 0.76,
} as const

const WEB_STANDARD_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]
const FARM_STANDARD_SIZES = [192, 512]

// Where the meadow meets the sky on the farm icons, in each source's own
// 0..64 units: through the pot, so the plant stands in the field.
const FARM_HORIZON = { mark: 49, favicon16: 50 } as const
const WEB_MASKABLE_SIZES = [192, 512]

const DESKTOP_CANVAS = 1024
const DESKTOP_TILE = 824
const DESKTOP_CORNER_RADIUS = 185

const PNG_OPTIONS = {
  compressionLevel: 9,
  effort: 10,
  palette: true,
} as const

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------

/** Strips the outer <svg ...>...</svg> wrapper, returning just the inner markup. */
function innerMarkup(svg: string): string {
  const match = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)
  if (!match) throw new Error('source SVG did not match the expected <svg>...</svg> shape')
  return match[1].trim()
}

/** Applies the dark-mode color mapping to a light source's inner markup. */
function toDark(markup: string): string {
  let out = markup
  for (const [light, dark] of Object.entries(DARK_RECOLOR)) {
    out = out.split(light).join(dark)
  }
  return out
}

/** Forces every fill color in the markup to pure white (for monochrome silhouettes). */
function toWhiteSilhouette(markup: string): string {
  return markup.replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#ffffff"')
}

interface BBox {
  x: number
  y: number
  width: number
  height: number
}

interface ContentMetrics extends BBox {
  /**
   * The farthest distance, in the mark's own 0..64 user-unit space, that any
   * opaque pixel sits from the content's bbox center (`x + width/2`,
   * `y + height/2`). Used to fit circular safe zones by true radial extent
   * rather than by bbox width/height.
   */
  maxRadius: number
}

/**
 * Measures a mark SVG's visible content: its bounding box (via a calibration
 * render + `sharp`'s `.trim()`) and the maximum radial distance any opaque
 * pixel sits from that bbox's center (via a raw alpha-channel scan of the
 * same render). Both are computed from the source file itself (not
 * hardcoded) so the generator stays correct if the mark artwork ever
 * changes.
 */
async function measureContent(svg: string): Promise<ContentMetrics> {
  const calibrationSize = 2048
  const pxPerUnit = calibrationSize / MARK_VIEWBOX_SIZE
  const rendered = await sharp(Buffer.from(svg), { density: pxPerUnit * 96 })
    .resize(calibrationSize, calibrationSize)
    .png()
    .toBuffer()

  const { info: trimInfo } = await sharp(rendered).trim().toBuffer({ resolveWithObject: true })
  const bbox: BBox = {
    x: -(trimInfo.trimOffsetLeft ?? 0) / pxPerUnit,
    y: -(trimInfo.trimOffsetTop ?? 0) / pxPerUnit,
    width: trimInfo.width / pxPerUnit,
    height: trimInfo.height / pxPerUnit,
  }
  const centerXPx = (bbox.x + bbox.width / 2) * pxPerUnit
  const centerYPx = (bbox.y + bbox.height / 2) * pxPerUnit

  const { data, info } = await sharp(rendered).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let maxRadiusSqPx = 0
  for (let y = 0; y < info.height; y++) {
    const dy = y + 0.5 - centerYPx
    const dySq = dy * dy
    const rowOffset = y * info.width * info.channels
    for (let x = 0; x < info.width; x++) {
      const alpha = data[rowOffset + x * info.channels + 3]
      if (alpha === 0) continue
      const dx = x + 0.5 - centerXPx
      const distSq = dx * dx + dySq
      if (distSq > maxRadiusSqPx) maxRadiusSqPx = distSq
    }
  }

  return { ...bbox, maxRadius: Math.sqrt(maxRadiusSqPx) / pxPerUnit }
}

type FillSpec =
  | { fill: number; radial?: undefined }
  | { fill?: undefined; radial: { maxRadius: number; diameterFraction: number } }

/**
 * Builds a self-contained composite SVG: an optional background (full-canvas
 * or a centered rounded tile) plus the mark's inner markup, scaled and
 * centered on the content's bbox center. Either `fill` (the content's
 * longest bbox dimension, as a fraction of the effective canvas) or
 * `radial` (the content's measured max radius, scaled so its diameter is a
 * given fraction of the canvas diameter — for circular safe zones) controls
 * the scale.
 */
function buildCompositeSVG(
  opts: {
    size: number
    markup: string
    bbox: BBox
    background?: string
    tile?: { size: number; cornerRadius: number }
    /** A two-band backdrop instead of `background`: sky above, ground below `horizon` (in mark units). */
    scene?: { sky: string; ground: string; horizon: number }
  } & FillSpec
): string {
  const { size, markup, bbox, background, tile, scene, fill, radial } = opts
  const effectiveSize = tile?.size ?? size
  const scale = radial
    ? (radial.diameterFraction * effectiveSize) / (2 * radial.maxRadius)
    : (fill * effectiveSize) / Math.max(bbox.width, bbox.height)
  const contentCenterX = bbox.x + bbox.width / 2
  const contentCenterY = bbox.y + bbox.height / 2
  const tx = size / 2 - contentCenterX * scale
  const ty = size / 2 - contentCenterY * scale

  let backgroundShape = ''
  if (scene) {
    const horizonY = Math.min(size, Math.max(0, ty + scene.horizon * scale))
    backgroundShape =
      `<rect x="0" y="0" width="${size}" height="${size}" fill="${scene.sky}"/>` +
      `<rect x="0" y="${horizonY}" width="${size}" height="${size - horizonY}" fill="${scene.ground}"/>`
  } else if (background && tile) {
    const tileX = (size - tile.size) / 2
    const tileY = (size - tile.size) / 2
    backgroundShape = `<rect x="${tileX}" y="${tileY}" width="${tile.size}" height="${tile.size}" rx="${tile.cornerRadius}" ry="${tile.cornerRadius}" fill="${background}"/>`
  } else if (background) {
    backgroundShape = `<rect x="0" y="0" width="${size}" height="${size}" fill="${background}"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${backgroundShape}<g transform="translate(${tx} ${ty}) scale(${scale})">${markup}</g></svg>`
}

/** Renders a composite SVG string to a PNG file with fixed, deterministic options. */
async function renderPng(svg: string, outPath: string, opts: { removeAlpha?: boolean } = {}): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true })
  let pipeline = sharp(Buffer.from(svg))
  if (opts.removeAlpha) pipeline = pipeline.flatten().removeAlpha()
  const buffer = await pipeline.png(PNG_OPTIONS).toBuffer()
  await writeFile(outPath, buffer)
}

interface WebVariant {
  /** Subdirectory of outDir, e.g. 'web' or 'web/dark'. */
  dir: string
  markMarkup: string
  faviconMarkup: string
  background: string
}

/**
 * Renders the full "web" icon set (favicons, apple-touch-icon, the standard
 * PWA icon-*.png sizes and the maskable icon-maskable-*.png sizes) for one
 * variant (light-on-linen or dark-on-soil). Core web and Platform web share
 * this exact set.
 */
async function generateWebIconSet(
  outDir: string,
  variant: WebVariant,
  markMetrics: ContentMetrics,
  favicon16BBox: BBox
): Promise<void> {
  const { dir, markMarkup, faviconMarkup, background } = variant

  await renderPng(
    buildCompositeSVG({ size: 16, markup: faviconMarkup, bbox: favicon16BBox, fill: 1, background }),
    join(outDir, dir, 'favicon-16x16.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 32, markup: markMarkup, bbox: markMetrics, fill: FILL.webIcon, background }),
    join(outDir, dir, 'favicon-32x32.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 180, markup: markMarkup, bbox: markMetrics, fill: FILL.appleTouch, background }),
    join(outDir, dir, 'apple-touch-icon.png'),
    { removeAlpha: true }
  )
  for (const size of WEB_STANDARD_SIZES) {
    await renderPng(
      buildCompositeSVG({ size, markup: markMarkup, bbox: markMetrics, fill: FILL.webIcon, background }),
      join(outDir, dir, `icon-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
  for (const size of WEB_MASKABLE_SIZES) {
    await renderPng(
      buildCompositeSVG({
        size,
        markup: markMarkup,
        bbox: markMetrics,
        radial: { maxRadius: markMetrics.maxRadius, diameterFraction: RADIAL_DIAMETER_FRACTION.webMaskable },
        background,
      }),
      join(outDir, dir, `icon-maskable-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
}

/**
 * Renders the farm app's icons: the light mark standing in the farm's meadow
 * under its sky, so the farm is told apart from Ficus on a home screen.
 */
async function generateFarmIconSet(
  outDir: string,
  markMarkup: string,
  faviconMarkup: string,
  markMetrics: ContentMetrics,
  favicon16BBox: BBox
): Promise<void> {
  const scene = (horizon: number) => ({ sky: COLORS.farmSky, ground: COLORS.farmMeadow, horizon })
  const mark = { markup: markMarkup, bbox: markMetrics, scene: scene(FARM_HORIZON.mark) }

  await renderPng(
    buildCompositeSVG({
      size: 16,
      markup: faviconMarkup,
      bbox: favicon16BBox,
      fill: 1,
      scene: scene(FARM_HORIZON.favicon16),
    }),
    join(outDir, 'farm', 'favicon-16x16.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 32, ...mark, fill: FILL.webIcon }),
    join(outDir, 'farm', 'favicon-32x32.png'),
    {
      removeAlpha: true,
    }
  )
  await renderPng(
    buildCompositeSVG({ size: 180, ...mark, fill: FILL.appleTouch }),
    join(outDir, 'farm', 'apple-touch-icon.png'),
    { removeAlpha: true }
  )
  for (const size of FARM_STANDARD_SIZES) {
    await renderPng(
      buildCompositeSVG({ size, ...mark, fill: FILL.webIcon }),
      join(outDir, 'farm', `icon-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
  for (const size of WEB_MASKABLE_SIZES) {
    await renderPng(
      buildCompositeSVG({
        size,
        ...mark,
        radial: { maxRadius: markMetrics.maxRadius, diameterFraction: RADIAL_DIAMETER_FRACTION.webMaskable },
      }),
      join(outDir, 'farm', `icon-maskable-${size}x${size}.png`),
      { removeAlpha: true }
    )
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function generate(outDir: string = OUT_DIR): Promise<void> {
  await Promise.all(
    ['web/dark', 'farm', 'desktop', 'mobile', 'docs'].map((sub) => mkdir(join(outDir, sub), { recursive: true }))
  )

  const [markLightSvg, markDarkSvg, favicon16Svg] = await Promise.all([
    readFile(join(BRAND_DIR, 'ficus-mark.svg'), 'utf8'),
    readFile(join(BRAND_DIR, 'ficus-mark-dark.svg'), 'utf8'),
    readFile(join(BRAND_DIR, 'ficus-favicon-16.svg'), 'utf8'),
  ])

  const markLight = innerMarkup(markLightSvg)
  const markDark = innerMarkup(markDarkSvg)
  const favicon16Light = innerMarkup(favicon16Svg)
  const favicon16Dark = toDark(favicon16Light)
  const markLightWhite = toWhiteSilhouette(markLight)

  const [markMetrics, favicon16BBox] = await Promise.all([measureContent(markLightSvg), measureContent(favicon16Svg)])
  // ficus-mark.svg and ficus-mark-dark.svg share identical geometry (only
  // colors differ), so the same metrics apply to both.

  // --- web/ + web/dark/ (Core web + Platform web share this set) -----------

  await writeFile(join(outDir, 'web', 'favicon.svg'), `${favicon16Svg.trim()}\n`)

  await generateWebIconSet(
    outDir,
    { dir: 'web', markMarkup: markLight, faviconMarkup: favicon16Light, background: COLORS.linen },
    markMetrics,
    favicon16BBox
  )
  await generateWebIconSet(
    outDir,
    { dir: 'web/dark', markMarkup: markDark, faviconMarkup: favicon16Dark, background: COLORS.soil },
    markMetrics,
    favicon16BBox
  )

  // Existing apps/web/public/icons/ also ships two manifest "shortcuts" icons
  // (shortcut-chat.png, shortcut-tasks.png, 96x96) that the brief's list
  // doesn't cover. Per the task's guidance, generate mark-only equivalents
  // at the same name/size rather than inventing new shortcut glyphs, so a
  // later swap is a straight copy.
  for (const name of ['shortcut-chat', 'shortcut-tasks']) {
    await renderPng(
      buildCompositeSVG({
        size: 96,
        markup: markLight,
        bbox: markMetrics,
        fill: FILL.webIcon,
        background: COLORS.linen,
      }),
      join(outDir, 'web', `${name}.png`),
      { removeAlpha: true }
    )
  }

  // --- farm/ (the farm app, apps/farm) ------------------------------------------

  await generateFarmIconSet(outDir, markLight, favicon16Light, markMetrics, favicon16BBox)

  // --- desktop/ -------------------------------------------------------------

  await renderPng(
    buildCompositeSVG({
      size: DESKTOP_CANVAS,
      markup: markLight,
      bbox: markMetrics,
      fill: FILL.desktopTile,
      background: COLORS.linen,
      tile: { size: DESKTOP_TILE, cornerRadius: DESKTOP_CORNER_RADIUS },
    }),
    join(outDir, 'desktop', 'icon-1024.png')
  )
  await renderPng(
    buildCompositeSVG({
      size: DESKTOP_CANVAS,
      markup: markDark,
      bbox: markMetrics,
      fill: FILL.desktopTile,
      background: COLORS.soil,
      tile: { size: DESKTOP_TILE, cornerRadius: DESKTOP_CORNER_RADIUS },
    }),
    join(outDir, 'desktop', 'icon-1024-dark.png')
  )

  // --- mobile/ ---------------------------------------------------------------

  await renderPng(
    buildCompositeSVG({
      size: 1024,
      markup: markLight,
      bbox: markMetrics,
      fill: FILL.mobileIcon,
      background: COLORS.linen,
    }),
    join(outDir, 'mobile', 'icon.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({
      size: 1024,
      markup: markLight,
      bbox: markMetrics,
      radial: { maxRadius: markMetrics.maxRadius, diameterFraction: RADIAL_DIAMETER_FRACTION.mobileAdaptive },
    }),
    join(outDir, 'mobile', 'adaptive-icon.png')
  )
  await renderPng(
    buildCompositeSVG({
      size: 1024,
      markup: '',
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      fill: 1,
      background: COLORS.linen,
    }),
    join(outDir, 'mobile', 'adaptive-background.png'),
    { removeAlpha: true }
  )
  await renderPng(
    buildCompositeSVG({ size: 1024, markup: markLight, bbox: markMetrics, fill: FILL.mobileSplash }),
    join(outDir, 'mobile', 'splash-icon.png')
  )
  await renderPng(
    buildCompositeSVG({ size: 96, markup: markLightWhite, bbox: markMetrics, fill: FILL.mobileNotification }),
    join(outDir, 'mobile', 'notification-icon.png')
  )

  // --- docs/ -------------------------------------------------------------

  await writeFile(join(outDir, 'docs', 'favicon.svg'), `${favicon16Svg.trim()}\n`)

  console.log('Ficus brand icons generated in', outDir)
}

if (import.meta.main) {
  generate().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
