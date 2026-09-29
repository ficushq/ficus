import type { BadgeKind } from '../../../farm/types'
import type { RobotLook } from '../../nostalgic/types'
import { at, Ball, Bean, Blob, Block, Drop, Face, FONT, Lettering, light, p, Pill, rim, sphere, xy } from './kit'
import { CozyRobot } from './Robot'

/* ---- The speech bubbles that say something needs you ---- */

/** A round white speech bubble with a count, for buildings. Anchored at its tail. */
function CountBubble({ count, tone = '#ff8f7a' }: { count: number; tone?: string }) {
  return (
    <g className="cz-bob">
      <path d="M-4 -8 L0 0 L4 -8 Z" fill="#fffaf0" />
      <Pill x={-13} y={-26} width={26} height={19} r={9.5} fill="#fffaf0" />
      <text y={-12} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={13} fill={tone}>
        {count > 99 ? '99+' : count}
      </text>
    </g>
  )
}

/** A plant's badge: a bubble with a glyph, anchored at the tip of its tail. */
export function CozyBadge({ kind }: { kind: BadgeKind }) {
  return (
    <g className="cz-bob">
      <Drop rx={8} ry={2.4} cy={4} />
      <path d="M-4.5 -9 L0 0 L4.5 -9 Z" fill="#fffaf0" stroke="#e6d3ae" strokeWidth={1.2} strokeLinejoin="round" />
      <circle cy={-21} r={13.5} fill="#fffaf0" stroke="#e6d3ae" strokeWidth={1.4} />
      <circle cy={-21} r={13.5} fill="url(#cz-shade)" />
      <path d="M-4.4 -9.6 L4.4 -9.6" stroke="#fffaf0" strokeWidth={2.4} />
      {kind === 'harvest' ? (
        <g transform="translate(0 -21)">
          <path
            d="M-7 -1 h14 l-2 7 q-5 2 -10 0z"
            fill="#e3b27a"
            stroke={rim('#e3b27a')}
            strokeWidth={1}
            strokeLinejoin="round"
          />
          <path d="M-5 -1 q5 -9 10 0" stroke="#c9905a" strokeWidth={1.6} fill="none" />
          <circle cx={-3} cy={-2.5} r={3} fill={sphere('tomato')} />
          <circle cx={3} cy={-3} r={3} fill={sphere('orange')} />
        </g>
      ) : (
        <text
          y={-15}
          textAnchor="middle"
          fontFamily={FONT}
          fontWeight={700}
          fontSize={18}
          fill={kind === 'question' ? '#3cb8a0' : '#ff7a62'}
        >
          {kind === 'question' ? '?' : '!'}
        </text>
      )}
    </g>
  )
}

/* ---- The cottage ---- */

const WALL = '#fff1d6'
const ROOF = '#f2866e'
const TRIM = '#fffaf0'
const DOOR = '#7cc6b6'

/** A window on the front-left wall (j = e), i1..i2 across, z1..z2 up. */
function WindowLeft({ e, i1, i2, z1, z2 }: { e: number; i1: number; i2: number; z1: number; z2: number }) {
  return (
    <g>
      <Face points={`${p(i1, e, z1)} ${p(i2, e, z1)} ${p(i2, e, z2)} ${p(i1, e, z2)}`} fill={TRIM} round={7} />
      <Face
        points={`${p(i1 + 0.04, e, z1 + 2.5)} ${p(i2 - 0.04, e, z1 + 2.5)} ${p(i2 - 0.04, e, z2 - 2.5)} ${p(i1 + 0.04, e, z2 - 2.5)}`}
        fill="#9fd8f2"
        round={4}
      />
      <path d={`M${at((i1 + i2) / 2, e, z1 + 2)} L${at((i1 + i2) / 2, e, z2 - 2)}`} stroke={TRIM} strokeWidth={2} />
      {/* a flower box under it */}
      <Face
        points={`${p(i1 - 0.02, e + 0.02, z1 - 5)} ${p(i2 + 0.02, e + 0.02, z1 - 5)} ${p(i2 + 0.02, e + 0.02, z1)} ${p(i1 - 0.02, e + 0.02, z1)}`}
        fill="#d49a60"
        round={4}
      />
      {[0.2, 0.5, 0.8].map((t) => {
        const [x, y] = xy(i1 + (i2 - i1) * t, e + 0.02, z1 + 1)
        return <circle key={t} cx={x} cy={y} r={2.4} fill={t === 0.5 ? '#ffd54a' : '#ff9fb2'} />
      })}
    </g>
  )
}

