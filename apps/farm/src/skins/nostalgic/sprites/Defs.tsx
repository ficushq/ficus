import { INK, mixHex } from './shared'

/** Shell colours that have a matching `g-shell-<hex>` gradient. */
export const ROBOT_SHELLS = ['#fbf4e4', '#e9f3d6', '#f7e3cf', '#e6eef5', '#f3e6f4', '#fff1c7'] as const

/** Fill for a robot shell colour: its gradient when defined, the flat colour otherwise. */
export function shellFill(shell: string): string {
  const known = (ROBOT_SHELLS as readonly string[]).includes(shell.toLowerCase())
  return known ? `url(#g-shell-${shell.slice(1).toLowerCase()})` : shell
}

const VERTICAL = { x1: 0, y1: 0, x2: 0, y2: 1 } as const
const UPWARD = { x1: 0, y1: 1, x2: 0, y2: 0 } as const
const HORIZONTAL = { x1: 0, y1: 0, x2: 1, y2: 0 } as const
const DIAGONAL = { x1: 0, y1: 0, x2: 1, y2: 1 } as const
type Direction = typeof VERTICAL | typeof UPWARD | typeof HORIZONTAL | typeof DIAGONAL

// Stops are written "colour offset, colour offset, ...".
const LINEAR: ReadonlyArray<readonly [id: string, dir: Direction, stops: string]> = [
  ['g-leaf', UPWARD, '#2f5a3e 0, #4f8a58 .6, #7cb465 1'],
  ['g-leaf-side', UPWARD, '#6e7d3c 0, #b3c46c 1'],
  ['g-wither', UPWARD, '#6b5530 0, #b09356 1'],
  ['g-petal', UPWARD, '#e0a020 0, #ffe07a 1'],
  ['g-soil', DIAGONAL, '#a26d40 0, #83552f 1'],
  ['g-wood', HORIZONTAL, '#d09a5f 0, #a06e40 1'],
  ['g-wall', VERTICAL, '#fbf1dc 0, #ecdcb8 1'],
  ['g-roof', VERTICAL, '#e07a45 0, #b0582f 1'],
  ['g-roof-green', VERTICAL, '#5d9a68 0, #3f6b4f 1'],
  ['g-door', VERTICAL, '#8e5c35 0, #6b4426 1'],
  ['g-glass', DIAGONAL, '#e6f6ff 0, #9fcbe0 .5, #7fb0c8 1'],
  ['g-brick', HORIZONTAL, '#b8603a 0, #8e4524 1'],
  ['g-bark', HORIZONTAL, '#9a6b41 0, #6b4426 1'],
  ['g-terra', VERTICAL, '#e07a45 0, #a24a24 1'],
  ['g-straw', VERTICAL, '#f4d88a 0, #d4a94f 1'],
  ['g-denim', VERTICAL, '#7da3cc 0, #4f75a0 1'],
  ['g-hay', VERTICAL, '#f4d88a 0, #c9a24a 1'],
  ['g-compost', VERTICAL, '#8a6a42 0, #5e3f27 1'],
  ['g-solar', DIAGONAL, '#7fa6cf 0, #3f5f86 .5, #2b4263 1'],
  ['g-metal', VERTICAL, '#d7dce0 0, #9aa4ad 1'],
]

const RADIAL: ReadonlyArray<readonly [id: string, cx: number, cy: number, r: number, stops: string]> = [
  ['g-fruit', 0.35, 0.3, 0.8, '#ffb38a 0, #e0643a .35, #9c3a1c 1'],
  ['g-pumpkin', 0.35, 0.3, 0.8, '#ffd08a 0, #ef8d33 .4, #b35a18 1'],
  ['g-disk', 0.4, 0.35, 0.5, '#8a5a33 0, #4a2e18 1'],
  ['g-tree', 0.35, 0.3, 0.8, '#8cc46a 0, #4f8a58 .6, #2f5a3e 1'],
  ['g-tree2', 0.35, 0.3, 0.8, '#b7cf6e 0, #7f9a45 .6, #566b2f 1'],
  ['g-badge', 0.4, 0.3, 0.8, '#ffffff 0, #f1e2c4 1'],
]

function Stops({ spec }: { spec: string }) {
  return (
    <>
      {spec.split(',').map((part) => {
        const [color, offset] = part.trim().split(' ')
        return <stop key={part} offset={Number(offset)} stopColor={color} />
      })}
    </>
  )
}

/** Every gradient the farm sprites reference. Render once per scene `<svg>`. */
export function SceneDefs() {
  return (
    <defs>
      {LINEAR.map(([id, dir, stops]) => (
        <linearGradient key={id} id={id} {...dir}>
          <Stops spec={stops} />
        </linearGradient>
      ))}
      {RADIAL.map(([id, cx, cy, r, stops]) => (
        <radialGradient key={id} id={id} cx={cx} cy={cy} r={r}>
          <Stops spec={stops} />
        </radialGradient>
      ))}
      {ROBOT_SHELLS.map((c) => (
        <linearGradient key={c} id={`g-shell-${c.slice(1)}`} {...DIAGONAL}>
          <stop offset={0} stopColor="#ffffff" />
          <stop offset={0.45} stopColor={c} />
          <stop offset={1} stopColor={mixHex(c, INK, 0.2)} />
        </linearGradient>
      ))}
    </defs>
  )
}
