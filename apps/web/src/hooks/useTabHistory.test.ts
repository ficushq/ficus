import { beforeEach, describe, expect, test } from 'bun:test'
import {
  getTabKey,
  getTabNavigationTarget,
  getTabPath,
  recordTabPath,
  resetTabHistory,
  TAB_ROOTS,
} from './useTabHistory'

describe('useTabHistory store', () => {
  beforeEach(() => resetTabHistory())

  test('getTabKey maps known prefixes', () => {
    expect(getTabKey('/')).toBe('feed')
    expect(getTabKey('/feed')).toBe('feed')
    expect(getTabKey('/feed/today')).toBe('feed')
    expect(getTabKey('/actions')).toBe('feed')
    expect(getTabKey('/actions/123')).toBe('feed')
    expect(getTabKey('/squads')).toBe('squads')
    expect(getTabKey('/squads/abc?tab=agents')).toBe('squads')
    // The retired chat page only redirects, so it is no tab of its own.
    expect(getTabKey('/chat')).toBeNull()
    expect(getTabKey('/chat/agent-1')).toBeNull()
    expect(getTabKey('/inbox')).toBe('inbox')
    expect(getTabKey('/schedules')).toBe('schedules')
    expect(getTabKey('/settings')).toBe('settings')
    expect(getTabKey('/voice')).toBeNull()
  })

  test('records and returns last path per tab; falls back to root', () => {
    expect(getTabPath('squads')).toBe('/squads')
    recordTabPath('/squads/abc?tab=agents')
    expect(getTabPath('squads')).toBe('/squads/abc?tab=agents')
    recordTabPath('/inbox')
    expect(getTabPath('inbox')).toBe('/inbox')
    expect(getTabPath('squads')).toBe('/squads/abc?tab=agents')
  })

  test('ignores unknown routes', () => {
    recordTabPath('/voice')
    expect(getTabPath('feed')).toBe('/')
  })

  test('gets the target URL for mobile tab navigation', () => {
    recordTabPath('/squads/abc?tab=agents')

    expect(getTabNavigationTarget('/inbox', '/squads')).toBe('/squads/abc?tab=agents')
    expect(getTabNavigationTarget('/squads/abc?tab=agents', '/squads')).toBe('/squads')
    expect(getTabNavigationTarget('/inbox', '/unknown')).toBe('/unknown')
  })

  test('TAB_ROOTS exposes ordered tab list', () => {
    expect(TAB_ROOTS.map((tab) => tab.key)).toEqual(['feed', 'squads', 'inbox', 'schedules', 'settings'])
  })
})
