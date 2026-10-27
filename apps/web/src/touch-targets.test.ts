import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Rule } from 'postcss'

// The layout itself is checked in Chromium by scripts/check-mobile-touch-targets.ts.
const stylesheets = ['index.css', 'design-system.css'].map((name) =>
  postcss.parse(readFileSync(join(import.meta.dir, name), 'utf8'), { from: name })
)

function minHeightSelectors() {
  const selectors: string[] = []
  for (const sheet of stylesheets)
    sheet.walkDecls('min-height', (decl) => {
      const rule = decl.parent as Rule
      if (rule.type === 'rule') selectors.push(...rule.selectors)
    })
  return selectors
}

describe('phone touch targets', () => {
  test('no minimum height on every button or link, which made lines of text taller than their text', () => {
    const elementWide = minHeightSelectors().filter((selector) => /^(?::where\()?\s*(button|a)\s*\)?$/.test(selector))
    expect(elementWide).toEqual([])
  })

  test('standalone design-system buttons keep a 24px minimum height on phones, link-style buttons do not', () => {
    const phoneRules: Rule[] = []
    for (const sheet of stylesheets)
      sheet.walkAtRules('media', (media) => {
        if (media.params.replace(/\s+/g, '') === '(max-width:767px)')
          media.walkRules((rule) => {
            if (rule.nodes.some((node) => node.type === 'decl' && node.prop === 'min-height')) phoneRules.push(rule)
          })
      })
    const buttonRule = phoneRules.find((rule) => rule.selector.includes('.ficus-button'))
    expect(buttonRule?.selector).toBe(':where(.ficus-button:not(.ficus-button-link))')
    expect(buttonRule?.nodes.map((node) => node.toString())).toEqual(['min-height: 1.5rem'])
  })
})
