import type { PlantState } from '../../../farm/types'
import type { CropKind } from '../../nostalgic/types'
import { Ball, Bean, Blob, Drop, rim, sphere } from './kit'

const STEM = '#5dab4e'
const LEAF = '#7ccf6b'
const WILT = '#b8a46a'

/** A round leaf on a short stalk, from the stem at (0, y), leaning out to one side. */
function Leaf({ y, side, size = 7, color = LEAF }: { y: number; side: 1 | -1; size?: number; color?: string }) {
  return (
    <Bean cx={side * size * 0.9} cy={y - size * 0.35} rx={size} ry={size * 0.62} fill={color} rotate={side * -24} />
  )
}

function Stem({ height, color = STEM, bend = 0 }: { height: number; color?: string; bend?: number }) {
  return (
    <path
      d={`M0 0 Q${bend} ${-height / 2} ${bend * 0.4} ${-height}`}
      stroke={color}
      strokeWidth={3.4}
      strokeLinecap="round"
      fill="none"
    />
  )
}

function Sprout({ height = 12, color = LEAF }: { height?: number; color?: string }) {
  return (
    <g>
      <Stem height={height} />
      <Leaf y={-height + 2} side={-1} size={5.5} color={color} />
      <Leaf y={-height + 3} side={1} size={5.5} color={color} />
    </g>
  )
}

/** The ripe crop itself, drawn large and glossy. */
function Ripe({ kind }: { kind: CropKind }) {
  switch (kind) {
    case 'tomato':
      return (
        <g>
          <Stem height={34} />
          <Leaf y={-12} side={-1} size={8} />
          <Leaf y={-22} side={1} size={7.5} />
          <Leaf y={-32} side={-1} size={6.5} />
          {[
            [-8, -16, 6.5],
            [8, -24, 6],
            [-3, -32, 5.5],
          ].map(([x, y, r]) => (
            <g key={`${x}${y}`}>
              <circle cx={x} cy={y} r={r} fill={sphere('tomato')} stroke={rim('#ef5a4c')} strokeWidth={1.2} />
              <path
                d={`M${x! - 2} ${y! - r! + 1} l2 1.6 l2 -1.6`}
                stroke="#4f9a42"
                strokeWidth={1.8}
                strokeLinecap="round"
                fill="none"
              />
            </g>
          ))}
        </g>
      )
    case 'sunflower':
      return (
        <g>
          <Stem height={40} bend={2} />
          <Leaf y={-12} side={-1} size={8.5} />
          <Leaf y={-22} side={1} size={8} />
          <g transform="translate(1 -44)">
            <g className="cz-nod">
              {Array.from({ length: 12 }, (_, k) => (
                <ellipse
                  key={k}
                  cx={0}
                  cy={-10}
                  rx={3.8}
                  ry={6.5}
                  fill="#ffd54a"
                  stroke={rim('#ffd54a', 20)}
                  strokeWidth={1}
                  transform={`rotate(${k * 30})`}
                />
              ))}
              <Ball r={7.5} fill="#8a5a3a" />
              <circle cx={-2.4} cy={-1} r={1.1} fill="#3b2a20" />
              <circle cx={2.4} cy={-1} r={1.1} fill="#3b2a20" />
              <path d="M-2 2 q2 1.8 4 0" stroke="#3b2a20" strokeWidth={1.1} fill="none" strokeLinecap="round" />
            </g>
          </g>
        </g>
      )
    case 'pumpkin':
      return (
        <g>
          <path d="M-14 -4 q-6 -10 2 -16" stroke={STEM} strokeWidth={3} fill="none" strokeLinecap="round" />
          <Leaf y={-14} side={-1} size={8} />
          <g transform="translate(2 -11)">
            <ellipse cx={-7} cy={0} rx={8} ry={10} fill={sphere('pumpkin')} stroke={rim('#f59c3c')} strokeWidth={1.2} />
            <ellipse cx={7} cy={0} rx={8} ry={10} fill={sphere('pumpkin')} stroke={rim('#f59c3c')} strokeWidth={1.2} />
            <ellipse cx={0} cy={0} rx={9} ry={11} fill={sphere('pumpkin')} stroke={rim('#f59c3c')} strokeWidth={1.2} />
            <path d="M0 -10 q1 -4 4 -6" stroke="#6b8a3a" strokeWidth={3} strokeLinecap="round" fill="none" />
          </g>
        </g>
      )
  }
}

/** The crop part-grown: leafy, with a small green promise of what it'll be. */
function Young({ kind }: { kind: CropKind }) {
  return (
    <g>
      <Stem height={24} />
      <Leaf y={-9} side={-1} size={7.5} />
      <Leaf y={-16} side={1} size={7} />
      <Leaf y={-23} side={-1} size={5.5} />
      {kind === 'sunflower' ? (
        <Ball cx={0.5} cy={-27} r={4.5} fill="#9bd96f" />
      ) : (
        <Ball cx={6} cy={-10} r={3.6} fill="#a6dc76" />
      )}
    </g>
  )
}

function Weeds() {
  return (
    <g>
      {[-12, 10, -4].map((x, k) => (
        <g key={x} transform={`translate(${x} ${k === 2 ? 2 : 0})`}>
          <Blob
            d="M-5 0 q-2 -9 0 -12 q2 4 2 7 q1 -8 4 -10 q0 6 -1 9 q3 -4 6 -4 q-2 5 -6 10z"
            fill="#6f9a4b"
            shine={false}
          />
        </g>
      ))}
    </g>
  )
}

