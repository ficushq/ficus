import { iso } from '../../../farm/iso'
import { CountBadge, Shadow } from './shared'

const W = 0.24
const D = 0.2
const HEIGHT = 58
const SLOTS = 4

/** A point on the rack, in tiles from its centre, `up` pixels above the ground. */
function p(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${x.toFixed(1)},${(y - up).toFixed(1)}`
}

/**
 * A little server rack beside a yard, humming while its squad has apps to
 * open: a painted wooden cabinet with a stack of servers behind its door, their
 * lights blinking, and a bubble with how many apps. Anchored on the ground at
 * the centre of its footprint.
 */
export function ServerRack({ count }: { count: number }) {
  const front = (k: number) => {
    const bottom = 6 + k * ((HEIGHT - 12) / SLOTS)
    const top = bottom + (HEIGHT - 12) / SLOTS - 3
    return [p(-W + 0.03, D, bottom), p(W - 0.03, D, bottom), p(W - 0.03, D, top), p(-W + 0.03, D, top)].join(' ')
  }
  const [lx, ly] = iso(W - 0.08, D)
  return (
    <g>
      <Shadow rx={24} ry={9} />
      {/* cabinet */}
      <polygon
        points={[p(-W, D), p(W, D), p(W, D, HEIGHT), p(-W, D, HEIGHT)].join(' ')}
        fill="#4b5d7a"
        className="g-ol"
      />
      <polygon
        points={[p(W, D), p(W, -D), p(W, -D, HEIGHT), p(W, D, HEIGHT)].join(' ')}
        fill="#3a4a63"
        className="g-ol"
      />
      <polygon
        points={[p(-W, D, HEIGHT), p(W, D, HEIGHT), p(W, -D, HEIGHT), p(-W, -D, HEIGHT)].join(' ')}
        fill="#6b7f9e"
        className="g-ol"
      />
      {/* servers, each with a light */}
      {Array.from({ length: SLOTS }, (_, k) => (
        <g key={k}>
          <polygon points={front(k)} fill="#23282c" className="g-ol2" />
          <circle
            cx={lx}
            cy={ly - 8 - k * ((HEIGHT - 12) / SLOTS)}
            r={1.8}
            fill={k < Math.min(SLOTS, count) ? '#7cf0a0' : '#4a5560'}
            className={k < count ? 'g-rack-light' : undefined}
            style={{ animationDelay: `${k * 0.37}s` }}
          />
        </g>
      ))}
      {count > 0 && (
        <g transform={`translate(20 ${-HEIGHT - 20})`}>
          <CountBadge count={count} />
        </g>
      )}
    </g>
  )
}
