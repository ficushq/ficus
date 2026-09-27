import { describe, expect, test } from 'bun:test'
import { GARDEN_STYLES, isGardenStyle, readGardenSettings, validateGardenSettingsPatch } from './garden-preferences'

describe('garden settings patches', () => {
  test('accept every garden style, and an empty change', () => {
    for (const style of GARDEN_STYLES)
      expect(validateGardenSettingsPatch({ style })).toEqual({ ok: true, patch: { style } })
    expect(validateGardenSettingsPatch({})).toEqual({ ok: true, patch: {} })
  })

  test('reject unknown keys, invalid values and non-objects', () => {
    for (const style of ['grid', 'farm', '', 'NOSTALGIC', null, 1, {}])
      expect(validateGardenSettingsPatch({ style }).ok).toBe(false)
    expect(validateGardenSettingsPatch({ style: 'blueprint', zoom: 2 }).ok).toBe(false)
    for (const input of [null, undefined, 'blueprint', ['style'], 3])
      expect(validateGardenSettingsPatch(input).ok).toBe(false)
  })
})

describe('reading stored settings', () => {
  test('keeps known, valid keys and drops the rest', () => {
    expect(readGardenSettings({ style: 'sketchbook' })).toEqual({ style: 'sketchbook' })
    expect(readGardenSettings({ style: 'sketchbook', retired: true })).toEqual({ style: 'sketchbook' })
    expect(readGardenSettings({ style: 'grid' })).toEqual({})
    expect(readGardenSettings(null)).toEqual({})
    expect(readGardenSettings('style')).toEqual({})
  })

  test('isGardenStyle narrows', () => {
    expect(isGardenStyle('blueprint')).toBe(true)
    expect(isGardenStyle('neon')).toBe(false)
  })
})
