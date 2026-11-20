import { describe, expect, test } from 'bun:test'
import {
  dragSnapTarget,
  edgeSnapAt,
  resizeRect,
  SNAPS,
  snapRect,
  snapZoneAt,
  snapZoneLayout,
  unsnapUnderPointer,
  type Snap,
} from './floatingWindow'

const screen = { width: 1200, height: 900 }
const min = { w: 340, h: 300 }

describe('snapping by dragging to a screen edge', () => {
  test('the left and right edges are halves, the top fills the screen and the bottom is the bottom half', () => {
    expect(edgeSnapAt({ x: 0, y: 450 }, screen)).toBe('left')
    expect(edgeSnapAt({ x: -40, y: 450 }, screen)).toBe('left')
    expect(edgeSnapAt({ x: 1199, y: 450 }, screen)).toBe('right')
    expect(edgeSnapAt({ x: 600, y: 0 }, screen)).toBe('full')
    expect(edgeSnapAt({ x: 600, y: 899 }, screen)).toBe('bottom')
  })

  test('a corner, reached along either edge, is that quarter', () => {
    expect(edgeSnapAt({ x: 0, y: 30 }, screen)).toBe('top-left')
    expect(edgeSnapAt({ x: 40, y: 2 }, screen)).toBe('top-left')
    expect(edgeSnapAt({ x: 1200, y: 20 }, screen)).toBe('top-right')
    expect(edgeSnapAt({ x: 3, y: 880 }, screen)).toBe('bottom-left')
    expect(edgeSnapAt({ x: 1150, y: 900 }, screen)).toBe('bottom-right')
  })

  test('away from every edge nothing snaps', () => {
    expect(edgeSnapAt({ x: 20, y: 450 }, screen)).toBeNull()
    expect(edgeSnapAt({ x: 600, y: 890 }, screen)).toBeNull()
    expect(edgeSnapAt({ x: 600, y: 400 }, screen)).toBeNull()
  })
})

describe('the snap-zone picker', () => {
  test('sits near the top center and offers every region the layout menu does, thirds included', () => {
    const layout = snapZoneLayout(screen)
    expect(layout.frame.y).toBeGreaterThan(6)
    expect(Math.abs(layout.frame.x + layout.frame.w / 2 - 600)).toBeLessThanOrEqual(1)
    const offered = layout.groups.flatMap((group) => group.zones.map((zone) => zone.snap))
    expect(new Set(offered)).toEqual(new Set(SNAPS))
    // The middle of each zone picks that zone.
    for (const group of layout.groups)
      for (const zone of group.zones)
        expect(snapZoneAt({ x: zone.rect.x + zone.rect.w / 2, y: zone.rect.y + zone.rect.h / 2 }, layout)).toBe(
          zone.snap
        )
    expect(snapZoneAt({ x: 10, y: 400 }, layout)).toBeNull()
  })

  test('a picker zone wins over the top edge; elsewhere the edge applies', () => {
    const layout = snapZoneLayout(screen)
    const middle = layout.groups[3]!.zones.find((zone) => zone.snap === 'middle-third')!.rect
    expect(dragSnapTarget({ x: middle.x + 2, y: middle.y + 2 }, screen)).toEqual({
      snap: 'middle-third',
      source: 'zone',
    })
    expect(dragSnapTarget({ x: 0, y: 450 }, screen)).toEqual({ snap: 'left', source: 'edge' })
    expect(dragSnapTarget({ x: 300, y: 300 }, screen)).toBeNull()
  })
})

describe('dragging a snapped window out of its snap', () => {
  test('takes back its free size, keeping the grabbed point under the pointer', () => {
    const snapped = snapRect('left', screen)
    // Grabbed a quarter of the way across its title bar, 14px below its top.
    const grab = { x: snapped.x + snapped.w / 4, y: snapped.y + 14 }
    const restored = unsnapUnderPointer(snapped, { w: 400, h: 500 }, grab)
    expect(restored).toEqual({ x: Math.round(grab.x - 100), y: snapped.y, w: 400, h: 500 })
  })
})

describe('resizing from any edge', () => {
  const start = { x: 300, y: 200, w: 500, h: 400 }
  test('each edge moves only itself, and the opposite edges stay put', () => {
    expect(resizeRect(start, 'e', 50, 99, screen, min)).toEqual({ x: 300, y: 200, w: 550, h: 400 })
    expect(resizeRect(start, 'w', -50, 99, screen, min)).toEqual({ x: 250, y: 200, w: 550, h: 400 })
    expect(resizeRect(start, 'n', 99, -40, screen, min)).toEqual({ x: 300, y: 160, w: 500, h: 440 })
    expect(resizeRect(start, 's', 99, 40, screen, min)).toEqual({ x: 300, y: 200, w: 500, h: 440 })
    expect(resizeRect(start, 'nw', 20, 20, screen, min)).toEqual({ x: 320, y: 220, w: 480, h: 380 })
    expect(resizeRect(start, 'se', 100, 60, screen, min)).toEqual({ x: 300, y: 200, w: 600, h: 460 })
  })

  test('never below the minimum size, and never past the screen', () => {
    // Shrinking from the left stops at the minimum width, with the right edge where it was.
    expect(resizeRect(start, 'w', 400, 0, screen, min)).toEqual({ x: 460, y: 200, w: 340, h: 400 })
    expect(resizeRect(start, 'n', 0, 400, screen, min)).toEqual({ x: 300, y: 300, w: 500, h: 300 })
    expect(resizeRect(start, 'w', -600, 0, screen, min)).toEqual({ x: 8, y: 200, w: 792, h: 400 })
    expect(resizeRect(start, 'se', 2000, 2000, screen, min)).toEqual({ x: 300, y: 200, w: 892, h: 692 })
  })
})

test('every snap region stays inside the screen margins', () => {
  for (const snap of SNAPS as readonly Snap[]) {
    const rect = snapRect(snap, screen)
    expect(rect.x).toBeGreaterThanOrEqual(8)
    expect(rect.y).toBeGreaterThanOrEqual(8)
    expect(rect.x + rect.w).toBeLessThanOrEqual(1192)
    expect(rect.y + rect.h).toBeLessThanOrEqual(892)
  }
})
