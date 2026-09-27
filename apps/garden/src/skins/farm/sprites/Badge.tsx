import type { ReactNode } from 'react'
import type { BadgeKind } from '../../../farm/types'
import type { CropKind } from '../types'
import { FONT_DISPLAY, INK } from './shared'

/** Distance from the bubble's centre down to its tail tip. */
const TAIL = 16

const ICONS: Record<BadgeKind, ReactNode> = {
  question: (
    <text
      y={7}
      textAnchor="middle"
      fontFamily={FONT_DISPLAY}
      fontWeight={900}
      fontSize={20}
      fill="#b0582f"
      stroke={INK}
      strokeWidth={1}
      paintOrder="stroke"
    >
      ?
    </text>
  ),
  blocked: (
    <text y={7} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={900} fontSize={20} fill="#c2412b">
      !
    </text>
  ),
  // New updates waiting (the porch assistant): a little letter.
  news: (
    <g transform="translate(0 1)">
      <rect x={-8.5} y={-6} width={17} height={12} rx={2} fill="#fffaf1" className="g-ol2" />
      <path d="M-7.5 -5 L0 1 L7.5 -5" fill="none" stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
    </g>
  ),
  harvest: (
    <g transform="translate(0 2)">
      <path d="M-9 -2 H9 L7 8 H-7Z" fill="#c98f52" className="g-ol2" />
      <path d="M-6 -2 Q0 -13 6 -2" fill="none" stroke={INK} strokeWidth={1.8} />
      <circle cx={-3} cy={-4} r={3.4} fill="url(#g-fruit)" className="g-ol2" />
      <circle cx={3.5} cy={-4.5} r={3.4} fill="url(#g-fruit)" className="g-ol2" />
    </g>
  ),
}

/**
 * A speech-bubble badge, anchored at the tip of its tail (the bubble sits
 * above the origin). Bobs gently.
 */
export function Badge({ kind }: { kind: BadgeKind }) {
  return (
    <g className="g-bob">
      <g transform={`translate(0 ${-TAIL})`}>
        <path d="M0 16 l-5 -6 h10z" fill="#fffaf1" className="g-ol" />
        <circle r={14} fill="url(#g-badge)" className="g-ol" />
        <ellipse cx={-3} cy={-7} rx={7} ry={3.2} fill="#fff" opacity={0.8} />
        {ICONS[kind]}
      </g>
    </g>
  )
}

/**
 * Where to put the Badge (its tail tip) relative to the Crop's anchor. Puts
 * the bubble's centre where the mock had it: 92px up for sunflowers, 76px
 * for the rest.
 */
export function badgeLift(kind: CropKind): number {
  return (kind === 'sunflower' ? -92 : -76) + TAIL
}
