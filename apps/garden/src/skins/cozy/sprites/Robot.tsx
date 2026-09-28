import type { RobotFace } from '../../../farm/types'
import { DENIM } from '../../nostalgic/looks'
import type { RobotHat, RobotLook, RobotProp } from '../../nostalgic/types'
import { Ball, Bean, Blob, Drop, FONT, light, Pill, rim } from './kit'

/*
 * A Cozy robot: round and squishy, a big glossy face screen and blushing
 * cheeks. It wears the same look as its Nostalgic self (shell, head shape,
 * hat, outfit, scarf, antenna, prop), in softer colours, so each agent is
 * recognisable in either style.
 */

const SCREEN = '#35334a'
const METAL = '#9a98b3'

/** Softer versions of the look's colours. */
const soft = (color: string) => (color === DENIM ? '#8fb4e3' : light(color, 28))

/** The glyph transform that undoes a mirrored robot's flip, so text still reads. */
const unmirror = (flip: boolean, x: number) => (flip ? `matrix(-1 0 0 1 ${2 * x} 0)` : undefined)

function Eyes({ face, glow, y, flip }: { face: RobotFace; glow: string; y: number; flip: boolean }) {
  const xs = [-5, 5]
  switch (face) {
    case 'happy':
      return (
        <g className="cz-blink">
          {xs.map((x) => (
            <path
              key={x}
              d={`M${x - 3} ${y + 1} q3 -4.5 6 0`}
              stroke={glow}
              strokeWidth={2.4}
              strokeLinecap="round"
              fill="none"
            />
          ))}
        </g>
      )
    case 'normal':
      return (
        <g className="cz-blink">
          {xs.map((x) => (
            <ellipse key={x} cx={x} cy={y} rx={2.3} ry={3} fill={glow} />
          ))}
        </g>
      )
    case 'question':
      return (
        <g className="cz-blink">
          {xs.map((x) => (
            <text
              key={x}
              x={x}
              y={y + 3.5}
              transform={unmirror(flip, x)}
              textAnchor="middle"
              fontFamily={FONT}
              fontWeight={700}
              fontSize={10}
              fill={glow}
            >
              ?
            </text>
          ))}
        </g>
      )
    case 'sleepy':
      return (
        <g>
          {xs.map((x) => (
            <path
              key={x}
              d={`M${x - 3} ${y} q3 2.4 6 0`}
              stroke={glow}
              strokeWidth={2.2}
              strokeLinecap="round"
              fill="none"
            />
          ))}
        </g>
      )
    case 'error':
      return (
        <g>
          {xs.map((x) => (
            <path
              key={x}
              d={`M${x - 2.4} ${y - 2.4} l4.8 4.8 M${x + 2.4} ${y - 2.4} l-4.8 4.8`}
              stroke="#ff9a8a"
              strokeWidth={2.2}
              strokeLinecap="round"
            />
          ))}
        </g>
      )
  }
}

