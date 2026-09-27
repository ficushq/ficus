import type { ReactNode } from 'react'

/** Outline ink used everywhere (scenery softens it via `.g-soft`). */
export const INK = '#3b2415'
export const FONT_DISPLAY = "'Fraunces Variable', Fraunces, Georgia, serif"

/** A teardrop leaf, base at (0,0), tip at (0,-30). */
export const LEAF_PATH =
  'M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z'

/** Small deterministic integer hash (for variety from a seed). */
export function hash(...parts: number[]): number {
  let h = 2166136261
  for (const p of parts) {
    h ^= Math.floor(p * 1000) | 0
    h = Math.imul(h, 16777619)
    h ^= h >>> 13
  }
  return h >>> 0
}

/** Deterministic 0..1 from a seed. */
export function rand01(...parts: number[]): number {
  return (hash(...parts) % 10000) / 10000
}

export function pick<T>(list: readonly T[], ...seed: number[]): T {
  return list[hash(...seed) % list.length] as T
}

/** Mix two #rrggbb colours: t=0 gives a, t=1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a)
  const pb = parseHex(b)
  const out = pa.map((v, k) => Math.round(v + ((pb[k] ?? 0) - v) * t))
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): number[] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((k) => parseInt(h.slice(k, k + 2), 16))
}

export function Shadow({ rx, ry, opacity = 0.22 }: { rx: number; ry: number; opacity?: number }) {
  return <ellipse rx={rx} ry={ry} fill="#2a1a0e" opacity={opacity} />
}

export function Leaf({
  x,
  y,
  r,
  s,
  fill = 'url(#g-leaf)',
  vein = true,
}: {
  x: number
  y: number
  r: number
  s: number
  fill?: string
  vein?: boolean
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      <path d={LEAF_PATH} fill={fill} className="g-ol" />
      {vein && (
        <>
          <path d="M0 -3 V-25" stroke="#2c4d36" strokeWidth={1 / s} opacity={0.5} />
          <path
            d="M-2 -8 C-6 -12 -6 -18 -3 -23"
            stroke="#fff"
            strokeOpacity={0.45}
            strokeWidth={1.8 / s}
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
    </g>
  )
}

/** Four-point twinkle star. */
export function Spark({ x, y, s = 1, late = false }: { x: number; y: number; s?: number; late?: boolean }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <path
        className={late ? 'g-twinkle g-t2' : 'g-twinkle'}
        d="M0 -7 L1.8 -1.8 L7 0 L1.8 1.8 L0 7 L-1.8 1.8 L-7 0 L-1.8 -1.8Z"
        fill="#fff8d6"
        stroke={INK}
        strokeWidth={1}
      />
    </g>
  )
}

/** Wrapper that positions an animated child without mixing `transform=` and CSS transforms. */
export function At({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <g transform={`translate(${x} ${y})`}>{children}</g>
}
