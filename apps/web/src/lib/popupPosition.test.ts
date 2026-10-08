import { describe, expect, test } from 'bun:test'
import { intersectBoxes, placePopup, type Box } from './popupPosition'

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

  test('start alignment lines up left edges, with an inward offset', () => {
    const place = placePopup(anchorAt(40, 20), content, viewport, { align: 'start', alignOffset: 4 })
    expect(place.left).toBe(44)
    const end = placePopup(anchorAt(250, 20), content, viewport, { alignOffset: 8 })
    expect(end.left + end.width).toBe(286 - 8)
  })

  test('prefers above when asked, and flips below when above is short', () => {
    const above = placePopup(anchorAt(100, 200), { width: 192, height: 80 }, viewport, { side: 'above', gap: 8 })
    expect(above.side).toBe('above')
    expect(above.top + 80).toBe(200 - 8)
    const flipped = placePopup(anchorAt(100, 20), { width: 192, height: 80 }, viewport, { side: 'above' })
    expect(flipped.side).toBe('below')
    expectInside(flipped, 80)
  })

  test('an unlimited max height still stops at the viewport', () => {
    const place = placePopup(anchorAt(100, 20), { width: 192, height: 2000 }, viewport, { maxHeight: Infinity })
    expect(place.maxHeight).toBe(260 - 20 - 36 - 6 - 8)
    expectInside(place, 2000)
  })

  test('a boundary intersected with the viewport keeps the popup inside both', () => {
    const region = intersectBoxes(viewport, { left: 0, top: 0, right: 320, bottom: 180 })
    expect(region).toEqual({ left: 0, top: 0, right: 320, bottom: 180 })
    const place = placePopup(anchorAt(100, 40), { width: 192, height: 400 }, region, { maxHeight: Infinity })
    expectInside(place, 400, region)
    expect(intersectBoxes(viewport, { left: 400, top: 400, right: 500, bottom: 500 })).toEqual({
      left: 400,
      top: 400,
      right: 400,
      bottom: 400,
    })
  })
})
