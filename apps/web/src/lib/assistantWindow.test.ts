import { describe, expect, test } from 'bun:test'
import {
  clampPosition,
  clampRect,
  readAssistantWindow,
  saveAssistantWindow,
  snapForKey,
  snapRect,
  SNAPS,
} from './assistantWindow'

const screen = { width: 1200, height: 900 }

describe('assistant window geometry', () => {
  test('clamping keeps a free window on screen and at least its minimum size', () => {
    expect(clampRect({ x: 400, y: 200, w: 500, h: 400 }, screen)).toEqual({ x: 400, y: 200, w: 500, h: 400 })
    expect(clampRect({ x: -50, y: 2000, w: 100, h: 100 }, screen)).toEqual({ x: 8, y: 612, w: 320, h: 280 })
    expect(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, screen)).toEqual({ x: 8, y: 8, w: 1184, h: 884 })
    // An on-screen keyboard leaves 300px: the window shrinks and lifts rather than going under it.
    expect(clampRect({ x: 100, y: 160, w: 600, h: 672 }, { width: 390, height: 300 })).toEqual({
      x: 8,
      y: 8,
      w: 374,
      h: 284,
    })
  })

  test('the command bar is moved, never resized, to stay on screen', () => {
    expect(clampPosition({ x: 1100, y: -20, w: 256, h: 60 }, screen)).toEqual({ x: 936, y: 8, w: 256, h: 60 })
  })

  test('snaps fill their share of the screen, with a gap between neighbours', () => {
    expect(snapRect('full', screen)).toEqual({ x: 8, y: 8, w: 1184, h: 884 })
    expect(snapRect('left', screen)).toEqual({ x: 8, y: 8, w: 588, h: 884 })
    expect(snapRect('right', screen)).toEqual({ x: 604, y: 8, w: 588, h: 884 })
    expect(snapRect('bottom-right', screen)).toEqual({ x: 604, y: 454, w: 588, h: 438 })
    const thirds = (['left-third', 'middle-third', 'right-third'] as const).map((snap) => snapRect(snap, screen))
    expect(thirds.map((rect) => rect.w)).toEqual([389, 389, 389])
    expect(thirds[2].x + thirds[2].w).toBe(1192)
  })

  test('Ctrl+Option shortcuts pick a snap, and only with exactly those modifiers', () => {
    const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({
      ctrlKey: true,
      altKey: true,
      metaKey: false,
      shiftKey: false,
      code,
      ...extra,
    })
    expect(snapForKey(key('ArrowLeft'))).toBe('left')
    expect(snapForKey(key('KeyF'))).toBe('middle-third')
    expect(snapForKey(key('Enter'))).toBe('full')
    expect(snapForKey(key('ArrowLeft', { shiftKey: true }))).toBeNull()
    expect(snapForKey(key('ArrowLeft', { altKey: false }))).toBeNull()
    expect(snapForKey(key('KeyZ'))).toBeNull()
    expect(new Set(SNAPS.map((snap) => snapForKey(key(snapInfoCode(snap)))))).toEqual(new Set(SNAPS))
  })
})

function snapInfoCode(snap: (typeof SNAPS)[number]) {
  return {
    left: 'ArrowLeft',
    right: 'ArrowRight',
    top: 'ArrowUp',
    bottom: 'ArrowDown',
    'top-left': 'KeyU',
    'top-right': 'KeyI',
    'bottom-left': 'KeyJ',
    'bottom-right': 'KeyK',
    'left-third': 'KeyD',
    'middle-third': 'KeyF',
    'right-third': 'KeyG',
    full: 'Enter',
  }[snap]
}

describe('assistant window storage', () => {
  const memory = () => {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    }
  }

  test('round-trips a free rect or a snap, and clearing forgets it', () => {
    const storage = memory()
    saveAssistantWindow({ rect: { x: 10, y: 20, w: 400, h: 300 } }, storage)
    expect(readAssistantWindow(storage)).toEqual({ rect: { x: 10, y: 20, w: 400, h: 300 } })
    saveAssistantWindow({ snap: 'left', rect: { x: 8, y: 8, w: 588, h: 884 } }, storage)
    expect(readAssistantWindow(storage)).toEqual({ snap: 'left', rect: { x: 8, y: 8, w: 588, h: 884 } })
    saveAssistantWindow({}, storage)
    expect(storage.getItem('ficus-assistant-window')).toBeNull()
  })

  test('garbage or unavailable storage falls back to the default placement', () => {
    const storage = memory()
    storage.setItem('ficus-assistant-window', '{"rect":{"x":"a"},"snap":"sideways"}')
    expect(readAssistantWindow(storage)).toEqual({})
    storage.setItem('ficus-assistant-window', 'not json')
    expect(readAssistantWindow(storage)).toEqual({})
    const broken = {
      getItem: () => {
        throw new Error('Unavailable')
      },
      setItem: () => {
        throw new Error('Unavailable')
      },
      removeItem: () => {
        throw new Error('Unavailable')
      },
    }
    expect(readAssistantWindow(broken)).toEqual({})
    expect(() => saveAssistantWindow({ snap: 'full' }, broken)).not.toThrow()
  })
})
