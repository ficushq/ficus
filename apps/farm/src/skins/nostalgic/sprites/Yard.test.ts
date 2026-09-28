import { describe, expect, it } from 'bun:test'
import { yardFrontPieces } from './Yard'

describe('yardFrontPieces', () => {
  const yard = { i0: 2, j0: 3, w: 4.5, h: 3 }
  const pieces = yardFrontPieces(yard)

  it('keeps every stretch to about a tile so it sorts near what stands beside it', () => {
    expect(pieces.length).toBeGreaterThan(5)
    expect(new Set(pieces.map((p) => p.key)).size).toBe(pieces.length)
  })

  it('draws under a robot standing just outside the gate, whatever the yard width', () => {
    // The farmer stands a little in front of the front edge, right of the gate (see layout.ts).
    const farmer = { i: yard.i0 + yard.w / 2 + 1.2, j: yard.j0 + yard.h + 0.55 }
    const front = pieces
      .filter((p) => p.key.startsWith('f'))
      .map((p) => ({ start: Number(p.key.slice(1)), depth: p.depth }))
      .sort((x, y) => x.start - y.start)
    // The stretch of front fence the farmer stands in front of.
    const behind = front.filter((p) => p.start <= farmer.i).at(-1)!
    expect(behind.depth).toBeLessThan(farmer.i + farmer.j)
  })

  it('leaves the gate open', () => {
    const gateMid = yard.i0 + yard.w / 2 + yard.j0 + yard.h
    expect(pieces.some((p) => p.key.startsWith('f') && Math.abs(p.depth - gateMid) < 0.3)).toBe(false)
  })
})
