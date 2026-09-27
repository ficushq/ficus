import { memo, type ReactNode } from 'react'
import type { Agent } from '@ficus/shared'
import { iso } from '../../farm/iso'
import type { DecorPlacement, FarmLayout, PlotLayout, RobotFace, RobotPlacement, RobotRole } from '../../farm/types'
import type { YardRect } from '../types'
import { at, diamond, gridLines, poly, type TilePoint } from '../line/draw'
import { LineDefs } from '../line/sprites'

/*
 * The Blueprint style: the farm as a drafting sheet. Pale lines on cyanotype
 * blue, hidden edges dashed, yards dimensioned, trees drawn as architect's
 * symbols, and the robots as technical drawings of the Nostalgic ones. It
 * draws with the line kit's colours (--ln-*), which its theme fixes to blue
 * paper, white ink and a yellow highlighter for what needs you.
 */
const FG = 'var(--ln-fg)'
const BG = 'var(--ln-bg)'
const ACCENT = 'var(--ln-accent)'
const MONO = 'var(--g-font-mono)'

/** How opaque a drawn face is: solid enough to read as a surface, faint enough to feel like paper. */
const FACE = 0.9

export function BlueprintDefs() {
  return (
    <>
      <LineDefs glow={false} />
      <defs>
        <pattern id="bp-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0 V5" stroke={ACCENT} strokeOpacity={0.75} />
        </pattern>
        <pattern id="bp-hatch-ink" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <path d="M0 0 V4" stroke={FG} strokeOpacity={0.35} />
        </pattern>
      </defs>
    </>
  )
}

/** Text that sits in a gap in whatever it's drawn over, like lettering on a drawing. */
function Lettering({
  x = 0,
  y,
  size = 9,
  anchor = 'middle',
  fill = FG,
  opacity = 0.85,
  children,
}: {
  x?: number
  y: number
  size?: number
  anchor?: 'start' | 'middle' | 'end'
  fill?: string
  opacity?: number
  children: ReactNode
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontFamily={MONO}
      fontSize={size}
      letterSpacing="0.14em"
      fill={fill}
      fillOpacity={opacity}
      stroke={BG}
      strokeWidth={3}
      paintOrder="stroke"
      style={{ textTransform: 'uppercase' }}
    >
      {children}
    </text>
  )
}

/** The drafting sheet: a fine grid over the whole world, a north arrow and a scale bar. */
export const BlueprintGround = memo(function BlueprintGround({ bounds }: { bounds: FarmLayout['bounds'] }) {
  const { minor, major, box } = gridLines(bounds, 16)
  const [nx, ny] = iso(bounds.minI - 1, bounds.maxJ + 2.5)
  return (
    <g>
      <rect x={box.x - 2000} y={box.y - 2000} width={box.w + 4000} height={box.h + 4000} fill={BG} />
      <path d={minor} stroke={FG} strokeOpacity={0.08} fill="none" vectorEffect="non-scaling-stroke" />
      <path d={major} stroke={FG} strokeOpacity={0.18} fill="none" vectorEffect="non-scaling-stroke" />
      <g transform={`translate(${nx} ${ny})`} aria-hidden="true">
        <circle r={16} fill="none" stroke={FG} strokeOpacity={0.6} />
        <path d="M0 -22 L5 0 L0 -4 L-5 0 Z" fill={FG} fillOpacity={0.7} />
        <Lettering y={-26} size={10}>
          N
        </Lettering>
        <g transform="translate(34 6)">
          {[0, 1, 2, 3].map((k) => (
            <rect
              key={k}
              x={k * 20}
              y={-3}
              width={20}
              height={6}
              fill={k % 2 ? 'none' : FG}
              fillOpacity={0.55}
              stroke={FG}
              strokeOpacity={0.6}
            />
          ))}
          <Lettering x={0} y={16} size={8} anchor="start">
            0
          </Lettering>
          <Lettering x={80} y={16} size={8} anchor="end">
            16′
          </Lettering>
        </g>
      </g>
    </g>
  )
})

/** Tiles to feet on the drawing, for dimension labels. */
const feet = (tiles: number) => `${Math.round(tiles * 4)}′-0″`