/** A window on the front-right wall (i = b). */
function WindowRight({ b, j1, j2, z1, z2 }: { b: number; j1: number; j2: number; z1: number; z2: number }) {
  return (
    <g>
      <Face points={`${p(b, j1, z1)} ${p(b, j2, z1)} ${p(b, j2, z2)} ${p(b, j1, z2)}`} fill={TRIM} round={7} />
      <Face
        points={`${p(b, j1 - 0.04, z1 + 2.5)} ${p(b, j2 + 0.04, z1 + 2.5)} ${p(b, j2 + 0.04, z2 - 2.5)} ${p(b, j1 - 0.04, z2 - 2.5)}`}
        fill="#8bc9e6"
        round={4}
      />
    </g>
  )
}

export function CozyFarmhouse() {
  const [a, b, c, e] = [-1.2, 1.2, -0.9, 0.9]
  const [z1, rise, o] = [44, 34, 0.14]
  const top = z1 + rise
  return (
    <g>
      <Drop rx={120} ry={34} cy={6} />
      {/* chimney, behind the roof */}
      <Block a={-0.75} b={-0.45} c={-0.55} e={-0.25} z0={z1 + 10} z1={top + 16} color="#e7a27a" round={4} />
      <Ball cx={xy(-0.6, -0.4, top + 30)[0]} cy={xy(-0.6, -0.4, top + 30)[1]} r={5} fill="#f4f1ff" edge={false} />
      <g className="cz-smoke">
        <circle
          cx={xy(-0.6, -0.4, top + 30)[0] + 4}
          cy={xy(-0.6, -0.4, top + 30)[1] - 10}
          r={4}
          fill="#f4f1ff"
          opacity={0.8}
        />
      </g>
      {/* the back roof slope, peeking over the gable */}
      <Face
        points={`${p(a - o, 0, top)} ${p(b + o, 0, top)} ${p(b + o, c - o, z1 - 3)} ${p(a - o, c - o, z1 - 3)}`}
        fill={rim(ROOF, 14)}
        round={12}
      />
      {/* walls */}
      <Block a={a} b={b} c={c} e={e} z1={z1} color={WALL} />
      {/* the gable end on the right wall */}
      <Face points={`${p(b, e, z1)} ${p(b, c, z1)} ${p(b, 0, top)}`} fill={light(WALL, 0)} round={6} />
      <Ball cx={xy(b, -0.3, z1 + rise * 0.3)[0]} cy={xy(b, -0.3, z1 + rise * 0.3)[1]} r={6.5} fill="#9fd8f2" />
      {/* roof: the front slope, big and soft */}
      <Face
        points={`${p(a - o, e + o, z1 - 3)} ${p(b + o, e + o, z1 - 3)} ${p(b + o, 0, top)} ${p(a - o, 0, top)}`}
        fill={ROOF}
        round={12}
      />
      <Face
        points={`${p(a - o, e + o, z1 - 3)} ${p(b + o, e + o, z1 - 3)} ${p(b + o, e * 0.55, z1 + rise * 0.42)} ${p(a - o, e * 0.55, z1 + rise * 0.42)}`}
        fill={rim(ROOF, 8)}
        round={12}
      />
      <path
        d={`M${at(a - o + 0.06, 0.08, top - 2)} L${at(b + o - 0.06, 0.08, top - 2)}`}
        stroke={light(ROOF, 40)}
        strokeWidth={4}
        strokeLinecap="round"
      />
      {/* a soft fascia along the gable's edges */}
      <path
        d={`M${at(b + o, e + o, z1 - 3)} L${at(b + o, 0, top)} L${at(b + o, c - o, z1 - 3)}`}
        stroke={light(ROOF, 18)}
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* front wall: door and windows */}
      <WindowLeft e={e} i1={-0.95} i2={-0.45} z1={14} z2={32} />
      <WindowLeft e={e} i1={0.55} i2={1.0} z1={14} z2={32} />
      <Face points={`${p(-0.12, e, 0)} ${p(0.3, e, 0)} ${p(0.3, e, 26)} ${p(-0.12, e, 26)}`} fill={DOOR} round={9} />
      <circle cx={xy(0.22, e, 12)[0]} cy={xy(0.22, e, 12)[1]} r={1.8} fill="#ffd54a" />
      <WindowRight b={b} j1={0.6} j2={0.15} z1={14} z2={30} />
      <WindowRight b={b} j1={-0.2} j2={-0.65} z1={14} z2={30} />
      {/* stepping stones to the door */}
      {[
        [0.1, e + 0.35],
        [0.22, e + 0.7],
      ].map(([i, j]) => {
        const [x, y] = xy(i!, j!)
        return <Bean key={j} cx={x} cy={y} rx={9} ry={4.5} fill="#e7e1d6" />
      })}
      <Lettering y={xy(b, e)[1] + 18} size={13}>
        Farmhouse
      </Lettering>
    </g>
  )
}