/** The hat, drawn with its brim at `top` (the top of the head). */
function Hat({ hat, color, top }: { hat: RobotHat; color: string; top: number }) {
  const c = soft(color)
  switch (hat) {
    case 'straw':
      return (
        <g>
          <Bean cx={0} cy={top + 2} rx={22} ry={5.5} fill="#f4d67f" />
          <Blob d={`M-12 ${top + 2} Q-12 ${top - 12} 0 ${top - 12} Q12 ${top - 12} 12 ${top + 2} Z`} fill="#f4d67f" />
          <rect x={-12} y={top - 2} width={24} height={4} rx={2} fill={c} />
        </g>
      )
    case 'sun':
      return (
        <g>
          <Bean cx={0} cy={top + 2} rx={23} ry={6.5} fill={c} />
          <Blob d={`M-11 ${top + 2} Q-11 ${top - 11} 0 ${top - 11} Q11 ${top - 11} 11 ${top + 2} Z`} fill={c} />
          <Ball cx={9} cy={top - 2} r={3.4} fill="#fff1f5" />
          <circle cx={9} cy={top - 2} r={1.4} fill="#f7cf4d" />
        </g>
      )
    case 'cap':
      return (
        <g>
          <Bean cx={13} cy={top + 3} rx={10} ry={3.4} fill={rim(c, 10)} />
          <Blob d={`M-14 ${top + 4} Q-14 ${top - 12} 0 ${top - 12} Q14 ${top - 12} 14 ${top + 4} Z`} fill={c} />
          <circle cx={0} cy={top - 11} r={2} fill={light(c, 40)} />
        </g>
      )
    case 'bandana':
      return (
        <g>
          <Blob
            d={`M-15 ${top + 6} Q-15 ${top - 6} 0 ${top - 7} Q15 ${top - 6} 15 ${top + 6} Q0 ${top + 2} -15 ${top + 6} Z`}
            fill={c}
          />
          <Ball cx={-15} cy={top + 6} r={3.4} fill={c} />
          {[-6, 1, 8].map((x) => (
            <circle key={x} cx={x} cy={top - 1} r={1.3} fill="#fffaf0" opacity={0.85} />
          ))}
        </g>
      )
    case 'beanie':
      return (
        <g>
          <Blob d={`M-14 ${top + 5} Q-14 ${top - 13} 0 ${top - 13} Q14 ${top - 13} 14 ${top + 5} Z`} fill={c} />
          <Pill x={-15} y={top + 1} width={30} height={7} r={3.5} fill={light(c, 18)} />
          <Ball cx={0} cy={top - 15} r={4.2} fill={light(c, 30)} />
        </g>
      )
    case 'bucket':
      return (
        <g>
          <Bean cx={0} cy={top + 4} rx={17} ry={4.6} fill={rim(c, 8)} />
          <Blob d={`M-11 ${top + 4} L-9 ${top - 9} Q0 ${top - 12} 9 ${top - 9} L11 ${top + 4} Z`} fill={c} />
        </g>
      )
  }
}

function Prop({ prop, hand }: { prop: RobotProp; hand: readonly [number, number] }) {
  const [x, y] = hand
  switch (prop) {
    case 'can':
      return (
        <g transform={`translate(${x + 2} ${y - 4})`}>
          <g className="cz-pour">
            <path d="M3 -8 q4 -6 8 0" stroke="#5fb8c2" strokeWidth={2.2} fill="none" strokeLinecap="round" />
            <Pill x={0} y={-6} width={14} height={11} r={4.5} fill="#7fd0d8" />
            <path d="M13 -3 L21 -9" stroke="#5fb8c2" strokeWidth={3} strokeLinecap="round" />
            <Ball cx={22} cy={-10} r={2.4} fill="#7fd0d8" edge={false} />
          </g>
          <g className="cz-drip">
            <circle cx={24} cy={-6} r={1.5} fill="#8fd3f2" />
            <circle cx={25} cy={-2} r={1.5} fill="#8fd3f2" />
            <circle cx={23.5} cy={2} r={1.5} fill="#8fd3f2" />
          </g>
        </g>
      )
    case 'clip':
      return (
        <g transform={`translate(${x - 3} ${y - 16}) rotate(8)`}>
          <Pill x={0} y={0} width={13} height={16} r={3} fill="#d49a60" />
          <rect x={2} y={3} width={9} height={11} rx={1.5} fill="#fffdf6" />
          <path d="M4 7 h5 M4 9.6 h5 M4 12 h3" stroke="#c9b08a" strokeWidth={1} strokeLinecap="round" />
          <rect x={4.5} y={-1} width={4} height={3} rx={1} fill="#b0aec6" />
        </g>
      )
    case 'hoe':
      return (
        <g>
          <path
            d={`M${x + 1} ${y + 12} L${x + 6} ${y - 30}`}
            stroke="#c9905a"
            strokeWidth={3.4}
            strokeLinecap="round"
          />
          <Blob d={`M${x + 3} ${y - 31} h10 q2 0 1 3 l-2 3 h-9z`} fill="#b7c3cf" />
        </g>
      )
  }
}

