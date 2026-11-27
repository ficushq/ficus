/** DB-free rendered check of motion for live changes in the Feed, a squad's Work list and Activity, with
 * the real components and stylesheet.
 * From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-live-list-motion.ts
 * Every built-in theme (light and dark for dual themes), every surface: first load is still; after one live
 * update the moved rows slide (300 ms transforms), the arrived row gets a visible theme-colored wash, the
 * changed status badge swells, and all of it is gone again afterwards. An arrived row stays clear for
 * 120 ms while the rows around it slide, then fades in. A change that arrives while Needs you is collapsed
 * plays nothing when it is opened. Under reduced motion nothing animates. With 200 rows, one live update is measured for long tasks and slow frames.
 * Optional SCREENSHOT_DIR saves the Feed mid-update per theme and appearance; THEMES (comma-separated ids)
 * limits the themes; MOTION=0 skips the motion assertions (for a "before" run on a branch without it).
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { BUILT_IN_THEMES } from '../src/theme/registry'
import { startFixtureServer } from './fixture-server'

const root = resolve(import.meta.dir, '..')
const { chromium } = createRequire(resolve(root, '../core/package.json'))(
  'playwright-core'
) as typeof import('playwright-core')
const screenshotDir = process.env.SCREENSHOT_DIR
if (screenshotDir) await mkdir(screenshotDir, { recursive: true })
const checkMotion = process.env.MOTION !== '0'
const server = await startFixtureServer({
  path: '/live-list-motion-fixture',
  entry: '/scripts/fixtures/live-list-motion.tsx',
})

const onlyThemes = process.env.THEMES?.split(',').map((id) => id.trim())
const variants = BUILT_IN_THEMES.filter((theme) => !onlyThemes || onlyThemes.includes(theme.id)).flatMap((theme) =>
  theme.kind === 'dual' ? [`${theme.id}:light`, `${theme.id}:dark`] : [`${theme.id}:constant`]
)

/** The live motion running now: row moves (Web Animations on rows) and the wash and swell (CSS animations). */
async function liveMotion(page: Page) {
  return page.evaluate(() => {
    const moves: string[] = []
    const css: string[] = []
    for (const animation of document.getAnimations()) {
      const name = (animation as CSSAnimation).animationName
      if (name?.startsWith('ficus-live')) css.push(name)
      const target = (animation.effect as KeyframeEffect | null)?.target
      if (!name && target instanceof HTMLElement && target.matches('[data-live-row]'))
        moves.push(target.getAttribute('data-live-row')!)
    }
    const arrived = [...document.querySelectorAll('.ficus-live-arrived')]
    const emphasized = [...document.querySelectorAll('.ficus-live-emphasis')]
    return {
      moves,
      css,
      arrived: arrived.map((node) => node.getAttribute('data-live-row')),
      washes: arrived.map((node) => getComputedStyle(node, '::after').backgroundColor),
      emphasized: emphasized.map((node) => node.closest('[data-live-row]')?.getAttribute('data-live-row')),
    }
  })
}

const SURFACES = [
  // Feed: a stream moves to the top, one arrives, one changes state; a question arrives in Needs you.
  { section: 'feed', arrived: ['agent-question:q-2', 'ws-99999'], emphasized: ['ws-1'], moves: true },
  { section: 'squad', arrived: ['ws-99999'], emphasized: ['ws-1'], moves: true },
  // Activity: a row streams in at the top and pushes the others down.
  { section: 'activity', arrived: ['act-4'], emphasized: [], moves: true },
] as const

