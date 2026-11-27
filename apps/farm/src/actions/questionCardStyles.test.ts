import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The two question cards share RecommendedOption's markup but not their option boxes, so these
// guard the styles that make a label and its Recommended tag set the same way in both.
const css = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8')
const actionsCss = css('actions.css')
const chatCss = css('../chat/chat.css')

/** The declarations of the top-level rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped} \\{\\n([^}]*)\\}`, 'm').exec(sheet)
  if (!match) throw new Error(`No rule ${selector}`)
  return Object.fromEntries(
    match[1]!
      .split(';')
      .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
      })
  )
}

describe('question card option styles', () => {
  it('sets chat options in the Action Center option type', () => {
    const actionCenter = rule(actionsCss, '.g-option')
    expect(actionCenter.font).toBeDefined()
    expect(rule(chatCss, '.g-chat-option').font).toBe(actionCenter.font!)
  })

  it('keeps the tag inline after the label, not in a wrapping row of its own', () => {
    expect(actionsCss).not.toMatch(/^\.g-option-name \{/m)
    expect(rule(actionsCss, '.g-recommended').display).toBe('inline-block')
    expect(rule(actionsCss, '.g-recommended')['white-space']).toBe('nowrap')
  })
})
