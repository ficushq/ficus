import { iso, pt } from '../iso'
import { FONT_DISPLAY, INK, Shadow } from './shared'

/** Seed shed footprint in tiles (w along i, d along j). Origin is its centre. */
export const SEED_SHED_FOOTPRINT = { w: 1.5, d: 1.3 } as const

/** Local point helper for a footprint whose corner (0,0) sits at (-w/2, -d/2) tiles from the origin. */
function footprint(w: number, d: number) {
  const i0 = -w / 2
  const j0 = -d / 2
  return {
    p: (a: number, b: number, dy = 0) => pt(i0 + a, j0 + b, dy),
    xy: (a: number, b: number) => iso(i0 + a, j0 + b),
  }
}

const PACKET_COLORS = ['#b0582f', '#e0a93b', '#8a9a5b']

/** Seed shed with a crate of packets out front. Anchored at the footprint's centre ground point. */
export function SeedShed() {
  const { w, d } = SEED_SHED_FOOTPRINT
  const h = 40
  const { p, xy } = footprint(w, d)
  const [px, py] = xy(w / 2, d / 2)
  const peak = `${px},${py - h - 34}`
  const [sx, sy] = xy(0.72, d)
  const [cx, cy] = xy(1.25, d + 0.35)
  return (
    <g>
      <polygon points={`${p(0, d)} ${p(w, d)} ${p(w, d, -h)} ${p(0, d, -h)}`} fill="url(#g-wood)" className="g-ol" />
      <polygon points={`${p(w, d)} ${p(w, 0)} ${p(w, 0, -h)} ${p(w, d, -h)}`} fill="#94643a" className="g-ol" />
      {[1, 2, 3].map((k) => {
        const f = k / 4
        const [x1, y1] = xy(w * f, d)
        const [x2, y2] = xy(w, d * f)
        return (
          <g key={k}>
            <path d={`M${x1} ${y1} v${-h}`} stroke="#8a5a33" strokeWidth={1} />
            <path d={`M${x2} ${y2} v${-h}`} stroke="#744a2a" strokeWidth={1} />
          </g>
        )
      })}
      <polygon
        points={`${p(-0.12, d + 0.12, -h)} ${p(w + 0.12, d + 0.12, -h)} ${peak}`}
        fill="url(#g-roof-green)"
        className="g-ol"
      />
      <polygon
        points={`${p(w + 0.12, d + 0.12, -h)} ${p(w + 0.12, -0.12, -h)} ${peak}`}
        fill="#2f5540"
        className="g-ol"
      />
      <polygon points={`${p(0.45, d)} ${p(1, d)} ${p(1, d, -30)} ${p(0.45, d, -30)}`} fill="#4a3120" className="g-ol" />
      <polygon
        points={`${p(w, 0.35, -18)} ${p(w, 0.9, -18)} ${p(w, 0.9, -32)} ${p(w, 0.35, -32)}`}
        fill="url(#g-glass)"
        className="g-ol"
      />
      <g transform={`translate(${sx} ${sy - 40})`}>
        <rect x={-19} y={-8} width={38} height={13} rx={3} fill="#fffaf1" className="g-ol2" />
        <text y={2.6} textAnchor="middle" fontFamily={FONT_DISPLAY} fontWeight={900} fontSize={9} fill="#3f6b4f">
          SEEDS
        </text>
      </g>
      <g transform={`translate(${cx} ${cy})`}>
        <Shadow rx={14} ry={4} />
        <path d="M-12 0 V-9 H12 V0Z" fill="url(#g-wood)" className="g-ol" />
        <path d="M-12 -4.5 H12" stroke="#8a5a33" strokeWidth={1.2} />
        {PACKET_COLORS.map((c, k) => (
          <g key={c} transform={`translate(${k * 7 - 10} ${-19 + (k % 2)}) rotate(${-8 + k * 8})`}>
            <rect width={7} height={10} rx={1.2} fill="#fffaf1" className="g-ol2" />
            <circle cx={3.5} cy={5.5} r={2.2} fill={c} />
          </g>
        ))}
      </g>
    </g>
  )
}

/** Mailbox; the flag is up and a count badge shows only when there's mail. Anchored at the post's foot. */
export function Mailbox({ count }: { count: number }) {
  const has = count > 0
  return (
    <g>
      <Shadow rx={16} ry={5} />
      <rect x={-3.5} y={-40} width={7} height={40} fill="url(#g-wood)" className="g-ol" />
      <g transform="translate(0 -40)">
        {!has && <MailFlag up={false} />}
        <path d="M-18 0 V-16 a12 12 0 0 1 12 -12 h12 a12 12 0 0 1 12 12 V0Z" fill="url(#g-terra)" className="g-ol" />
        <path
          d="M-12 -18 a8 8 0 0 1 8 -8"
          stroke="#fff"
          strokeOpacity={0.45}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
        {has && <MailFlag up />}
      </g>
      {has && (
        <g transform="translate(-20 -74)">
          <circle r={13} fill="url(#g-badge-mail)" className="g-ol" />
          <ellipse cx={-3} cy={-6} rx={6} ry={2.6} fill="#fff" opacity={0.5} />
          <text
            y={6}
            textAnchor="middle"
            fontFamily={FONT_DISPLAY}
            fontWeight={900}
            fontSize={count > 9 ? 13 : 16}
            fill="#fff"
            stroke={INK}
            strokeWidth={2.4}
            paintOrder="stroke"
          >
            {count > 99 ? '99+' : count}
          </text>
        </g>
      )}
    </g>
  )
}

