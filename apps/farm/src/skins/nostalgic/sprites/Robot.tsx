import type { ReactNode } from 'react'
import type { RobotFace } from '../../../farm/types'
import type { RobotAntenna, RobotHat, RobotHead, RobotLook, RobotProp } from '../types'
import { shellFill } from './Defs'
import { CountBadge, FONT_DISPLAY, INK, LEAF_PATH } from './shared'

/** The default overalls/apron fill: denim. */
export const DENIM = 'url(#g-denim)'

// Robots use explicit stroke attributes (1.5 / 1.1) rather than the shared
// outline classes, matching the approved cast sheet.
const OL = { stroke: INK, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round' } as const
const OL2 = { stroke: INK, strokeWidth: 1.1, strokeLinejoin: 'round', strokeLinecap: 'round' } as const

/** Head centre y. */
const HY = -43
/** Screen centre x (faces look slightly right). */
const SX = 1.5
const EYES = [SX - 4.6, SX + 4.6] as const
const EY = HY + 0.2

/** How far each hat's crown rises above the head top; antennas start there. */
const CROWN: Record<RobotHat, number> = {
  straw: 22.5,
  sun: 20.5,
  cap: 21.5,
  bandana: 19.5,
  beanie: 25,
  bucket: 24.5,
}

/** Maps a legacy `url(#name)` fill to its `g-` prefixed id. */
function fillRef(fill: string): string {
  return fill.startsWith('url(#') && !fill.startsWith('url(#g-') ? fill.replace('url(#', 'url(#g-') : fill
}

function Tube({ d, color, w = 4.4, inner = 2.4 }: { d: string; color: string; w?: number; inner?: number }) {
  return (
    <>
      <path d={d} fill="none" stroke={INK} strokeWidth={w} strokeLinecap="round" />
      <path d={d} fill="none" stroke={color} strokeWidth={inner} strokeLinecap="round" />
    </>
  )
}

function Locomotion({ look }: { look: RobotLook }) {
  switch (look.move) {
    case 'wheel':
      return (
        <>
          <Tube d="M-4 -12 L-3 -6 M4 -12 L3 -6" color="#9aa4ad" w={3.4} inner={1.8} />
          <circle cy={-5.5} r={5.5} fill="#4a4f55" {...OL} />
          <circle cy={-5.5} r={2.2} fill="#c9ced3" {...OL2} />
          <path d="M0 -10.5 v2.4 M0 -.5 v-2.4 M-5 -5.5 h2.4 M5 -5.5 h-2.4" stroke="#2b2f33" strokeWidth={1} />
        </>
      )
    case 'treads':
      return (
        <>
          <rect x={-12} y={-9} width={24} height={9} rx={4.5} fill="#4a4f55" {...OL} />
          {[-7, 0, 7].map((x) => (
            <circle key={x} cx={x} cy={-4.5} r={2.4} fill="#9aa4ad" {...OL2} />
          ))}
          <path d="M-10 -9.5 h20" stroke="#fff" strokeOpacity={0.25} strokeWidth={1.2} />
        </>
      )
    case 'hover':
      return (
        <>
          <ellipse cy={-4} rx={4.5} ry={6} fill={look.glow} opacity={0.55} />
          <ellipse cy={-5} rx={2.4} ry={3.6} fill="#fff" opacity={0.8} />
          <path d="M-7 -10 h14 l-2 3 h-10z" fill="#9aa4ad" {...OL2} />
        </>
      )
    case 'legs':
      return (
        <>
          <path d="M-5 -10 q-3 2 0 4 q3 2 0 4" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
          <path d="M5 -10 q-3 2 0 4 q3 2 0 4" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
          <path
            d="M-5 -10 q-3 2 0 4 q3 2 0 4 M5 -10 q-3 2 0 4 q3 2 0 4"
            stroke="#c9ced3"
            strokeWidth={1.4}
            fill="none"
          />
          <ellipse cx={-5.5} cy={-1.5} rx={4.2} ry={2.2} fill={look.panel} {...OL2} />
          <ellipse cx={5.5} cy={-1.5} rx={4.2} ry={2.2} fill={look.panel} {...OL2} />
        </>
      )
  }
}

function Outfit({ look }: { look: RobotLook }) {
  const fill = fillRef(look.outfitColor || DENIM)
  if (look.outfit === 'overalls') {
    return (
      <>
        <path d="M-11 -17 H11 V-18 Q11 -10 5 -10 H-5 Q-11 -10 -11 -18Z" fill={fill} {...OL} />
        <rect x={-7} y={-26} width={14} height={10} rx={1.5} fill={fill} {...OL2} />
        <Tube d="M-6 -26 L-8.5 -29.6 M6 -26 L8.5 -29.6" color="#6d93bd" w={3.2} inner={1.8} />
        <circle cx={-5.2} cy={-24.6} r={1.3} fill="#f2c14e" {...OL2} />
        <circle cx={5.2} cy={-24.6} r={1.3} fill="#f2c14e" {...OL2} />
        <rect
          x={-3.4}
          y={-23}
          width={6.8}
          height={4.6}
          rx={1}
          fill="none"
          stroke="#2f5078"
          strokeWidth={0.9}
          strokeDasharray="1.4 1"
        />
        <path d="M1 -23.4 l1.4 -3.6" stroke="#f2c14e" strokeWidth={1.6} strokeLinecap="round" />
      </>
    )
  }
  if (look.outfit === 'apron') {
    return (
      <>
        <path d="M-8 -27 H8 V-12 Q8 -6 0 -6 Q-8 -6 -8 -12Z" fill={fill} {...OL} />
        <path d="M-8 -26 Q-11 -28 -9 -30 M8 -26 Q11 -28 9 -30" stroke={INK} strokeWidth={1.4} fill="none" />
        <rect x={-5} y={-17} width={10} height={6} rx={1.4} fill="none" stroke={INK} strokeWidth={1} opacity={0.55} />
        <path d="M-3 -17 v-4 M3 -17 v-3" stroke="#9aa4ad" strokeWidth={1.6} strokeLinecap="round" />
      </>
    )
  }
  return null
}

function Head({ head, fill }: { head: RobotHead; fill: string }) {
  switch (head) {
    case 'round':
      return <ellipse cy={HY} rx={14} ry={11.5} fill={fill} {...OL} />
    case 'box':
      return <rect x={-14} y={HY - 11} width={28} height={22} rx={6} fill={fill} {...OL} />
    case 'dome':
      return (
        <path
          d={`M-14 ${HY + 9} V${HY} a14 13 0 0 1 28 0 V${HY + 9} q0 2 -2 2 h-24 q-2 0 -2 -2z`}
          fill={fill}
          {...OL}
        />
      )
  }
}

/** A transform that mirrors a glyph about x, undoing a mirrored robot's flip so text still reads. */
const unmirror = (flip: boolean, x: number) => (flip ? `matrix(-1 0 0 1 ${2 * x} 0)` : undefined)

function Face({ face, glow, flip }: { face: RobotFace; glow: string; flip: boolean }) {
  const gs = {
    stroke: glow,
    strokeWidth: 1.9,
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  let eyes: ReactNode
  switch (face) {
    case 'happy':
      eyes = (
        <>
          {EYES.map((x) => (
            <path key={x} d={`M${x - 2.4} ${EY + 1} q2.4 -3.6 4.8 0`} {...gs} />
          ))}
          <path d={`M${SX - 2} ${EY + 3.8} q2 1.6 4 0`} {...gs} strokeWidth={1.4} />
        </>
      )
      break
    case 'normal':
      eyes = (
        <g className="g-blink">
          {EYES.map((x) => (
            <rect key={x} x={x - 1.7} y={EY - 2.6} width={3.4} height={5.2} rx={1.7} fill={glow} />
          ))}
        </g>
      )
      break
    case 'question':
      eyes = (
        <g className="g-blink">
          {EYES.map((x) => (
            <text
              key={x}
              x={x}
              y={EY + 3}
              transform={unmirror(flip, x)}
              textAnchor="middle"
              fontFamily={FONT_DISPLAY}
              fontWeight={900}
              fontSize={8.5}
              fill={glow}
            >
              ?
            </text>
          ))}
        </g>
      )
      break
    case 'sleepy':
      eyes = EYES.map((x) => <path key={x} d={`M${x - 2.2} ${EY + 0.6} h4.4`} {...gs} />)
      break
    case 'error':
      eyes = EYES.map((x) => (
        <path
          key={x}
          d={`M${x - 2} ${EY - 2} l4 4 M${x + 2} ${EY - 2} l-4 4`}
          stroke="#ff8a7a"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ))
      break
  }
  const cheeks = face !== 'error' && face !== 'sleepy'
  return (
    <>
      <rect x={SX - 10.5} y={HY - 7} width={21} height={14} rx={5.5} fill="#23282c" {...OL2} />
      <path
        d={`M${SX - 8} ${HY - 4.6} q3 -1.6 6 -1.6`}
        stroke="#fff"
        strokeOpacity={0.22}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      {eyes}
      {cheeks && (
        <>
          <rect x={SX - 9.6} y={EY + 2.6} width={3} height={1.6} rx={0.8} fill="#ef8f80" opacity={0.9} />
          <rect x={SX + 6.6} y={EY + 2.6} width={3} height={1.6} rx={0.8} fill="#ef8f80" opacity={0.9} />
        </>
      )}
      {face === 'sleepy' && (
        <g className="g-zz">
          <text
            x={14}
            y={HY - 12}
            transform={unmirror(flip, 16)}
            fontFamily={FONT_DISPLAY}
            fontWeight={900}
            fontSize={8}
            fill="#fffaf1"
            stroke={INK}
            strokeWidth={2}
            paintOrder="stroke"
          >
            z
          </text>
          <text
            x={19}
            y={HY - 19}
            transform={unmirror(flip, 20.5)}
            fontFamily={FONT_DISPLAY}
            fontWeight={900}
            fontSize={6}
            fill="#fffaf1"
            stroke={INK}
            strokeWidth={1.8}
            paintOrder="stroke"
          >
            z
          </text>
        </g>
      )}
      {face === 'error' && (
        <g className="g-glow">
          <path d={`M14 ${HY - 10} l3 -4 l-1 3 l3 -1 l-4 5`} fill="#f2c14e" {...OL2} />
        </g>
      )}
    </>
  )
}

function SmallLeaf({ r, s, fill, sw }: { r: number; s: number; fill: string; sw: number }) {
  return (
    <g transform={`rotate(${r}) scale(${s})`}>
      <path d={LEAF_PATH} fill={fill} stroke={INK} strokeWidth={sw} />
    </g>
  )
}

function Hat({ hat, color }: { hat: RobotHat; color: string }) {
  switch (hat) {
    case 'straw':
      return (
        <g transform={`translate(0 ${HY - 9})`}>
          <ellipse rx={22} ry={5.8} fill="url(#g-straw)" {...OL} />
          <path d="M-12 0 Q-12 -13 0 -13.5 Q12 -13 12 0 Q0 3 -12 0Z" fill="url(#g-straw)" {...OL} />
          <path d="M-12 -3 Q0 0 12 -3" stroke="#b0582f" strokeWidth={3.4} fill="none" />
          <path d="M-16 1 l-1 3 M-6 3.4 l-.5 3 M8 3.2 l.5 3 M16 1.4 l1 3" stroke="#b8923f" strokeWidth={1} />
          <g transform="translate(7 -11)">
            <SmallLeaf r={30} s={0.26} fill="#5d9a58" sw={5.4} />
          </g>
        </g>
      )
    case 'cap':
      return (
        <g transform={`translate(0 ${HY - 11.5})`}>
          <path d="M-14.4 4 Q-15 -10 0 -10.5 Q14 -10 14.6 3 Q0 -1 -14.4 4Z" fill={color} {...OL} />
          <path d="M9 2 Q18 0 23 4 Q16 6.6 9 5.4Z" fill={color} {...OL} />
          <path
            d="M-7 -7 Q-3 -9 1 -8"
            stroke="#fff"
            strokeOpacity={0.4}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />
          <path d="M0 -10 V2" stroke={INK} strokeWidth={0.8} opacity={0.35} />
        </g>
      )
    case 'bandana':
      return (
        <g transform={`translate(0 ${HY - 10.5})`}>
          <path d="M-14.3 4 Q-14 -8 0 -8.8 Q14 -8 14.3 4 Q7 0 0 .2 Q-7 0 -14.3 4Z" fill={color} {...OL} />
          <path d="M-14 2 q-6 2 -7 7 q4 -1 6 -3.4" fill={color} {...OL2} />
          {(
            [
              [-7, -3],
              [0, -5.4],
              [7, -3],
              [-3.4, 1],
              [3.4, 0.4],
            ] as const
          ).map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r={1} fill="#fff" opacity={0.9} />
          ))}
        </g>
      )
    case 'beanie':
      return (
        <g transform={`translate(0 ${HY - 10})`}>
          <path d="M-14.4 3 Q-15 -14 0 -14.6 Q15 -14 14.4 3Z" fill={color} {...OL} />
          <rect x={-15} y={-1} width={30} height={6} rx={3} fill={color} {...OL} />
          {[-10, -5, 0, 5, 10].map((x) => (
            <path key={x} d={`M${x} 0 v4`} stroke={INK} strokeWidth={0.8} opacity={0.4} />
          ))}
          <circle cy={-16} r={4} fill="#fffaf1" {...OL2} />
        </g>
      )
    case 'bucket':
      return (
        <g transform={`translate(0 ${HY - 11.5})`}>
          <path d="M-19 4 Q0 -2 19 4 Q18 8 0 6 Q-18 8 -19 4Z" fill={color} {...OL} />
          <path d="M-11 2 Q-12 -13 0 -13.5 Q12 -13 11 2Z" fill={color} {...OL} />
          <path d="M-11 -2 Q0 1 11 -2" stroke={INK} strokeWidth={1} opacity={0.4} fill="none" />
          <path
            d="M-6 -9 q3 -2 6 -2"
            stroke="#fff"
            strokeOpacity={0.4}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
          />
        </g>
      )
    case 'sun':
      return (
        <g transform={`translate(0 ${HY - 9})`}>
          <ellipse rx={20} ry={5} fill="#fbf4e4" {...OL} />
          <path d="M-11 0 Q-11 -11 0 -11.5 Q11 -11 11 0 Q0 2.6 -11 0Z" fill="#fbf4e4" {...OL} />
          <path d="M-11 -2.6 Q0 0 11 -2.6" stroke="#8a9a5b" strokeWidth={3} fill="none" />
          <circle cx={8.5} cy={-5} r={3.2} fill="#f2c14e" {...OL2} />
          <circle cx={8.5} cy={-5} r={1.1} fill="#b0582f" />
        </g>
      )
  }
}

