import { describe, expect, test } from 'bun:test'
import { placePopup, type Box } from './popupPosition'

const viewport: Box = { left: 0, top: 0, right: 320, bottom: 260 }
const anchorAt = (left: number, top: number, size = 36): Box => ({
  left,
  top,
  right: left + size,
  bottom: top + size,
})
const content = { width: 192, height: 150 }

function expectInside(place: ReturnType<typeof placePopup>, height: number, box = viewport) {
  const shown = Math.min(height, place.maxHeight)
  expect(place.left).toBeGreaterThanOrEqual(box.left + 8)
  expect(place.top).toBeGreaterThanOrEqual(box.top + 8)
  expect(place.left + place.width).toBeLessThanOrEqual(box.right - 8)
  expect(place.top + shown).toBeLessThanOrEqual(box.bottom - 8)
}

describe('placePopup', () => {
  test('opens below, end-aligned to the anchor, when there is room', () => {
    const place = placePopup(anchorAt(250, 20), content, viewport)
    expect(place.side).toBe('below')
    expect(place.top).toBe(20 + 36 + 6)
    expect(place.left + place.width).toBe(286)
  })

  test('flips above near the bottom edge', () => {
    const place = placePopup(anchorAt(250, 210), content, viewport)
    expect(place.side).toBe('above')
    expect(place.top + Math.min(150, place.maxHeight)).toBe(210 - 6)
  })

  for (const [name, anchor] of [
    ['top-left', anchorAt(8, 8)],
    ['top-right', anchorAt(276, 8)],
    ['bottom-left', anchorAt(8, 216)],
    ['bottom-right', anchorAt(276, 216)],
  ] as const) {
    test(`stays inside a short narrow viewport at the ${name} corner`, () => {
      const tall = { width: 192, height: 600 }
      const place = placePopup(anchor, tall, viewport)
      expectInside(place, 600)
      expect(place.maxHeight).toBeLessThan(600) // content scrolls
    })
  }

  test('shrinks wide content to the viewport width', () => {
    const place = placePopup(anchorAt(100, 20), { width: 500, height: 80 }, viewport)
    expect(place.width).toBe(304)
    expect(place.left).toBe(8)
  })

  test('uses the visual viewport offset (keyboard open / panned page)', () => {
    const visual = { left: 20, top: 80, right: 320, bottom: 240 }
    const place = placePopup(anchorAt(260, 300), content, visual)
    expectInside(place, 150, visual)
  })
})