/* ---- The seed tent ---- */

export function CozySeedShed() {
  const [a, b, c, e] = [-0.7, 0.7, -0.62, 0.62]
  const ridge = 48
  const n = 6
  const bands = Array.from({ length: n }, (_, k) => {
    const i1 = a + ((b - a) * k) / n
    const i2 = a + ((b - a) * (k + 1)) / n
    return (
      <Face
        key={k}
        points={`${p(i1, e, 0)} ${p(i2, e, 0)} ${p(i2, 0, ridge)} ${p(i1, 0, ridge)}`}
        fill={k % 2 ? '#fffaf0' : '#8fd6a2'}
        round={2}
      />
    )
  })
  return (
    <g>
      <Drop rx={74} ry={22} cy={4} />
      {bands}
      <Face points={`${p(b, e, 0)} ${p(b, c, 0)} ${p(b, 0, ridge)}`} fill="#d9f2df" round={5} />
      {/* the doorway, its flap tied back */}
      <Face points={`${p(b, 0.3, 0)} ${p(b, -0.3, 0)} ${p(b, -0.08, 30)} ${p(b, 0.08, 30)}`} fill="#7a6c93" round={6} />
      <Face points={`${p(b, 0.3, 0)} ${p(b, 0.08, 30)} ${p(b, 0.36, 12)}`} fill="#8fd6a2" round={4} />
      <circle cx={xy(b, 0.33, 12)[0]} cy={xy(b, 0.33, 12)[1]} r={2} fill="#ffd54a" />
      {/* ridge flag */}
      <g transform={`translate(${at(a, 0, ridge)})`}>
        <path d="M0 0 V-16" stroke="#c9905a" strokeWidth={2.2} strokeLinecap="round" />
        <path d="M1 -16 q8 1 13 4 q-5 3 -13 4z" fill="#ffd54a" className="cz-wave" />
      </g>
      {/* a seed-packet sign */}
      <g transform={`translate(${at(-0.2, e + 0.45)})`}>
        <path d="M0 0 V-14" stroke="#c9905a" strokeWidth={2.4} strokeLinecap="round" />
        <Pill x={-16} y={-32} width={32} height={20} r={7} fill="#fff4dc" />
        <Ball cx={-8} cy={-22} r={4} fill="#9bd96f" />
        <text x={3} y={-18} textAnchor="middle" fontFamily={FONT} fontWeight={700} fontSize={9} fill="#6b5a45">
          seeds
        </text>
      </g>
      <Lettering y={xy(b, e)[1] + 18} size={13}>
        Seed tent
      </Lettering>
    </g>
  )
}

/* ---- The charging hut ---- */

/** A squad's server rack: a rounded cabinet with a stack of servers, their lights on while it has apps. */
export function CozyRack({ count }: { count: number }) {
  const [a, b, c, e] = [-0.24, 0.24, -0.2, 0.2]
  return (
    <g>
      <Drop rx={26} ry={9} />
      <Block a={a} b={b} c={c} e={e} z1={58} color="#7e8fb8" />
      {[0, 1, 2, 3].map((k) => {
        const z = 8 + k * 12
        const on = k < count
        return (
          <g key={k}>
            <Face
              points={`${p(a + 0.04, e, z)} ${p(b - 0.04, e, z)} ${p(b - 0.04, e, z + 9)} ${p(a + 0.04, e, z + 9)}`}
              fill="#3b3f5c"
              round={3}
            />
            <Ball {...xyPoint(b - 0.1, e, z + 4.5)} r={1.9} fill={on ? '#8ff5b4' : '#6a6f86'} edge={false} />
          </g>
        )
      })}
      {count > 0 && (
        <g transform="translate(22 -80)">
          <Ball r={11} fill="#fff6e8" />
          <text
            y={4.5}
            textAnchor="middle"
            fontFamily={FONT}
            fontWeight={700}
            fontSize={count > 9 ? 10 : 13}
            fill="#6b5a45"
          >
            {count > 99 ? '99+' : count}
          </text>
        </g>
      )}
    </g>
  )
}

/** Where a tile point `up` pixels high lands, as circle coordinates. */
function xyPoint(i: number, j: number, up: number): { cx: number; cy: number } {
  const [x, y] = xy(i, j, up)
  return { cx: x, cy: y }
}

