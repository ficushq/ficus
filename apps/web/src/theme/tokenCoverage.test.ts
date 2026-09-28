import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACTIVE_THEME_TOKENS, THEME_TOKEN_FAMILIES, validateThemeTokenSet } from '@ficus/shared'

// Ties the CSS token scopes in src/index.css to the single source-of-truth
// token registry in packages/shared/src/theme-schema.ts: every built-in theme
// must define exactly the registry's active token set, in every variant scope.

const webRoot = join(import.meta.dir, '..', '..')
const css = readFileSync(join(webRoot, 'src', 'index.css'), 'utf8')

/** Extracts the custom-property names declared in a CSS block. */
function declaredTokens(block: string): string[] {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)]
    .map((match) => match[1]!)
    .filter((name) => !name.startsWith('--opacity-'))
}

/** Slices a balanced `{ ... }` block starting at the given selector. */
function cssBlock(selector: string): string {
  const start = css.indexOf(selector)
  expect(start).toBeGreaterThan(-1)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  throw new Error(`unbalanced block for selector ${selector}`)
}

const rootBlock = cssBlock(':root')
const darkBlock = cssBlock('.dark')

describe('built-in theme token completeness (tau dual variant)', () => {
  test('the light scope (:root) defines exactly the registry active token set', () => {
    const result = validateThemeTokenSet(new Set(declaredTokens(rootBlock)))
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.ok).toBe(true)
  })

  test('the dark scope (.dark) defines exactly the registry active token set', () => {
    const result = validateThemeTokenSet(new Set(declaredTokens(darkBlock)))
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.ok).toBe(true)
  })

  test('removing any newly active semantic token fails completeness in either variant', () => {
    const semanticTokens = THEME_TOKEN_FAMILIES.filter((family) =>
      ['status', 'agent-type', 'misc-chrome', 'badge-decoration', 'syntax', 'terminal', 'ansi', 'graph'].includes(
        family.family
      )
    ).flatMap((family) => family.tokens)
    for (const block of [rootBlock, darkBlock]) {
      for (const omitted of semanticTokens) {
        const result = validateThemeTokenSet(declaredTokens(block).filter((name) => name !== omitted))
        expect(result.ok).toBe(false)
        expect(result.missing).toEqual([omitted])
      }
    }
  })

  test('both variant scopes declare the same token names', () => {
    expect([...new Set(declaredTokens(rootBlock))].sort()).toEqual([...new Set(declaredTokens(darkBlock))].sort())
  })

  test('scopes declare every active token (including newly activated families)', () => {
    expect(new Set(declaredTokens(rootBlock)).size).toBe(ACTIVE_THEME_TOKENS.length)
  })
})

describe('channel-form tokens (opacity modifier support)', () => {
  test('intrinsic opacity metadata is explicit, separate from color-token completeness', () => {
    for (const block of [rootBlock, darkBlock]) {
      const metadata = [...block.matchAll(/(--opacity-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
      expect(metadata.map((match) => match[1])).toEqual(
        expect.arrayContaining(['--opacity-input-border', '--opacity-panel-border'])
      )
      expect(new Set(metadata.map((match) => match[1])).size).toBe(metadata.length)
      for (const match of metadata) {
        expect(Number(match[2])).toBeGreaterThan(0)
        expect(Number(match[2])).toBeLessThanOrEqual(1)
      }
    }
  })

  const CHANNEL_DECL =
    /^--[a-z0-9-]+:\s*(?:var\(--[a-z0-9-]+\)|\d{1,3}\s+\d{1,3}\s+\d{1,3}(?:\s*\/\s*(?:0?\.\d+|1|0))?)\s*;/

  test('every token declaration in both scopes is a channel triplet, a channel triplet with alpha, or a var() alias', () => {
    for (const [name, block] of [
      [':root', rootBlock],
      ['.dark', darkBlock],
    ] as const) {
      const declarations = block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('--color-'))
      expect(declarations.length).toBe(29)
      for (const declaration of declarations) {
        expect(CHANNEL_DECL.test(declaration)).toBeTrue()
      }
      expect(new Set(declarations).size).toBe(29)
      void name
    }
  })
})