function Antenna({ kind, glow }: { kind: RobotAntenna; glow: string }) {
  const stalk = <Tube d={`M0 ${HY - 11} v-7`} color="#9aa4ad" w={3} inner={1.4} />
  switch (kind) {
    case 'sprout':
      return (
        <>
          {stalk}
          <g transform={`translate(0 ${HY - 17})`}>
            <SmallLeaf r={35} s={0.32} fill="#5d9a58" sw={4.4} />
            <SmallLeaf r={-40} s={0.26} fill="#8a9a5b" sw={5.4} />
          </g>
        </>
      )
    case 'bulb':
      return (
        <>
          {stalk}
          <circle cy={HY - 20} r={3.4} fill={glow} {...OL2} />
          <circle cx={-1} cy={HY - 21} r={1} fill="#fff" />
        </>
      )
    case 'twin':
      return (
        <>
          <Tube d={`M-6 ${HY - 10} l-3 -7 M6 ${HY - 10} l3 -7`} color="#9aa4ad" w={3} inner={1.4} />
          <circle cx={-9.4} cy={HY - 18} r={2.4} fill="#e8897a" {...OL2} />
          <circle cx={9.4} cy={HY - 18} r={2.4} fill="#e8897a" {...OL2} />
        </>
      )
    case 'none':
      return null
  }
}

