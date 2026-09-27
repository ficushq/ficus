import { memo, useId } from 'react'
import type { Agent } from '@ficus/shared'
import { iso } from '../../farm/iso'
import type {
  BadgeKind,
  DecorPlacement,
  FarmLayout,
  PlotLayout,
  RobotFace,
  RobotPlacement,
  RobotRole,
} from '../../farm/types'
import type { YardRect } from '../types'
import { at, boxEdges, diamond } from './draw'

/*
 * The Futurist style: everything is thin strokes in three colours, read from CSS
 * variables so it can follow a theme — --fu-bg (the void), --fu-fg (lines and
 * text) and --fu-accent (what's alive or needs you).
 */
const FG = 'var(--fu-fg)'
const BG = 'var(--fu-bg)'
const ACCENT = 'var(--fu-accent)'
const MONO = 'var(--g-font-mono)'

export function FuturistDefs() {
  return (
    <defs>
      <filter id="fu-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.2" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <radialGradient id="fu-fade" cx="50%" cy="50%" r="50%">
        <stop offset="0" stopColor="#fff" stopOpacity="1" />
        <stop offset="0.7" stopColor="#fff" stopOpacity="0.55" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <mask id="fu-fade-mask" maskContentUnits="objectBoundingBox">
        <rect width="1" height="1" fill="url(#fu-fade)" />
      </mask>
    </defs>
  )
}

/** The infinite grid: minor lines every tile, major every four, fading out toward the edges. */
export const FuturistGround = memo(function FuturistGround({ bounds }: { bounds: FarmLayout['bounds'] }) {
  const pad = 12
  const minI = Math.floor(bounds.minI) - pad
  const maxI = Math.ceil(bounds.maxI) + pad
  const minJ = Math.floor(bounds.minJ) - pad
  const maxJ = Math.ceil(bounds.maxJ) + pad
  let minor = ''
  let major = ''
  for (let i = minI; i <= maxI; i++) {
    const seg = `M${at(i, minJ)} L${at(i, maxJ)} `
    if (i % 4 === 0) major += seg
    else minor += seg
  }
  for (let j = minJ; j <= maxJ; j++) {
    const seg = `M${at(minI, j)} L${at(maxI, j)} `
    if (j % 4 === 0) major += seg
    else minor += seg
  }
  const corners = [iso(minI, minJ), iso(maxI, minJ), iso(maxI, maxJ), iso(minI, maxJ)]
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const box = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
  return (
    <g>
      <rect x={box.x - 2000} y={box.y - 2000} width={box.w + 4000} height={box.h + 4000} fill={BG} />
      <g mask="url(#fu-fade-mask)">
        <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" />
        <path
          d={minor}
          stroke={FG}
          strokeOpacity={0.09}
          strokeWidth={1}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        <path d={major} stroke={FG} strokeOpacity={0.2} strokeWidth={1} fill="none" vectorEffect="non-scaling-stroke" />
      </g>
    </g>
  )
})

/** A yard: a faint field with a dashed boundary and corner brackets. */
export function FuturistYard({ i0, j0, w, h }: YardRect) {
  const bracket = (i: number, j: number, di: number, dj: number) =>
    `M${at(i + di * 0.5, j)} L${at(i, j)} L${at(i, j + dj * 0.5)}`
  return (
    <g>
      <path
        d={diamond(i0, j0, w, h)}
        fill={FG}
        fillOpacity={0.03}
        stroke={FG}
        strokeOpacity={0.35}
        strokeDasharray="3 5"
      />
      <path
        d={[
          bracket(i0, j0, 1, 1),
          bracket(i0 + w, j0, -1, 1),
          bracket(i0 + w, j0 + h, -1, -1),
          bracket(i0, j0 + h, 1, -1),
        ].join(' ')}
        fill="none"
        stroke={FG}
        strokeOpacity={0.8}
        strokeWidth={1.5}
      />
    </g>
  )
}

