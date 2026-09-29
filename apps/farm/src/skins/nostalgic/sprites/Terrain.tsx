import { memo } from 'react'
import { iso } from '../../../farm/iso'
import { hash } from './shared'

const LIGHT = '#a8c064'
const DARK = '#9fb85a'
const TUFT = '#8faa52'

function r1(n: number): number {
  return Math.round(n * 10) / 10
}

function diamond(i: number, j: number): string {
  const [ax, ay] = iso(i, j)
  const [bx, by] = iso(i + 1, j)
  const [cx, cy] = iso(i + 1, j + 1)
  const [dx, dy] = iso(i, j + 1)
  return `M${ax} ${ay}L${bx} ${by}L${cx} ${cy}L${dx} ${dy}Z`
}

/**
 * Checkerboard grass covering the world rectangle [minI, maxI] × [minJ, maxJ]
 * (absolute coords), plus sparse tufts (about one per five tiles, stable per
 * tile). Two fill paths and one stroke path regardless of size.
 */
export const Grass = memo(function Grass({
  minI,
  maxI,
  minJ,
  maxJ,
}: {
  minI: number
  maxI: number
  minJ: number
  maxJ: number
}) {
  const light: string[] = []
  const dark: string[] = []
  const tufts: string[] = []
  for (let i = Math.floor(minI); i < Math.ceil(maxI); i++) {
    for (let j = Math.floor(minJ); j < Math.ceil(maxJ); j++) {
      ;((i + j) & 1 ? light : dark).push(diamond(i, j))
      const h = hash(i, j, 7)
      if (h % 5 === 0) {
        const u = ((h >>> 3) % 100) / 100
        const v = ((h >>> 10) % 100) / 100
        const [x, y] = iso(i + 0.15 + u * 0.7, j + 0.15 + v * 0.7)
        const X = r1(x)
        const Y = r1(y)
        tufts.push(`M${X} ${Y}l-2 -5M${X} ${Y}l0 -6M${X} ${Y}l2.4 -5`)
      }
    }
  }
  return (
    <g>
      <path d={dark.join('')} fill={DARK} />
      <path d={light.join('')} fill={LIGHT} />
      <path d={tufts.join('')} stroke={TUFT} strokeWidth={1.2} strokeLinecap="round" fill="none" />
    </g>
  )
})
