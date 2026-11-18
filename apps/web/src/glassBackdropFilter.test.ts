import { optimize } from '@tailwindcss/node'
import tailwindcss from '@tailwindcss/postcss'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postcss, { type Root, type Rule } from 'postcss'

// Regression: Tailwind 4's production optimiser (Lightning CSS) turned
//   backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
// into the prefixed declaration alone. Chromium ignores -webkit-backdrop-filter, so every glass
// surface (the Assistant panel included) lost its blur and only the translucent tint was left.
// The stylesheets now write the standard property only and let the minifier add the prefix.

const srcRoot = import.meta.dir
const webRoot = join(srcRoot, '..')

/** The stylesheets the app imports that it writes itself. */
const stylesheets = ['index.css', 'components/squads/SquadAgentThreads.css', 'components/ResponsiveChat.css']

/**
 * The production CSS pipeline for one stylesheet: postcss.config.js runs @tailwindcss/postcss, which
 * optimises with Lightning CSS when NODE_ENV is production (forced on here). Stylesheets without
 * Tailwind at-rules skip that step, as they do in Vite. Vite then minifies every CSS chunk with
 * Lightning CSS (build.cssMinify) for the same browser baseline as Tailwind's optimiser.
 */
async function productionCss(file: string): Promise<Root> {
  const from = join(srcRoot, file)
  const result = await postcss([tailwindcss({ base: webRoot, optimize: { minify: true } })]).process(
    readFileSync(from, 'utf8'),
    { from }
  )
  return postcss.parse(optimize(result.css, { minify: true }).code)
}

const compiled = new Map<string, Root>()
for (const file of stylesheets) compiled.set(file, await productionCss(file))

function declarations(rule: Rule): Record<string, string> {
  const result: Record<string, string> = {}
  rule.each((node) => {
    if (node.type === 'decl') result[node.prop] = node.value
  })
  return result
}

/** Rules for exactly this selector, with the at-rules (`@supports …`, `@media …`) that wrap them. */
function rulesFor(root: Root, selector: string) {
  const rules: Array<{ context: string[]; declarations: Record<string, string> }> = []
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    const context: string[] = []
    for (let parent = rule.parent; parent && parent.type === 'atrule'; parent = parent.parent) {
      context.unshift(`@${parent.name} ${parent.params}`)
    }
    rules.push({ context, declarations: declarations(rule) })
  })
  return rules
}

describe('glass surfaces keep their backdrop blur in production CSS', () => {
  test.each(stylesheets)('%s declares backdrop-filter and its -webkit- prefix together', (file) => {
    const mismatched: string[] = []
    compiled.get(file)!.walkRules((rule) => {
      const values = declarations(rule)
      const standard = values['backdrop-filter']
      const prefixed = values['-webkit-backdrop-filter']
      if (standard === undefined && prefixed === undefined) return
      if (standard !== prefixed) mismatched.push(rule.toString())
    })
    expect(mismatched).toEqual([])
  })

  const glassRules = [
    { file: 'index.css', selector: '.ficus-glass', blur: 'blur(16px)' },
    { file: 'index.css', selector: '.ficus-assistant-panel.ficus-glass', blur: 'blur(12px)' },
    { file: 'components/squads/SquadAgentThreads.css', selector: '.squad-chat-sidebar', blur: 'blur(16px)' },
    { file: 'components/squads/SquadAgentThreads.css', selector: '.squad-chat-toolbar', blur: 'blur(16px)' },
  ]

  test.each(glassRules)('$selector blurs with $blur in Chromium and Safari', ({ file, selector, blur }) => {
    const blurred = rulesFor(compiled.get(file)!, selector).filter(
      (rule) => rule.declarations['backdrop-filter'] === blur
    )
    expect(blurred).toHaveLength(1)
    expect(blurred[0]!.declarations['-webkit-backdrop-filter']).toBe(blur)
  })

  test.each(glassRules.filter((rule) => rule.file === 'index.css'))(
    '$selector drops the blur and turns opaque when transparency is reduced',
    ({ file, selector }) => {
      const reduced = rulesFor(compiled.get(file)!, selector).filter((rule) =>
        rule.context.some((atRule) => atRule.includes('prefers-reduced-transparency'))
      )
      expect(reduced).toHaveLength(1)
      expect(reduced[0]!.declarations).toMatchObject({
        background: 'rgb(var(--color-bg-surface))',
        'backdrop-filter': 'none',
        '-webkit-backdrop-filter': 'none',
      })
    }
  )
})
