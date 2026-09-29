import { describe, expect, test } from 'bun:test'
import { doorwayOut, porchLift } from './doorway'

const HOUSE = [-4.5, -2] as const
const PORCH = { i: 0.35, j: 1, floor: 7, steps: [1.75, 2.03] } as const
const LEVEL = { i: 0.09, j: 0.9, floor: 0, steps: [0.9, 0.9] } as const

describe('the farmhouse doorway', () => {
  test('runs from just inside the door, straight out, to past the foot of the steps', () => {
    const [from, to] = doorwayOut([...HOUSE], PORCH)
    expect(from![0]).toBeCloseTo(-4.15)
    expect(from![1]).toBeCloseTo(-1.15)
    expect(to![0]).toBeCloseTo(-4.15)
    expect(to![1]).toBeCloseTo(0.38)
  })

  test('a door without steps still leads out past the wall', () => {
    const [from, to] = doorwayOut([...HOUSE], LEVEL)
    expect(from![1]).toBeCloseTo(-1.25)
    expect(to![1]).toBeCloseTo(-0.75)
  })

  test('people stand on the porch floor, step down the steps, and are on the ground past them', () => {
    const at = (j: number, i = -4.15) => porchLift([...HOUSE], PORCH, [i, HOUSE[1] + j])
    expect(at(1)).toBe(7)
    expect(at(1.5)).toBe(7)
    expect(at(1.89)).toBeCloseTo(3.5)
    expect(at(2.03)).toBe(0)
    expect(at(2.5)).toBe(0)
    // Off to the side of the door, or somewhere else entirely: on the ground.
    expect(at(1.5, -3)).toBe(0)
    expect(porchLift([...HOUSE], LEVEL, [-4.41, -1])).toBe(0)
  })
})
