import type { RobotMood } from '@ficus/shared'

/*
 * The small mark beside a robot's head that shows its mood (moods.ts), drawn
 * the same in every style from the style's own ink and colours (farm.css
 * `.g-mood-*`). Centred on its anchor, about 20px across. `focused` is the
 * plain working face, so it has no mark; `idle` and `waiting` are never shown.
 */

function Drop({ x = 0, y = 0, scale = 1 }: { x?: number; y?: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <g className="g-mood-drop">
        <path
          className="g-mood-drop-fill g-mood-ink"
          d="M0 -6.5 C2.6 -2.6 4.6 0 4.6 2.4 A4.6 4.6 0 0 1 -4.6 2.4 C-4.6 0 -2.6 -2.6 0 -6.5Z"
        />
        <ellipse className="g-mood-shine" cx={-1.6} cy={1.6} rx={1.1} ry={1.7} />
      </g>
    </g>
  )
}

export function MoodMark({ mood }: { mood: RobotMood }) {
  switch (mood) {
    case 'struggling':
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <Drop />
        </g>
      )
    case 'stuck':
      // Two drops: it's not getting anywhere.
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <Drop x={-2.5} y={1} />
          <Drop x={4} y={-3} scale={0.7} />
        </g>
      )
    case 'looping':
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <g className="g-mood-loop">
            <path className="g-mood-arrow" d="M5.2 0 A5.2 5.2 0 1 1 1.6 -4.95" />
            <path className="g-mood-arrow-head g-mood-ink" d="M-0.6 -7.6 L4.2 -5.4 L0.4 -2.2Z" />
          </g>
        </g>
      )
    case 'risky':
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <path className="g-mood-pole" d="M-3 8 V-8" />
          <path className="g-mood-flag g-mood-ink" d="M-3 -8 C0 -9.4 2.4 -6.4 6.4 -7.6 V-1.6 C2.4 -0.4 0 -3.4 -3 -2Z" />
        </g>
      )
    case 'exploring':
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <g className="g-mood-glass">
            <path className="g-mood-handle" d="M2.2 2.2 L6.2 6.2" />
            <circle className="g-mood-lens g-mood-ink" cx={-1} cy={-1} r={4.4} />
            <path className="g-mood-shine-line" d="M-3.2 -1.8 A2.6 2.6 0 0 1 -1.6 -3.4" />
          </g>
        </g>
      )
    case 'wrapping-up':
      return (
        <g className="g-mood-mark" data-mood={mood} transform="scale(1.35)">
          <path
            className="g-mood-spark g-mood-ink"
            d="M0 -7 L1.5 -1.5 L7 0 L1.5 1.5 L0 7 L-1.5 1.5 L-7 0 L-1.5 -1.5Z"
          />
          <circle className="g-mood-confetti g-mood-confetti-a" cx={-7} cy={-6} r={1.4} />
          <circle className="g-mood-confetti g-mood-confetti-b" cx={7} cy={-7} r={1.2} />
          <rect className="g-mood-confetti g-mood-confetti-c" x={5.5} y={5} width={2.4} height={2.4} rx={0.4} />
        </g>
      )
    default:
      return null
  }
}

/** Moods that move the whole robot a little (farm.css `.g-mood-body-*`); the rest only add a mark. */
export const MOOD_MOTION: Partial<Record<RobotMood, string>> = {
  looping: 'g-mood-body-pacing',
  exploring: 'g-mood-body-looking',
  'wrapping-up': 'g-mood-body-hop',
}