function Crow() {
  return (
    <g transform="translate(13 -6)">
      <Drop rx={7} ry={2} cy={6} />
      <Bean cx={0} cy={0} rx={7} ry={6} fill="#4a4660" />
      <Ball cx={4} cy={-6} r={4.5} fill="#4a4660" />
      <circle cx={5.5} cy={-7} r={1.2} fill="#fff" />
      <path d="M8 -6 l4 1.2 l-4 1.2z" fill="#f7c948" />
    </g>
  )
}

/**
 * Handed to the code host: a soft hourglass floating where a badge would,
 * without a bubble, since nothing is asked of you. `y` is its centre.
 */
function CozyHourglass({ y }: { y: number }) {
  return (
    <g className="cz-hover">
      <g transform={`translate(0 ${y})`}>
        <path d="M-6.5 -8 H6.5 L1.2 0 L6.5 8 H-6.5 L-1.2 0 Z" fill="#e8f7ff" stroke="#ffffff" strokeWidth={1.2} />
        <path d="M-4.2 -5.4 H4.2 L0 -1.2 Z" fill="#ffd54a" />
        <path d="M-4.8 7.6 Q0 3.4 4.8 7.6 Z" fill="#ffd54a" />
        <rect x={-8.5} y={-11} width={17} height={3.6} rx={1.8} fill="#c9905a" />
        <rect x={-8.5} y={7.4} width={17} height={3.6} rx={1.8} fill="#c9905a" />
      </g>
    </g>
  )
}

/** A cozy plant by state. Anchored at the middle of its bed. */
export function CozyPlant({ kind, state }: { kind: CropKind; state: PlantState }) {
  switch (state) {
    case 'queued':
      return (
        <g>
          <ellipse rx={7} ry={3} fill="#8d6243" />
          <path d="M0 0 V-16" stroke="#c9905a" strokeWidth={2.4} strokeLinecap="round" />
          <rect x={-7} y={-26} width={14} height={11} rx={3.5} fill="#fff4dc" stroke="#d49a60" strokeWidth={1.4} />
          <Ball
            cx={0}
            cy={-20.5}
            r={3}
            fill={kind === 'sunflower' ? '#ffd54a' : kind === 'pumpkin' ? '#f59c3c' : '#ef5a4c'}
          />
        </g>
      )
    case 'waiting':
      return (
        <g opacity={0.9}>
          <Sprout height={10} color="#a6dc76" />
        </g>
      )
    case 'growing':
    case 'question':
      return (
        <g className="cz-sway">
          <Young kind={kind} />
        </g>
      )
    case 'review':
      return (
        <g>
          <ellipse cy={-16} rx={22} ry={22} fill="url(#cz-glow)" className="cz-pulse" />
          <Ripe kind={kind} />
          <path
            d="M-16 -34 l1.5 3.5 l3.5 1.5 l-3.5 1.5 l-1.5 3.5 l-1.5 -3.5 l-3.5 -1.5 l3.5 -1.5z"
            fill="#fff6b0"
            className="cz-twinkle"
          />
          <path
            d="M15 -20 l1 2.5 l2.5 1 l-2.5 1 l-1 2.5 l-1 -2.5 l-2.5 -1 l2.5 -1z"
            fill="#fff"
            className="cz-twinkle cz-late"
          />
        </g>
      )
    case 'delivering':
      // Ripe but not glowing: done here, out with the code host.
      return (
        <g>
          <Ripe kind={kind} />
          <CozyHourglass y={cozyBadgeLift(kind, 'review') - 14} />
        </g>
      )
    case 'blocked':
      return (
        <g>
          <Young kind={kind} />
          <Weeds />
        </g>
      )
    case 'paused':
      return (
        <g>
          <Sprout height={14} />
          <ellipse cy={1} rx={15} ry={4} fill="#cfeeff" opacity={0.5} />
          <path
            d="M-15 0 V-14 A15 15 0 0 1 15 -14 V0 Z"
            fill="url(#cz-glass)"
            stroke="#ffffff"
            strokeOpacity={0.9}
            strokeWidth={1.4}
          />
          <path
            d="M-9 -20 q3 -7 10 -8"
            stroke="#fff"
            strokeWidth={2.4}
            strokeLinecap="round"
            fill="none"
            opacity={0.85}
          />
          <Ball cx={0} cy={-30} r={2.6} fill="#e8f7ff" />
        </g>
      )
    case 'idle':
    case 'failed':
      return (
        <g>
          <path d="M0 0 Q2 -10 10 -12" stroke={WILT} strokeWidth={3.2} strokeLinecap="round" fill="none" />
          <Bean cx={11} cy={-9} rx={5} ry={3.2} fill={WILT} rotate={40} />
          <Bean cx={-4} cy={-5} rx={5} ry={3} fill="#c9b67c" rotate={-30} />
          {state === 'failed' && <Crow />}
        </g>
      )
    default:
      // Every plant state is drawn: a new one must be added above.
      return unreachablePlantState(state)
  }
}

function unreachablePlantState(state: never): null {
  void state
  return null
}

/** How far above a plant's anchor its badge's tip sits. */
export function cozyBadgeLift(kind: CropKind, state: PlantState): number {
  if (state === 'review') return kind === 'sunflower' ? -66 : kind === 'pumpkin' ? -34 : -48
  if (state === 'queued') return -32
  return -40
}