let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const errors: string[] = []
  const open = async (query: string, { reducedMotion = false } = {}) => {
    const page = await browser!.newPage()
    page.setDefaultTimeout(10000)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
    await page.goto(`${server.resolvedUrls!.local[0]!}live-list-motion-fixture?${query}`)
    await page.locator('main li').first().waitFor()
    await page.waitForFunction(() => typeof window.liveStep === 'function')
    return page
  }

  for (const variant of variants) {
    const [theme, appearance] = variant.split(':')
    for (const surface of SURFACES) {
      const label = `${variant} ${surface.section}`
      const page = await open(`section=${surface.section}&theme=${theme}&appearance=${appearance}`)
      if (checkMotion) {
        const first = await liveMotion(page)
        assert.deepEqual([first.moves, first.css, first.arrived], [[], [], []], `${label}: first load is still`)
      }
      // The arrived rows' fade-in, as soon as the frame that started the motion has run.
      const entering = await page.evaluate(async (count) => {
        window.liveStep()
        const frame = () => new Promise((done) => requestAnimationFrame(done))
        for (let frames = 0; frames < 60 && document.querySelectorAll('.ficus-live-arrived').length < count; frames++)
          await frame()
        return document
          .getAnimations()
          .filter((animation) => (animation as CSSAnimation).animationName === 'ficus-live-enter')
          .map((animation) => {
            const timing = animation.effect!.getComputedTiming()
            const target = (animation.effect as KeyframeEffect).target as HTMLElement
            return {
              delay: timing.delay,
              fill: timing.fill,
              currentTime: Number(animation.currentTime),
              opacity: getComputedStyle(target).opacity,
            }
          })
      }, surface.arrived.length)
      await page.waitForTimeout(120)
      const during = await liveMotion(page)
      if (screenshotDir && surface.section === 'feed')
        await page.screenshot({ path: resolve(screenshotDir, `feed-${theme}-${appearance}.png`) })
      if (screenshotDir && surface.section === 'activity' && theme === 'ficus')
        await page.screenshot({ path: resolve(screenshotDir, `activity-${theme}-${appearance}.png`) })
      if (checkMotion) {
        assert.equal(entering.length, surface.arrived.length, `${label}: each arrived row fades in`)
        for (const enter of entering) {
          assert.deepEqual([enter.delay, enter.fill], [120, 'both'], `${label}: the fade-in waits 120 ms`)
          if (enter.currentTime < 120) assert.equal(enter.opacity, '0', `${label}: clear while rows slide past`)
        }
        assert.deepEqual(during.arrived.sort(), [...surface.arrived].sort(), `${label}: the arrived rows are washed`)
        for (const wash of during.washes)
          assert.ok(wash && wash !== 'rgba(0, 0, 0, 0)' && wash !== 'transparent', `${label}: wash has a color`)
        assert.deepEqual(during.emphasized, surface.emphasized, `${label}: the changed status is emphasized`)
        assert.ok(during.moves.length > 0 === surface.moves, `${label}: moved rows slide (${during.moves})`)
        await page.waitForTimeout(1800)
        const after = await liveMotion(page)
        assert.deepEqual(
          [after.moves, after.css, after.arrived, after.emphasized],
          [[], [], [], []],
          `${label}: motion ends`
        )
      }
      await page.close()
    }
  }

  if (checkMotion) {
    // A card that arrives while Needs you is collapsed: nothing waits to play when it is opened. The work
    // list below it still animates.
    const collapsed = await open('section=feed&collapsed=1')
    await collapsed.evaluate(() => window.liveStep())
    await collapsed.waitForTimeout(120)
    const whileCollapsed = await liveMotion(collapsed)
    assert.deepEqual(whileCollapsed.arrived, ['ws-99999'], 'collapsed Needs you: only the visible arrival')
    await collapsed.evaluate(() => {
      document.querySelector<HTMLDetailsElement>('[data-testid="needs-you"]')!.open = true
    })
    await collapsed.waitForTimeout(120)
    const opened = await collapsed.evaluate(() =>
      document
        .querySelector('[data-testid="needs-you"]')!
        .getAnimations({ subtree: true })
        .map((animation) => (animation as CSSAnimation).animationName)
    )
    assert.deepEqual(opened, [], 'collapsed Needs you: opening it plays nothing')
    assert.ok(
      await collapsed.locator('[data-live-row="agent-question:q-2"]').isVisible(),
      'collapsed Needs you: the new card is there once opened'
    )
    await collapsed.close()

    for (const surface of SURFACES) {
      const page = await open(`section=${surface.section}`, { reducedMotion: true })
      await page.evaluate(() => window.liveStep())
      await page.waitForTimeout(120)
      const during = await liveMotion(page)
      assert.deepEqual(
        [during.moves, during.css, during.arrived, during.emphasized],
        [[], [], [], []],
        `reduced motion ${surface.section}: nothing animates`
      )
      await page.close()
    }
  }

  // 200 rows: one live update (a row from the bottom to the top, an arrival, a status change), then the
  // frames until the motion is over.
  const page = await open('section=feed&rows=200')
  // Chrome's own counters: whether the motion adds layout or style work to the update.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const metrics = async () =>
    Object.fromEntries(
      ((await cdp.send('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> }).metrics.map(
        ({ name, value }) => [name, value]
      )
    )
  const startMetrics = await metrics()
  const frames = await page.evaluate(async () => {
    if (window.liveMotionMs !== undefined) window.liveMotionMs = {}
    const longTasks: number[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration))
    })
    observer.observe({ type: 'longtask' })
    const deltas: number[] = []
    await new Promise<void>((done) => {
      let last = 0
      let start = 0
      const tick = (time: number) => {
        if (!start) {
          start = time
          window.liveStep()
        } else deltas.push(time - last)
        last = time
        if (time - start < 1000) requestAnimationFrame(tick)
        else done()
      }
      requestAnimationFrame(tick)
    })
    observer.disconnect()
    return { deltas, longTasks, motionMs: window.liveMotionMs }
  })
  const endMetrics = await metrics()
  const work = (name: string, scale = 1) => Math.round((endMetrics[name]! - startMetrics[name]!) * scale)
  const rows = await page.locator('[data-testid="work-stream-row"]').count()
  await page.close()
  const slow = frames.deltas.filter((delta) => delta > 25)
  // Frames after the update has rendered: while the rows slide (the render itself is React's).
  const sliding = frames.deltas.slice(frames.deltas.findIndex((delta) => delta > 25) + 1).slice(0, 18)
  console.log(
    `200 rows (${rows} rendered): ${frames.deltas.length} frames in 1 s, longest ${Math.round(Math.max(...frames.deltas))} ms, ` +
      `${slow.length} over 25 ms (${slow.map(Math.round).join(', ') || 'none'}), long tasks: ${frames.longTasks.join(', ') || 'none'}; ` +
      `motion code ${
        frames.motionMs === undefined
          ? 'absent'
          : Object.entries(frames.motionMs)
              .map(([method, ms]) => `${method} ${ms.toFixed(1)} ms`)
              .join(', ')
      }; ` +
      `frames while sliding: ${sliding.map(Math.round).join(', ')}`
  )
  console.log(
    `200 rows, the update and its second of motion: ${work('LayoutCount')} layouts (${work('LayoutDuration', 1000)} ms), ` +
      `${work('RecalcStyleCount')} style recalcs (${work('RecalcStyleDuration', 1000)} ms), script ${work('ScriptDuration', 1000)} ms`
  )

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`live list motion: ${variants.length} theme variants × ${SURFACES.length} surfaces passed`)
} finally {
  await browser?.close()
  await server.close()
}