function Prop({ prop }: { prop: RobotProp }) {
  switch (prop) {
    case 'can':
      return (
        <g transform="translate(15 -18)">
          <g className="g-pour">
            <path d="M0 -6 h12 v9 q0 3 -3 3 h-6 q-3 0 -3 -3z" fill="url(#g-terra)" {...OL} />
            <path d="M12 -3 l9 -7 l1.6 1.6 l-9 7z" fill="#c8643a" {...OL2} />
            <path d="M2 -6 q4 -8 8 0" fill="none" stroke={INK} strokeWidth={1.6} />
          </g>
          <g className="g-drip">
            <circle cx={24} cy={-8} r={1.5} fill="#7fc0e4" />
            <circle cx={25} cy={-4} r={1.5} fill="#7fc0e4" />
            <circle cx={23} cy={0} r={1.5} fill="#7fc0e4" />
          </g>
        </g>
      )
    case 'clip':
      return (
        <g transform="translate(7 -26) rotate(10)">
          <rect width={12} height={15} rx={1.6} fill="#9a6b41" {...OL2} />
          <rect x={2} y={3} width={8} height={10} fill="#fffdf7" />
          <rect x={4} y={1} width={4} height={3} rx={1} fill="#c9c9c9" {...OL2} />
          <path d="M3.5 6.5 h5 M3.5 9 h5 M3.5 11.2 h3" stroke="#8a5a33" strokeWidth={0.9} />
        </g>
      )
    case 'hoe':
      return (
        <g>
          <Tube d="M15 -4 L21 -46" color="#c99459" w={4} inner={2.2} />
          <path d="M19 -46 h9 l-2 5 h-7z" fill="#9aa4ad" {...OL2} />
        </g>
      )
  }
}

