import type { ReactNode } from 'react'
import type { PlantState } from '../../../farm/types'
import type { CropKind } from '../types'
import { At, Leaf, Spark } from './shared'

type Stage = 'young' | 'ripe' | 'wither'

function Tomato({ stage }: { stage: Stage }) {
  if (stage === 'wither') {
    return (
      <g className="g-droop">
        <path d="M0 0 C1 -10 4 -16 9 -20" fill="none" stroke="#8a6a3a" strokeWidth={3} className="g-ol2" />
        <Leaf x={2} y={-6} r={-120} s={0.5} fill="url(#g-wither)" vein={false} />
        <Leaf x={5} y={-13} r={110} s={0.45} fill="url(#g-wither)" vein={false} />
        <Leaf x={9} y={-20} r={150} s={0.55} fill="url(#g-wither)" vein={false} />
        <circle cx={11} cy={-10} r={4} fill="#8a5a33" className="g-ol2" />
      </g>
    )
  }
  const s = stage === 'young' ? 0.72 : 1
  return (
    <g className="g-sway">
      <path d={`M0 0 V${-34 * s}`} stroke="#4d7a44" strokeWidth={3.2} className="g-ol2" fill="none" />
      <Leaf x={0} y={-8 * s} r={-62} s={0.62 * s} fill="url(#g-leaf-side)" />
      <Leaf x={0} y={-8 * s} r={62} s={0.62 * s} fill="url(#g-leaf-side)" />
      <Leaf x={0} y={-18 * s} r={-38} s={0.7 * s} />
      <Leaf x={0} y={-18 * s} r={38} s={0.7 * s} />
      <Leaf x={0} y={-28 * s} r={0} s={0.78 * s} />
      {stage === 'ripe' &&
        (
          [
            [-13, -20],
            [12, -24],
            [-4, -34],
            [6, -12],
            [-10, -9],
          ] as const
        ).map(([x, y]) => (
          <g key={`${x},${y}`}>
            <circle cx={x} cy={y} r={6.2} fill="url(#g-fruit)" className="g-ol" />
            <path
              d={`M${x - 2} ${y - 6} l2 -3 2 3`}
              stroke="#3f6b4f"
              strokeWidth={1.8}
              fill="none"
              strokeLinecap="round"
            />
          </g>
        ))}
    </g>
  )
}

const RAYS_10 = Array.from({ length: 10 }, (_, k) => k * 36)
const RAYS_14 = Array.from({ length: 14 }, (_, k) => (k * 360) / 14)

function Sunflower({ stage }: { stage: Stage }) {
  if (stage === 'wither') {
    return (
      <g className="g-droop">
        <path d="M0 0 C0 -24 6 -40 16 -36" fill="none" stroke="#8a6a3a" strokeWidth={3.4} className="g-ol2" />
        <Leaf x={0} y={-12} r={-80} s={0.55} fill="url(#g-wither)" vein={false} />
        <Leaf x={1} y={-20} r={95} s={0.5} fill="url(#g-wither)" vein={false} />
        <g transform="translate(17 -32) rotate(70)">
          {RAYS_10.map((r) => (
            <ellipse key={r} rx={3} ry={6} cy={-8} transform={`rotate(${r})`} fill="#9a7a3e" className="g-ol2" />
          ))}
          <circle r={6} fill="#5e3f27" className="g-ol2" />
        </g>
      </g>
    )
  }
  const young = stage === 'young'
  const h = young ? 40 : 62
  return (
    <g className="g-sway">
      <path d={`M0 0 V${-h}`} stroke="#4d7a44" strokeWidth={3.6} className="g-ol2" fill="none" />
      <Leaf x={0} y={-h * 0.3} r={-58} s={0.62} fill="url(#g-leaf-side)" />
      <Leaf x={0} y={-h * 0.5} r={58} s={0.62} />
      <g transform={`translate(0 ${-h})`}>
        {young ? (
          <>
            <circle r={7} fill="#7fae5a" className="g-ol" />
            <path d="M-4 -3 Q0 -9 4 -3" stroke="#3f6b4f" strokeWidth={1.6} fill="none" />
          </>
        ) : (
          <>
            {RAYS_14.map((r) => (
              <ellipse
                key={r}
                rx={4.2}
                ry={9}
                cy={-11}
                transform={`rotate(${r})`}
                fill="url(#g-petal)"
                className="g-ol2"
              />
            ))}
            <circle r={10} fill="url(#g-disk)" className="g-ol" />
            <circle cx={-3} cy={-3} r={2.4} fill="#fff" opacity={0.25} />
          </>
        )}
      </g>
    </g>
  )
}

