import { iso } from '../../farm/iso'
import type { FarmLayout } from '../../farm/types'

/** A point `up` pixels above tile (i, j), as an SVG coordinate pair. */
export function at(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${x.toFixed(1)} ${(y - up).toFixed(1)}`
}

/**
 * The visible edges of a wireframe box centred on the anchor: w × d tiles,
 * h pixels tall. Back edges are returned separately so they can be dimmed.
 */
export function boxEdges(w: number, d: number, h: number): { front: string; back: string } {
  const a = -w / 2
  const b = w / 2
  const c = -d / 2
  const e = d / 2
  const L = (p: string, q: string) => `M${p} L${q}`
  const front = [
    // base, front two sides
    L(at(a, e), at(b, e)),
    L(at(b, e), at(b, c)),
    // verticals
    L(at(a, e), at(a, e, h)),
    L(at(b, e), at(b, e, h)),
    L(at(b, c), at(b, c, h)),
    // top
    L(at(a, e, h), at(b, e, h)),
    L(at(b, e, h), at(b, c, h)),
    L(at(b, c, h), at(a, c, h)),
    L(at(a, c, h), at(a, e, h)),
  ].join(' ')
  const back = [L(at(a, e), at(a, c)), L(at(a, c), at(b, c)), L(at(a, c), at(a, c, h))].join(' ')
  return { front, back }
}

/** A flat diamond (tile rectangle) path, optionally inset from the tile edges. */
export function diamond(i0: number, j0: number, w: number, h: number, inset = 0, up = 0): string {
  const a = i0 + inset
  const b = i0 + w - inset
  const c = j0 + inset
  const e = j0 + h - inset
  return `M${at(a, c, up)} L${at(b, c, up)} L${at(b, e, up)} L${at(a, e, up)} Z`
}

/**
 * Grid lines over the farm and `pad` tiles past it: minor every tile, major
 * every `every`, as two paths, plus the screen box they cover.
 */
export function gridLines(
  bounds: FarmLayout['bounds'],
  pad = 12,
  every = 4
): { minor: string; major: string; box: { x: number; y: number; w: number; h: number } } {
  const minI = Math.floor(bounds.minI) - pad
  const maxI = Math.ceil(bounds.maxI) + pad
  const minJ = Math.floor(bounds.minJ) - pad
  const maxJ = Math.ceil(bounds.maxJ) + pad
  let minor = ''
  let major = ''
  for (let i = minI; i <= maxI; i++) {
    const seg = `M${at(i, minJ)} L${at(i, maxJ)} `
    if (i % every === 0) major += seg
    else minor += seg
  }
  for (let j = minJ; j <= maxJ; j++) {
    const seg = `M${at(minI, j)} L${at(maxI, j)} `
    if (j % every === 0) major += seg
    else minor += seg
  }
  const corners = [iso(minI, minJ), iso(maxI, minJ), iso(maxI, maxJ), iso(minI, maxJ)]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { minor, major, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } }
}

/** A point in tile space: i, j and pixels up. */
export type TilePoint = readonly [i: number, j: number, up?: number]

/** A polygon (or, open, a polyline) through tile-space points. */
export function poly(points: readonly TilePoint[], close = true): string {
  const d = points.map((p, k) => `${k ? 'L' : 'M'}${at(p[0], p[1], p[2] ?? 0)}`).join(' ')
  return close ? `${d} Z` : d
}
