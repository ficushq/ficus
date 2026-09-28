import { memo, type ReactNode } from 'react'
import type { Agent, FarmLook } from '@ficus/shared'
import { iso } from '../../farm/iso'
import type { DecorPlacement, FarmLayout, PlotLayout, RobotFace, RobotPlacement, RobotRole } from '../../farm/types'
import type { YardRect } from '../types'
import { HATS, hairUnderHat, PIERCINGS } from '../../multiplayer/personParts'
import { at, diamond, gridLines, poly, type TilePoint } from '../line/draw'
import { LineDefs } from '../line/sprites'
import { Circle, Ellipse, Path, Rect, useDrafting } from './drafting'

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
/** The lettering face: Blueprint's mono unless a style sets its own hand. */
const LETTER = 'var(--ln-letter, var(--g-font-mono))'

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
  const { letterScale } = useDrafting()
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontFamily={LETTER}
      fontSize={size * letterScale}
      fill={fill}
      fillOpacity={opacity}
      stroke={BG}
      strokeWidth={3}
      paintOrder="stroke"
      style={{
        textTransform: 'var(--ln-letter-case, uppercase)' as 'uppercase',
        letterSpacing: 'var(--ln-letter-tracking, 0.14em)',
      }}
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
      <Path
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

/** A yard: a drafted boundary and, on technical drawings, a dash-dot setback line and dimensions along the near edges. */
export function BlueprintYard({ i0, j0, w, h }: YardRect) {
  const { technical } = useDrafting()
  return (
    <g>
      <Path
        d={diamond(i0, j0, w, h)}
        fill={FG}
        fillOpacity={0.035}
        stroke={FG}
        strokeOpacity={0.85}
        strokeWidth={1.4}
      />
      {technical && (
        <>
          <Path
            d={diamond(i0, j0, w, h, 0.22)}
            fill="none"
            stroke={FG}
            strokeOpacity={0.3}
            strokeDasharray="10 3 2 3"
          />
          <Dimension from={[i0, j0 + h]} to={[i0 + w, j0 + h]} di={0} dj={0.7} />
          <Dimension from={[i0 + w, j0]} to={[i0 + w, j0 + h]} di={0.7} dj={0} />
        </>
      )}
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
      <Circle r={2} fill={FG} />
      <Path d={`M0 0 L-10 -14 H${-14 - width}`} fill="none" stroke={FG} strokeOpacity={0.7} />
      <Lettering x={-13} y={-18} size={11} anchor="end" opacity={1}>
        {label}
      </Lettering>
      {flag && (
        // The pulse sits inside the placing group: an animated class on an element with a transform
        // attribute replaces that transform (the warning slid about).
        <g transform={`translate(${-26 - width} -18)`}>
          <g className="ln-pulse">
            <Path d="M0 -8 L8 6 H-8 Z" fill={BG} stroke={ACCENT} strokeWidth={1.4} strokeLinejoin="round" />
            <text y={4} textAnchor="middle" fontFamily={LETTER} fontSize={9} fontWeight={700} fill={ACCENT}>
              !
            </text>
          </g>
        </g>
      )}
    </g>
  )
}