/** A dimension line between two tile points, pushed out by (di, dj), with extension lines and ticks. */
function Dimension({ from, to, di, dj }: { from: TilePoint; to: TilePoint; di: number; dj: number }) {
  const a: TilePoint = [from[0] + di, from[1] + dj]
  const b: TilePoint = [to[0] + di, to[1] + dj]
  const [ax, ay] = iso(a[0], a[1])
  const [bx, by] = iso(b[0], b[1])
  const tick = (x: number, y: number) => `M${x - 4} ${y + 4} L${x + 4} ${y - 4}`
  const ext = (p: TilePoint, q: TilePoint) =>
    `M${at(p[0] + di * 0.25, p[1] + dj * 0.25)} L${at(q[0] + di * 0.25, q[1] + dj * 0.25)}`
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  return (
    <g aria-hidden="true">
      <path
        d={`${ext(from, a)} ${ext(to, b)} M${ax} ${ay} L${bx} ${by} ${tick(ax, ay)} ${tick(bx, by)}`}
        stroke={FG}
        strokeOpacity={0.5}
        fill="none"
      />
      <Lettering x={(ax + bx) / 2} y={(ay + by) / 2 + 3} size={8} opacity={0.7}>
        {feet(length)}
      </Lettering>
    </g>
  )
}

/** A yard: a drafted boundary, a dash-dot setback line and dimensions along the two near edges. */
export function BlueprintYard({ i0, j0, w, h }: YardRect) {
  return (
    <g>
      <path
        d={diamond(i0, j0, w, h)}
        fill={FG}
        fillOpacity={0.035}
        stroke={FG}
        strokeOpacity={0.85}
        strokeWidth={1.4}
      />
      <path d={diamond(i0, j0, w, h, 0.22)} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="10 3 2 3" />
      <Dimension from={[i0, j0 + h]} to={[i0 + w, j0 + h]} di={0} dj={0.7} />
      <Dimension from={[i0 + w, j0]} to={[i0 + w, j0 + h]} di={0.7} dj={0} />
    </g>
  )
}

/**
 * The squad's name as a drawing title on a leader, with a revision mark when
 * something needs you. It hangs to the left, clear of the farmer who stands
 * just inside the yard.
 */
export function BlueprintSign({ name, flag }: { name: string; flag: boolean }) {
  const label = name.length > 24 ? `${name.slice(0, 23)}…` : name
  const width = label.length * 8.2
  return (
    <g>
      <circle r={2} fill={FG} />
      <path d={`M0 0 L-10 -14 H${-14 - width}`} fill="none" stroke={FG} strokeOpacity={0.7} />
      <Lettering x={-13} y={-18} size={11} anchor="end" opacity={1}>
        {label}
      </Lettering>
      {flag && (
        <g transform={`translate(${-26 - width} -18)`} className="ln-pulse">
          <path d="M0 -8 L8 6 H-8 Z" fill={BG} stroke={ACCENT} strokeWidth={1.4} strokeLinejoin="round" />
          <text y={4} textAnchor="middle" fontFamily={MONO} fontSize={9} fontWeight={700} fill={ACCENT}>
            !
          </text>
        </g>
      )}
    </g>
  )
}

/** A plant's bed: a thin inset tile, hatched in highlighter when selected. */
export function BlueprintPlot({ i, j, selected }: { i: number; j: number; selected: boolean }) {
  return (
    <path
      d={diamond(i, j, 1, 1, 0.14)}
      fill={selected ? 'url(#bp-hatch)' : 'none'}
      stroke={selected ? ACCENT : FG}
      strokeOpacity={selected ? 1 : 0.4}
      strokeWidth={selected ? 1.5 : 1}
    />
  )
}

/** An outlined leaf leaving the stem at height y, to one side, with its midrib. */
function leaf(y: number, dir: 1 | -1, s: number): string {
  const tx = dir * s
  const ty = y - s * 0.45
  return [
    `M0 ${y} Q${dir * s * 0.3} ${y - s * 0.8} ${tx} ${ty} Q${dir * s * 0.7} ${y + s * 0.2} 0 ${y}`,
    `M0 ${y} L${tx * 0.8} ${y + (ty - y) * 0.8}`,
  ].join(' ')
}

