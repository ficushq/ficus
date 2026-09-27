import type { ReactNode } from 'react'
import { iso, rect } from '../iso'
import { FONT_DISPLAY, INK, Shadow } from './shared'

type Corner = readonly [i: number, j: number]

/** Fraction of the front edge (from the left) where the gate gap starts and ends. */
const GATE_FROM = 0.35
const GATE_TO = 0.65

function Post({ at: [i, j] }: { at: Corner }) {
  const [x, y] = iso(i, j)
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-3} y={-20} width={6} height={21} rx={1.5} fill="url(#g-wood)" className="g-ol" />
      <rect x={-3} y={-20} width={6} height={3} rx={1.5} fill="#d9a871" />
    </g>
  )
}

function Rails({ from, to }: { from: Corner; to: Corner }) {
  const [x1, y1] = iso(...from)
  const [x2, y2] = iso(...to)
  return (
    <>
      {[15, 7].map((h) => (
        <g key={h}>
          <path d={`M${x1} ${y1 - h} L${x2} ${y2 - h}`} stroke={INK} strokeWidth={5.4} strokeLinecap="round" />
          <path d={`M${x1} ${y1 - h} L${x2} ${y2 - h}`} stroke="#c99459" strokeWidth={3} strokeLinecap="round" />
        </g>
      ))}
    </>
  )
}

interface YardRect {
  i0: number
  j0: number
  w: number
  h: number
}

/** Inner grass tint plus the two back fences (along j0 and i0). Absolute world coords. */
export function YardBack({ i0, j0, w, h }: YardRect) {
  const posts: ReactNode[] = []
  for (let i = 0; i <= w; i++) posts.push(<Post key={`b${i}`} at={[i0 + i, j0]} />)
  for (let j = 1; j <= h; j++) posts.push(<Post key={`l${j}`} at={[i0, j0 + j]} />)
  return (
    <g>
      <polygon points={rect(i0, j0, w, h)} fill="#98b155" opacity={0.45} />
      <Rails from={[i0, j0]} to={[i0 + w, j0]} />
      <Rails from={[i0, j0]} to={[i0, j0 + h]} />
      {posts}
    </g>
  )
}

export interface FencePiece {
  key: string
  /** Painter's-order key (i + j of the piece's middle), so robots in front of a stretch draw over it. */
  depth: number
  node: ReactNode
}

/** Splits [from, to] into stretches no longer than one tile, breaking at whole-tile offsets from `from`. */
function stretches(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let a = from; a < to - 1e-6; a = Math.min(to, Math.floor(a - from + 1e-6) + 1 + from)) {
    out.push([a, Math.min(to, Math.floor(a - from + 1e-6) + 1 + from)])
  }
  return out
}

/**
 * The right fence and the front fence (with a gate gap in the middle third of
 * the front edge), as short pieces in absolute world coords. One long fence
 * sorted as a single sprite would paint over anyone standing just outside it,
 * so each stretch of about a tile sorts on its own.
 */
export function yardFrontPieces({ i0, j0, w, h }: YardRect): FencePiece[] {
  const front = j0 + h
  const right = i0 + w
  const gateA = i0 + w * GATE_FROM
  const gateB = i0 + w * GATE_TO
  const pieces: FencePiece[] = []
  const piece = (key: string, a: Corner, b: Corner, posts: Corner[]) =>
    pieces.push({
      key,
      depth: (a[0] + b[0]) / 2 + (a[1] + b[1]) / 2,
      node: (
        <g key={key}>
          <Rails from={a} to={b} />
          {posts.map((at) => (
            <Post key={`${at[0]}:${at[1]}`} at={at} />
          ))}
        </g>
      ),
    })
  for (const [a, b] of stretches(j0, front)) piece(`r${a}`, [right, a], [right, b], [[right, a]])
  const frontRuns: Array<[number, number]> = [
    [i0, gateA],
    [gateB, right],
  ]
  for (const [from, to] of frontRuns) {
    for (const [a, b] of stretches(from, to)) {
      const posts: Corner[] = [[a, front]]
      if (Math.abs(b - to) < 1e-6) posts.push([b, front])
      piece(`f${a}`, [a, front], [b, front], posts)
    }
  }
  return pieces
}

const SIGN_MAX_CHARS = 20
const CHAR_W = 8.5

/** The squad's signpost by the gate. Anchored at the post's foot. */
export function YardSign({ name, flag }: { name: string; flag: boolean }) {
  const label = name.length > SIGN_MAX_CHARS ? `${name.slice(0, SIGN_MAX_CHARS - 1).trimEnd()}…` : name
  const bw = Math.min(180, Math.max(80, Math.round(label.length * CHAR_W + 22)))
  const half = bw / 2
  return (
    <g>
      <Shadow rx={20} ry={5} />
      <rect x={-3} y={-30} width={6} height={30} fill="url(#g-wood)" className="g-ol" />
      <g transform="translate(0 -40)">
        <rect x={-half} y={-14} width={bw} height={26} rx={5} fill="url(#g-wood)" className="g-ol" />
        <rect x={-half + 4} y={-10} width={bw - 8} height={18} rx={3} fill="none" stroke="#8a5a33" strokeWidth={1.2} />
        <text
          y={5}
          textAnchor="middle"
          fontFamily={FONT_DISPLAY}
          fontWeight={900}
          fontSize={15}
          fill="#fffaf1"
          stroke={INK}
          strokeWidth={3}
          paintOrder="stroke"
        >
          {label}
        </text>
      </g>
      {flag && (
        <g transform={`translate(${half - 6} -54)`}>
          <path d="M0 0 V-22" stroke={INK} strokeWidth={2.4} />
          <path className="g-flagwave g-ol2" d="M0 -22 l16 5 -16 5z" fill="#d9743f" />
        </g>
      )}
    </g>
  )
}