/** A plant's bed: a thin inset tile, hatched in highlighter when selected. */
export function BlueprintPlot({ i, j, selected }: { i: number; j: number; selected: boolean }) {
  return (
    <Path
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
  const { leafWash, leafInk, fruitWash } = useDrafting()
  const s = plot.state
  const stroke = plot.badge ? ACCENT : (leafInk ?? FG)
  if (s === 'queued')
    return (
      <g>
        <Ellipse rx={8} ry={3.5} fill="none" stroke={FG} strokeOpacity={0.5} strokeDasharray="2 2" />
        <Path d="M0 0 V-16 M0 -16 H9 V-10 H0" fill={BG} stroke={FG} />
        <Path d="M2.5 -13 H6.5" stroke={FG} strokeOpacity={0.6} />
      </g>
    )
  if (s === 'idle' || s === 'failed')
    return (
      <g opacity={s === 'idle' ? 0.5 : 0.85}>
        <Path
          d="M0 0 Q1 -12 9 -13 Q12 -12 12 -8"
          fill="none"
          stroke={FG}
          strokeDasharray={s === 'failed' ? '3 2' : undefined}
        />
        <Path d={leaf(-6, -1, 7)} fill="none" stroke={FG} transform="rotate(25 0 -6)" />
        {s === 'failed' && <Path d="M8 -26 L16 -18 M16 -26 L8 -18" stroke={ACCENT} strokeWidth={1.6} />}
      </g>
    )
  if (s === 'paused')
    return (
      <g>
        <Path d={`M0 0 V-14 ${leaf(-8, 1, 6)} ${leaf(-11, -1, 5)}`} fill="none" stroke={FG} strokeOpacity={0.8} />
        <Path
          d="M-12 0 V-16 A12 12 0 0 1 12 -16 V0 M-2 -28 H2"
          fill="none"
          stroke={FG}
          strokeOpacity={0.75}
          strokeDasharray="4 2"
        />
        <Path d="M-15 0 H15" stroke={FG} strokeOpacity={0.6} />
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
      <Path
        d={`M0 0 V${-tall} ${leaves}`}
        fill={leafWash ?? 'none'}
        fillOpacity={0.55}
        stroke={stroke}
        strokeDasharray={s === 'waiting' ? '3 2' : undefined}
      />
      {s !== 'review' && <Circle cy={-tall - 2} r={2} fill={BG} stroke={stroke} />}
      {s === 'review' &&
        [
          [-8, -13],
          [8, -19],
          [0, -tall - 4],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <Circle cx={x} cy={y} r={4} fill={fruitWash ?? BG} stroke={ACCENT} strokeWidth={1.4} />
            <Path d={`M${x! - 1.8} ${y! - 1.2} q1 -1.4 2.6 -1.2`} fill="none" stroke={ACCENT} strokeOpacity={0.8} />
          </g>
        ))}
      {s === 'growing' && <Circle cy={-tall - 2} r={1.2} fill={ACCENT} className="ln-pulse" />}
      {s === 'blocked' && (
        <Path d={`M-10 ${-tall + 2} L10 -4 M10 ${-tall + 2} L-10 -4`} stroke={ACCENT} strokeWidth={1.6} />
      )}
    </g>
  )
}

