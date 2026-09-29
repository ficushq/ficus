import { iso, pt } from '../../../farm/iso'

const A = 0.1
const B = 0.9
/** Height of the raised soil block, px. */
const LIFT = 6

/** A raised, furrowed soil square filling tile (i, j). Absolute world coords. */
export function PlowedSoil({ i, j }: { i: number; j: number }) {
  return (
    <g>
      <polygon
        points={`${pt(i + A, j + B)} ${pt(i + B, j + B)} ${pt(i + B, j + B, LIFT)} ${pt(i + A, j + B, LIFT)}`}
        fill="#6b4426"
        className="g-ol2"
      />
      <polygon
        points={`${pt(i + B, j + B)} ${pt(i + B, j + A)} ${pt(i + B, j + A, LIFT)} ${pt(i + B, j + B, LIFT)}`}
        fill="#553520"
        className="g-ol2"
      />
      <polygon
        points={`${pt(i + A, j + A)} ${pt(i + B, j + A)} ${pt(i + B, j + B)} ${pt(i + A, j + B)}`}
        fill="url(#g-soil)"
        className="g-ol2"
      />
      {[0.3, 0.5, 0.7].map((t) => {
        const [x1, y1] = iso(i + 0.16, j + t)
        const [x2, y2] = iso(i + 0.84, j + t)
        return (
          <g key={t}>
            <path d={`M${x1} ${y1 + 1} L${x2} ${y2 + 1}`} stroke="#6e4527" strokeWidth={3} strokeLinecap="round" />
            <path
              d={`M${x1} ${y1 - 1} L${x2} ${y2 - 1}`}
              stroke="#a9754a"
              strokeWidth={1.2}
              strokeLinecap="round"
              opacity={0.7}
            />
          </g>
        )
      })}
    </g>
  )
}

/**
 * Selection glow on the ground around the soil block's base. Draw BEFORE
 * PlowedSoil so the block sits on it.
 */
export function PlotSelectionGround({ i, j }: { i: number; j: number }) {
  const e = 0.04
  return (
    <polygon
      className="g-sel"
      points={`${pt(i - e, j - e, LIFT)} ${pt(i + 1 + e, j - e, LIFT)} ${pt(i + 1 + e, j + 1 + e, LIFT)} ${pt(i - e, j + 1 + e, LIFT)}`}
      fill="#fff3a8"
      fillOpacity={0.5}
      stroke="#fff6c2"
      strokeWidth={3}
      strokeLinejoin="round"
    />
  )
}

/** Faint tint on the selected soil's top face. Draw AFTER PlowedSoil. */
export function PlotSelectionTint({ i, j }: { i: number; j: number }) {
  return (
    <polygon
      points={`${pt(i + A, j + A)} ${pt(i + B, j + A)} ${pt(i + B, j + B)} ${pt(i + A, j + B)}`}
      fill="#fff3a8"
      fillOpacity={0.22}
      pointerEvents="none"
    />
  )
}