export function CozyHut({ count, peek }: { count: number; peek?: RobotLook }) {
  const [a, b, c, e] = [-0.5, 0.5, -0.4, 0.4]
  const [lo, hi] = [24, 34]
  const z = (j: number) => lo + ((hi - lo) * (e - j)) / (e - c)
  const panels = [0, 1, 2].flatMap((k) =>
    [0, 1].map((m) => {
      const i1 = a + 0.08 + k * 0.28
      const j1 = c + 0.08 + m * 0.34
      return (
        <Face
          key={`${k}${m}`}
          points={`${p(i1, j1, z(j1))} ${p(i1 + 0.24, j1, z(j1))} ${p(i1 + 0.24, j1 + 0.28, z(j1 + 0.28))} ${p(i1, j1 + 0.28, z(j1 + 0.28))}`}
          fill="#86b8ef"
          round={3}
        />
      )
    })
  )
  const [px, py] = xy(b + 0.35, 0.2)
  const [dx, dy] = xy(-0.05, e)
  return (
    <g>
      <Drop rx={52} ry={16} cy={4} />
      <Face points={`${p(a, e, 0)} ${p(b, e, 0)} ${p(b, e, lo)} ${p(a, e, lo)}`} fill="#d6f3e6" round={6} />
      <Face points={`${p(b, e, 0)} ${p(b, c, 0)} ${p(b, c, hi)} ${p(b, e, lo)}`} fill="#b3e2cd" round={6} />
      <Face
        points={`${p(a - 0.06, c - 0.06, hi + 1)} ${p(b + 0.06, c - 0.06, hi + 1)} ${p(b + 0.06, e + 0.06, lo - 1)} ${p(a - 0.06, e + 0.06, lo - 1)}`}
        fill="#f7f3ea"
        round={8}
      />
      {panels}
      <g className="cz-glint">
        <path
          d={`M${at(a + 0.12, c + 0.12, z(c + 0.12))} l10 -3`}
          stroke="#fff"
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.8}
        />
      </g>
      {/* door, with a resting robot peeking out */}
      <Face
        points={`${p(-0.25, e, 0)} ${p(0.12, e, 0)} ${p(0.12, e, 18)} ${p(-0.25, e, 18)}`}
        fill="#a79cc8"
        round={8}
      />
      {peek && (
        <g transform={`translate(${dx - 3} ${dy + 4}) scale(0.5)`}>
          <CozyRobot look={peek} face="sleepy" prop={null} shadow={false} />
        </g>
      )}
      {/* plugged in: a cable to a little post */}
      <path
        d={`M${at(b, 0.2, 6)} Q${px - 8} ${py + 6} ${px} ${py - 4}`}
        stroke="#6b6f86"
        strokeWidth={2.2}
        fill="none"
        strokeLinecap="round"
      />
      <Pill x={px - 3.5} y={py - 14} width={7} height={14} r={3} fill="#c9c6dc" />
      <circle cx={px} cy={py - 10} r={1.4} fill="#7be0a0" className="cz-pulse" />
      {count > 0 && (
        <g transform={`translate(${at(0, 0, hi + 10)})`}>
          <CountBubble count={count} tone="#3cb8a0" />
        </g>
      )}
    </g>
  )
}

/* ---- The consulting stand ---- */