/** A tiny hovering helper bot near the robot's shoulder (live subagents). */
function HelperDrone({ count, glow, panel, x }: { count: number; glow: string; panel: string; x: number }) {
  return (
    <g transform={`translate(${x} -40)`}>
      <g className="g-drone">
        <ellipse cy={9} rx={2.2} ry={3} fill={glow} opacity={0.55} />
        <path d="M0 -6.5 v-3" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />
        <path d="M0 -6.5 v-3" stroke="#9aa4ad" strokeWidth={1} />
        <circle cy={-10.5} r={1.8} fill={glow} {...OL2} />
        <circle r={6.5} fill="url(#g-shell-e6eef5)" {...OL} />
        <path d="M-4.5 5 h9" stroke={panel} strokeWidth={2} strokeLinecap="round" />
        <rect x={-4.4} y={-3.4} width={8.8} height={6} rx={3} fill="#23282c" {...OL2} />
        <circle cx={0.6} cy={-0.4} r={1.6} fill={glow} />
        {count > 1 && (
          <g transform="translate(7 -7)">
            <CountBadge count={count} small />
          </g>
        )}
      </g>
    </g>
  )
}

/** "+N" pill at the robot's feet: more robots here than are drawn. */
function ExtraTag({ n }: { n: number }) {
  const label = `+${n > 99 ? 99 : n}`
  const w = 8 + label.length * 5.6
  return (
    <g transform="translate(14 -13)">
      <rect width={w} height={12} rx={6} fill="#fffaf1" {...OL2} />
      <text x={w / 2} y={9} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={900} fontSize={9} fill={INK}>
        {label}
      </text>
    </g>
  )
}

