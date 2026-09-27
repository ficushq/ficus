import { iso } from '../../farm/iso'

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