/** The squad's name as a small uppercase label, with an accent tick when something needs you. */
export function FuturistSign({ name, flag }: { name: string; flag: boolean }) {
  const label = name.length > 24 ? `${name.slice(0, 23)}…` : name
  return (
    <g>
      <path d="M0 0 V-14" stroke={FG} strokeOpacity={0.5} />
      <circle r={2} fill={flag ? ACCENT : FG} />
      <text
        x={6}
        y={-18}
        fontFamily={MONO}
        fontSize={11}
        letterSpacing="0.12em"
        fill={FG}
        style={{ textTransform: 'uppercase' }}
      >
        {label}
      </text>
      {flag && <circle cx={0} cy={-22} r={3} fill={ACCENT} className="fu-pulse" />}
    </g>
  )
}

/** A plant's patch: a thin inset tile, lit when selected. */
export function FuturistPlot({ i, j, selected }: { i: number; j: number; selected: boolean }) {
  return (
    <path
      d={diamond(i, j, 1, 1, 0.14)}
      fill={selected ? ACCENT : 'none'}
      fillOpacity={selected ? 0.12 : 0}
      stroke={selected ? ACCENT : FG}
      strokeOpacity={selected ? 1 : 0.35}
      strokeWidth={selected ? 1.5 : 1}
      filter={selected ? 'url(#fu-glow)' : undefined}
    />
  )
}

/** Line-art plants: a stem and a few chevron leaves, drawn by state. */
export function FuturistPlant({ plot }: { plot: PlotLayout }) {
  const s = plot.state
  const needs = plot.badge !== null
  const stroke = needs ? ACCENT : FG
  const leaves = (h: number, n: number) =>
    Array.from({ length: n }, (_, k) => {
      const y = -8 - k * (h / (n + 0.5))
      const w = 7 - k * 1.2
      return `M${-w} ${y + 4} L0 ${y} L${w} ${y + 4}`
    }).join(' ')
  if (s === 'queued')
    return (
      <g>
        <circle r={2.4} fill={FG} />
        <circle r={7} fill="none" stroke={FG} strokeOpacity={0.5} strokeDasharray="2 3" />
      </g>
    )
  if (s === 'idle' || s === 'failed')
    return (
      <g opacity={s === 'idle' ? 0.45 : 0.8}>
        <path d="M0 0 L2 -10 L9 -16" fill="none" stroke={FG} strokeDasharray={s === 'failed' ? '2 3' : undefined} />
        <path d="M-5 -4 L2 -10 L0 -1" fill="none" stroke={FG} />
        {s === 'failed' && <path d="M6 -22 L12 -16 M12 -22 L6 -16" stroke={ACCENT} strokeWidth={1.5} />}
      </g>
    )
  const tall = s === 'review' ? 30 : s === 'waiting' ? 16 : 24
  return (
    <g className={s === 'growing' ? 'fu-sway' : undefined}>
      <path d={`M0 0 V${-tall}`} stroke={stroke} strokeDasharray={s === 'waiting' ? '2 3' : undefined} />
      <path d={leaves(tall, s === 'review' ? 4 : 3)} fill="none" stroke={stroke} strokeOpacity={0.9} />
      {s === 'review' && (
        <g filter="url(#fu-glow)">
          {[
            [-7, -12],
            [7, -18],
            [0, -tall - 3],
          ].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r={2.6} fill="none" stroke={ACCENT} strokeWidth={1.4} />
          ))}
        </g>
      )}
      {s === 'growing' && <circle cy={-tall - 2} r={2} fill={ACCENT} className="fu-pulse" />}
      {s === 'blocked' && (
        <path d={`M-9 ${-tall + 2} L9 -4 M9 ${-tall + 2} L-9 -4`} stroke={ACCENT} strokeWidth={1.4} />
      )}
      {s === 'paused' && (
        <path
          d={`M-12 -2 V${-tall - 4} H-8 M12 -2 V${-tall - 4} H8 M-12 -2 H-8 M12 -2 H8`}
          fill="none"
          stroke={FG}
          strokeOpacity={0.7}
        />
      )}
    </g>
  )
}

