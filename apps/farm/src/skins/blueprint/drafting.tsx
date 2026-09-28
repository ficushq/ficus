import { createContext, useContext, type SVGAttributes } from 'react'

/**
 * How Blueprint's drawings are put on paper. Blueprint itself draws them
 * exactly, as a technical sheet; another style (Sketchbook) can draw the very
 * same sprites through its own pen, with its own shading and washes, by
 * providing a different value around them.
 */
export interface Drafting {
  /** Redraws an exact path the way this style draws; null draws it exactly. */
  pen: ((d: string) => string) | null
  /** Draughtsman's marks: dimensions, setback lines, hidden edges, the compass. */
  technical: boolean
  /** Fill laid over a solid's shaded (right-hand) face, if any. */
  shade?: string
  /** Colour washed under leaves and tree crowns, if any. */
  leafWash?: string
  /** Colour plants are drawn in, if not the ink. */
  leafInk?: string
  /** Colour washed into ripe produce, if any. */
  fruitWash?: string
  /** Lettering size relative to Blueprint's (handwriting runs small). */
  letterScale: number
}

export const BLUEPRINT_DRAFTING: Drafting = { pen: null, technical: true, letterScale: 1 }

export const DraftingContext = createContext<Drafting>(BLUEPRINT_DRAFTING)

export function useDrafting(): Drafting {
  return useContext(DraftingContext)
}

type Paint = Omit<SVGAttributes<SVGElement>, 'd' | 'cx' | 'cy' | 'r' | 'rx' | 'ry' | 'x' | 'y' | 'width' | 'height'>

const n = (v: number) => Math.round(v * 100) / 100

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${n(cx - rx)} ${n(cy)} A${n(rx)} ${n(ry)} 0 1 0 ${n(cx + rx)} ${n(cy)} A${n(rx)} ${n(ry)} 0 1 0 ${n(cx - rx)} ${n(cy)} Z`
}

function rectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (!r) return `M${n(x)} ${n(y)} H${n(x + w)} V${n(y + h)} H${n(x)} Z`
  const a = `A${n(r)} ${n(r)} 0 0 1`
  return [
    `M${n(x + r)} ${n(y)} H${n(x + w - r)} ${a} ${n(x + w)} ${n(y + r)}`,
    `V${n(y + h - r)} ${a} ${n(x + w - r)} ${n(y + h)}`,
    `H${n(x + r)} ${a} ${n(x)} ${n(y + h - r)}`,
    `V${n(y + r)} ${a} ${n(x + r)} ${n(y)} Z`,
  ].join(' ')
}

/* The shapes the sprites draw with: exact SVG elements, or paths through the pen. */

export function Path({ d, ...paint }: Paint & { d: string }) {
  const { pen } = useDrafting()
  return <path d={pen ? pen(d) : d} {...paint} />
}

export function Circle({ cx = 0, cy = 0, r, ...paint }: Paint & { cx?: number; cy?: number; r: number }) {
  const { pen } = useDrafting()
  if (!pen) return <circle cx={cx} cy={cy} r={r} {...paint} />
  return <path d={pen(ellipsePath(cx, cy, r, r))} {...paint} />
}

export function Ellipse({
  cx = 0,
  cy = 0,
  rx,
  ry,
  ...paint
}: Paint & { cx?: number; cy?: number; rx: number; ry: number }) {
  const { pen } = useDrafting()
  if (!pen) return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} {...paint} />
  return <path d={pen(ellipsePath(cx, cy, rx, ry))} {...paint} />
}

export function Rect({
  x,
  y,
  width,
  height,
  rx = 0,
  ...paint
}: Paint & { x: number; y: number; width: number; height: number; rx?: number }) {
  const { pen } = useDrafting()
  if (!pen) return <rect x={x} y={y} width={width} height={height} rx={rx || undefined} {...paint} />
  return <path d={pen(rectPath(x, y, width, height, rx))} {...paint} />
}
