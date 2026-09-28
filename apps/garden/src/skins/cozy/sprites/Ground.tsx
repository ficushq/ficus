import { memo, type ReactNode } from 'react'
import { iso } from '../../../farm/iso'
import type { FencePiece, YardRect } from '../../types'
import { Drop, Face, FONT, p, rim, scatter, sphere, TEXT } from './kit'

const GRASS_A = '#a6dd7f'
const GRASS_B = '#9fd878'
const TUFT = '#86c565'
const YARD = '#bfe58f'

function tile(i: number, j: number): string {
  const [ax, ay] = iso(i, j)
  const [bx, by] = iso(i + 1, j)
  const [cx, cy] = iso(i + 1, j + 1)
  const [dx, dy] = iso(i, j + 1)
  return `M${ax} ${ay}L${bx} ${by}L${cx} ${cy}L${dx} ${dy}Z`
}

/** Soft grass: a barely-there checker, tufts, and little white flowers here and there. */
export const CozyGround = memo(function CozyGround({
  bounds,
}: {
  bounds: { minI: number; maxI: number; minJ: number; maxJ: number }
}) {
  const a: string[] = []
  const b: string[] = []
  const tufts: string[] = []
  const flowers: ReactNode[] = []
  for (let i = Math.floor(bounds.minI); i < Math.ceil(bounds.maxI); i++) {
    for (let j = Math.floor(bounds.minJ); j < Math.ceil(bounds.maxJ); j++) {
      ;((i + j) & 1 ? a : b).push(tile(i, j))
      const h = scatter(i, j, 11)
      const [x, y] = iso(i + 0.2 + ((h >>> 4) % 60) / 100, j + 0.2 + ((h >>> 11) % 60) / 100)
      if (h % 4 === 0) tufts.push(`M${x - 3} ${y}q1 -5 2 -6M${x} ${y}q0 -5 0 -7M${x + 3} ${y}q-1 -5 -2 -6`)
      else if (h % 13 === 1)
        flowers.push(
          <g key={`${i}:${j}`} transform={`translate(${x} ${y})`}>
            {[0, 72, 144, 216, 288].map((deg) => (
              <circle key={deg} cx={0} cy={-2.6} r={1.9} fill="#fffdf6" transform={`rotate(${deg})`} />
            ))}
            <circle r={1.4} fill="#f7cf4d" />
          </g>
        )
    }
  }
  return (
    <g>
      <path d={b.join('')} fill={GRASS_B} />
      <path d={a.join('')} fill={GRASS_A} />
      <path d={tufts.join('')} stroke={TUFT} strokeWidth={1.4} strokeLinecap="round" fill="none" />
      {flowers}
    </g>
  )
})

/* ---- Yards: a soft lawn ringed by round hedges ---- */

type Corner = readonly [i: number, j: number]

const GATE_FROM = 0.35
const GATE_TO = 0.65
/** Hedge balls every this many tiles along an edge. */
const STEP = 0.3

function HedgeBall({ at: [i, j], seed }: { at: Corner; seed: number }) {
  const [x, y] = iso(i, j)
  const r = 9 + (seed % 3)
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cy={-r + 2} r={r} fill={sphere('hedge')} stroke={rim('#63c071')} strokeWidth={1.2} />
      {seed % 5 === 0 && (
        <g>
          <circle cx={-3} cy={-r - 1} r={1.8} fill="#ffb3c7" />
          <circle cx={3} cy={-r + 3} r={1.6} fill="#fff1f5" />
        </g>
      )}
    </g>
  )
}

/** Hedge balls from one corner to another (inclusive), back to front. */
function hedgeRun(from: Corner, to: Corner, key: string, withEnd = true): ReactNode[] {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  const n = Math.max(1, Math.round(length / STEP))
  const balls: ReactNode[] = []
  for (let k = 0; k <= n; k++) {
    if (k === n && !withEnd) break
    const t = k / n
    const at: Corner = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
    balls.push(<HedgeBall key={`${key}:${k}`} at={at} seed={scatter(Math.round(at[0] * 10), Math.round(at[1] * 10))} />)
  }
  return balls
}

/** The lawn inside the yard and the hedges along its two back edges. */
export function CozyYardBack({ i0, j0, w, h }: YardRect) {
  return (
    <g>
      <Face points={`${p(i0, j0)} ${p(i0 + w, j0)} ${p(i0 + w, j0 + h)} ${p(i0, j0 + h)}`} fill={YARD} round={18} />
      {hedgeRun([i0, j0 + h], [i0, j0], 'l', false)}
      {hedgeRun([i0, j0], [i0 + w, j0], 'b')}
    </g>
  )
}