function MailFlag({ up }: { up: boolean }) {
  // Pivot at the arm's foot; lowered, it lies flat along the box's side.
  return (
    <g transform={up ? undefined : 'rotate(90 19.5 -9)'}>
      <rect x={18} y={-30} width={3} height={22} fill="#5e3f27" className="g-ol2" />
      <path className={up ? 'g-flagwave g-ol2' : 'g-ol2'} d="M21 -30 h13 v9 h-13z" fill="#5d9a58" />
    </g>
  )
}

/** Harvest crates: up to 3 filled crates (one empty crate when count is 0). Anchored at the middle crate's foot. */
export function Crates({ count }: { count: number }) {
  const n = Math.max(1, Math.min(3, count))
  const empty = count <= 0
  return (
    <g>
      {Array.from({ length: n }, (_, k) => (
        <g key={k} transform={`translate(${k * 20 - (n - 1) * 10} ${k % 2 ? -3 : 0})`}>
          <Shadow rx={12} ry={4} />
          {!empty &&
            (k === 1 ? (
              <>
                <circle cx={-4} cy={-15} r={4.4} fill="url(#g-pumpkin)" className="g-ol2" />
                <circle cx={4} cy={-15} r={4.4} fill="url(#g-pumpkin)" className="g-ol2" />
              </>
            ) : (
              <>
                <circle cx={-4} cy={-15} r={4} fill="url(#g-fruit)" className="g-ol2" />
                <circle cx={4} cy={-15} r={4} fill="url(#g-fruit)" className="g-ol2" />
                <circle cx={0} cy={-19} r={4} fill="url(#g-fruit)" className="g-ol2" />
              </>
            ))}
          <path d="M-10 0 V-13 H10 V0Z" fill="url(#g-wood)" className="g-ol" />
          <path d="M-10 -7 H10" stroke="#8a5a33" strokeWidth={1.4} />
        </g>
      ))}
    </g>
  )
}

/** Compost heap for canceled work; grows a little with the count. Anchored at the heap's centre. */
export function Compost({ count }: { count: number }) {
  const s = count <= 0 ? 0.72 : count < 3 ? 0.88 : 1
  return (
    <g>
      <Shadow rx={22 * s} ry={6 * s} />
      <g transform={`scale(${s})`}>
        <path d="M-20 0 Q-16 -18 0 -20 Q16 -18 20 0Z" fill="url(#g-compost)" className="g-ol" />
        {count > 0 && (
          <path
            d="M-8 -10 l4 -3 M4 -14 l4 2 M-2 -6 l3 -3 M8 -6 l3 -2"
            stroke="#8a9a5b"
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}
      </g>
    </g>
  )
}

/** Wooden bench for visiting consultants; seat runs along j, back on the -i side. Anchored at the seat's centre. */
export function Bench() {
  const seatY = -12
  const q = (a: number, b: number, dy: number) => {
    const [x, y] = iso(a, b)
    return `${x},${y + dy}`
  }
  const leg = (a: number, b: number) => {
    const [x, y] = iso(a, b)
    return (
      <rect key={`${a},${b}`} x={x - 1.8} y={y + seatY} width={3.6} height={-seatY} fill="#7c5232" className="g-ol2" />
    )
  }
  const A = 0.13
  const L = 0.42
  return (
    <g>
      <Shadow rx={28} ry={9} opacity={0.18} />
      {leg(-A, -L + 0.06)}
      {leg(A, -L + 0.06)}
      {leg(-A, L - 0.06)}
      {leg(A, L - 0.06)}
      {/* backrest */}
      {[-30, -22].map((dy) => (
        <polygon
          key={dy}
          points={`${q(-A - 0.02, -L, dy)} ${q(-A - 0.02, L, dy)} ${q(-A - 0.02, L, dy + 5)} ${q(-A - 0.02, -L, dy + 5)}`}
          fill="url(#g-wood)"
          className="g-ol2"
        />
      ))}
      {[-L + 0.06, L - 0.06].map((b) => {
        const [x, y] = iso(-A - 0.02, b)
        return <rect key={b} x={x - 1.6} y={y - 31} width={3.2} height={19} fill="#8a5a33" className="g-ol2" />
      })}
      {/* seat: top face then front edge */}
      <polygon
        points={`${q(-A, -L, seatY)} ${q(-A, L, seatY)} ${q(A, L, seatY)} ${q(A, -L, seatY)}`}
        fill="#d09a5f"
        className="g-ol2"
      />
      <polygon
        points={`${q(A, -L, seatY)} ${q(A, L, seatY)} ${q(A, L, seatY + 3.5)} ${q(A, -L, seatY + 3.5)}`}
        fill="#a06e40"
        className="g-ol2"
      />
      <polygon
        points={`${q(-A, L, seatY)} ${q(A, L, seatY)} ${q(A, L, seatY + 3.5)} ${q(-A, L, seatY + 3.5)}`}
        fill="#8a5a33"
        className="g-ol2"
      />
      <path d={`M${q(0, -L, seatY)} L${q(0, L, seatY)}`} stroke="#a06e40" strokeWidth={1} />
    </g>
  )
}
