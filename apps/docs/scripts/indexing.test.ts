import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// docs.ficus.sh went public with Core on 2026-09-16. The hosted build must
// invite crawlers; only the copy embedded in an instance (behind sign-in)
// keeps the noindex tag.
const config = readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8')
const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')

describe('hosted docs are indexable', () => {
  test('the noindex tag is gated on the embedded build', () => {
    const line = config.split('\n').find((l) => l.includes("name: 'robots'"))
    expect(line).toBeDefined()
    expect(line).toContain('embedded ?')
  })

  test('robots.txt allows everything and names the sitemap the site config produces', () => {
    expect(robots).toMatch(/^User-agent: \*\nAllow: \/\n/)
    expect(robots).not.toContain('Disallow')
    expect(robots).toContain('Sitemap: https://docs.ficus.sh/sitemap-index.xml')
    expect(config).toContain("site: embedded ? undefined : 'https://docs.ficus.sh'")
  })
})
