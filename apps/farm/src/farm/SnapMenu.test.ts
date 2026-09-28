import { describe, expect, it } from 'bun:test'
import { snapForKey } from './SnapMenu'

const press = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {}) => ({
  code,
  ctrlKey: true,
  altKey: true,
  metaKey: false,
  shiftKey: false,
  ...mods,
})

describe('snap shortcuts', () => {
  it('map Ctrl+Option with arrows, U I J K, D F G and Enter to their places', () => {
    expect(snapForKey(press('ArrowLeft'))).toBe('left')
    expect(snapForKey(press('ArrowDown'))).toBe('bottom')
    expect(snapForKey(press('KeyU'))).toBe('top-left')
    expect(snapForKey(press('KeyK'))).toBe('bottom-right')
    expect(snapForKey(press('KeyF'))).toBe('middle-third')
    expect(snapForKey(press('Enter'))).toBe('full')
  })

  it('need exactly Ctrl and Option held', () => {
    expect(snapForKey(press('ArrowLeft', { altKey: false }))).toBeNull()
    expect(snapForKey(press('ArrowLeft', { ctrlKey: false }))).toBeNull()
    expect(snapForKey(press('ArrowLeft', { shiftKey: true }))).toBeNull()
    expect(snapForKey(press('ArrowLeft', { metaKey: true }))).toBeNull()
    expect(snapForKey(press('KeyZ'))).toBeNull()
  })
})