function Eyes({ face }: { face: RobotFace }) {
  switch (face) {
    case 'happy':
      return <Path d="M-6.5 -28.5 q2.5 -3.5 5 0 M1.5 -28.5 q2.5 -3.5 5 0" fill="none" stroke={FG} strokeWidth={1.3} />
    case 'question':
      return (
        <g fill={ACCENT}>
          <Circle cx={-4} cy={-29.5} r={1.8} />
          <Circle cx={4} cy={-30.5} r={2.4} />
        </g>
      )
    case 'error':
      return (
        <Path
          d="M-6 -32 l3.5 3.5 m0 -3.5 l-3.5 3.5 M2.5 -32 l3.5 3.5 m0 -3.5 l-3.5 3.5"
          stroke={ACCENT}
          strokeWidth={1.4}
          className="ln-flicker"
        />
      )
    case 'sleepy':
      return <Path d="M-6 -29.5 H-2 M2 -29.5 H6" stroke={FG} strokeWidth={1.3} />
    case 'normal':
      return (
        <g fill={FG}>
          <Circle cx={-4} cy={-29.5} r={1.7} />
          <Circle cx={4} cy={-29.5} r={1.7} />
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
          <Path d="M-9 -38 V-45 Q0 -50 9 -45 V-38" {...ink} />
          <Path d="M-9 -41 H9" stroke={FG} strokeOpacity={0.6} />
          <Ellipse cy={-38} rx={18} ry={3.5} {...ink} />
        </g>
      )
    case 'worker':
      return (
        <g>
          <Path d="M0 -44 V-49" stroke={FG} />
          <Circle cy={-50.5} r={1.8} {...ink} />
          <Path d="M-11.5 -36 Q-11.5 -45 0 -45 Q11.5 -45 11.5 -36 Z" {...ink} />
          <Path d="M8 -36.5 L19 -35 L11.5 -34" {...ink} />
        </g>
      )
    case 'consultant':
      return (
        <g>
          <Path d="M0 -38 V-44" stroke={FG} />
          <Circle cy={-45.5} r={1.8} {...ink} />
          <Path d="M0 -19 L-5.5 -22 V-16 Z M0 -19 L5.5 -22 V-16 Z" {...ink} />
        </g>
      )
    case 'assistant':
      return (
        <g>
          <Path d="M-13.5 -30 A13.5 13.5 0 0 1 13.5 -30" fill="none" stroke={FG} strokeWidth={1.4} />
          <Rect x={-15.5} y={-33} width={4} height={8} rx={1.5} {...ink} />
          <Rect x={11.5} y={-33} width={4} height={8} rx={1.5} {...ink} />
          <Path d="M-13.5 -25 Q-12 -21 -6 -22" fill="none" stroke={FG} />
          <Circle cx={-5.5} cy={-22} r={1.3} fill={ACCENT} />
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
      {ground && <Ellipse rx={12} ry={4} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="2 2" />}
      <Path d="M-8 -17 L-13 -11 M8 -17 L13 -11" stroke={FG} />
      <Circle cx={-13.5} cy={-10.5} r={1.6} {...ink} />
      <Circle cx={13.5} cy={-10.5} r={1.6} {...ink} />
      <Rect x={-11} y={-7} width={22} height={7} rx={3.5} {...ink} />
      {[-6.5, 0, 6.5].map((x) => (
        <Circle key={x} cx={x} cy={-3.5} r={1.8} fill="none" stroke={FG} strokeOpacity={0.7} />
      ))}
      <Rect x={-8} y={-20} width={16} height={13} rx={2} {...ink} />
      <Circle
        cy={-13.5}
        r={2}
        fill={working ? ACCENT : 'none'}
        stroke={working ? ACCENT : FG}
        strokeOpacity={working ? 1 : 0.6}
        className={working ? 'ln-pulse' : undefined}
      />
      <Rect x={-12} y={-38} width={24} height={17} rx={5} {...ink} />
      <Rect x={-9} y={-35} width={18} height={11} rx={3} fill="none" stroke={FG} strokeOpacity={0.55} />
      <Eyes face={face} />
      <Kit role={role} />
      {face === 'question' && (
        <text x={16} y={-40} fontFamily={LETTER} fontSize={11} fontWeight={700} fill={ACCENT} className="ln-blink">
          ?
        </text>
      )}
      {face === 'sleepy' && (
        <text x={14} y={-40} fontFamily={LETTER} fontSize={9} fill={FG}>
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
        <g transform="translate(20 -36)">
          <g className="ln-float">
            <Path d="M-5 -4 H5 M0 -4 V-1.5" stroke={FG} />
            <Circle r={2.6} fill={BG} stroke={FG} />
            {helpers > 1 && (
              <text x={5} y={3} fontFamily={LETTER} fontSize={8} fill={FG}>
                ×{helpers}
              </text>
            )}
          </g>
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

/** Filled faces, the shaded one shaded, then (on technical drawings) the edges behind them as dashed hidden lines. */
function Solid({ faces, hidden, lit }: { faces: string[]; hidden?: string; lit?: boolean }) {
  const { technical, shade } = useDrafting()
  return (
    <g>
      {faces.map((d, k) => (
        <Path
          key={k}
          d={d}
          fill={BG}
          fillOpacity={FACE}
          stroke={lit ? ACCENT : FG}
          strokeOpacity={lit ? 1 : 0.85}
          strokeLinejoin="round"
        />
      ))}
      {/* With light from the upper left, the second face of a solid (its right-hand wall) is in shade. */}
      {shade && faces[1] && <Path d={faces[1]} fill={shade} stroke="none" />}
      {technical && hidden && <Path d={hidden} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="3 3" />}
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
      <Path d={`${onLeft(e, a + 0.2, a + 0.55, 14, 26)} ${onLeft(e, b - 0.55, b - 0.2, 14, 26)}`} {...detail} />
      <Path
        d={`M${at(a + 0.375, e, 14)} L${at(a + 0.375, e, 26)} M${at(b - 0.375, e, 14)} L${at(b - 0.375, e, 26)}`}
        {...detail}
      />
      <Path d={onLeft(e, -0.18, 0.18, 4, 24)} {...detail} />
      <Path d={`${onRight(b, -0.45, -0.1, 14, 26)} ${onRight(b, 0.1, 0.45, 14, 26)}`} {...detail} />
      <Path d={onRight(b, -0.12, 0.12, 40, 50)} {...detail} />
      <Solid faces={porch.faces} />
      <Path
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
      <Path d={`${onRight(b, -0.3, 0.3, 0, 16)} M${at(b, 0, 0)} L${at(b, 0, 16)}`} {...detail} />
      <Path d={onLeft(e, -0.3, 0.1, 8, 16)} {...detail} />
      <Path d={`M${at(-0.1, e, 10)} L${at(-0.1, e, 14)} M${at(-0.16, e, 12)} L${at(-0.04, e, 12)}`} {...detail} />
      <Title below={[b, e]} text="Seed shed" />
    </g>
  )
}

export function BlueprintMailbox({ count }: { count: number }) {
  const box = block(-0.2, 0.2, -0.1, 0.1, 22, 32)
  const [fx, fy] = iso(0.2, 0.02)
  return (
    <g>
      <Path d="M0 0 V-22" stroke={FG} strokeWidth={1.6} />
      <Solid faces={box.faces} hidden={box.hidden} lit={count > 0} />
      {count > 0 ? (
        <g className="ln-pulse">
          <Path d={`M${fx} ${fy - 24} V${fy - 44} H${fx + 12} V${fy - 37} H${fx}`} fill={ACCENT} stroke={ACCENT} />
        </g>
      ) : (
        <Path d={`M${fx} ${fy - 26} H${fx + 14} V${fy - 30} H${fx}`} fill="none" stroke={FG} strokeOpacity={0.7} />
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
        <Path
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
      <Path d={mound} fill={BG} fillOpacity={FACE} stroke={FG} strokeOpacity={0.85} />
      <Path d={mound} fill="url(#bp-hatch-ink)" />
      <Title below={[0.3, 0.3]} text="Compost" count={count} />
    </g>
  )
}

/** A robot's head alone, for peeking out of a doorway. */
function Head({ face }: { face: RobotFace }) {
  return (
    <g>
      <Rect x={-12} y={-38} width={24} height={17} rx={5} fill={BG} stroke={FG} />
      <Rect x={-9} y={-35} width={18} height={11} rx={3} fill="none" stroke={FG} strokeOpacity={0.55} />
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
      <Path
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
      <Path d={panels} fill="none" stroke={FG} strokeOpacity={0.6} />
      <Path d={onLeft(e, -0.17, 0.17, 0, 12)} fill={BG} stroke={FG} strokeOpacity={0.8} />
      {peek && (
        <g transform={`translate(${dx} ${dy + 7}) scale(0.42)`}>
          <Head face={peek.face} />
        </g>
      )}
      <Path d={`M${at(b, 0.1, 4)} Q${px - 4} ${py + 2} ${px} ${py - 4}`} fill="none" stroke={FG} strokeOpacity={0.7} />
      <Rect x={px - 3} y={py - 10} width={6} height={10} fill={BG} stroke={FG} strokeOpacity={0.8} />
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
      <Path d={`${post(a, -0.35, 0)} ${post(b, -0.35, 0)}`} stroke={FG} strokeOpacity={0.5} />
      {host && (
        <g transform={`translate(${hx} ${hy}) scale(0.8)`}>
          <Figure role="consultant" face={host.face} ground={false} />
        </g>
      )}
      <Solid faces={counter.faces} hidden={counter.hidden} />
      <Path d={`${post(a, e, 12)} ${post(b, e, 12)}`} stroke={FG} strokeOpacity={0.85} />
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
      <Path d={`${stripes} ${scallops}`} fill="none" stroke={FG} strokeOpacity={0.6} />
      <Title below={[b, e]} text="Consulting" count={count} />
    </g>
  )
}

/** Scenery as architect's symbols: trees in plan-circle elevation, bushes as clouds, hay as a bale. */
export function BlueprintDecor({ decor }: { decor: DecorPlacement }) {
  const { leafWash } = useDrafting()
  // A wash lets the paper through; a plain face covers what's behind it.
  const foliage = leafWash ? { fill: leafWash, fillOpacity: 0.45 } : { fill: BG, fillOpacity: FACE }
  switch (decor.kind) {
    case 'tree':
    case 'fruitTree': {
      const spokes = Array.from({ length: 8 }, (_, k) => {
        const t = (k / 8) * Math.PI * 2
        return `M${(Math.cos(t) * 4).toFixed(1)} ${(-30 + Math.sin(t) * 4).toFixed(1)} L${(Math.cos(t) * 11).toFixed(1)} ${(-30 + Math.sin(t) * 11).toFixed(1)}`
      }).join(' ')
      return (
        <g>
          <Ellipse rx={14} ry={5} fill="none" stroke={FG} strokeOpacity={0.25} strokeDasharray="2 3" />
          <Path d="M0 0 V-15" stroke={FG} strokeOpacity={0.7} strokeWidth={1.4} />
          <Circle cy={-30} r={16} {...foliage} stroke={FG} strokeOpacity={0.7} />
          <Path d={spokes} stroke={FG} strokeOpacity={0.35} />
          <Circle cy={-30} r={1.5} fill={FG} fillOpacity={0.6} />
          {decor.kind === 'fruitTree' &&
            [
              [-8, -36],
              [7, -24],
              [9, -38],
            ].map(([x, y]) => (
              <Circle key={`${x}${y}`} cx={x} cy={y} r={2.4} fill={BG} stroke={FG} strokeOpacity={0.8} />
            ))}
        </g>
      )
    }
    case 'bush':
      return (
        <Path
          d="M-13 0 a6 6 0 0 1 2 -10 a7 7 0 0 1 12 -4 a6 6 0 0 1 11 6 a5 5 0 0 1 1 8 Z"
          {...foliage}
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
              <Path d={`M${x} ${y! + 6} V${y}`} />
              <Circle cx={x} cy={y! - 2} r={2.5} />
            </g>
          ))}
        </g>
      )
    case 'hay': {
      const bale = block(-0.25, 0.25, -0.18, 0.18, 0, 12)
      return (
        <g>
          <Solid faces={bale.faces} />
          <Path
            d={`M${at(-0.08, 0.18, 0)} L${at(-0.08, 0.18, 12)} L${at(-0.08, -0.18, 12)} M${at(0.08, 0.18, 0)} L${at(0.08, 0.18, 12)} L${at(0.08, -0.18, 12)}`}
            {...detail}
          />
        </g>
      )
    }
  }
}

/** A person on the farm, drawn like the robots: a technical figure, dressed by shape (hair, hat, clothes, shoes). */
export function BlueprintPerson({ look }: { look: FarmLook }) {
  const { shade } = useDrafting()
  const ink = { fill: BG, stroke: FG, strokeLinejoin: 'round' as const }
  // Hair reads as tone: hatched in pencil, a light wash on the blueprint.
  const hairTone = shade ? { fill: shade, stroke: FG } : { fill: FG, fillOpacity: 0.28, stroke: FG }
  const hy = -40
  const head = `translate(0 ${hy}) scale(0.8)`
  const hair = hairUnderHat(look)
  const sleeves = look.shirt !== 'tank'
  return (
    <g>
      <Ellipse rx={10} ry={3.5} fill="none" stroke={FG} strokeOpacity={0.3} strokeDasharray="2 2" />
      {hair.back && (
        <g transform={head}>
          <Path d={hair.back} {...hairTone} />
        </g>
      )}
      {look.shirt === 'hoodie' && <Path d="M-9.5 -30 Q-10.5 -38 0 -38.5 Q10.5 -38 9.5 -30" {...ink} />}
      <Path d="M-5 0 L-3 -15 M5 0 L3 -15" fill="none" stroke={FG} />
      {look.pants === 'shorts' && <Path d="M-6.5 -16 H6.5 L6 -9.5 H1 L0 -13 L-1 -9.5 H-6 Z" {...ink} />}
      {look.pants === 'skirt' && <Path d="M-6 -16 H6 L9 -6 H-9 Z" {...ink} />}
      {look.shoes === 'boots' ? (
        <Path d="M-7 -4 H-3 V1 H-7 Z M3 -4 H7 V1 H3 Z" {...ink} />
      ) : look.shoes === 'clogs' ? (
        <g>
          <Ellipse cx={-5} cy={-0.5} rx={3} ry={1.8} {...ink} />
          <Ellipse cx={5} cy={-0.5} rx={3} ry={1.8} {...ink} />
        </g>
      ) : look.shoes === 'sandals' ? (
        <Path d="M-7.5 0.5 H-2.5 M2.5 0.5 H7.5" fill="none" stroke={FG} strokeWidth={1.6} />
      ) : (
        <Path d="M-7.5 1 Q-7.5 -2 -4 -2 L-2.5 1 Z M2.5 1 L4 -2 Q7.5 -2 7.5 1 Z" {...ink} />
      )}
      <Path
        d="M-8 -31 L-11 -17 M8 -31 L11 -17"
        fill="none"
        stroke={FG}
        strokeDasharray={sleeves ? undefined : '2 1.6'}
      />
      {look.shirt === 'tee' && <Path d="M-9.9 -26.5 L-7.4 -26 M9.9 -26.5 L7.4 -26" fill="none" stroke={FG} />}
      <Rect x={-8} y={-33} width={16} height={18} rx={4} {...ink} />
      {look.shirt === 'flannel' && (
        <Path d="M-3 -32 V-16 M3 -32 V-16 M-7.5 -27 H7.5 M-7.5 -21 H7.5" fill="none" stroke={FG} strokeOpacity={0.45} />
      )}
      {look.shirt === 'hoodie' && <Path d="M-5 -22 H5 L6 -18 H-6 Z" fill="none" stroke={FG} strokeOpacity={0.6} />}
      {look.pants === 'overalls' ? (
        <Path d="M-5 -26 H5 V-15 H-5 Z M-5 -26 L-6 -33 M5 -26 L6 -33" {...ink} />
      ) : (
        <Path d="M-4 -33 L0 -29 L4 -33" fill="none" stroke={FG} strokeOpacity={0.6} />
      )}
      <Circle cy={hy} r={8} {...ink} />
      <Circle cx={-2.8} cy={hy + 1} r={1} fill={FG} />
      <Circle cx={2.8} cy={hy + 1} r={1} fill={FG} />
      <Path d={`M-2.2 ${hy + 4} q2.2 1.8 4.4 0`} fill="none" stroke={FG} strokeOpacity={0.7} />
      <g transform={head}>
        {hair.front && <Path d={hair.front} {...hairTone} />}
        {look.piercings.flatMap((kind) =>
          PIERCINGS[kind].map((p, k) => (
            <Path
              key={`${kind}${k}`}
              d={p.d}
              fill={p.ring ? 'none' : ACCENT}
              stroke={ACCENT}
              strokeWidth={p.ring ? 1.2 : 0.6}
            />
          ))
        )}
        {look.hat !== 'none' &&
          HATS[look.hat].map((piece, k) =>
            piece.line ? (
              <Path key={k} d={piece.d} fill="none" stroke={FG} strokeOpacity={0.7} />
            ) : (
              <Path key={k} d={piece.d} {...ink} />
            )
          )}
      </g>
    </g>
  )
}
