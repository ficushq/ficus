import { describe, expect, it } from 'bun:test'
import {
  appToFarmMessage,
  farmToAppMessage,
  parseAppToFarmMessage,
  parseFarmEmbedBootstrap,
  parseFarmToAppMessage,
} from './farm-embed'

describe('farm embed messages', () => {
  it('round-trips farm → app messages', () => {
    for (const message of [
      { type: 'ready' },
      { type: 'auth-required' },
      { type: 'haptic', kind: 'harvest' },
      { type: 'haptic', kind: 'wave' },
      { type: 'haptic', kind: 'message' },
      { type: 'haptic', kind: 'answer' },
    ] as const) {
      expect(parseFarmToAppMessage(farmToAppMessage(message))).toEqual(message)
    }
  })

  it('round-trips app → farm messages, as strings or objects', () => {
    const handoff = { type: 'handoff', code: 'ficus_wh_abc' } as const
    expect(parseAppToFarmMessage(appToFarmMessage(handoff))).toEqual(handoff)
    expect(parseAppToFarmMessage(JSON.parse(appToFarmMessage(handoff)))).toEqual(handoff)
    const theme = { type: 'theme', theme: { themeId: 'harbor', appearance: 'dark', customTheme: null } } as const
    expect(parseAppToFarmMessage(appToFarmMessage(theme))).toEqual(theme)
  })

  it('ignores other sources, versions, types and junk', () => {
    expect(parseAppToFarmMessage(farmToAppMessage({ type: 'ready' }))).toBeNull()
    expect(parseFarmToAppMessage(appToFarmMessage({ type: 'handoff', code: 'x' }))).toBeNull()
    expect(parseAppToFarmMessage({ source: 'ficus-app', v: 2, type: 'handoff', code: 'x' })).toBeNull()
    expect(parseAppToFarmMessage({ source: 'ficus-app', v: 1, type: 'navigate', path: '/' })).toBeNull()
    expect(parseFarmToAppMessage({ source: 'ficus-farm', v: 1, type: 'haptic', kind: 'earthquake' })).toBeNull()
    expect(parseAppToFarmMessage('{not json')).toBeNull()
    expect(parseAppToFarmMessage({ source: 'ficus-app', v: 1, type: 'handoff', code: '' })).toBeNull()
    expect(parseAppToFarmMessage({ source: 'ficus-app', v: 1, type: 'handoff', code: 'x'.repeat(300) })).toBeNull()
  })

  it('checks a theme, keeping it when only its custom document is invalid', () => {
    const base = { source: 'ficus-app', v: 1, type: 'theme' }
    expect(
      parseAppToFarmMessage({ ...base, theme: { themeId: 'iris', appearance: 'sepia', customTheme: null } })
    ).toBeNull()
    expect(
      parseAppToFarmMessage({ ...base, theme: { themeId: 'iris', appearance: 'system', customTheme: { junk: true } } })
    ).toEqual({ type: 'theme', theme: { themeId: 'iris', appearance: 'system', customTheme: null } })
  })

  it('reads the bootstrap the app sets before load', () => {
    expect(
      parseFarmEmbedBootstrap({ v: 1, handoff: 'ficus_wh_abc', theme: { themeId: 'ficus', appearance: 'light' } })
    ).toEqual({ v: 1, handoff: 'ficus_wh_abc', theme: { themeId: 'ficus', appearance: 'light', customTheme: null } })
    expect(parseFarmEmbedBootstrap({ v: 1 })).toEqual({ v: 1 })
    expect(parseFarmEmbedBootstrap({ v: 9, handoff: 'x' })).toBeNull()
    expect(parseFarmEmbedBootstrap(undefined)).toBeNull()
  })
})