const GLYPHS: Record<BadgeKind, string> = { question: '?', blocked: '!', harvest: '✓' }

/** A ring with a glyph, anchored at the bottom of its stalk. */
export function FuturistBadge({ kind }: { kind: BadgeKind }) {
  return (
    <g className="fu-float">
      <path d="M0 0 V-6" stroke={ACCENT} />
      <circle cy={-16} r={10} fill={BG} stroke={ACCENT} strokeWidth={1.4} filter="url(#fu-glow)" />
      <text y={-12} textAnchor="middle" fontFamily={MONO} fontSize={12} fontWeight={700} fill={ACCENT}>
        {GLYPHS[kind]}
      </text>
    </g>
  )
}

function faceStyle(face: RobotFace): { core: string; opacity: number; className?: string } {
  switch (face) {
    case 'happy':
      return { core: ACCENT, opacity: 1, className: 'fu-pulse' }
    case 'question':
      return { core: ACCENT, opacity: 1, className: 'fu-blink' }
    case 'error':
      return { core: ACCENT, opacity: 1, className: 'fu-flicker' }
    case 'sleepy':
      return { core: FG, opacity: 0.25 }
    case 'normal':
      return { core: FG, opacity: 0.7 }
  }
}

/** An orb: a ring with a core whose colour and rhythm show the agent's state; role adds a halo. */
function Orb({ role, face, r = 9 }: { role: RobotRole; face: RobotFace; r?: number }) {
  const look = faceStyle(face)
  return (
    <g>
      {role === 'manager' && (
        <ellipse rx={r + 7} ry={(r + 7) * 0.38} fill="none" stroke={FG} strokeOpacity={0.8} transform="rotate(-18)" />
      )}
      {role === 'consultant' && (
        <rect
          x={-r - 5}
          y={-r - 5}
          width={(r + 5) * 2}
          height={(r + 5) * 2}
          fill="none"
          stroke={FG}
          strokeOpacity={0.6}
          transform="rotate(45)"
        />
      )}
      {role === 'assistant' && <path d={`M0 ${-r} V${-r - 7}`} stroke={FG} />}
      {role === 'assistant' && <circle cy={-r - 9} r={2} fill={ACCENT} />}
      <circle r={r} fill={BG} stroke={FG} strokeWidth={1.3} />
      <circle
        r={r * 0.42}
        fill={look.core}
        opacity={look.opacity}
        className={look.className}
        filter={look.core === ACCENT ? 'url(#fu-glow)' : undefined}
      />
      {face === 'question' && (
        <text y={-r - 4} textAnchor="middle" fontFamily={MONO} fontSize={9} fill={ACCENT}>
          ?
        </text>
      )}
      {face === 'error' && (
        <path
          d={`M${-r * 0.3} ${-r * 0.3} L${r * 0.3} ${r * 0.3} M${r * 0.3} ${-r * 0.3} L${-r * 0.3} ${r * 0.3}`}
          stroke={BG}
          strokeWidth={1.4}
        />
      )}
    </g>
  )
}

export function FuturistRobot({ placement, extra }: { placement: RobotPlacement; extra?: number }) {
  const { role, face, helpers } = placement
  return (
    <g>
      <ellipse rx={8} ry={3} fill="none" stroke={FG} strokeOpacity={0.3} />
      <g className={face === 'sleepy' ? undefined : 'fu-float'}>
        <g transform="translate(0 -26)">
          <Orb role={role} face={face} />
          {helpers > 0 &&
            Array.from({ length: Math.min(3, helpers) }, (_, k) => (
              <circle key={k} cx={16 + k * 5} cy={-10 + k * 4} r={1.8} fill={ACCENT} opacity={0.85} />
            ))}
        </g>
      </g>
      {extra ? (
        <text x={12} y={2} fontFamily={MONO} fontSize={9} fill={FG} fillOpacity={0.8}>
          +{extra}
        </text>
      ) : null}
    </g>
  )
}