/** Botanical line drawings, one per state. */
export function BlueprintPlant({ plot }: { plot: PlotLayout }) {
  const s = plot.state
  const stroke = plot.badge ? ACCENT : FG
  if (s === 'queued')
    return (
      <g>
        <ellipse rx={8} ry={3.5} fill="none" stroke={FG} strokeOpacity={0.5} strokeDasharray="2 2" />
        <path d="M0 0 V-16 M0 -16 H9 V-10 H0" fill={BG} stroke={FG} />
        <path d="M2.5 -13 H6.5" stroke={FG} strokeOpacity={0.6} />
      </g>
    )
  if (s === 'idle' || s === 'failed')
    return (
      <g opacity={s === 'idle' ? 0.5 : 0.85}>
        <path
          d="M0 0 Q1 -12 9 -13 Q12 -12 12 -8"
          fill="none"
          stroke={FG}
          strokeDasharray={s === 'failed' ? '3 2' : undefined}
        />
        <path d={leaf(-6, -1, 7)} fill="none" stroke={FG} transform="rotate(25 0 -6)" />
        {s === 'failed' && <path d="M8 -26 L16 -18 M16 -26 L8 -18" stroke={ACCENT} strokeWidth={1.6} />}
      </g>
    )
  if (s === 'paused')
    return (
      <g>
        <path d={`M0 0 V-14 ${leaf(-8, 1, 6)} ${leaf(-11, -1, 5)}`} fill="none" stroke={FG} strokeOpacity={0.8} />
        <path
          d="M-12 0 V-16 A12 12 0 0 1 12 -16 V0 M-2 -28 H2"
          fill="none"
          stroke={FG}
          strokeOpacity={0.75}
          strokeDasharray="4 2"
        />
        <path d="M-15 0 H15" stroke={FG} strokeOpacity={0.6} />
      </g>
    )
  const tall = s === 'review' ? 30 : s === 'waiting' ? 15 : 24
  const pairs = s === 'review' ? 3 : s === 'waiting' ? 1 : 2
  const leaves = Array.from({ length: pairs }, (_, k) => {
    const y = -7 - k * ((tall - 8) / pairs)
    const size = 9 - k * 1.5
    return `${leaf(y, 1, size)} ${leaf(y - 2, -1, size - 0.5)}`
  }).join(' ')
  return (
    <g className={s === 'growing' || s === 'question' ? 'ln-sway' : undefined}>
      <path
        d={`M0 0 V${-tall} ${leaves}`}
        fill="none"
        stroke={stroke}
        strokeDasharray={s === 'waiting' ? '3 2' : undefined}
      />
      {s !== 'review' && <circle cy={-tall - 2} r={2} fill={BG} stroke={stroke} />}
      {s === 'review' &&
        [
          [-8, -13],
          [8, -19],
          [0, -tall - 4],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <circle cx={x} cy={y} r={4} fill={BG} stroke={ACCENT} strokeWidth={1.4} />
            <path d={`M${x! - 1.8} ${y! - 1.2} q1 -1.4 2.6 -1.2`} fill="none" stroke={ACCENT} strokeOpacity={0.8} />
          </g>
        ))}
      {s === 'growing' && <circle cy={-tall - 2} r={1.2} fill={ACCENT} className="ln-pulse" />}
      {s === 'blocked' && (
        <path d={`M-10 ${-tall + 2} L10 -4 M10 ${-tall + 2} L-10 -4`} stroke={ACCENT} strokeWidth={1.6} />
      )}
    </g>
  )
}

function Eyes({ face }: { face: RobotFace }) {
  switch (face) {
    case 'happy':
      return <path d="M-6.5 -28.5 q2.5 -3.5 5 0 M1.5 -28.5 q2.5 -3.5 5 0" fill="none" stroke={FG} strokeWidth={1.3} />
    case 'question':
      return (
        <g fill={ACCENT}>
          <circle cx={-4} cy={-29.5} r={1.8} />
          <circle cx={4} cy={-30.5} r={2.4} />
        </g>
      )
    case 'error':
      return (
        <path
          d="M-6 -32 l3.5 3.5 m0 -3.5 l-3.5 3.5 M2.5 -32 l3.5 3.5 m0 -3.5 l-3.5 3.5"
          stroke={ACCENT}
          strokeWidth={1.4}
          className="ln-flicker"
        />
      )
    case 'sleepy':
      return <path d="M-6 -29.5 H-2 M2 -29.5 H6" stroke={FG} strokeWidth={1.3} />
    case 'normal':
      return (
        <g fill={FG}>
          <circle cx={-4} cy={-29.5} r={1.7} />
          <circle cx={4} cy={-29.5} r={1.7} />
        </g>
      )
  }
}