function PumpkinLeaf({ x, y, r, s }: { x: number; y: number; r: number; s: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${r}) scale(${s})`}>
      <path
        d="M0 0 C-10 -2 -14 -12 -8 -18 C-5 -22 0 -20 0 -16 C0 -20 5 -22 8 -18 C14 -12 10 -2 0 0Z"
        fill="url(#g-leaf)"
        className="g-ol"
      />
      <path d="M0 -2 V-15" stroke="#2c4d36" strokeWidth={1 / s} opacity={0.5} />
    </g>
  )
}

function Pumpkin({ stage }: { stage: Stage }) {
  if (stage === 'wither') {
    // The mock had no withered pumpkin; a limp brown vine with a shrivelled gourd.
    return (
      <g className="g-droop">
        <path
          d="M-16 -1 C-9 -6 -2 1 5 -3 S15 -2 18 -5"
          fill="none"
          stroke="#8a6a3a"
          strokeWidth={2.6}
          className="g-ol2"
        />
        <Leaf x={-10} y={-2} r={-105} s={0.45} fill="url(#g-wither)" vein={false} />
        <Leaf x={12} y={-4} r={100} s={0.42} fill="url(#g-wither)" vein={false} />
        <ellipse cx={4} cy={-4} rx={8} ry={5.5} fill="#9a7a3e" className="g-ol2" />
        <path d="M1 -9 Q0 -4 1 1 M7 -9 Q8 -4 7 1" stroke="#6b5530" strokeWidth={1} fill="none" />
      </g>
    )
  }
  return (
    <g className="g-sway">
      <path
        d="M-18 -2 C-10 -10 -2 2 6 -6 S18 -4 20 -10"
        fill="none"
        stroke="#4d7a44"
        strokeWidth={2.6}
        className="g-ol2"
      />
      <PumpkinLeaf x={-14} y={-2} r={-30} s={0.9} />
      <PumpkinLeaf x={14} y={-6} r={25} s={0.85} />
      <PumpkinLeaf x={0} y={-8} r={0} s={1} />
      {stage === 'young' && (
        <>
          <ellipse cx={6} cy={-3} rx={7} ry={5.5} fill="#8fbf5c" className="g-ol" />
          <path d="M6 -8 v-3" stroke="#4d7a44" strokeWidth={2} />
        </>
      )}
      {stage === 'ripe' && (
        <g transform="translate(4 -6)">
          <ellipse rx={15} ry={11} fill="url(#g-pumpkin)" className="g-ol" />
          <path d="M-5 -10 Q-8 0 -5 10 M5 -10 Q8 0 5 10" stroke="#a24f1a" strokeWidth={1.4} fill="none" />
          <path d="M0 -10 q1 -5 4 -6" stroke="#4d7a44" strokeWidth={3} className="g-ol2" fill="none" />
        </g>
      )}
    </g>
  )
}

const PLANTS: Record<CropKind, (props: { stage: Stage }) => ReactNode> = {
  tomato: Tomato,
  sunflower: Sunflower,
  pumpkin: Pumpkin,
}

function SeedStake() {
  return (
    <>
      <g className="g-sway">
        <path d="M8 0 V-30" stroke="#8a5a33" strokeWidth={2.4} className="g-ol2" />
        <g transform="translate(8 -34) rotate(-6)">
          <rect x={-9} y={-12} width={18} height={22} rx={2.5} fill="#fffaf1" className="g-ol" />
          <circle cy={0} r={5} fill="#e0a93b" className="g-ol2" />
          <path d="M-9 -6 H9" stroke="#b0582f" strokeWidth={2} />
        </g>
      </g>
      <ellipse cx={-4} cy={-2} rx={3} ry={2} fill="#5e3f27" />
      <ellipse cx={3} cy={-1} rx={2.5} ry={1.6} fill="#5e3f27" />
    </>
  )
}

function Cloche() {
  return (
    <>
      <path d="M-20 2 V-30 A20 20 0 0 1 20 -30 V2 Z" fill="#e9f6fb" fillOpacity={0.42} className="g-ol" />
      <path
        d="M-12 -36 A13 13 0 0 1 -3 -45"
        stroke="#fff"
        strokeWidth={3.4}
        fill="none"
        strokeLinecap="round"
        opacity={0.9}
      />
      <circle cy={-52} r={4} fill="#e9f6fb" className="g-ol2" />
    </>
  )
}

const WEED_BASES = [
  [-16, 2],
  [14, 0],
  [-4, 6],
] as const

function Weeds() {
  return (
    <g>
      {WEED_BASES.map(([x, y]) => (
        <path key={x} d={`M${x} ${y} l-4 -12 l4 5 l2 -14 l3 12 l4 -8 l-1 17z`} fill="#566b2f" className="g-ol2" />
      ))}
      <path
        d="M-18 -6 C-6 -16 10 -2 16 -18 C18 -24 6 -30 -2 -26 C-10 -22 -12 -34 -2 -38"
        fill="none"
        stroke="#3a4f25"
        strokeWidth={3}
        className="g-ol2"
      />
      <path
        d="M-10 -12 l-4 -2 M6 -9 l3 -3 M12 -22 l4 0 M-6 -29 l-3 -3"
        stroke="#3a4f25"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </g>
  )
}

function Crow() {
  return (
    <At x={12} y={-26}>
      <g className="g-hop">
        <ellipse cx={0} cy={0} rx={9} ry={7} fill="#2d2a33" className="g-ol" />
        <circle cx={7} cy={-7} r={5} fill="#2d2a33" className="g-ol" />
        <path d="M11 -8 l6 1.5 -6 1.5z" fill="#e0a93b" className="g-ol2" />
        <circle cx={8} cy={-8.5} r={1.3} fill="#fff" />
        <path d="M-9 -2 l-7 -4 l2 6z" fill="#2d2a33" className="g-ol2" />
        <path d="M-2 7 v4 M2 7 v4" stroke="#e0a93b" strokeWidth={1.6} />
      </g>
    </At>
  )
}

/**
 * Handed to the code host: an hourglass bobbing where a badge would float,
 * without a bubble, since nothing is asked of you. `y` is its centre.
 */
function Hourglass({ y }: { y: number }) {
  return (
    <g className="g-bob">
      <g transform={`translate(0 ${y})`}>
        <path d="M-7 -9 H7 L1.2 0 L7 9 H-7 L-1.2 0 Z" fill="#e9f6fb" fillOpacity={0.9} className="g-ol2" />
        <path d="M-4.6 -6 H4.6 L0 -1.4 Z" fill="#e7c27a" />
        <path d="M0 -1 V6" stroke="#e7c27a" strokeWidth={1.2} />
        <path d="M-5.2 8.6 Q0 3.6 5.2 8.6 Z" fill="#e7c27a" />
        <rect x={-9.5} y={-12.5} width={19} height={4} rx={1.8} fill="#a0673f" className="g-ol2" />
        <rect x={-9.5} y={8.5} width={19} height={4} rx={1.8} fill="#a0673f" className="g-ol2" />
      </g>
    </g>
  )
}

/**
 * A work stream's plant, anchored at its ground point. The mock placed it at
 * the tile centre nudged 2px down: iso(i + 0.5, j + 0.5) + (0, 2).
 * Badges are drawn separately (see Badge / badgeLift).
 */
export function Crop({ kind, state }: { kind: CropKind; state: PlantState }) {
  const Plant = PLANTS[kind]
  let body: ReactNode
  switch (state) {
    case 'queued':
      body = <SeedStake />
      break
    case 'growing':
      body = (
        <g className="g-grow">
          <Plant stage="young" />
        </g>
      )
      break
    case 'question':
      body = <Plant stage="young" />
      break
    case 'review':
      body = (
        <>
          <g className="g-glow">
            <ellipse cy={-24} rx={30} ry={30} fill="#fff3a8" opacity={0.35} />
          </g>
          <Plant stage="ripe" />
          <Spark x={-22} y={-44} />
          <Spark x={20} y={-54} s={0.8} late />
        </>
      )
      break
    case 'delivering':
      // Ripe but not glowing: done here, out with the code host.
      body = (
        <>
          <Plant stage="ripe" />
          <Hourglass y={kind === 'sunflower' ? -92 : -76} />
        </>
      )
      break
    case 'blocked':
      body = (
        <>
          <Plant stage="young" />
          <Weeds />
        </>
      )
      break
    case 'paused':
      body = (
        <>
          <Plant stage="young" />
          <Cloche />
        </>
      )
      break
    case 'waiting':
      body = (
        <g transform="scale(0.7)">
          <Plant stage="young" />
        </g>
      )
      break
    case 'idle':
      body = <Plant stage="wither" />
      break
    case 'failed':
      body = (
        <>
          <Plant stage="wither" />
          <Crow />
        </>
      )
      break
    default:
      // Every plant state is drawn: a new one must be added above.
      body = unreachablePlantState(state)
  }
  return <g>{body}</g>
}

function unreachablePlantState(state: never): null {
  void state
  return null
}
