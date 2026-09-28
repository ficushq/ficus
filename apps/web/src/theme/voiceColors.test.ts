import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import fixture from './fixtures/legacy-voice-colors.json'
import { palettes, tokenRgba } from './test/builtins'
import { ACTIVE_THEME_TOKENS } from '@ficus/shared'

test('voice glass, shadows, and every state retain their original channels and intrinsic alpha via tokens', () => {
  const source = readFileSync(new URL('../components/VoiceWorkspacePage.tsx', import.meta.url), 'utf8')
  const matches = [
    ...source.matchAll(
      /rgb\(var\(--custom-rgb-(voice-[\w-]+), var\(--\1\)\) \/ calc\(var\(--custom-alpha-\1, 1\) \* ([\d.]+)\)\)/g
    ),
  ]
  expect(matches).toHaveLength(fixture.length)
  // Moving the two arbitrary utility declarations into the existing stylesheet
  // changes declaration order, not visual values. Compare multisets.
  const sort = (values: number[][]) => values.map((v) => JSON.stringify(v)).sort()
  for (const palette of palettes) {
    const values = matches.map((match) => {
      expect(ACTIVE_THEME_TOKENS).toContain(`--${match[1]}`)
      return [...tokenRgba(palette.tokens, `--${match[1]}`), Number(match[2])]
    })
    expect(sort(values)).toEqual(sort(fixture))
  }
})