/** Splits [from, to] into stretches of at most a tile. */
function stretches(from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let a = from; a < to - 1e-6; ) {
    const b = Math.min(to, a + 1)
    out.push([a, b])
    a = b
  }
  return out
}

/** The right and front hedges (with a gap for the gate), in short pieces so robots in front draw over them. */
export function cozyYardFront({ i0, j0, w, h }: YardRect): FencePiece[] {
  const front = j0 + h
  const right = i0 + w
  const pieces: FencePiece[] = []
  const piece = (key: string, a: Corner, b: Corner, withEnd: boolean) =>
    pieces.push({
      key,
      depth: (a[0] + b[0]) / 2 + (a[1] + b[1]) / 2,
      node: <g key={key}>{hedgeRun(a, b, key, withEnd)}</g>,
    })
  for (const [a, b] of stretches(j0, front)) piece(`r${a}`, [right, a], [right, b], false)
  const runs: Array<[number, number]> = [
    [i0, i0 + w * GATE_FROM],
    [i0 + w * GATE_TO, right],
  ]
  for (const [from, to] of runs)
    for (const [a, b] of stretches(from, to)) piece(`f${a}`, [a, front], [b, front], Math.abs(b - to) < 1e-6)
  return pieces
}

/** The squad's wooden signboard by the gate, anchored at its feet. */
export function CozySign({ name, flag }: { name: string; flag: boolean }) {
  const label = name.length > 20 ? `${name.slice(0, 19).trimEnd()}…` : name
  const bw = Math.min(190, Math.max(84, Math.round(label.length * 9 + 28)))
  const half = bw / 2
  return (
    <g>
      <Drop rx={26} ry={6} />
      <rect x={-half + 10} y={-30} width={6} height={30} rx={3} fill="#c9905a" />
      <rect x={half - 16} y={-30} width={6} height={30} rx={3} fill="#b57e4b" />
      <g transform="translate(0 -44)">
        <rect x={-half} y={-15} width={bw} height={30} rx={11} fill="#d49a60" />
        <rect x={-half + 3} y={-12} width={bw - 6} height={23} rx={9} fill="#fff4dc" />
        <rect x={-half + 3} y={-12} width={bw - 6} height={23} rx={9} fill="url(#cz-shade)" />
        <text y={5} textAnchor="middle" fontFamily={FONT} fontWeight={600} fontSize={15} fill={TEXT}>
          {label}
        </text>
      </g>
      {flag && (
        <g transform={`translate(${half - 4} -58)`}>
          <path d="M0 2 V-20" stroke="#b57e4b" strokeWidth={2.4} strokeLinecap="round" />
          <g className="cz-wave">
            <path d="M1 -20 q9 1 15 5 q-6 4 -15 5z" fill="#ff8f7a" stroke={rim('#ff8f7a')} strokeWidth={1} />
          </g>
        </g>
      )}
    </g>
  )
}

/* ---- Garden beds ---- */

const A = 0.12
const B = 0.88
const LIFT = 5

/** A plump bed of dark soil filling tile (i, j), glowing when selected. Absolute world coords. */
export function CozyPlot({ i, j, selected }: { i: number; j: number; selected: boolean }) {
  const top = `${p(i + A, j + A, LIFT)} ${p(i + B, j + A, LIFT)} ${p(i + B, j + B, LIFT)} ${p(i + A, j + B, LIFT)}`
  return (
    <g>
      {selected && (
        <Face
          points={`${p(i - 0.02, j - 0.02)} ${p(i + 1.02, j - 0.02)} ${p(i + 1.02, j + 1.02)} ${p(i - 0.02, j + 1.02)}`}
          fill="#fff6b0"
          round={16}
        />
      )}
      <Face
        points={`${p(i + A, j + B)} ${p(i + B, j + B)} ${p(i + B, j + B, LIFT)} ${p(i + A, j + B, LIFT)}`}
        fill="#8c6245"
        round={8}
      />
      <Face
        points={`${p(i + B, j + B)} ${p(i + B, j + A)} ${p(i + B, j + A, LIFT)} ${p(i + B, j + B, LIFT)}`}
        fill="#76503a"
        round={8}
      />
      <Face points={top} fill="#a4744f" round={10} />
      {[0.32, 0.5, 0.68].map((t) =>
        [0.3, 0.5, 0.7].map((s) => {
          const [x, y] = iso(i + s, j + t)
          return <circle key={`${t}${s}`} cx={x} cy={y - LIFT} r={1.6} fill="#8d6243" />
        })
      )}
      {selected && <Face points={top} fill="#fff6b0" round={10} />}
      {selected && <polygon points={top} fill="#a4744f" opacity={0.55} />}
    </g>
  )
}
