import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BIGBRAIN_PALETTES } from '@ficus/shared/bigbrain-palettes'
import {
  GENERATED_END,
  GENERATED_START,
  generateBigBrainBuiltinsCss,
  generateBigBrainThemes,
} from './generate-bigbrain-builtins'

const builtinsCssPath = resolve(import.meta.dir, '../src/theme/builtins.css')

test('the committed builtins.css matches a fresh generator run (regenerate with: bun apps/web/scripts/generate-bigbrain-builtins.ts)', async () => {
  const committed = readFileSync(builtinsCssPath, 'utf8')
  const generated = await generateBigBrainBuiltinsCss()
  const startIndex = committed.indexOf(GENERATED_START)
  const endIndex = committed.indexOf(GENERATED_END)
  expect(startIndex).toBeGreaterThan(-1)
  expect(endIndex).toBeGreaterThan(startIndex)
  const committedSection = committed.slice(startIndex, endIndex + GENERATED_END.length)
  expect(committedSection).toBe(generated)
})

describe('generateBigBrainThemes', () => {
  test('produces one CSS block per BigBrain palette, in order', async () => {
    const themes = await generateBigBrainThemes()
    expect(themes.map((t) => t.palette.id)).toEqual(BIGBRAIN_PALETTES.map((p) => p.id))
    for (const theme of themes) {
      expect(theme.css).toContain(`:root[data-theme='${theme.palette.id}']`)
      expect(theme.css).toContain(`color-scheme: ${theme.palette.scheme};`)
    }
  })

  test('running twice produces byte-identical output (deterministic, no incidental object-key ordering drift)', async () => {
    const [first, second] = await Promise.all([generateBigBrainThemes(), generateBigBrainThemes()])
    expect(first.map((t) => t.css)).toEqual(second.map((t) => t.css))
  })
})
