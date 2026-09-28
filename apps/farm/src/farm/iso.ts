/**
 * Isometric projection for the farm. World tiles are addressed by (i, j):
 * i runs down-right, j runs down-left. A tile is TILE_W wide and TILE_H tall
 * on screen. Screen coordinates here are "world pixels"; the camera applies
 * pan and zoom on top.
 */
export const TILE_W = 96
export const TILE_H = 48

export type Point = readonly [x: number, y: number]

export function iso(i: number, j: number): Point {
  return [((i - j) * TILE_W) / 2, ((i + j) * TILE_H) / 2]
}

/** An SVG `points` entry for tile corner (i, j), optionally raised/lowered by dy pixels. */
export function pt(i: number, j: number, dy = 0): string {
  const [x, y] = iso(i, j)
  return `${round(x)},${round(y + dy)}`
}

/** The four corners of the rectangle [i0, i0+w] × [j0, j0+h] as a polygon. */
export function rect(i0: number, j0: number, w: number, h: number, dy = 0): string {
  return `${pt(i0, j0, dy)} ${pt(i0 + w, j0, dy)} ${pt(i0 + w, j0 + h, dy)} ${pt(i0, j0 + h, dy)}`
}

/** Painter's-order key: things further down-screen draw later. */
export function depth(i: number, j: number): number {
  return i + j
}

/** Screen-space bounding box of a tile rectangle. */
export function screenBounds(minI: number, maxI: number, minJ: number, maxJ: number) {
  const corners = [iso(minI, minJ), iso(maxI, minJ), iso(maxI, maxJ), iso(minI, maxJ)]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
