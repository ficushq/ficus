import { describe, expect, test } from 'bun:test'
import { clampSidebarWidth } from './useSidebarWidth'

describe('clampSidebarWidth', () => {
  test('keeps a width within the bounds and rounds it', () => {
    expect(clampSidebarWidth(320.4, { min: 200, max: 520 })).toBe(320)
    expect(clampSidebarWidth(120, { min: 200, max: 520 })).toBe(200)
    expect(clampSidebarWidth(900, { min: 200, max: 520 })).toBe(520)
  })

  test('never goes below the min when a narrow container shrinks the max under it', () => {
    expect(clampSidebarWidth(400, { min: 200, max: 150 })).toBe(200)
  })
})
