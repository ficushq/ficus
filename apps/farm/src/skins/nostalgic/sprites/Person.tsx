import type { FarmLook } from '@ficus/shared'
import { tint } from '../../../multiplayer/personLook'
import { HATS, hairUnderHat, METAL, PIERCINGS, STRAW, type HatPaint } from '../../../multiplayer/personParts'
import { INK, Shadow } from './shared'

const HEAD_Y = -43
const HEAD_R = 9.5
const HEAD = `translate(0 ${HEAD_Y}) scale(${HEAD_R / 10})`

function hatColor(paint: HatPaint, color: string): string {
  switch (paint) {
    case 'hat':
      return color
    case 'straw':
      return STRAW
    case 'band':
      return tint(color, -0.28)
    case 'trim':
      return tint(color, 0.3)
    case 'flower':
      return '#fff1f5'
  }
}

/** Their feet: each shoe is drawn at the origin of its foot (x −8…0), the right one shifted over. */
function Shoe({ look, dx }: { look: FarmLook; dx: number }) {
  const fill = look.shoesColor
  const t = `translate(${dx} 0)`
  switch (look.shoes) {
    case 'boots':
      return <path transform={t} d="M-7.6 -6.5 H-1.2 V-2 H0.4 V0.5 H-7.6 Z" fill={fill} className="g-ol2" />
    case 'sneakers':
      return (
        <g transform={t}>
          <path d="M-8 -2.4 h6.8 q1.6 0 1.6 2.9 h-8.4 z" fill={fill} className="g-ol2" />
          <path d="M-7.6 -0.3 h7.6" stroke="#fffaf0" strokeWidth={1} />
        </g>
      )
    case 'sandals':
      return (
        <g transform={t}>
          <path d="M-8 -0.8 h8.2 v1.4 h-8.2 z" fill={fill} className="g-ol2" />
          <path d="M-6.8 -2.4 h4.8" stroke={fill} strokeWidth={1.6} strokeLinecap="round" />
        </g>
      )
    case 'clogs':
      return <path transform={t} d="M-8.4 0.5 Q-8.4 -4 -4.2 -4 Q-0.4 -4 0.2 0.5 Z" fill={fill} className="g-ol2" />
  }
}

