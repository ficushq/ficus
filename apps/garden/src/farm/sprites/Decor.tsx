import { Shadow, hash, pick, rand01 } from './shared'

const BLOOMS = ['#f2c14e', '#e8897a', '#fffaf1', '#c9a0dc'] as const

/** A round tree; `fruit` gives the dark canopy with red fruit. Anchored at the trunk's foot. */
export function Tree({ fruit, seed }: { fruit: boolean; seed: number }) {
  const s = 1.1 + rand01(seed, 1) * 0.25
  const canopy = fruit ? 'url(#g-tree)' : 'url(#g-tree2)'
  return (
    <g className="g-soft">
      <g transform={`scale(${s.toFixed(3)})`}>
        <Shadow rx={30} ry={10} />
        <path d="M-6 0 L-4 -34 H4 L6 0Z" fill="url(#g-bark)" className="g-ol" />
        <circle cx={-16} cy={-44} r={20} fill={canopy} className="g-ol" />
        <circle cx={16} cy={-46} r={19} fill={canopy} className="g-ol" />
        <circle cx={0} cy={-66} r={24} fill={canopy} className="g-ol" />
        <ellipse cx={-8} cy={-76} rx={10} ry={5} fill="#fff" opacity={0.22} />
        {fruit && (
          <>
            <circle cx={-12} cy={-50} r={3.4} fill="url(#g-fruit)" className="g-ol2" />
            <circle cx={12} cy={-60} r={3.4} fill="url(#g-fruit)" className="g-ol2" />
            <circle cx={8} cy={-42} r={3.4} fill="url(#g-fruit)" className="g-ol2" />
          </>
        )}
      </g>
    </g>
  )
}

const BUSH_BLOOMS = ['#e8897a', '#f2c14e', '#fffaf1'] as const
const BUSH_SPOTS = [
  [-10, -16],
  [6, -24],
  [12, -8],
  [-2, -8],
] as const

/** A flowering bush. Anchored at its base. */
export function Bush({ seed }: { seed: number }) {
  const bloom = pick(BUSH_BLOOMS, seed, 2)
  return (
    <g className="g-soft">
      <Shadow rx={20} ry={6} />
      <circle cx={-10} cy={-10} r={12} fill="url(#g-tree2)" className="g-ol" />
      <circle cx={10} cy={-10} r={12} fill="url(#g-tree2)" className="g-ol" />
      <circle cy={-18} r={13} fill="url(#g-tree2)" className="g-ol" />
      {BUSH_SPOTS.map(([x, y]) => (
        <circle key={x} cx={x} cy={y} r={2.8} fill={bloom} className="g-ol2" />
      ))}
    </g>
  )
}

/** A loose cluster of four wildflowers. Anchored at the cluster's centre. */
export function Flowers({ seed }: { seed: number }) {
  const base = hash(seed, 3) % 997
  const offset = hash(seed, 4) % BLOOMS.length
  return (
    <g className="g-soft">
      {[0, 1, 2, 3].map((k) => {
        const x = Math.round(Math.sin(base + k * 3.1) * 260) / 10
        const y = Math.round(Math.cos(base + k * 1.7) * 120) / 10
        return (
          <g key={k}>
            <path d={`M${x} ${y} v-7`} stroke="#4d7a44" strokeWidth={1.6} />
            <circle cx={x} cy={y - 8} r={3} fill={BLOOMS[(k + offset) % BLOOMS.length]} className="g-ol2" />
          </g>
        )
      })}
    </g>
  )
}

/** A round hay bale. Anchored at its base. */
export function HayBale() {
  return (
    <g>
      <Shadow rx={18} ry={6} />
      <path d="M-16 0 V-16 Q0 -26 16 -16 V0 Q0 6 -16 0Z" fill="url(#g-hay)" className="g-ol" />
      <path d="M-16 -9 Q0 -3 16 -9" stroke="#b8923f" strokeWidth={1.6} fill="none" />
      <path d="M-8 -20 l2 -4 M4 -21 l-1 -5 M10 -18 l3 -3" stroke="#b8923f" strokeWidth={1.4} />
    </g>
  )
}

const WINGS = ['#fffaf1', '#f2c14e', '#c9a0dc', '#e8897a'] as const

/** A butterfly looping around its anchor. */
export function Butterfly({ seed }: { seed: number }) {
  const c = pick(WINGS, seed, 5)
  const delay = `${-(hash(seed, 6) % 7000) / 1000}s`
  return (
    <g className="g-fly" style={{ animationDelay: delay }}>
      <ellipse className="g-flap g-ol2" cx={-4} cy={0} rx={5} ry={6} fill={c} />
      <ellipse className="g-flap g-ol2" cx={4} cy={0} rx={5} ry={6} fill={c} />
      <rect x={-1} y={-4} width={2} height={9} rx={1} fill="#3b2415" />
    </g>
  )
}