/** What a role wears: the farmer's wide hat, a worker's cap, a consultant's bow tie, the assistant's headset. */
function Kit({ role }: { role: RobotRole }) {
  const ink = { fill: BG, stroke: FG, strokeLinejoin: 'round' as const }
  switch (role) {
    case 'manager':
      return (
        <g>
          <path d="M-9 -38 V-45 Q0 -50 9 -45 V-38" {...ink} />
          <path d="M-9 -41 H9" stroke={FG} strokeOpacity={0.6} />
          <ellipse cy={-38} rx={18} ry={3.5} {...ink} />
        </g>
      )
    case 'worker':
      return (
        <g>
          <path d="M0 -44 V-49" stroke={FG} />
          <circle cy={-50.5} r={1.8} {...ink} />
          <path d="M-11.5 -36 Q-11.5 -45 0 -45 Q11.5 -45 11.5 -36 Z" {...ink} />
          <path d="M8 -36.5 L19 -35 L11.5 -34" {...ink} />
        </g>
      )
    case 'consultant':
      return (
        <g>
          <path d="M0 -38 V-44" stroke={FG} />
          <circle cy={-45.5} r={1.8} {...ink} />
          <path d="M0 -19 L-5.5 -22 V-16 Z M0 -19 L5.5 -22 V-16 Z" {...ink} />
        </g>
      )
    case 'assistant':
      return (
        <g>
          <path d="M-13.5 -30 A13.5 13.5 0 0 1 13.5 -30" fill="none" stroke={FG} strokeWidth={1.4} />
          <rect x={-15.5} y={-33} width={4} height={8} rx={1.5} {...ink} />
          <rect x={11.5} y={-33} width={4} height={8} rx={1.5} {...ink} />
          <path d="M-13.5 -25 Q-12 -21 -6 -22" fill="none" stroke={FG} />
          <circle cx={-5.5} cy={-22} r={1.3} fill={ACCENT} />
        </g>
      )
  }
}

/** A robot drawn as a technical figure, feet on the anchor. */
function Figure({ role, face, ground = true }: { role: RobotRole; face: RobotFace; ground?: boolean }) {
  const ink = { fill: BG, stroke: FG, strokeLinejoin: 'round' as const }
  const working = face === 'happy'
  return (
    <g opacity={face === 'sleepy' ? 0.6 : 1}>
      {ground && <ellipse rx={12} ry={4} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="2 2" />}
      <path d="M-8 -17 L-13 -11 M8 -17 L13 -11" stroke={FG} />
      <circle cx={-13.5} cy={-10.5} r={1.6} {...ink} />
      <circle cx={13.5} cy={-10.5} r={1.6} {...ink} />
      <rect x={-11} y={-7} width={22} height={7} rx={3.5} {...ink} />
      {[-6.5, 0, 6.5].map((x) => (
        <circle key={x} cx={x} cy={-3.5} r={1.8} fill="none" stroke={FG} strokeOpacity={0.7} />
      ))}
      <rect x={-8} y={-20} width={16} height={13} rx={2} {...ink} />
      <circle
        cy={-13.5}
        r={2}
        fill={working ? ACCENT : 'none'}
        stroke={working ? ACCENT : FG}
        strokeOpacity={working ? 1 : 0.6}
        className={working ? 'ln-pulse' : undefined}
      />
      <rect x={-12} y={-38} width={24} height={17} rx={5} {...ink} />
      <rect x={-9} y={-35} width={18} height={11} rx={3} fill="none" stroke={FG} strokeOpacity={0.55} />
      <Eyes face={face} />
      <Kit role={role} />
      {face === 'question' && (
        <text x={16} y={-40} fontFamily={MONO} fontSize={11} fontWeight={700} fill={ACCENT} className="ln-blink">
          ?
        </text>
      )}
      {face === 'sleepy' && (
        <text x={14} y={-40} fontFamily={MONO} fontSize={9} fill={FG}>
          z
        </text>
      )}
    </g>
  )
}

export function BlueprintRobot({ placement, extra }: { placement: RobotPlacement; extra?: number }) {
  const { role, face, helpers } = placement
  return (
    <g>
      <Figure role={role} face={face} />
      {helpers > 0 && (
        <g transform="translate(20 -36)" className="ln-float">
          <path d="M-5 -4 H5 M0 -4 V-1.5" stroke={FG} />
          <circle r={2.6} fill={BG} stroke={FG} />
          {helpers > 1 && (
            <text x={5} y={3} fontFamily={MONO} fontSize={8} fill={FG}>
              ×{helpers}
            </text>
          )}
        </g>
      )}
      {extra ? (
        <Lettering x={14} y={4} anchor="start" size={9}>
          +{extra}
        </Lettering>
      ) : null}
    </g>
  )
}

