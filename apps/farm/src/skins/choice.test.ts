import { describe, expect, test } from 'bun:test'
import { initialSkin, knownSkin, withoutStyle } from './choice'
import type { SkinId } from './types'

const IDS: readonly SkinId[] = ['nostalgic', 'futurist', 'blueprint', 'sketchbook']

describe('initialSkin', () => {
  test('a ?style= link wins over the saved choice', () => {
    expect(initialSkin('?style=blueprint', 'futurist', IDS, 'nostalgic')).toBe('blueprint')
  })

  test('otherwise the saved choice, otherwise the default', () => {
    expect(initialSkin('?demo', 'sketchbook', IDS, 'nostalgic')).toBe('sketchbook')
    expect(initialSkin('', null, IDS, 'nostalgic')).toBe('nostalgic')
  })

  test('ignores unknown styles and maps the old names', () => {
    expect(initialSkin('?style=neon', 'nope', IDS, 'nostalgic')).toBe('nostalgic')
    expect(knownSkin('grid', IDS)).toBe('futurist')
    expect(knownSkin('farm', IDS)).toBe('nostalgic')
  })
})

describe('withoutStyle', () => {
  test('drops only the style parameter, keeping the rest as written', () => {
    expect(withoutStyle('?demo&style=futurist')).toBe('?demo')
    expect(withoutStyle('?style=futurist&demo=empty')).toBe('?demo=empty')
    expect(withoutStyle('?style=futurist')).toBe('')
    expect(withoutStyle('?demo')).toBe('?demo')
    expect(withoutStyle('')).toBe('')
  })
})
