import type { FarmLook } from '@ficus/shared'
import { tint } from '../../../multiplayer/personLook'
import { HATS, hairUnderHat, METAL, PIERCINGS, type HatPaint } from '../../../multiplayer/personParts'
import { Ball, Bean, Blob, Drop, light, Pill, rim } from './kit'

const HEAD_Y = -38
const HEAD_R = 14
const HEAD = `translate(0 ${HEAD_Y}) scale(${HEAD_R / 10})`

function hatColor(paint: HatPaint, color: string): string {
  switch (paint) {
    case 'hat':
      return light(color, 25)
    case 'straw':
      return '#f4d67f'
    case 'band':
      return tint(color, -0.18)
    case 'trim':
      return light(color, 45)
    case 'flower':
      return '#fff1f5'
  }
}

/** One foot's shoe, centred on the foot at x. */
function Shoe({ look, x }: { look: FarmLook; x: number }) {
  const fill = light(look.shoesColor, 12)
  switch (look.shoes) {
    case 'boots':
      return <Pill x={x - 4.6} y={-7} width={9.2} height={7.6} r={3.4} fill={fill} />
    case 'sneakers':
      return (
        <g>
          <Bean cx={x + 0.4} cy={-1.8} rx={5} ry={2.8} fill={fill} />
          <path d={`M${x - 4} -0.4 H${x + 4.6}`} stroke="#fffaf0" strokeWidth={1.2} strokeLinecap="round" />
        </g>
      )
    case 'sandals':
      return (
        <g>
          <Pill x={x - 4.6} y={-1.4} width={9.6} height={2.2} r={1.1} fill={fill} />
          <path d={`M${x - 3} -3.2 H${x + 3}`} stroke={fill} strokeWidth={1.8} strokeLinecap="round" />
        </g>
      )
    case 'clogs':
      return <Bean cx={x + 0.2} cy={-2.2} rx={5.4} ry={3.4} fill={fill} />
  }
}

/** A person on the farm, Cozy style: a round-headed villager with dot eyes and rosy cheeks. */
export function CozyPerson({ look }: { look: FarmLook }) {
  const hy = HEAD_Y
  const shirt = light(look.shirtColor, 20)
  const pants = light(look.pantsColor, 15)
  const hair = hairUnderHat(look)
  const legs = look.pants === 'long' || look.pants === 'overalls' ? pants : look.skin
  const sleeves = look.shirt === 'longsleeve' || look.shirt === 'hoodie' || look.shirt === 'flannel'
  return (
    <g>
      <Drop rx={13} ry={4.4} />
      {hair.back && (
        <g transform={HEAD}>
          <Blob d={hair.back} fill={look.hairColor} shine={false} />
        </g>
      )}
      {look.shirt === 'hoodie' && <Pill x={-14} y={-30} width={28} height={9} r={4.5} fill={rim(shirt, 12)} />}

      {/* Legs and what's worn on them. */}
      <Bean cx={-4.5} cy={-5} rx={4} ry={4.8} fill={legs} />
      <Bean cx={4.5} cy={-5} rx={4} ry={4.8} fill={legs} />
      {look.pants === 'shorts' && <Pill x={-9} y={-11} width={18} height={5} r={2.5} fill={pants} />}
      {look.pants === 'skirt' && <Blob d="M-10 -9.5 Q0 -11.5 10 -9.5 L12.5 -2.8 Q0 -0.4 -12.5 -2.8 Z" fill={pants} />}
      <Shoe look={look} x={-4.5} />
      <Shoe look={look} x={4.5} />

      {/* Arms: a sleeve (or bare arm) from the shoulder, the hand a little ball. */}
      {[-1, 1].map((side) => (
        <g key={side}>
          <Pill x={side < 0 ? -14 : 9} y={-24} width={5} height={9} r={2.5} fill={sleeves ? shirt : look.skin} />
          {look.shirt === 'tee' && <Ball cx={side * 10.5} cy={-21.5} r={4.2} fill={shirt} />}
          <Ball cx={side * 11.5} cy={-15} r={3.6} fill={look.skin} />
        </g>
      ))}

      {/* Body. */}
      <Pill x={-10} y={-26} width={20} height={20} r={9} fill={shirt} />
      {look.shirt === 'flannel' && (
        <path
          d="M-4.5 -25 V-7 M0 -25.6 V-6.4 M4.5 -25 V-7 M-8.8 -20 H8.8 M-9 -13 H9"
          stroke={rim(shirt, 40)}
          strokeWidth={1.4}
          opacity={0.55}
          strokeLinecap="round"
        />
      )}
      {look.shirt === 'tank' && <path d="M-4.5 -26 Q0 -21 4.5 -26 Z" fill={look.skin} />}
      {look.shirt === 'hoodie' && <Pill x={-6} y={-15} width={12} height={5.5} r={2.5} fill={rim(shirt, 12)} />}
      {look.pants === 'overalls' && (
        <g>
          <path d="M-5 -16 L-6.5 -25 M5 -16 L6.5 -25" stroke={pants} strokeWidth={2.6} strokeLinecap="round" />
          <Pill x={-6.5} y={-17} width={13} height={10} r={3} fill={pants} />
          <circle cx={-4} cy={-15} r={1} fill={METAL} />
          <circle cx={4} cy={-15} r={1} fill={METAL} />
        </g>
      )}

      {/* Head and face. */}
      <Ball cy={hy} r={HEAD_R} fill={look.skin} />
      <ellipse cx={-4.5} cy={hy + 2} rx={1.7} ry={2.4} fill="#3b2f3f" />
      <ellipse cx={4.5} cy={hy + 2} rx={1.7} ry={2.4} fill="#3b2f3f" />
      <circle cx={-4} cy={hy + 1} r={0.6} fill="#fff" />
      <circle cx={5} cy={hy + 1} r={0.6} fill="#fff" />
      <circle cx={-8.5} cy={hy + 6.5} r={2.6} fill="#ff9fb2" opacity={0.75} />
      <circle cx={8.5} cy={hy + 6.5} r={2.6} fill="#ff9fb2" opacity={0.75} />
      <path d={`M-2 ${hy + 7} q2 1.6 4 0`} stroke="#8a5a4a" strokeWidth={1.3} fill="none" strokeLinecap="round" />

      <g transform={HEAD}>
        {hair.front && <Blob d={hair.front} fill={look.hairColor} />}
        {look.piercings.flatMap((kind) =>
          PIERCINGS[kind].map((p, k) => (
            <path
              key={`${kind}${k}`}
              d={p.d}
              fill={p.ring ? 'none' : '#fff6d8'}
              stroke={p.ring ? '#f2d27a' : '#c9a54a'}
              strokeWidth={p.ring ? 0.9 : 0.35}
            />
          ))
        )}
        {look.hat !== 'none' &&
          HATS[look.hat].map((piece, k) =>
            piece.line ? (
              <path
                key={k}
                d={piece.d}
                fill="none"
                stroke={hatColor(piece.paint, look.hatColor)}
                strokeWidth={2.2}
                strokeLinecap="round"
              />
            ) : (
              <Blob key={k} d={piece.d} fill={hatColor(piece.paint, look.hatColor)} />
            )
          )}
      </g>
    </g>
  )
}
