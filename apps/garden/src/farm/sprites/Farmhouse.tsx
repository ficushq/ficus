import { iso } from '../iso'
import { INK, Shadow } from './shared'

/** Farmhouse footprint in tiles (w along i, d along j), porch not included. Origin is its centre. */
export const FARMHOUSE_FOOTPRINT = { w: 2.4, d: 2 } as const
/** How far the porch deck reaches out in front of the house (tiles, along j). */
export const FARMHOUSE_PORCH_DEPTH = 0.75
/** Where the front door is along the front wall (tiles from the centre, along i). */
export const FARMHOUSE_DOOR_I = 0.35

const W = FARMHOUSE_FOOTPRINT.w / 2
const D = FARMHOUSE_FOOTPRINT.d / 2
const WALL = 56
const RIDGE = 46
const PORCH = FARMHOUSE_PORCH_DEPTH
const DECK = 7

/** A point on the house, in tiles from its centre, `up` pixels above the ground. */
function p(i: number, j: number, up = 0): string {
  const [x, y] = iso(i, j)
  return `${x.toFixed(1)},${(y - up).toFixed(1)}`
}
function xy(i: number, j: number, up = 0): readonly [number, number] {
  const [x, y] = iso(i, j)
  return [x, y - up]
}
const poly = (...points: string[]) => points.join(' ')
const line = (a: readonly [number, number], b: readonly [number, number]) => `M${a[0]} ${a[1]} L${b[0]} ${b[1]}`

/** A window on the front wall (j = D) from i=a, width w, with shutters and a flower box. */
function FrontWindow({ a, w }: { a: number; w: number }) {
  const top = 44
  const bottom = 22
  return (
    <g>
      <polygon
        points={poly(p(a - 0.13, D, bottom), p(a, D, bottom), p(a, D, top), p(a - 0.13, D, top))}
        fill="#5d9a58"
        className="g-ol2"
      />
      <polygon
        points={poly(p(a + w, D, bottom), p(a + w + 0.13, D, bottom), p(a + w + 0.13, D, top), p(a + w, D, top))}
        fill="#5d9a58"
        className="g-ol2"
      />
      <polygon
        points={poly(p(a, D, bottom), p(a + w, D, bottom), p(a + w, D, top), p(a, D, top))}
        fill="url(#g-glass)"
        className="g-ol"
      />
      <path d={line(xy(a + w / 2, D, bottom), xy(a + w / 2, D, top))} stroke="#fffaf1" strokeWidth={1.6} />
      <path
        d={line(xy(a, D, (top + bottom) / 2), xy(a + w, D, (top + bottom) / 2))}
        stroke="#fffaf1"
        strokeWidth={1.6}
      />
      <polygon
        points={poly(
          p(a - 0.04, D, bottom - 6),
          p(a + w + 0.04, D, bottom - 6),
          p(a + w + 0.04, D, bottom),
          p(a - 0.04, D, bottom)
        )}
        fill="#b0582f"
        className="g-ol2"
      />
      {[0.1, 0.3, 0.5, 0.7, 0.9].map((t, k) => {
        const [fx, fy] = xy(a + w * t, D, bottom + 1)
        return (
          <circle
            key={t}
            cx={fx}
            cy={fy}
            r={2.6}
            fill={['#f2c14e', '#e8897a', '#fffaf1', '#e8897a', '#f2c14e'][k]}
            className="g-ol2"
          />
        )
      })}
    </g>
  )
}

/**
 * The farmhouse: a gabled cottage with shingles, shutters, flower boxes, a
 * round attic window, a leaf weather vane and a smoking chimney, and a front
 * porch with a railing, steps, a rocking chair, pots, a lantern, a striped
 * canopy over the door and a welcome mat. The porch assistant stands at the foot of the steps.
 * Anchored at the house's footprint centre on the ground.
 */