export function BlueprintAvatar({ role, face }: { agent: Agent; role: RobotRole; face: RobotFace }) {
  return <Figure role={role} face={face} ground={false} />
}

/* ---- Buildings: faces filled with paper, hidden edges dashed ---- */

/** Filled faces, then the edges behind them as dashed hidden lines. */
function Solid({ faces, hidden, lit }: { faces: string[]; hidden?: string; lit?: boolean }) {
  return (
    <g>
      {faces.map((d, k) => (
        <path
          key={k}
          d={d}
          fill={BG}
          fillOpacity={FACE}
          stroke={lit ? ACCENT : FG}
          strokeOpacity={lit ? 1 : 0.85}
          strokeLinejoin="round"
        />
      ))}
      {hidden && <path d={hidden} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="3 3" />}
    </g>
  )
}

/** A box from i a..b, j c..e, z0..z1 pixels up: its three visible faces and three hidden edges. */
function block(a: number, b: number, c: number, e: number, z0: number, z1: number) {
  return {
    faces: [
      poly([
        [a, e, z0],
        [b, e, z0],
        [b, e, z1],
        [a, e, z1],
      ]),
      poly([
        [b, e, z0],
        [b, c, z0],
        [b, c, z1],
        [b, e, z1],
      ]),
      poly([
        [a, c, z1],
        [b, c, z1],
        [b, e, z1],
        [a, e, z1],
      ]),
    ],
    hidden: `M${at(a, c, z0)} L${at(b, c, z0)} M${at(a, c, z0)} L${at(a, e, z0)} M${at(a, c, z0)} L${at(a, c, z1)}`,
  }
}

/** A gabled building from i a..b, j c..e: walls z1 tall, ridge along i, `rise` pixels above the eaves. */
function gable(a: number, b: number, c: number, e: number, z1: number, rise: number) {
  const m = (c + e) / 2
  const top = z1 + rise
  return {
    back: poly([
      [a, m, top],
      [b, m, top],
      [b, c, z1],
      [a, c, z1],
    ]),
    walls: [
      poly([
        [a, e, 0],
        [b, e, 0],
        [b, e, z1],
        [a, e, z1],
      ]),
      poly([
        [b, e, 0],
        [b, c, 0],
        [b, c, z1],
        [b, m, top],
        [b, e, z1],
      ]),
    ],
    roof: poly([
      [a, e, z1],
      [b, e, z1],
      [b, m, top],
      [a, m, top],
    ]),
    hidden: `M${at(a, c, 0)} L${at(b, c, 0)} M${at(a, c, 0)} L${at(a, e, 0)} M${at(a, c, 0)} L${at(a, c, z1)}`,
  }
}

/** An opening (window or door) on the near-left wall (j = e). */
function onLeft(e: number, i1: number, i2: number, z1: number, z2: number): string {
  return poly([
    [i1, e, z1],
    [i2, e, z1],
    [i2, e, z2],
    [i1, e, z2],
  ])
}

/** An opening on the near-right wall (i = b). */
function onRight(b: number, j1: number, j2: number, z1: number, z2: number): string {
  return poly([
    [b, j1, z1],
    [b, j2, z1],
    [b, j2, z2],
    [b, j1, z2],
  ])
}

/** A building's title under its lowest corner. */
function Title({ below, text, count }: { below: TilePoint; text: string; count?: number }) {
  const [, y] = iso(below[0], below[1])
  return (
    <Lettering y={y + 14}>
      {text}
      {count !== undefined ? ` · ${count}` : ''}
    </Lettering>
  )
}

const detail = { fill: 'none', stroke: FG, strokeOpacity: 0.7 } as const

