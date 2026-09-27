import { useId } from 'react'
import { iso } from '../iso'
import type { RobotLook } from '../types'
import { Robot } from './Robot'
import { FONT_DISPLAY, INK, Shadow } from './shared'

/** The hut's footprint in tiles (i × j), centred on its anchor. */
export const CHARGING_HUT_FOOTPRINT = { w: 1.1, d: 0.9 } as const

const W = CHARGING_HUT_FOOTPRINT.w / 2
const D = CHARGING_HUT_FOOTPRINT.d / 2
const WALL = 34

/** A point on the hut, in tiles from its centre, `up` pixels above the ground. */
function p(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${x.toFixed(1)},${(y - up).toFixed(1)}`
}

/**
 * A little charging hut where a yard's idle robots rest: solar panels on the
 * roof, a battery gauge that fills with how many are
 * charging (it runs on sunshine), and (when anyone's in) a glowing doorway with one
 * robot peeking out. It's the same size whatever the count; the roof shows it.
 * Anchored at the centre of its footprint on the ground.
 */
export function ChargingHut({ count, peek }: { count: number; peek?: RobotLook }) {
  const on = count > 0
  const clip = useId()
  const cells = Math.min(4, count)
  // Door on the front-left wall (the j = +D face), a little left of centre.
  const door = [p(-0.3, D), p(0.05, D), p(0.05, D, 25), p(-0.3, D, 25)].join(' ')
  const [dx, dy] = iso(-0.125, D)
  const [bx, by] = iso(0.3, D)
  const [rx, ry] = iso(0, 0)
  return (
    <g>
      <Shadow rx={62} ry={22} />
      {/* walls */}
      <polygon points={[p(-W, D), p(W, D), p(W, D, WALL), p(-W, D, WALL)].join(' ')} fill="#eef3e4" className="g-ol" />
      <polygon points={[p(W, D), p(W, -D), p(W, -D, WALL), p(W, D, WALL)].join(' ')} fill="#cfdac0" className="g-ol" />
      <path d={`M${p(-W, D, 8).replace(',', ' ')} L${p(W, D, 8).replace(',', ' ')}`} stroke="#8a9a5b" strokeWidth={3} />
      <path d={`M${p(W, D, 8).replace(',', ' ')} L${p(W, -D, 8).replace(',', ' ')}`} stroke="#6f7d49" strokeWidth={3} />

      {/* doorway, glowing when someone's charging, with a robot peeking out */}
      <clipPath id={clip}>
        <polygon points={door} />
      </clipPath>
      <polygon points={door} fill="#23282c" className="g-ol" />
      {on && (
        <g clipPath={`url(#${clip})`}>
          <polygon points={door} fill="#9ff0c8" opacity={0.28} className="g-glow" />
          {peek && (
            <g transform={`translate(${dx + 2} ${dy + 3}) scale(0.62)`}>
              <Robot look={peek} face="normal" prop={null} />
            </g>
          )}
        </g>
      )}

      {/* battery gauge beside the door: fills with how many are charging */}
      <g transform={`translate(${bx} ${by - 12}) skewY(26.57)`}>
        <rect x={-5} y={-12} width={12} height={20} rx={2} fill="#fffdf7" className="g-ol2" />
        <rect x={-1.5} y={-15} width={5} height={3} rx={1} fill={INK} />
        {[0, 1, 2, 3].map((k) => (
          <rect
            key={k}
            x={-3}
            y={4 - k * 4.4}
            width={8}
            height={3.2}
            rx={0.8}
            fill={k < cells ? '#5d9a58' : '#e3dccb'}
            className={k < cells ? 'g-glow' : undefined}
          />
        ))}
      </g>

      {/* roof: an overhanging slab under a tilted bank of solar panels */}
      <polygon
        points={[
          p(-W - 0.08, D + 0.08, WALL),
          p(W + 0.08, D + 0.08, WALL),
          p(W + 0.08, -D - 0.08, WALL),
          p(-W - 0.08, -D - 0.08, WALL),
        ].join(' ')}
        fill="#6f7d49"
        className="g-ol"
      />
      <polygon
        points={[p(-W, D, WALL + 4), p(W, D, WALL + 4), p(W, -D, WALL + 16), p(-W, -D, WALL + 16)].join(' ')}
        fill="url(#g-solar)"
        className="g-ol"
      />
      {[0.25, 0.5, 0.75].map((t) => (
        <path
          key={`r${t}`}
          d={`M${p(-W + 2 * W * t, D, WALL + 4).replace(',', ' ')} L${p(-W + 2 * W * t, -D, WALL + 16).replace(',', ' ')}`}
          stroke="#cfe3f5"
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      ))}
      <path
        d={`M${p(-W, 0, WALL + 10).replace(',', ' ')} L${p(W, 0, WALL + 10).replace(',', ' ')}`}
        stroke="#cfe3f5"
        strokeOpacity={0.5}
        strokeWidth={1}
      />
      <path
        d={`M${p(-W + 0.1, D - 0.1, WALL + 6).replace(',', ' ')} L${p(-W + 0.45, D - 0.1, WALL + 6).replace(',', ' ')}`}
        stroke="#fff"
        strokeOpacity={0.7}
        strokeWidth={2}
        strokeLinecap="round"
      />

      {/* how many are resting, on the roof */}
      {on && (
        <g transform={`translate(${rx} ${ry - WALL - 34})`}>
          <circle r={11} fill="#5d9a58" className="g-ol" />
          <text
            y={4.5}
            textAnchor="middle"
            fontFamily={FONT_DISPLAY}
            fontWeight={900}
            fontSize={count > 9 ? 10 : 13}
            fill="#fffaf1"
          >
            {count}
          </text>
        </g>
      )}
    </g>
  )
}