/** A person on the farm: a farmhand in the Nostalgic style's ink and flat colour, feet on the anchor. */
export function Person({ look }: { look: FarmLook }) {
  const hy = HEAD_Y
  const { skin, shirtColor: shirt, pantsColor: pants } = look
  const hair = hairUnderHat(look)
  const legs = look.pants === 'long' || look.pants === 'overalls' ? pants : skin
  const sleeves = look.shirt === 'longsleeve' || look.shirt === 'hoodie' || look.shirt === 'flannel'
  const check = tint(shirt, -0.32)
  return (
    <g>
      <Shadow rx={11} ry={4} />
      {hair.back && (
        <g transform={HEAD}>
          <path d={hair.back} fill={look.hairColor} className="g-ol2" />
        </g>
      )}
      {look.shirt === 'hoodie' && (
        <path d="M-10.5 -31 Q-12 -40.5 0 -41 Q12 -40.5 10.5 -31 Z" fill={tint(shirt, -0.12)} className="g-ol2" />
      )}

      {/* Legs, then what's worn on them. */}
      <rect x={-6.5} y={-17} width={5.5} height={16} rx={2} fill={legs} className="g-ol" />
      <rect x={1} y={-17} width={5.5} height={16} rx={2} fill={legs} className="g-ol" />
      {look.pants === 'shorts' && (
        <g>
          <rect x={-7} y={-18} width={6.4} height={8} rx={1.6} fill={pants} className="g-ol" />
          <rect x={0.6} y={-18} width={6.4} height={8} rx={1.6} fill={pants} className="g-ol" />
        </g>
      )}
      {look.pants === 'skirt' && (
        <path d="M-7.5 -18 H7.5 L10.5 -6.5 Q0 -5 -10.5 -6.5 Z" fill={pants} className="g-ol" />
      )}
      <Shoe look={look} dx={0.2} />
      <Shoe look={look} dx={8.4} />

      {/* Arms: sleeves as far as they go, then skin. */}
      {[-1, 1].map((side) => (
        <g key={side}>
          <rect
            x={side < 0 ? -12.5 : 8}
            y={-31}
            width={4.5}
            height={13}
            rx={2.2}
            fill={sleeves ? shirt : skin}
            className="g-ol"
          />
          {look.shirt === 'tee' && (
            <rect
              x={side < 0 ? -12.9 : 7.6}
              y={-31.5}
              width={5.3}
              height={6.5}
              rx={2.2}
              fill={shirt}
              className="g-ol"
            />
          )}
          <circle cx={side * 10.2} cy={-17} r={2.4} fill={skin} className="g-ol2" />
        </g>
      ))}

      {/* Body. */}
      <rect x={-9} y={-34} width={18} height={19} rx={6} fill={shirt} className="g-ol" />
      {look.shirt === 'flannel' && (
        <path
          d="M-4.5 -33 V-16 M0 -33.6 V-15.6 M4.5 -33 V-16 M-8.4 -28 H8.4 M-8.6 -21.5 H8.6"
          stroke={check}
          strokeWidth={1.3}
          opacity={0.7}
        />
      )}
      {look.shirt === 'tank' ? (
        <path d="M-4.6 -34 Q0 -28.5 4.6 -34 Z" fill={skin} className="g-ol2" />
      ) : look.shirt === 'hoodie' ? (
        <g>
          <path d="M-5.5 -24 h11 l1 5 h-13 z" fill={tint(shirt, -0.12)} className="g-ol2" />
          <path d="M-2 -33 v5 M2 -33 v5" stroke={INK} strokeWidth={0.9} strokeLinecap="round" />
        </g>
      ) : (
        <path d="M-4 -34 L0 -30 L4 -34" fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
      )}
      {look.pants === 'overalls' && (
        <g>
          <path d="M-5 -28 L-6.8 -34 M5 -28 L6.8 -34" stroke={pants} strokeWidth={2.4} strokeLinecap="round" />
          <rect x={-6} y={-28.5} width={12} height={13} rx={2} fill={pants} className="g-ol" />
          <circle cx={-3.6} cy={-26} r={0.9} fill={METAL} />
          <circle cx={3.6} cy={-26} r={0.9} fill={METAL} />
        </g>
      )}

      {/* Head and face. */}
      <circle cy={hy} r={HEAD_R} fill={skin} className="g-ol" />
      <circle cx={-3.2} cy={hy + 1} r={1.3} fill={INK} />
      <circle cx={3.2} cy={hy + 1} r={1.3} fill={INK} />
      <path d={`M-2.5 ${hy + 4.5} q2.5 2 5 0`} fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
      <circle cx={-5.8} cy={hy + 4} r={1.6} fill="#ef8f80" opacity={0.7} />
      <circle cx={5.8} cy={hy + 4} r={1.6} fill="#ef8f80" opacity={0.7} />

      <g transform={HEAD}>
        {hair.front && <path d={hair.front} fill={look.hairColor} className="g-ol2" />}
        {look.piercings.flatMap((kind) =>
          PIERCINGS[kind].map((p, k) => (
            <path
              key={`${kind}${k}`}
              d={p.d}
              fill={p.ring ? 'none' : METAL}
              stroke={p.ring ? METAL : INK}
              strokeWidth={p.ring ? 1.1 : 0.5}
            />
          ))
        )}
        {look.hat !== 'none' &&
          HATS[look.hat].map((piece, k) =>
            piece.line ? (
              <path key={k} d={piece.d} fill="none" stroke={hatColor(piece.paint, look.hatColor)} strokeWidth={2.4} />
            ) : (
              <path key={k} d={piece.d} fill={hatColor(piece.paint, look.hatColor)} className="g-ol" />
            )
          )}
      </g>
    </g>
  )
}
