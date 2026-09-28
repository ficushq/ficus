import type { ReactNode } from 'react'
import { iso } from '../../../farm/iso'

/*
 * The Cozy style's drawing kit. Everything is soft and rounded with no ink
 * outlines: a shape is its colour, a gentle rim a shade darker, a soft shadow
 * underneath and a glossy highlight up top. The shading is colour-agnostic
 * overlays (#cz-shade, #cz-shine), so any colour — a robot's shell, a hat —
 * looks lit the same way.
 */

export const FONT = "'Fredoka Variable', 'Nunito Variable', ui-rounded, system-ui, sans-serif"
export const TEXT = '#6b5a45'

/** A colour a little darker, for rims and the shaded sides of things. */
export const rim = (color: string, amount = 28) => `color-mix(in srgb, ${color} ${100 - amount}%, #4a3550)`
/** A colour a little lighter, for sunlit faces. */
export const light = (color: string, amount = 30) => `color-mix(in srgb, ${color} ${100 - amount}%, #ffffff)`

/** Sphere fills for the colours the world uses most (trees, hedges, fruit): light top-left, darker bottom-right. */
const SPHERES: Record<string, string> = {
  leaf: '#7ccf6b',
  hedge: '#63c071',
  deep: '#4fae62',
  apple: '#f0605a',
  orange: '#f7a13c',
  peach: '#f8a9a0',
  pumpkin: '#f59c3c',
  tomato: '#ef5a4c',
  bud: '#9bd96f',
  sky: '#8fd3f2',
}

export const sphere = (name: keyof typeof SPHERES) => `url(#cz-sphere-${name})`

export function CozyDefs() {
  return (
    <defs>
      <radialGradient id="cz-shine" cx="0.34" cy="0.26" r="0.62">
        <stop offset="0" stopColor="#fff" stopOpacity="0.7" />
        <stop offset="0.35" stopColor="#fff" stopOpacity="0.22" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="cz-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.45" stopColor="#3b2a55" stopOpacity="0" />
        <stop offset="1" stopColor="#3b2a55" stopOpacity="0.22" />
      </linearGradient>
      <radialGradient id="cz-drop">
        <stop offset="0" stopColor="#3f6b35" stopOpacity="0.34" />
        <stop offset="0.6" stopColor="#3f6b35" stopOpacity="0.16" />
        <stop offset="1" stopColor="#3f6b35" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="cz-glow">
        <stop offset="0" stopColor="#fff6b0" stopOpacity="0.95" />
        <stop offset="1" stopColor="#fff6b0" stopOpacity="0" />
      </radialGradient>
      <linearGradient id="cz-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
        <stop offset="0.5" stopColor="#dff4ff" stopOpacity="0.18" />
        <stop offset="1" stopColor="#bfe6ff" stopOpacity="0.3" />
      </linearGradient>
      {Object.entries(SPHERES).map(([name, color]) => (
        <radialGradient key={name} id={`cz-sphere-${name}`} cx="0.36" cy="0.3" r="0.75">
          <stop offset="0" stopColor={light(color, 45)} />
          <stop offset="0.45" stopColor={color} />
          <stop offset="1" stopColor={rim(color, 30)} />
        </radialGradient>
      ))}
    </defs>
  )
}

/** A soft, blurry-looking shadow on the ground (a gradient, not a filter, so it costs nothing to pan). */
export function Drop({ rx, ry, cx = 0, cy = 0 }: { rx: number; ry: number; cx?: number; cy?: number }) {
  return <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#cz-drop)" />
}

/** Shade and highlight laid over a shape already drawn in its colour. */
function Lit({ children }: { children: (fill: string) => ReactNode }) {
  return (
    <>
      {children('url(#cz-shade)')}
      {children('url(#cz-shine)')}
    </>
  )
}

/** A lit ball of any colour. */
export function Ball({
  cx = 0,
  cy = 0,
  r,
  fill,
  edge = true,
}: {
  cx?: number
  cy?: number
  r: number
  fill: string
  edge?: boolean
}) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={fill} stroke={edge ? rim(fill) : 'none'} strokeWidth={1.3} />
      <Lit>{(f) => <circle cx={cx} cy={cy} r={r} fill={f} />}</Lit>
    </g>
  )
}