export function BlueprintFarmhouse() {
  const [a, b, c, e] = [-1, 1, -0.75, 0.75]
  const house = gable(a, b, c, e, 34, 26)
  const chimney = block(a + 0.35, a + 0.6, -0.45, -0.2, 34, 70)
  const porch = block(a + 0.15, b - 0.15, e, e + 0.5, 0, 4)
  return (
    <g>
      <Solid faces={[house.back]} />
      <Solid faces={chimney.faces} />
      <Solid faces={house.walls} hidden={house.hidden} />
      <Solid faces={[house.roof]} />
      <path d={`${onLeft(e, a + 0.2, a + 0.55, 14, 26)} ${onLeft(e, b - 0.55, b - 0.2, 14, 26)}`} {...detail} />
      <path
        d={`M${at(a + 0.375, e, 14)} L${at(a + 0.375, e, 26)} M${at(b - 0.375, e, 14)} L${at(b - 0.375, e, 26)}`}
        {...detail}
      />
      <path d={onLeft(e, -0.18, 0.18, 4, 24)} {...detail} />
      <path d={`${onRight(b, -0.45, -0.1, 14, 26)} ${onRight(b, 0.1, 0.45, 14, 26)}`} {...detail} />
      <path d={onRight(b, -0.12, 0.12, 40, 50)} {...detail} />
      <Solid faces={porch.faces} />
      <path
        d={`M${at(a + 0.2, e + 0.45, 4)} L${at(a + 0.2, e + 0.45, 26)} M${at(b - 0.2, e + 0.45, 4)} L${at(b - 0.2, e + 0.45, 26)}`}
        stroke={FG}
        strokeOpacity={0.85}
      />
      <Solid
        faces={[
          poly([
            [a + 0.1, e, 32],
            [b - 0.1, e, 32],
            [b - 0.1, e + 0.55, 26],
            [a + 0.1, e + 0.55, 26],
          ]),
        ]}
      />
      <Title below={[b, e + 0.5]} text="Farmhouse" />
    </g>
  )
}

export function BlueprintSeedShed() {
  const [a, b, c, e] = [-0.55, 0.55, -0.5, 0.5]
  const shed = gable(a, b, c, e, 20, 16)
  return (
    <g>
      <Solid faces={[shed.back]} />
      <Solid faces={shed.walls} hidden={shed.hidden} />
      <Solid faces={[shed.roof]} />
      <path d={`${onRight(b, -0.3, 0.3, 0, 16)} M${at(b, 0, 0)} L${at(b, 0, 16)}`} {...detail} />
      <path d={onLeft(e, -0.3, 0.1, 8, 16)} {...detail} />
      <path d={`M${at(-0.1, e, 10)} L${at(-0.1, e, 14)} M${at(-0.16, e, 12)} L${at(-0.04, e, 12)}`} {...detail} />
      <Title below={[b, e]} text="Seed shed" />
    </g>
  )
}

export function BlueprintMailbox({ count }: { count: number }) {
  const box = block(-0.2, 0.2, -0.1, 0.1, 22, 32)
  const [fx, fy] = iso(0.2, 0.02)
  return (
    <g>
      <path d="M0 0 V-22" stroke={FG} strokeWidth={1.6} />
      <Solid faces={box.faces} hidden={box.hidden} lit={count > 0} />
      {count > 0 ? (
        <g className="ln-pulse">
          <path d={`M${fx} ${fy - 24} V${fy - 44} H${fx + 12} V${fy - 37} H${fx}`} fill={ACCENT} stroke={ACCENT} />
        </g>
      ) : (
        <path d={`M${fx} ${fy - 26} H${fx + 14} V${fy - 30} H${fx}`} fill="none" stroke={FG} strokeOpacity={0.7} />
      )}
      {/* Beside the post rather than under it: a neighbouring stand often covers the ground below. */}
      <Lettering x={fx + 16} y={fy - 12} anchor="start" fill={count ? ACCENT : FG} opacity={count ? 1 : 0.85}>
        Mail · {count}
      </Lettering>
    </g>
  )
}

export function BlueprintCrates({ count }: { count: number }) {
  const crate = (i: number, j: number, z: number) => {
    const b = block(i - 0.17, i + 0.17, j - 0.17, j + 0.17, z, z + 12)
    return (
      <g key={`${i}${j}${z}`}>
        <Solid faces={b.faces} />
        <path
          d={`M${at(i - 0.17, j + 0.17, z + 6)} L${at(i + 0.17, j + 0.17, z + 6)} L${at(i + 0.17, j - 0.17, z + 6)}`}
          {...detail}
        />
      </g>
    )
  }
  return (
    <g>
      {crate(-0.2, -0.05, 0)}
      {crate(0.2, 0.05, 0)}
      {count > 1 && crate(0, 0, 12)}
      <Title below={[0.4, 0.2]} text="Harvest" count={count} />
    </g>
  )
}

