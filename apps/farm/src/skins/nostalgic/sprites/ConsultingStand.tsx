import { iso } from '../../../farm/iso'
import type { RobotLook } from '../types'
import { Robot } from './Robot'
import { CountBadge, INK, Shadow } from './shared'

const W = 0.5
const D = 0.32
const COUNTER = 20
const ROOF_LOW = 72
const ROOF_HIGH = 82

function p(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${x.toFixed(1)},${(y - up).toFixed(1)}`
}
function xy(i: number, j: number, up = 0): readonly [number, number] {
  const [x, y] = iso(i, j)
  return [x, y - up]
}
const poly = (...points: string[]) => points.join(' ')

/**
 * A little market stall where a squad's consultants take questions: a wooden
 * counter with a notepad and a jar of pencils, a striped awning on two posts,
 * a speech-bubble sign, and (when anyone's in) a consultant behind the counter.
 * It's the same size however many consultant chats there are; the awning
 * shows the count. Anchored at the centre of its footprint on the ground.
 */
export function ConsultingStand({ count, host }: { count: number; host?: RobotLook }) {
  const [signX, signY] = xy(0, -D, ROOF_HIGH + 12)
  const [padX, padY] = xy(-0.18, D, COUNTER)
  const [jarX, jarY] = xy(0.28, D - 0.05, COUNTER)
  const stripes = 6
  return (
    <g>
      <Shadow rx={52} ry={18} />
      {/* back posts */}
      {[-W + 0.04, W - 0.04].map((i) => (
        <path
          key={`bp${i}`}
          d={`M${xy(i, -D)[0]} ${xy(i, -D)[1]} L${xy(i, -D, ROOF_HIGH)[0]} ${xy(i, -D, ROOF_HIGH)[1]}`}
          stroke={INK}
          strokeWidth={4.6}
          strokeLinecap="round"
        />
      ))}
      {[-W + 0.04, W - 0.04].map((i) => (
        <path
          key={`bpc${i}`}
          d={`M${xy(i, -D)[0]} ${xy(i, -D)[1]} L${xy(i, -D, ROOF_HIGH)[0]} ${xy(i, -D, ROOF_HIGH)[1]}`}
          stroke="#c99459"
          strokeWidth={2.4}
          strokeLinecap="round"
        />
      ))}

      {/* the consultant on duty, behind the counter */}
      {host && (
        <g transform={`translate(${xy(-0.14, 0.02)[0]} ${xy(-0.14, 0.02)[1]}) scale(0.9)`}>
          <Robot look={host} face="normal" prop="clip" />
        </g>
      )}

      {/* counter */}
      <polygon
        points={poly(p(-W, D), p(W, D), p(W, D, COUNTER), p(-W, D, COUNTER))}
        fill="url(#g-wood)"
        className="g-ol"
      />
      <polygon points={poly(p(W, D), p(W, 0), p(W, 0, COUNTER), p(W, D, COUNTER))} fill="#94643a" className="g-ol" />
      {[0.33, 0.66].map((t) => (
        <path
          key={`plank${t}`}
          d={`M${xy(-W, D, COUNTER * t)[0]} ${xy(-W, D, COUNTER * t)[1]} L${xy(W, D, COUNTER * t)[0]} ${xy(W, D, COUNTER * t)[1]}`}
          stroke="#8a5a33"
          strokeWidth={1.1}
        />
      ))}
      <polygon
        points={poly(
          p(-W - 0.04, D + 0.06, COUNTER),
          p(W + 0.04, D + 0.06, COUNTER),
          p(W + 0.04, -0.02, COUNTER),
          p(-W - 0.04, -0.02, COUNTER)
        )}
        fill="#e3c38e"
        className="g-ol"
      />
      {/* notepad and a jar of pencils on the counter */}
      <g transform={`translate(${padX} ${padY - 1}) skewX(-30) scale(1 0.55)`}>
        <rect x={-7} y={-10} width={14} height={16} rx={1.5} fill="#fffdf7" className="g-ol2" />
        <path d="M-4 -5 h8 M-4 -1 h8 M-4 3 h5" stroke="#8a5a33" strokeWidth={1.2} />
      </g>
      <g transform={`translate(${jarX} ${jarY})`}>
        <path d="M-4 0 V-9 H4 V0Z" fill="#9fcbe0" className="g-ol2" />
        <path d="M-2 -9 L-3 -15 M1 -9 L2 -16 M3 -9 L5 -13" stroke="#e0a93b" strokeWidth={1.8} strokeLinecap="round" />
      </g>

      {/* front posts */}
      {[-W + 0.04, W - 0.04].map((i) => (
        <g key={`fp${i}`}>
          <path
            d={`M${xy(i, D)[0]} ${xy(i, D)[1]} L${xy(i, D, ROOF_LOW)[0]} ${xy(i, D, ROOF_LOW)[1]}`}
            stroke={INK}
            strokeWidth={4.6}
            strokeLinecap="round"
          />
          <path
            d={`M${xy(i, D)[0]} ${xy(i, D)[1]} L${xy(i, D, ROOF_LOW)[0]} ${xy(i, D, ROOF_LOW)[1]}`}
            stroke="#c99459"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      ))}

      {/* striped awning with a scalloped front */}
      {Array.from({ length: stripes }, (_, k) => {
        const a = -W - 0.06 + ((2 * W + 0.12) * k) / stripes
        const b = a + (2 * W + 0.12) / stripes
        return (
          <polygon
            key={`st${k}`}
            points={poly(
              p(a, -D - 0.04, ROOF_HIGH),
              p(b, -D - 0.04, ROOF_HIGH),
              p(b, D + 0.12, ROOF_LOW),
              p(a, D + 0.12, ROOF_LOW)
            )}
            fill={k % 2 ? '#fffaf1' : '#b0582f'}
          />
        )
      })}
      <polygon
        points={poly(
          p(-W - 0.06, -D - 0.04, ROOF_HIGH),
          p(W + 0.06, -D - 0.04, ROOF_HIGH),
          p(W + 0.06, D + 0.12, ROOF_LOW),
          p(-W - 0.06, D + 0.12, ROOF_LOW)
        )}
        fill="none"
        className="g-ol"
      />
      {Array.from({ length: stripes }, (_, k) => {
        const [x, y] = xy(-W - 0.06 + ((2 * W + 0.12) * (k + 0.5)) / stripes, D + 0.12, ROOF_LOW)
        return (
          <circle key={`sc${k}`} cx={x} cy={y + 1.5} r={3.8} fill={k % 2 ? '#fffaf1' : '#b0582f'} className="g-ol2" />
        )
      })}

      {/* how many questions are waiting, on top */}
      {count > 0 && (
        <g transform={`translate(${signX} ${signY})`}>
          <CountBadge count={count} />
        </g>
      )}
    </g>
  )
}