export function FuturistAvatar({ role, face }: { agent: Agent; role: RobotRole; face: RobotFace }) {
  return <Orb role={role} face={face} r={11} />
}

/** A labelled wireframe box: Futurist's stand-in for every building. */
function Node({
  w,
  d,
  h,
  label,
  count,
  lit,
  glyph,
}: {
  w: number
  d: number
  h: number
  label: string
  count?: number
  lit?: boolean
  glyph?: string
}) {
  const { front, back } = boxEdges(w, d, h)
  const [, top] = iso(0, 0)
  return (
    <g>
      <path d={diamond(-w / 2, -d / 2, w, d)} fill={FG} fillOpacity={0.04} />
      <path d={back} fill="none" stroke={FG} strokeOpacity={0.25} strokeDasharray="2 3" />
      <path
        d={front}
        fill="none"
        stroke={lit ? ACCENT : FG}
        strokeOpacity={lit ? 1 : 0.75}
        strokeWidth={1.2}
        filter={lit ? 'url(#fu-glow)' : undefined}
      />
      {glyph && (
        <text y={top - h / 2 + 4} textAnchor="middle" fontFamily={MONO} fontSize={12} fill={lit ? ACCENT : FG}>
          {glyph}
        </text>
      )}
      <text
        y={iso(w / 2, d / 2)[1] + 14}
        textAnchor="middle"
        fontFamily={MONO}
        fontSize={9}
        letterSpacing="0.14em"
        fill={FG}
        fillOpacity={0.75}
      >
        {label}
        {count !== undefined ? ` · ${count}` : ''}
      </text>
    </g>
  )
}

export function FuturistHut({ count, peek }: { count: number; peek?: RobotPlacement }) {
  return (
    <g>
      <Node w={0.9} d={0.7} h={14} label="IDLE" count={count} lit={false} />
      {peek && (
        <g transform="translate(0 -22) scale(0.7)" opacity={0.8}>
          <Orb role="worker" face="normal" />
        </g>
      )}
    </g>
  )
}

export function FuturistStand({ count, host }: { count: number; host?: RobotPlacement }) {
  return (
    <g>
      <Node w={0.7} d={0.7} h={10} label="CONSULT" count={count} />
      {host && (
        <g transform="translate(0 -26) scale(0.75)">
          <Orb role="consultant" face={host.face} />
        </g>
      )}
    </g>
  )
}

export const FuturistFarmhouse = () => <Node w={2} d={1.6} h={48} label="SETTINGS" glyph="◇" />
export const FuturistSeedShed = () => <Node w={1.1} d={1} h={24} label="NEW" glyph="+" />
export const FuturistMailbox = ({ count }: { count: number }) => (
  <Node w={0.5} d={0.5} h={26} label="INBOX" count={count} lit={count > 0} glyph={count ? '•' : undefined} />
)
export const FuturistCrates = ({ count }: { count: number }) => (
  <Node w={0.9} d={0.6} h={8} label="DONE" count={count} />
)
export const FuturistCompost = ({ count }: { count: number }) => (
  <Node w={0.6} d={0.6} h={4} label="CANCELED" count={count} />
)

/** Scenery is reduced to faint survey marks. */
export function FuturistDecor({ decor }: { decor: DecorPlacement }) {
  const big = decor.kind === 'tree' || decor.kind === 'fruitTree'
  return <path d={big ? 'M-4 0 H4 M0 -4 V4' : 'M-2 0 H2'} stroke={FG} strokeOpacity={0.3} />
}

/** Stable id helper for callers that need a per-instance gradient. */
export function useFuturistId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`
}