function Locomotion({ look }: { look: RobotLook }) {
  const panel = soft(look.panel)
  switch (look.move) {
    case 'legs':
      return (
        <g>
          <Bean cx={-5.5} cy={-3} rx={4.6} ry={3.6} fill={panel} />
          <Bean cx={5.5} cy={-3} rx={4.6} ry={3.6} fill={panel} />
        </g>
      )
    case 'wheel':
      return (
        <g>
          <Ball cx={0} cy={-6} r={6} fill={METAL} />
          <circle cx={0} cy={-6} r={2.2} fill={light(METAL, 45)} />
        </g>
      )
    case 'treads':
      return (
        <g>
          <Pill x={-12} y={-8} width={24} height={8} r={4} fill={METAL} />
          {[-7, 0, 7].map((cx) => (
            <circle key={cx} cx={cx} cy={-4} r={1.8} fill={light(METAL, 40)} />
          ))}
        </g>
      )
    case 'hover':
      return <ellipse cy={-3} rx={9} ry={3} fill={look.glow} opacity={0.5} className="cz-pulse" />
  }
}

const LIFT = { legs: 5, wheel: 10, treads: 7, hover: 11 } as const

/** Anchored at the ground point it stands on; about 60px tall. Faces right, or left when flipped. */
export function CozyRobot({
  look,
  face,
  prop,
  helpers = 0,
  extra = 0,
  flip = false,
  shadow = true,
}: {
  look: RobotLook
  face: RobotFace
  prop: RobotProp | null
  helpers?: number
  extra?: number
  flip?: boolean
  shadow?: boolean
}) {
  const lift = LIFT[look.move]
  const shell = look.shell
  const bodyY = -(lift + 11)
  const hy = bodyY - 22
  const headTop = look.head === 'box' ? hy - 13 : look.head === 'dome' ? hy - 15 : hy - 15
  const hand: readonly [number, number] = prop === 'can' ? [14, bodyY - 1] : prop ? [14, bodyY + 1] : [13, bodyY + 2]
  const outfit = look.outfit ? soft(look.outfitColor) : null
  return (
    <g>
      {shadow && <Drop rx={14} ry={4.6} />}
      <g className={look.move === 'hover' ? 'cz-hover' : undefined}>
        <g transform={flip ? 'scale(-1 1)' : undefined}>
          <Locomotion look={look} />
          <Ball cx={-13} cy={bodyY + 2} r={4.2} fill={shell} />
          <Bean cx={0} cy={bodyY} rx={12.5} ry={11.5} fill={shell} />
          {look.outfit === 'overalls' && outfit && (
            <g>
              <path
                d={`M-10 ${bodyY - 1} H10 Q10 ${bodyY + 11} 0 ${bodyY + 11} Q-10 ${bodyY + 11} -10 ${bodyY - 1} Z`}
                fill={outfit}
              />
              <path
                d={`M-7 ${bodyY - 1} L-6 ${bodyY - 9} M7 ${bodyY - 1} L6 ${bodyY - 9}`}
                stroke={outfit}
                strokeWidth={3}
                strokeLinecap="round"
              />
              <rect x={-3.5} y={bodyY + 1} width={7} height={5} rx={2} fill={light(outfit, 25)} />
              <circle cx={-6} cy={bodyY - 1} r={1.3} fill="#fff4b0" />
              <circle cx={6} cy={bodyY - 1} r={1.3} fill="#fff4b0" />
            </g>
          )}
          {look.outfit === 'apron' && outfit && (
            <g>
              <path
                d={`M-8 ${bodyY - 5} H8 L9 ${bodyY + 9} Q0 ${bodyY + 12} -9 ${bodyY + 9} Z`}
                fill={outfit}
                stroke={rim(outfit, 18)}
                strokeWidth={1}
                strokeLinejoin="round"
              />
              <path d={`M-4 ${bodyY + 3} h8`} stroke={light(outfit, 35)} strokeWidth={2} strokeLinecap="round" />
            </g>
          )}
          {look.scarf && (
            <path
              d={`M-8 ${bodyY - 10} Q0 ${bodyY - 5} 8 ${bodyY - 10} L2 ${bodyY - 2} Q0 ${bodyY} -2 ${bodyY - 2} Z`}
              fill={soft(look.scarf)}
              stroke={rim(soft(look.scarf), 18)}
              strokeWidth={1}
              strokeLinejoin="round"
            />
          )}
          {/* head */}
          {look.head === 'round' && <Ball cx={0} cy={hy} r={15.5} fill={shell} />}
          {look.head === 'box' && <Pill x={-16.5} y={hy - 13} width={33} height={26} r={11} fill={shell} />}
          {look.head === 'dome' && (
            <Blob
              d={`M-16 ${hy + 10} Q-17 ${hy - 16} 0 ${hy - 15} Q17 ${hy - 16} 16 ${hy + 10} Q0 ${hy + 13} -16 ${hy + 10} Z`}
              fill={shell}
            />
          )}
          <rect x={-11.5} y={hy - 7.5} width={23} height={15} rx={7.5} fill={SCREEN} />
          <path
            d={`M-8 ${hy - 4.5} q3 -2 7 -2`}
            stroke="#fff"
            strokeOpacity={0.35}
            strokeWidth={1.8}
            strokeLinecap="round"
            fill="none"
          />
          <Eyes face={face} glow={look.glow} y={hy} flip={flip} />
          {face !== 'error' && face !== 'sleepy' && (
            <>
              <circle cx={-12.5} cy={hy + 7} r={2.6} fill="#ff9fb2" opacity={0.75} />
              <circle cx={12.5} cy={hy + 7} r={2.6} fill="#ff9fb2" opacity={0.75} />
            </>
          )}
          {(!look.hat || look.hat === 'bandana') && look.antenna !== 'none' && (
            <g>
              {look.antenna === 'sprout' && (
                <g>
                  <path
                    d={`M0 ${headTop + 1} V${headTop - 6}`}
                    stroke="#5dab4e"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                  />
                  <Bean cx={-4} cy={headTop - 8} rx={4.5} ry={2.8} fill="#7ccf6b" rotate={20} />
                  <Bean cx={4} cy={headTop - 8} rx={4.5} ry={2.8} fill="#7ccf6b" rotate={-20} />
                </g>
              )}
              {look.antenna === 'bulb' && (
                <g>
                  <path
                    d={`M0 ${headTop + 1} V${headTop - 6}`}
                    stroke={METAL}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                  />
                  <Ball cx={0} cy={headTop - 9} r={3.8} fill={look.glow} />
                </g>
              )}
              {look.antenna === 'twin' && (
                <g>
                  <path
                    d={`M-4 ${headTop + 1} L-7 ${headTop - 6} M4 ${headTop + 1} L7 ${headTop - 6}`}
                    stroke={METAL}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                  />
                  <Ball cx={-7} cy={headTop - 8} r={2.6} fill={look.glow} />
                  <Ball cx={7} cy={headTop - 8} r={2.6} fill={look.glow} />
                </g>
              )}
            </g>
          )}
          {look.hat && <Hat hat={look.hat} color={look.hatColor} top={headTop + 3} />}
          {prop && <Prop prop={prop} hand={hand} />}
          <Ball cx={hand[0]} cy={hand[1]} r={4.2} fill={shell} />
        </g>
        {helpers > 0 && (
          <g transform={`translate(${flip ? 26 : -26} ${hy - 6})`}>
            <g className="cz-hover">
              <Ball r={6.5} fill={light(shell, 10)} />
              <rect x={-4} y={-2.5} width={8} height={5} rx={2.5} fill={SCREEN} />
              <circle cx={0} cy={0} r={1.3} fill={look.glow} />
              {helpers > 1 && (
                <g transform="translate(7 -7)">
                  <circle r={5.6} fill="#ff8f7a" />
                  <text y={2.6} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={7.5} fill="#fff">
                    {helpers > 9 ? '9+' : helpers}
                  </text>
                </g>
              )}
            </g>
          </g>
        )}
      </g>
      {extra > 0 && (
        <g transform="translate(14 -12)">
          <rect
            width={8 + `${extra > 99 ? 99 : extra}`.length * 6 + 6}
            height={13}
            rx={6.5}
            fill="#fffaf0"
            stroke="#e6d3ae"
            strokeWidth={1.2}
          />
          <text
            x={(8 + `${extra > 99 ? 99 : extra}`.length * 6 + 6) / 2}
            y={10}
            textAnchor="middle"
            fontFamily={FONT}
            fontWeight={700}
            fontSize={9}
            fill="#6b5a45"
          >
            +{extra > 99 ? 99 : extra}
          </text>
        </g>
      )}
    </g>
  )
}

/** Where a Cozy robot's face sits, for portraits. */
export const COZY_AVATAR_VIEWBOX = '-24 -76 48 48'