export function Farmhouse() {
  const door0 = FARMHOUSE_DOOR_I - 0.22
  const door1 = FARMHOUSE_DOOR_I + 0.22
  const front = D + PORCH
  const canopyLow = DECK + 42
  const canopyHigh = DECK + 50
  const [knobX, knobY] = xy(door1 - 0.07, D, DECK + 18)
  const [wreathX, wreathY] = xy(FARMHOUSE_DOOR_I, D, DECK + 30)
  // The front roof slope overhangs the gable's near half, so the window sits in the part you can see.
  const [atticX, atticY] = xy(W, -0.32, WALL + 15)
  const [chimX, chimY] = xy(0.35, -0.35, WALL + RIDGE - 14)
  const [vaneX, vaneY] = xy(-0.75, 0, WALL + RIDGE)
  const [lampX, lampY] = xy(door0 - 0.14, D, DECK + 30)
  return (
    <g>
      <Shadow rx={128} ry={52} />

      {/* walls */}
      <polygon points={poly(p(W, D), p(W, -D), p(W, -D, WALL), p(W, D, WALL))} fill="#e8d6b0" className="g-ol" />
      {[1, 2, 3, 4, 5].map((k) => (
        <path key={`sr${k}`} d={line(xy(W, D, k * 10), xy(W, -D, k * 10))} stroke="#d2bd92" strokeWidth={1.2} />
      ))}
      {/* right gable end, with a round attic window */}
      <polygon points={poly(p(W, D, WALL), p(W, -D, WALL), p(W, 0, WALL + RIDGE))} fill="#f1e2c2" className="g-ol" />
      <circle cx={atticX} cy={atticY} r={7} fill="url(#g-glass)" className="g-ol" />
      <path
        d={`M${atticX - 7} ${atticY} H${atticX + 7} M${atticX} ${atticY - 7} V${atticY + 7}`}
        stroke="#fffaf1"
        strokeWidth={1.4}
      />
      <polygon points={poly(p(-W, D), p(W, D), p(W, D, WALL), p(-W, D, WALL))} fill="url(#g-wall)" className="g-ol" />
      {[1, 2, 3, 4, 5].map((k) => (
        <path key={`sf${k}`} d={line(xy(-W, D, k * 10), xy(W, D, k * 10))} stroke="#e2cfa5" strokeWidth={1.2} />
      ))}
      {/* side window */}
      <polygon
        points={poly(p(W, 0.1, 20), p(W, 0.55, 20), p(W, 0.55, 42), p(W, 0.1, 42))}
        fill="url(#g-glass)"
        className="g-ol"
      />

      <FrontWindow a={-W + 0.28} w={0.5} />
      <FrontWindow a={door1 + 0.18} w={0.32} />

      {/* door: round window, wreath, brass knob */}
      <polygon
        points={poly(p(door0, D, DECK), p(door1, D, DECK), p(door1, D, DECK + 36), p(door0, D, DECK + 36))}
        fill="url(#g-door)"
        className="g-ol"
      />
      <circle cx={wreathX} cy={wreathY} r={6.5} fill="none" stroke="#3f6b4f" strokeWidth={4} />
      <circle cx={wreathX} cy={wreathY} r={6.5} fill="none" stroke="#5d9a58" strokeWidth={2} strokeDasharray="2 2" />
      <circle cx={wreathX} cy={wreathY + 6} r={2.2} fill="#c2412b" className="g-ol2" />
      <circle cx={knobX} cy={knobY} r={1.9} fill="#e0a93b" className="g-ol2" />

      {/* roof: the front slope with shingle rows, and the chimney behind the ridge */}
      <g transform={`translate(${chimX} ${chimY})`}>
        <rect x={-7} y={-26} width={14} height={32} fill="url(#g-brick)" className="g-ol" />
        <rect x={-9} y={-30} width={18} height={6} fill="#7a3a1f" className="g-ol2" />
        <g className="g-smoke">
          <circle cy={-34} r={7} fill="#fff" opacity={0.85} />
          <circle cy={-34} r={6} fill="#fff" opacity={0.85} />
          <circle cy={-34} r={5} fill="#fff" opacity={0.85} />
        </g>
      </g>
      <polygon
        points={poly(
          p(-W - 0.12, D + 0.18, WALL - 4),
          p(W + 0.12, D + 0.18, WALL - 4),
          p(W + 0.12, 0, WALL + RIDGE),
          p(-W - 0.12, 0, WALL + RIDGE)
        )}
        fill="url(#g-roof)"
        className="g-ol"
      />
      {[0.25, 0.5, 0.75].map((t) => {
        const j = D + 0.18 - (D + 0.18) * t
        const up = WALL - 4 + (RIDGE + 4) * t
        return (
          <path
            key={t}
            d={line(xy(-W - 0.12, j, up), xy(W + 0.12, j, up))}
            stroke="#9a4524"
            strokeWidth={1.4}
            strokeDasharray="7 4"
          />
        )
      })}
      <path
        d={line(xy(-W - 0.12, 0, WALL + RIDGE), xy(W + 0.12, 0, WALL + RIDGE))}
        stroke={INK}
        strokeWidth={3.4}
        strokeLinecap="round"
      />
      <path
        d={line(xy(W + 0.12, D + 0.18, WALL - 4), xy(W + 0.12, 0, WALL + RIDGE))}
        stroke="#8e4524"
        strokeWidth={4}
        strokeLinecap="round"
      />
      {/* leaf weather vane */}
      <g transform={`translate(${vaneX} ${vaneY})`}>
        <path d="M0 0 V-22" stroke={INK} strokeWidth={1.8} />
        <path d="M-7 -14 H7" stroke={INK} strokeWidth={1.4} />
        <g className="g-sway">
          <path d="M0 -22 C6 -24 10 -28 9 -33 C4 -33 1 -28 0 -22Z" fill="#5d9a58" className="g-ol2" />
        </g>
      </g>

      {/* porch deck */}
      <polygon
        points={poly(p(-W + 0.08, front), p(W - 0.08, front), p(W - 0.08, front, DECK), p(-W + 0.08, front, DECK))}
        fill="#8a5a33"
        className="g-ol"
      />
      <polygon
        points={poly(p(W - 0.08, front), p(W - 0.08, D), p(W - 0.08, D, DECK), p(W - 0.08, front, DECK))}
        fill="#6b4426"
        className="g-ol"
      />
      <polygon
        points={poly(p(-W + 0.08, D, DECK), p(W - 0.08, D, DECK), p(W - 0.08, front, DECK), p(-W + 0.08, front, DECK))}
        fill="url(#g-wood)"
        className="g-ol"
      />
      {[0.2, 0.4, 0.6, 0.8].map((t) => (
        <path
          key={`plank${t}`}
          d={line(xy(-W + 0.08, D + PORCH * t, DECK), xy(W - 0.08, D + PORCH * t, DECK))}
          stroke="#9a6b41"
          strokeWidth={1}
        />
      ))}
      {/* welcome mat and steps down from the door */}
      <polygon
        points={poly(
          p(door0 + 0.02, D + 0.08, DECK),
          p(door1 - 0.02, D + 0.08, DECK),
          p(door1 - 0.02, D + 0.34, DECK),
          p(door0 + 0.02, D + 0.34, DECK)
        )}
        fill="#c2412b"
        className="g-ol2"
      />
      {[0, 1].map((k) => {
        const j0 = front + k * 0.14
        const up = DECK - (k + 1) * 3.5
        return (
          <g key={`step${k}`}>
            <polygon
              points={poly(
                p(door0, j0, up + 3.5),
                p(door1, j0, up + 3.5),
                p(door1, j0 + 0.14, up + 3.5),
                p(door0, j0 + 0.14, up + 3.5)
              )}
              fill="#c99459"
              className="g-ol2"
            />
            <polygon
              points={poly(
                p(door0, j0 + 0.14, up),
                p(door1, j0 + 0.14, up),
                p(door1, j0 + 0.14, up + 3.5),
                p(door0, j0 + 0.14, up + 3.5)
              )}
              fill="#8a5a33"
              className="g-ol2"
            />
          </g>
        )
      })}

      {/* rocking chair on the left of the porch */}
      <g transform={`translate(${xy(-W + 0.45, D + 0.4, DECK)[0]} ${xy(-W + 0.45, D + 0.4, DECK)[1]})`}>
        <path d="M-10 2 Q0 7 10 2" fill="none" stroke={INK} strokeWidth={3.6} strokeLinecap="round" />
        <path d="M-10 2 Q0 7 10 2" fill="none" stroke="#9a6b41" strokeWidth={2} strokeLinecap="round" />
        <path d="M-8 1 V-8 M7 2 V-8" stroke={INK} strokeWidth={2.4} />
        <rect x={-10} y={-10} width={19} height={4} rx={1.5} fill="url(#g-wood)" className="g-ol2" />
        <rect
          x={-9}
          y={-28}
          width={5}
          height={19}
          rx={2}
          fill="url(#g-wood)"
          className="g-ol2"
          transform="skewY(-12)"
        />
        <rect x={-7} y={-16} width={10} height={6} rx={2} fill="#e8897a" className="g-ol2" />
      </g>
      {/* potted plants by the steps */}
      {[door0 - 0.18, door1 + 0.2].map((i, k) => {
        const [x, y] = xy(i, front - 0.12, DECK)
        return (
          <g key={`pot${k}`} transform={`translate(${x} ${y})`}>
            <path d="M-6 0 L-5 -9 H5 L6 0Z" fill="url(#g-terra)" className="g-ol2" />
            <circle cx={-3} cy={-13} r={4.5} fill="#5d9a58" className="g-ol2" />
            <circle cx={3} cy={-14} r={4.5} fill="#4f8a58" className="g-ol2" />
            <circle cx={0} cy={-18} r={4} fill="#6fae63" className="g-ol2" />
            {k === 0 && <circle cx={2} cy={-16} r={1.6} fill="#f2c14e" />}
          </g>
        )
      })}

      {/* a low railing along the porch front, open at the steps */}
      {[
        [-W + 0.1, door0 - 0.04],
        [door1 + 0.04, W - 0.1],
      ].map(([a, b]) => (
        <g key={`rail${a}`}>
          {[a, (a + b) / 2, b].map((i) => (
            <path
              key={`rp${i}`}
              d={line(xy(i, front - 0.03, DECK), xy(i, front - 0.03, DECK + 13))}
              stroke={INK}
              strokeWidth={3.6}
              strokeLinecap="round"
            />
          ))}
          <path
            d={line(xy(a, front - 0.03, DECK + 12), xy(b, front - 0.03, DECK + 12))}
            stroke={INK}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <path
            d={line(xy(a, front - 0.03, DECK + 12), xy(b, front - 0.03, DECK + 12))}
            stroke="#c99459"
            strokeWidth={2.8}
            strokeLinecap="round"
          />
          {[a, (a + b) / 2, b].map((i) => (
            <path
              key={`rpc${i}`}
              d={line(xy(i, front - 0.03, DECK), xy(i, front - 0.03, DECK + 11))}
              stroke="#c99459"
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          ))}
        </g>
      ))}

      {/* wall lantern beside the door */}
      <g transform={`translate(${lampX} ${lampY})`}>
        <rect x={-1.2} y={-4} width={2.4} height={6} fill={INK} />
        <rect x={-4} y={1} width={8} height={10} rx={2.5} fill="#fff3a8" className="g-ol2" />
        <circle cy={6} r={8} fill="#fff3a8" opacity={0.35} className="g-glow" />
      </g>

      {/* a little striped canopy over the door, high enough to keep the door and windows in view */}
      {Array.from({ length: 4 }, (_, k) => {
        const a = door0 - 0.1 + ((door1 - door0 + 0.2) * k) / 4
        const b = a + (door1 - door0 + 0.2) / 4
        return (
          <polygon
            key={`stripe${k}`}
            points={poly(p(a, D, canopyHigh), p(b, D, canopyHigh), p(b, D + 0.3, canopyLow), p(a, D + 0.3, canopyLow))}
            fill={k % 2 ? '#fffaf1' : '#5d9a58'}
          />
        )
      })}
      <polygon
        points={poly(
          p(door0 - 0.1, D, canopyHigh),
          p(door1 + 0.1, D, canopyHigh),
          p(door1 + 0.1, D + 0.3, canopyLow),
          p(door0 - 0.1, D + 0.3, canopyLow)
        )}
        fill="none"
        className="g-ol"
      />
      {Array.from({ length: 5 }, (_, k) => {
        const [x, y] = xy(door0 - 0.1 + ((door1 - door0 + 0.2) * (k + 0.5)) / 5, D + 0.3, canopyLow)
        return (
          <circle key={`sc${k}`} cx={x} cy={y + 1.5} r={3.4} fill={k % 2 ? '#fffaf1' : '#5d9a58'} className="g-ol2" />
        )
      })}
    </g>
  )
}
