/**
 * DB-free Chromium check: markdown prose (body, heading, bold, link, inline code, blockquote, list item) meets WCAG AA
 * (4.5:1) against the surface it is drawn on, in every built-in theme and appearance, as the browser renders it.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-markdown-prose-contrast.ts
 * Optional THEME_FILTER (a regex over "<theme>/<appearance>") narrows the run; SCREENSHOT_DIR saves one shot per theme;
 * REPORT=<file> writes the measured ratios as JSON. NO_DARK_CLASS=1 removes the root `dark` class after applying each
 * theme: prose colours come from theme tokens, so they must not depend on that Tailwind bridge class. Uses Core's declared playwright-core dependency.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser } from 'playwright-core'
import { startFixtureServer } from './fixture-server'
import { BUILT_IN_THEMES } from '../src/theme/registry'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const filter = process.env.THEME_FILTER ? new RegExp(process.env.THEME_FILTER) : null
const variants = BUILT_IN_THEMES.flatMap((theme) =>
  (theme.kind === 'unified' ? ['constant'] : ['light', 'dark']).map((appearance) => ({ theme: theme.id, appearance }))
).filter(({ theme, appearance }) => !filter || filter.test(`${theme}/${appearance}`))

const MINIMUM = 4.5
const noDark = process.env.NO_DARK_CLASS === '1' ? '&nodark' : ''
const server = await startFixtureServer({
  path: '/markdown-prose-fixture',
  entry: '/scripts/fixtures/markdown-prose.tsx',
})
let browser: Browser | undefined
const report: Record<string, Record<string, Record<string, number>>> = {}
const failures: string[] = []
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 2 })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(30000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const { theme, appearance } of variants) {
    const key = `${theme}/${appearance}`
    await page.goto(
      `${server.resolvedUrls!.local[0]!}markdown-prose-fixture?theme=${theme}&appearance=${appearance}${noDark}`
    )
    await page.locator('[data-case] blockquote').first().waitFor()
    const measured = await page.evaluate(measure)
    report[key] = measured
    for (const [section, roles] of Object.entries(measured))
      for (const [role, ratio] of Object.entries(roles))
        if (ratio < MINIMUM) failures.push(`${key} ${section} ${role}: ${ratio.toFixed(2)}`)
    if (screenshotDir)
      await page
        .locator('#shot')
        .screenshot({ path: resolve(screenshotDir, `${theme}-${appearance}${noDark ? '-nodark' : ''}.png`) })
  }
  if (errors.length) throw new Error(`Page errors:\n${errors.join('\n')}`)
} finally {
  await browser?.close()
  await server.close()
}

const roles = ['body', 'heading', 'bold', 'link', 'code', 'quote', 'list']
for (const [key, sections] of Object.entries(report)) {
  console.log(key)
  for (const [section, ratios] of Object.entries(sections))
    console.log(`  ${section.padEnd(16)} ${roles.map((role) => `${role} ${ratios[role]!.toFixed(2)}`).join('  ')}`)
}
if (process.env.REPORT) await writeFile(process.env.REPORT, JSON.stringify(report, null, 2))
if (failures.length) {
  console.error(`Below ${MINIMUM}:1\n${failures.join('\n')}`)
  process.exit(1)
}
console.log(`PASS: markdown prose ≥ ${MINIMUM}:1 in ${variants.length} theme variants`)

/** Runs in the page: each role's text colour against the opaque colour actually painted behind it. */
function measure() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  // The canvas normalises any CSS colour syntax (rgb, oklab, color-mix, color()) to sRGB bytes.
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return [r!, g!, b!, a! / 255]
  }
  const over = (top: number[], bottom: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!))
  const backdrop = (element: Element) => {
    const chain: Element[] = []
    for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node)
    // Browsers paint the canvas white beneath a transparent root.
    return chain.reduce((painted, node) => over(rgba(getComputedStyle(node).backgroundColor), painted), [255, 255, 255])
  }
  const luminance = (rgb: number[]) =>
    rgb
      .map((c) => c / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0)
  const ratio = (element: Element) => {
    const bg = backdrop(element)
    const fg = over(rgba(getComputedStyle(element).color), bg)
    const [a, b] = [luminance(fg), luminance(bg)]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }
  const result: Record<string, Record<string, number>> = {}
  for (const section of document.querySelectorAll('[data-case]')) {
    const prose = section.querySelector('.prose')!
    const pick = (selector: string) => {
      const element = prose.querySelector(selector)
      if (!element) throw new Error(`${section.getAttribute('data-case')}: no ${selector}`)
      return ratio(element)
    }
    result[section.getAttribute('data-case')!] = {
      body: pick(':scope > p'),
      heading: pick('h2'),
      bold: pick('strong'),
      link: pick('a'),
      code: pick('p code'),
      quote: pick('blockquote p'),
      list: pick('li'),
    }
  }
  return result
}