export function CozyStand({ count, host }: { count: number; host?: RobotLook }) {
  const [a, b, c, e] = [-0.42, 0.42, -0.22, 0.22]
  const [hx, hy] = xy(0, -0.32)
  const [f, g] = [-0.52, 0.52]
  const lo = 56
  const hi = 62
  const stripes = Array.from({ length: 6 }, (_, k) => {
    const i1 = f + ((g - f) * k) / 6
    const i2 = f + ((g - f) * (k + 1)) / 6
    return (
      <Face
        key={k}
        points={`${p(i1, -0.42, hi)} ${p(i2, -0.42, hi)} ${p(i2, 0.34, lo)} ${p(i1, 0.34, lo)}`}
        fill={k % 2 ? '#fffaf0' : '#ff9fb2'}
        round={2}
      />
    )
  })
  const scallops = Array.from({ length: 6 }, (_, k) => {
    const i1 = f + ((g - f) * k) / 6
    const [x1, y1] = xy(i1, 0.34, lo)
    const [x2, y2] = xy(i1 + (g - f) / 6, 0.34, lo)
    return (
      <path
        key={k}
        d={`M${x1} ${y1} Q${(x1 + x2) / 2} ${(y1 + y2) / 2 + 9} ${x2} ${y2} Z`}
        fill={k % 2 ? '#fffaf0' : '#ff9fb2'}
      />
    )
  })
  const post = (i: number, j: number) => {
    const [x0, y0] = xy(i, j)
    const [, y1] = xy(i, j, lo)
    return <rect key={`${i}${j}`} x={x0 - 2.5} y={y1} width={5} height={y0 - y1} rx={2.5} fill="#e3b27a" />
  }
  return (
    <g>
      <Drop rx={50} ry={14} cy={4} />
      {post(a, -0.34)}
      {post(b, -0.34)}
      {host && (
        <g transform={`translate(${hx} ${hy}) scale(0.82)`}>
          <CozyRobot look={host} face="normal" prop="clip" shadow={false} />
        </g>
      )}
      <Block a={a} b={b} c={c} e={e} z1={16} color="#e8b47d" top="#f6d3a6" round={4} />
      <Face
        points={`${p(a + 0.08, e, 4)} ${p(b - 0.08, e, 4)} ${p(b - 0.08, e, 12)} ${p(a + 0.08, e, 12)}`}
        fill="#ffe2b8"
        round={3}
      />
      {post(a, e)}
      {post(b, e)}
      {stripes}
      {scallops}
      {count > 0 && (
        <g transform={`translate(${at(0, -0.1, hi + 12)})`}>
          <CountBubble count={count} />
        </g>
      )}
    </g>
  )
}

/* ---- Mailbox, harvest baskets, compost ---- */

export function CozyMailbox({ count }: { count: number }) {
  const full = count > 0
  return (
    <g>
      <Drop rx={16} ry={5} />
      <rect x={-2.5} y={-30} width={5} height={30} rx={2.5} fill="#c9905a" />
      <Blob d="M-13 -30 V-46 Q-13 -56 0 -56 Q13 -56 13 -46 V-30 Z" fill={full ? '#ff9f8a' : '#8fc8f0'} />
      <Pill x={-7} y={-44} width={14} height={9} r={4} fill={rim(full ? '#ff9f8a' : '#8fc8f0', 22)} />
      {full ? (
        <g className="cz-wave">
          <path d="M13 -38 V-60" stroke="#8a7a6a" strokeWidth={2} strokeLinecap="round" />
          <path d="M14 -60 h9 q2 0 2 2 v4 q0 2 -2 2 h-9z" fill="#ff6b5a" />
        </g>
      ) : (
        <path d="M13 -40 h12" stroke="#ff6b5a" strokeWidth={3} strokeLinecap="round" />
      )}
      {full && (
        <g transform="translate(0 -62)">
          <CountBubble count={count} />
        </g>
      )}
    </g>
  )
}

function Basket({ x, y, fruit }: { x: number; y: number; fruit: 'tomato' | 'orange' | 'apple' }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx={-5} cy={-12} r={5} fill={sphere(fruit)} />
      <circle cx={4} cy={-13} r={5.2} fill={sphere(fruit === 'tomato' ? 'orange' : 'tomato')} />
      <circle cx={0} cy={-15} r={4.6} fill={sphere(fruit)} />
      <Blob d="M-12 -12 h24 l-3 11 q-9 3 -18 0z" fill="#e3b27a" />
      <path d="M-10 -8 h20 M-9 -4 h18" stroke={rim('#e3b27a', 12)} strokeWidth={1.2} strokeLinecap="round" />
    </g>
  )
}

export function CozyCrates({ count }: { count: number }) {
  return (
    <g>
      <Drop rx={34} ry={9} />
      <Basket x={-14} y={-2} fruit="tomato" />
      {count > 1 && <Basket x={14} y={0} fruit="orange" />}
      {count > 4 && <Basket x={0} y={6} fruit="apple" />}
    </g>
  )
}

export function CozyCompost({ count }: { count: number }) {
  return (
    <g>
      <Drop rx={26} ry={7} />
      <Blob d="M-22 0 Q-20 -18 0 -19 Q20 -18 22 0 Q0 5 -22 0 Z" fill="#a37656" />
      <Bean cx={-6} cy={-15} rx={5} ry={2.6} fill="#9bd96f" rotate={-20} />
      <Bean cx={7} cy={-11} rx={4.4} ry={2.4} fill="#c9b67c" rotate={25} />
      {count > 3 && <Bean cx={0} cy={-19} rx={3.8} ry={2.2} fill="#7ccf6b" rotate={5} />}
    </g>
  )
}
