/** From apps/web: CHROMIUM_PATH=/path/to/chromium bun scripts/check-inline-references.ts */
import assert from 'node:assert/strict'
import { chromium, type Browser } from 'playwright-core'
import { startFixtureServer } from './fixture-server'

const server = await startFixtureServer({ entry: '/scripts/fixtures/inline-references.tsx' })
let browser: Browser | undefined
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } })
  await page.goto(server.resolvedUrls!.local[0]!)
  await page.locator('article').first().waitFor()
  const results = await page.locator('article').evaluateAll((articles) =>
    articles.map((article) => {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      while (walker.nextNode()) nodes.push(walker.currentNode as Text)
      const rects = (text: Text) => {
        const range = document.createRange()
        range.selectNodeContents(text)
        return Array.from(range.getClientRects())
      }
      const [prefix, label, suffix] = nodes.map(rects)
      return {
        startsInline: Math.abs(prefix![0]!.top - label![0]!.top) < 3,
        wrapsAtMargin: label!.length > 1 && Math.abs(label![1]!.left - prefix![0]!.left) < 2,
        endsInline: Math.abs(label!.at(-1)!.top - suffix![0]!.top) < 3,
      }
    })
  )
  assert.equal(results.length, 5)
  for (const result of results) assert.deepEqual(result, { startsInline: true, wrapsAtMargin: true, endsInline: true })
  if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT })
  console.log('Both entity types flow with Activity and Markdown text, as do inline file downloads.')
} finally {
  await browser?.close()
  await server.close()
}