export function BlueprintCompost({ count }: { count: number }) {
  const mound = 'M-24 0 Q-16 -18 0 -18 Q16 -18 24 0 Q0 8 -24 0 Z'
  return (
    <g>
      <path d={mound} fill={BG} fillOpacity={FACE} stroke={FG} strokeOpacity={0.85} />
      <path d={mound} fill="url(#bp-hatch-ink)" />
      <Title below={[0.3, 0.3]} text="Compost" count={count} />
    </g>
  )
}

/** A robot's head alone, for peeking out of a doorway. */
function Head({ face }: { face: RobotFace }) {
  return (
    <g>
      <rect x={-12} y={-38} width={24} height={17} rx={5} fill={BG} stroke={FG} />
      <rect x={-9} y={-35} width={18} height={11} rx={3} fill="none" stroke={FG} strokeOpacity={0.55} />
      <Eyes face={face} />
    </g>
  )
}

export function BlueprintHut({ count, peek }: { count: number; peek?: RobotPlacement }) {
  const [a, b, c, e] = [-0.45, 0.45, -0.35, 0.35]
  const [lo, hi] = [16, 26]
  // The roof slopes toward you; its height at any j across the hut.
  const z = (j: number) => lo + ((hi - lo) * (e - j)) / (e - c)
  const roofAt = (i: number, j: number): TilePoint => [i, j, z(j)]
  const panels = [0, 1, 2, 3]
    .map((k) => {
      const i = a + 0.08 + (k * (b - a - 0.16)) / 3
      return `M${at(...roofAt(i, c + 0.08))} L${at(...roofAt(i, e - 0.08))}`
    })
    .concat(
      [0, 1, 2].map((k) => {
        const j = c + 0.08 + (k * (e - c - 0.16)) / 2
        return `M${at(...roofAt(a + 0.08, j))} L${at(...roofAt(b - 0.08, j))}`
      })
    )
    .join(' ')
  const [dx, dy] = iso(0, e)
  const [px, py] = iso(b + 0.35, 0.15)
  return (
    <g>
      <Solid
        faces={[
          poly([
            [a, e, 0],
            [b, e, 0],
            [b, e, lo],
            [a, e, lo],
          ]),
          poly([
            [b, e, 0],
            [b, c, 0],
            [b, c, hi],
            [b, e, lo],
          ]),
          poly([roofAt(a, c), roofAt(b, c), roofAt(b, e), roofAt(a, e)]),
        ]}
        hidden={`M${at(a, c, 0)} L${at(b, c, 0)} M${at(a, c, 0)} L${at(a, e, 0)} M${at(a, c, 0)} L${at(a, c, hi)}`}
      />
      <path
        d={poly([
          roofAt(a + 0.08, c + 0.08),
          roofAt(b - 0.08, c + 0.08),
          roofAt(b - 0.08, e - 0.08),
          roofAt(a + 0.08, e - 0.08),
        ])}
        fill={FG}
        fillOpacity={0.1}
        stroke="none"
      />
      <path d={panels} fill="none" stroke={FG} strokeOpacity={0.6} />
      <path d={onLeft(e, -0.17, 0.17, 0, 12)} fill={BG} stroke={FG} strokeOpacity={0.8} />
      {peek && (
        <g transform={`translate(${dx} ${dy + 7}) scale(0.42)`}>
          <Head face={peek.face} />
        </g>
      )}
      <path d={`M${at(b, 0.1, 4)} Q${px - 4} ${py + 2} ${px} ${py - 4}`} fill="none" stroke={FG} strokeOpacity={0.7} />
      <rect x={px - 3} y={py - 10} width={6} height={10} fill={BG} stroke={FG} strokeOpacity={0.8} />
      <Title below={[b, e]} text="Charging" count={count} />
    </g>
  )
}

