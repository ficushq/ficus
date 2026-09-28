import type { DecorPlacement } from '../../../farm/types'
import { Bean, Drop, Pill, rim, sphere } from './kit'

const FRUITS = ['apple', 'orange', 'peach'] as const
const PETALS = ['#ffb3c7', '#fff1f5', '#ffd54a', '#c9b6ff', '#ff9f8a'] as const

/** A round, fluffy tree: a short trunk under a cloud of green balls, fruit on some. */
function Tree({ fruit, seed }: { fruit: boolean; seed: number }) {
  const lean = (seed % 5) - 2
  const kind = FRUITS[seed % FRUITS.length]!
  return (
    <g>
      <Drop rx={28} ry={9} />
      <Pill x={-5} y={-30} width={10} height={31} r={5} fill="#b98556" />
      <g transform={`translate(${lean} 0)`}>
        {[
          [-14, -38, 14],
          [14, -38, 14],
          [0, -54, 18],
          [0, -36, 16],
        ].map(([x, y, r]) => (
          <circle
            key={`${x}${y}`}
            cx={x}
            cy={y}
            r={r}
            fill={sphere('leaf')}
            stroke={rim('#7ccf6b', 22)}
            strokeWidth={1.2}
          />
        ))}
        {fruit &&
          [
            [-12, -34],
            [10, -44],
            [2, -30],
            [-4, -56],
          ].map(([x, y]) => (
            <circle
              key={`${x}${y}`}
              cx={x}
              cy={y}
              r={4}
              fill={sphere(kind)}
              stroke={rim('#f0605a', 20)}
              strokeWidth={0.8}
            />
          ))}
      </g>
    </g>
  )
}

/** A round flowering bush. */
function Bush({ seed }: { seed: number }) {
  const petal = PETALS[seed % PETALS.length]!
  return (
    <g>
      <Drop rx={20} ry={6} />
      <circle cx={-8} cy={-9} r={10} fill={sphere('deep')} stroke={rim('#4fae62')} strokeWidth={1.2} />
      <circle cx={8} cy={-9} r={10} fill={sphere('deep')} stroke={rim('#4fae62')} strokeWidth={1.2} />
      <circle cx={0} cy={-15} r={11} fill={sphere('hedge')} stroke={rim('#63c071')} strokeWidth={1.2} />
      {[
        [-9, -12],
        [4, -20],
        [9, -8],
        [-2, -9],
      ].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={2.4} fill={petal} />
      ))}
    </g>
  )
}

/** A few cosmos-like flowers on little stems. */
function Flowers({ seed }: { seed: number }) {
  return (
    <g>
      {[
        [-8, 0],
        [0, -4],
        [8, 1],
      ].map(([x, y], k) => {
        const petal = PETALS[(seed + k) % PETALS.length]!
        return (
          <g key={k} transform={`translate(${x} ${y})`}>
            <path d="M0 0 V-10" stroke="#5dab4e" strokeWidth={2} strokeLinecap="round" />
            <Bean cx={-3} cy={-4} rx={3} ry={1.8} fill="#7ccf6b" rotate={-30} />
            {[0, 72, 144, 216, 288].map((deg) => (
              <ellipse key={deg} cx={0} cy={-15} rx={2.4} ry={3.4} fill={petal} transform={`rotate(${deg} 0 -12)`} />
            ))}
            <circle cy={-12} r={2} fill="#ffd54a" />
          </g>
        )
      })}
    </g>
  )
}

/** A round roll of hay. */
function HayRoll() {
  return (
    <g>
      <Drop rx={20} ry={6} />
      <Pill x={-16} y={-22} width={26} height={22} r={10} fill="#f0cd6e" />
      <Bean cx={10} cy={-11} rx={8} ry={11} fill="#f4d67f" />
      <path
        d="M10 -18 q-5 7 0 14 M10 -14 q-2 3 0 6"
        stroke={rim('#f4d67f', 20)}
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
      />
    </g>
  )
}

export function CozyDecor({ decor }: { decor: DecorPlacement }) {
  switch (decor.kind) {
    case 'tree':
    case 'fruitTree':
      return <Tree fruit={decor.kind === 'fruitTree'} seed={decor.seed} />
    case 'bush':
      return <Bush seed={decor.seed} />
    case 'flowers':
      return <Flowers seed={decor.seed} />
    case 'hay':
      return <HayRoll />
  }
}