/** A lit oval of any colour. */
export function Bean({
  cx = 0,
  cy = 0,
  rx,
  ry,
  fill,
  rotate,
}: {
  cx?: number
  cy?: number
  rx: number
  ry: number
  fill: string
  rotate?: number
}) {
  const transform = rotate ? `rotate(${rotate} ${cx} ${cy})` : undefined
  return (
    <g transform={transform}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} stroke={rim(fill)} strokeWidth={1.3} />
      <Lit>{(f) => <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={f} />}</Lit>
    </g>
  )
}

/** A lit rounded rectangle of any colour. */
export function Pill({
  x,
  y,
  width,
  height,
  r,
  fill,
}: {
  x: number
  y: number
  width: number
  height: number
  r: number
  fill: string
}) {
  const box = { x, y, width, height, rx: r }
  return (
    <g>
      <rect {...box} fill={fill} stroke={rim(fill)} strokeWidth={1.3} />
      <Lit>{(f) => <rect {...box} fill={f} />}</Lit>
    </g>
  )
}

/** A lit shape from a path, with its corners softened. */
export function Blob({ d, fill, shine = true }: { d: string; fill: string; shine?: boolean }) {
  return (
    <g>
      <path d={d} fill={fill} stroke={rim(fill)} strokeWidth={1.3} strokeLinejoin="round" />
      <path d={d} fill="url(#cz-shade)" />
      {shine && <path d={d} fill="url(#cz-shine)" />}
    </g>
  )
}

/** One face of a solid: its colour with corners rounded by a stroke of the same colour. */
export function Face({ points, fill, round = 5 }: { points: string; fill: string; round?: number }) {
  return <polygon points={points} fill={fill} stroke={fill} strokeWidth={round} strokeLinejoin="round" />
}

/** A tile-space point (i, j, up px) in screen pixels. */
export function xy(i: number, j: number, up = 0): [number, number] {
  const [x, y] = iso(i, j)
  return [Math.round(x * 10) / 10, Math.round((y - up) * 10) / 10]
}

/** A tile-space point as "x y", for path data and transforms. */
export const at = (i: number, j: number, up = 0) => xy(i, j, up).join(' ')

/** A tile-space point (i, j, up px) as "x,y" for polygon points. */
export function p(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${Math.round(x * 10) / 10},${Math.round((y - up) * 10) / 10}`
}

/** A box's three visible faces around the anchor (i a..b, j c..e, up z0..z1), lit from the upper left. */
export function Block({
  a,
  b,
  c,
  e,
  z0 = 0,
  z1,
  color,
  top,
  round = 5,
}: {
  a: number
  b: number
  c: number
  e: number
  z0?: number
  z1: number
  color: string
  top?: string
  round?: number
}) {
  return (
    <g>
      <Face
        points={`${p(a, e, z0)} ${p(b, e, z0)} ${p(b, e, z1)} ${p(a, e, z1)}`}
        fill={light(color, 8)}
        round={round}
      />
      <Face
        points={`${p(b, e, z0)} ${p(b, c, z0)} ${p(b, c, z1)} ${p(b, e, z1)}`}
        fill={rim(color, 16)}
        round={round}
      />
      <Face
        points={`${p(a, c, z1)} ${p(b, c, z1)} ${p(b, e, z1)} ${p(a, e, z1)}`}
        fill={top ?? light(color, 30)}
        round={round}
      />
    </g>
  )
}

/** Rounded lettering with a soft cream halo, for signs and labels. */
export function Lettering({
  x = 0,
  y,
  size = 13,
  fill = TEXT,
  anchor = 'middle',
  weight = 600,
  children,
}: {
  x?: number
  y: number
  size?: number
  fill?: string
  anchor?: 'start' | 'middle' | 'end'
  weight?: number
  children: ReactNode
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontFamily={FONT}
      fontWeight={weight}
      fontSize={size}
      fill={fill}
      stroke="#fffaf0"
      strokeWidth={3}
      strokeLinejoin="round"
      paintOrder="stroke"
    >
      {children}
    </text>
  )
}

/** A small stable hash for scattering decoration (same tile, same result). */
export function scatter(...parts: number[]): number {
  let h = 2166136261
  for (const part of parts) {
    h ^= part & 0xffff
    h = Math.imul(h, 16777619)
    h ^= part >>> 16
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
