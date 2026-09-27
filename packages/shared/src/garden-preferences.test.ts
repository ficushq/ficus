import { describe, expect, test } from 'bun:test'
import { GARDEN_STYLES, isGardenStyle, validateGardenStyle } from './garden-preferences'

describe('garden preferences', () => {
  test('accepts every garden style and nothing else', () => {
    for (const style of GARDEN_STYLES) expect(validateGardenStyle(style)).toEqual({ ok: true, style })
    for (const bad of ['grid', 'farm', '', 'NOSTALGIC', null, undefined, 1, {}])
      expect(validateGardenStyle(bad).ok).toBe(false)
  })

  test('isGardenStyle narrows', () => {
    expect(isGardenStyle('blueprint')).toBe(true)
    expect(isGardenStyle('neon')).toBe(false)
  })
})
