/** The Ficus mark's leaf, pointing up from its base at 0,0 (brand/ficus-mark.svg). */
const LEAF =
  'M0 0 C9 -5 12.5 -16 7 -22.5 C4.8 -25.2 2.4 -27.6 0 -30 C-2.4 -27.6 -4.8 -25.2 -7 -22.5 C-12.5 -16 -9 -5 0 0 Z'

/**
 * The Ficus mark with its leaves dancing, while a robot works: the side
 * leaves sway out of phase around their base, the center one bobs, the plant
 * hops a little (chat.css; still for reduced motion). Brand colors, as the
 * farm's header mark keeps in every style.
 */
export function DancingFicus() {
  return (
    <svg className="g-chat-ficus" viewBox="0 0 64 64" aria-hidden="true">
      <g transform="translate(0 -2.5)" className="g-chat-ficus-hop">
        <g transform="translate(32 39)">
          <g className="g-chat-ficus-left">
            <path d={LEAF} fill="#8a9a5b" transform="rotate(-36) scale(0.78 0.84)" />
          </g>
          <g className="g-chat-ficus-right">
            <path d={LEAF} fill="#8a9a5b" transform="rotate(36) scale(0.78 0.84)" />
          </g>
          <g className="g-chat-ficus-center">
            <path d={LEAF} fill="#3f6b4f" />
          </g>
        </g>
        <rect x="18" y="39" width="28" height="5" rx="2.5" fill="#b0582f" />
        <path d="M20 44 H44 L41 59 Q40.6 60 39.5 60 H24.5 Q23.4 60 23 59 Z" fill="#b0582f" />
      </g>
    </svg>
  )
}