export function BlueprintStand({ count, host }: { count: number; host?: RobotPlacement }) {
  const [a, b, c, e] = [-0.4, 0.4, -0.2, 0.2]
  const counter = block(a, b, c, e, 0, 12)
  const [hx, hy] = iso(0, -0.3)
  const post = (i: number, j: number, z0: number) => `M${at(i, j, z0)} L${at(i, j, 50)}`
  const [f, g] = [-0.5, 0.5]
  const scallops = [0, 1, 2, 3, 4]
    .map((k) => {
      const i1 = f + k * 0.2
      const [x1, y1] = iso(i1, 0.3)
      const [x2, y2] = iso(i1 + 0.2, 0.3)
      return `M${x1} ${y1 - 50} Q${(x1 + x2) / 2} ${(y1 + y2) / 2 - 42} ${x2} ${y2 - 50}`
    })
    .join(' ')
  const stripes = [1, 2, 3, 4].map((k) => `M${at(f + k * 0.2, -0.4, 56)} L${at(f + k * 0.2, 0.3, 50)}`).join(' ')
  return (
    <g>
      <path d={`${post(a, -0.35, 0)} ${post(b, -0.35, 0)}`} stroke={FG} strokeOpacity={0.5} />
      {host && (
        <g transform={`translate(${hx} ${hy}) scale(0.8)`}>
          <Figure role="consultant" face={host.face} ground={false} />
        </g>
      )}
      <Solid faces={counter.faces} hidden={counter.hidden} />
      <path d={`${post(a, e, 12)} ${post(b, e, 12)}`} stroke={FG} strokeOpacity={0.85} />
      <Solid
        faces={[
          poly([
            [f, -0.4, 56],
            [g, -0.4, 56],
            [g, 0.3, 50],
            [f, 0.3, 50],
          ]),
        ]}
      />
      <path d={`${stripes} ${scallops}`} fill="none" stroke={FG} strokeOpacity={0.6} />
      <Title below={[b, e]} text="Consulting" count={count} />
    </g>
  )
}

/** Scenery as architect's symbols: trees in plan-circle elevation, bushes as clouds, hay as a bale. */
export function BlueprintDecor({ decor }: { decor: DecorPlacement }) {
  switch (decor.kind) {
    case 'tree':
    case 'fruitTree': {
      const spokes = Array.from({ length: 8 }, (_, k) => {
        const t = (k / 8) * Math.PI * 2
        return `M${(Math.cos(t) * 4).toFixed(1)} ${(-30 + Math.sin(t) * 4).toFixed(1)} L${(Math.cos(t) * 11).toFixed(1)} ${(-30 + Math.sin(t) * 11).toFixed(1)}`
      }).join(' ')
      return (
        <g>
          <ellipse rx={14} ry={5} fill="none" stroke={FG} strokeOpacity={0.25} strokeDasharray="2 3" />
          <path d="M0 0 V-15" stroke={FG} strokeOpacity={0.7} strokeWidth={1.4} />
          <circle cy={-30} r={16} fill={BG} fillOpacity={FACE} stroke={FG} strokeOpacity={0.7} />
          <path d={spokes} stroke={FG} strokeOpacity={0.35} />
          <circle cy={-30} r={1.5} fill={FG} fillOpacity={0.6} />
          {decor.kind === 'fruitTree' &&
            [
              [-8, -36],
              [7, -24],
              [9, -38],
            ].map(([x, y]) => (
              <circle key={`${x}${y}`} cx={x} cy={y} r={2.4} fill={BG} stroke={FG} strokeOpacity={0.8} />
            ))}
        </g>
      )
    }
    case 'bush':
      return (
        <path
          d="M-13 0 a6 6 0 0 1 2 -10 a7 7 0 0 1 12 -4 a6 6 0 0 1 11 6 a5 5 0 0 1 1 8 Z"
          fill={BG}
          fillOpacity={FACE}
          stroke={FG}
          strokeOpacity={0.6}
        />
      )
    case 'flowers':
      return (
        <g stroke={FG} strokeOpacity={0.55} fill="none">
          {[
            [-7, -2],
            [0, -6],
            [7, -1],
          ].map(([x, y]) => (
            <g key={`${x}${y}`}>
              <path d={`M${x} ${y! + 6} V${y}`} />
              <circle cx={x} cy={y! - 2} r={2.5} />
            </g>
          ))}
        </g>
      )
    case 'hay': {
      const bale = block(-0.25, 0.25, -0.18, 0.18, 0, 12)
      return (
        <g>
          <Solid faces={bale.faces} />
          <path
            d={`M${at(-0.08, 0.18, 0)} L${at(-0.08, 0.18, 12)} L${at(-0.08, -0.18, 12)} M${at(0.08, 0.18, 0)} L${at(0.08, 0.18, 12)} L${at(0.08, -0.18, 12)}`}
            {...detail}
          />
        </g>
      )
    }
  }
}
