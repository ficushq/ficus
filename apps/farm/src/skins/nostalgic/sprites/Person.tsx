import type { PersonLook } from '../../../multiplayer/personLook'
import { INK, Shadow } from './shared'

/** A person on the farm: a farmhand in the Nostalgic style's ink and flat colour, feet on the anchor. */
export function Person({ look }: { look: PersonLook }) {
  const hy = -43
  return (
    <g>
      <Shadow rx={11} ry={4} />
      <rect x={-6.5} y={-17} width={5.5} height={16} rx={2} fill={look.pants} className="g-ol" />
      <rect x={1} y={-17} width={5.5} height={16} rx={2} fill={look.pants} className="g-ol" />
      <path d="M-8 -2 h7 v2.5 h-8 z M1 -2 h7 l1 2.5 h-8 z" fill="#5a3a24" className="g-ol2" />
      <rect x={-12.5} y={-31} width={4.5} height={13} rx={2.2} fill={look.shirt} className="g-ol" />
      <rect x={8} y={-31} width={4.5} height={13} rx={2.2} fill={look.shirt} className="g-ol" />
      <circle cx={-10.2} cy={-17} r={2.4} fill={look.skin} className="g-ol2" />
      <circle cx={10.2} cy={-17} r={2.4} fill={look.skin} className="g-ol2" />
      <rect x={-9} y={-34} width={18} height={19} rx={6} fill={look.shirt} className="g-ol" />
      <path d="M-4 -34 L0 -30 L4 -34" fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
      <circle cy={hy} r={9.5} fill={look.skin} className="g-ol" />
      <path
        d={`M-9.5 ${hy} q0 -10 9.5 -10 q9.5 0 9.5 10 q-3 -5 -9.5 -5.5 q-6.5 0.5 -9.5 5.5 z`}
        fill={look.hair}
        className="g-ol2"
      />
      <circle cx={-3.2} cy={hy + 1} r={1.3} fill={INK} />
      <circle cx={3.2} cy={hy + 1} r={1.3} fill={INK} />
      <path d={`M-2.5 ${hy + 4.5} q2.5 2 5 0`} fill="none" stroke={INK} strokeWidth={1.2} strokeLinecap="round" />
      <circle cx={-5.8} cy={hy + 4} r={1.6} fill="#ef8f80" opacity={0.7} />
      <circle cx={5.8} cy={hy + 4} r={1.6} fill="#ef8f80" opacity={0.7} />
      {look.hat === 'straw' && (
        <g>
          <ellipse cy={hy - 7} rx={15} ry={3.6} fill="#e9c46a" className="g-ol" />
          <path d={`M-7.5 ${hy - 7} q0 -8 7.5 -8 q7.5 0 7.5 8 z`} fill="#e9c46a" className="g-ol" />
          <path d={`M-7.2 ${hy - 9} h14.4`} stroke={look.hatColor} strokeWidth={2.2} />
        </g>
      )}
      {look.hat === 'sunhat' && (
        <g>
          <ellipse cy={hy - 6} rx={16} ry={4.4} fill={look.hatColor} className="g-ol" />
          <path d={`M-7 ${hy - 6} q0 -7 7 -7 q7 0 7 7 z`} fill={look.hatColor} className="g-ol" />
        </g>
      )}
      {look.hat === 'cap' && (
        <g>
          <path d={`M-9.5 ${hy - 3} q0 -9 9.5 -9 q9.5 0 9.5 9 z`} fill={look.hatColor} className="g-ol" />
          <path d={`M8 ${hy - 4} q8 0 9 2.5 h-9 z`} fill={look.hatColor} className="g-ol2" />
        </g>
      )}
      {look.hat === 'beanie' && (
        <g>
          <path d={`M-9.5 ${hy - 2} q0 -11 9.5 -11 q9.5 0 9.5 11 z`} fill={look.hatColor} className="g-ol" />
          <rect x={-10.5} y={hy - 4} width={21} height={4} rx={2} fill={look.hatColor} className="g-ol2" />
          <circle cy={hy - 14} r={2.6} fill={look.hatColor} className="g-ol2" />
        </g>
      )}
    </g>
  )
}
