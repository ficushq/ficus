import { describe, expect, test } from 'bun:test'
import { FARM_STYLES, isFarmStyle, readFarmSettings, validateFarmSettingsPatch } from './farm-preferences'

describe('farm settings patches', () => {
  test('accept every farm style, and an empty change', () => {
    for (const style of FARM_STYLES)
      expect(validateFarmSettingsPatch({ style })).toEqual({ ok: true, patch: { style } })
    expect(validateFarmSettingsPatch({})).toEqual({ ok: true, patch: {} })
  })

  test('accept sound on or off, together with a style', () => {
    expect(validateFarmSettingsPatch({ sound: true })).toEqual({ ok: true, patch: { sound: true } })
    expect(validateFarmSettingsPatch({ style: 'futurist', sound: false })).toEqual({
      ok: true,
      patch: { style: 'futurist', sound: false },
    })
    for (const sound of ['on', 1, null, {}]) expect(validateFarmSettingsPatch({ sound }).ok).toBe(false)
    expect(validateFarmSettingsPatch({ multiplayer: false })).toEqual({ ok: true, patch: { multiplayer: false } })
    expect(validateFarmSettingsPatch({ multiplayer: 'solo' }).ok).toBe(false)
  })

  test('reject unknown keys, invalid values and non-objects', () => {
    for (const style of ['grid', 'farm', '', 'NOSTALGIC', null, 1, {}])
      expect(validateFarmSettingsPatch({ style }).ok).toBe(false)
    expect(validateFarmSettingsPatch({ style: 'blueprint', zoom: 2 }).ok).toBe(false)
    for (const input of [null, undefined, 'blueprint', ['style'], 3])
      expect(validateFarmSettingsPatch(input).ok).toBe(false)
  })
})

describe('reading stored settings', () => {
  test('keeps known, valid keys and drops the rest', () => {
    expect(readFarmSettings({ style: 'sketchbook' })).toEqual({ style: 'sketchbook' })
    expect(readFarmSettings({ style: 'sketchbook', retired: true })).toEqual({ style: 'sketchbook' })
    expect(readFarmSettings({ style: 'grid' })).toEqual({})
    expect(readFarmSettings({ sound: false, style: 'blueprint' })).toEqual({ sound: false, style: 'blueprint' })
    expect(readFarmSettings({ sound: 'on' })).toEqual({})
    expect(readFarmSettings(null)).toEqual({})
    expect(readFarmSettings('style')).toEqual({})
  })

  test('isFarmStyle narrows', () => {
    expect(isFarmStyle('blueprint')).toBe(true)
    expect(isFarmStyle('neon')).toBe(false)
  })
})