/**
 * A farm robot, anchored at the ground point it stands on (~58px tall,
 * facing slightly right, or left when flipped). Only its body mirrors: the
 * glyphs on its face, its helper drone's count and the "+N" tag still read.
 */
export function Robot({
  look,
  face,
  prop,
  helpers = 0,
  extra = 0,
  flip = false,
}: {
  look: RobotLook
  face: RobotFace
  prop: RobotProp | null
  helpers?: number
  extra?: number
  flip?: boolean
}) {
  const hover = look.move === 'hover'
  const lift = hover ? 7 : look.move === 'legs' ? 3 : 0
  const shell = shellFill(look.shell)
  const crown = look.hat ? CROWN[look.hat] : 11
  const hand: readonly [number, number] = prop === 'can' ? [14, -17] : prop === 'clip' ? [10, -17] : [15, -13]
  return (
    <g>
      <ellipse rx={hover ? 9 : 13} ry={hover ? 3.4 : 4.5} fill="#2a1a0e" opacity={hover ? 0.16 : 0.22} />
      <g className={hover ? 'g-hover' : undefined}>
        <g transform={flip ? 'scale(-1 1)' : undefined}>
          <Locomotion look={look} />
          <g transform={`translate(0 ${-lift})`}>
            <Tube d="M-10 -24 q-6 3 -6 10" color="#c9ced3" />
            <Tube d="M-19 -12 a3.4 3.4 0 1 1 6 0" color={look.panel} w={3.8} inner={2} />
            <rect x={-11} y={-30} width={22} height={20} rx={8} fill={shell} {...OL} />
            <rect x={-6.5} y={-25} width={13} height={10} rx={3.5} fill={look.panel} {...OL2} />
            <circle cx={-2.6} cy={-20} r={1.5} fill="#fff" opacity={0.9} />
            <circle cx={1.6} cy={-20} r={1.5} fill="#f2c14e" />
            <rect x={-3.6} y={-17.4} width={7} height={1.4} rx={0.7} fill={INK} opacity={0.4} />
            <path d="M-8 -28 q2 -1 5 -1" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" opacity={0.8} />
            <Outfit look={look} />
            {look.scarf && (
              <>
                <path d="M-7 -30.5 Q0 -27 7 -30.5 L3 -24 L0 -21 L-3 -24Z" fill={look.scarf} {...OL2} />
                <circle cx={-1.6} cy={-27.6} r={0.7} fill="#fff" opacity={0.8} />
                <circle cx={1.6} cy={-25.6} r={0.7} fill="#fff" opacity={0.8} />
              </>
            )}
            <rect x={-3} y={-33} width={6} height={4} fill="#9aa4ad" {...OL2} />
            <rect x={-17.5} y={HY - 4} width={5} height={8} rx={2} fill={look.panel} {...OL2} />
            <rect x={12.5} y={HY - 4} width={5} height={8} rx={2} fill={look.panel} {...OL2} />
            <Head head={look.head} fill={shell} />
            <Face face={face} glow={look.glow} flip={flip} />
            {look.hat && <Hat hat={look.hat} color={look.hatColor} />}
            {look.antenna !== 'none' && (
              <g transform={`translate(0 ${-(crown - 11)})`}>
                <Antenna kind={look.antenna} glow={look.glow} />
              </g>
            )}
            <Tube d={`M10 -24 q6 2 ${hand[0] - 10} ${hand[1] + 24}`} color="#c9ced3" />
            {prop && <Prop prop={prop} />}
            <Tube d={`M${hand[0] - 3} ${hand[1] + 2} a3.4 3.4 0 1 1 6 0`} color={look.panel} w={3.8} inner={2} />
          </g>
        </g>
        {helpers > 0 && (
          <g transform={`translate(0 ${-lift})`}>
            <HelperDrone count={helpers} glow={look.glow} panel={look.panel} x={flip ? 27 : -27} />
          </g>
        )}
      </g>
      {extra > 0 && <ExtraTag n={extra} />}
    </g>
  )
}
