import { describe, expect, test } from 'bun:test'
import { parse, pencil } from './pencil'

describe('parse', () => {
  test('resolves relative commands, H/V and implicit lines to absolute segments', () => {
    expect(parse('M10 10 h5 v5 l-5 0 z')).toEqual([
      { c: 'M', p: [10, 10] },
      { c: 'L', p: [15, 10] },
      { c: 'L', p: [15, 15] },
      { c: 'L', p: [10, 15] },
      { c: 'Z' },
    ])
    expect(parse('M0 0 4 0 4 4')).toEqual([
      { c: 'M', p: [0, 0] },
      { c: 'L', p: [4, 0] },
      { c: 'L', p: [4, 4] },
    ])
  })

  test('keeps curves and arcs, relative ones included', () => {
    expect(parse('M-6.5 -28.5 q2.5 -3.5 5 0')).toEqual([
      { c: 'M', p: [-6.5, -28.5] },
      { c: 'Q', q: [-4, -32], p: [-1.5, -28.5] },
    ])
    expect(parse('M-13 0 a6 6 0 0 1 2 -10')).toEqual([
      { c: 'M', p: [-13, 0] },
      { c: 'A', rx: 6, ry: 6, rot: 0, large: 0, sweep: 1, p: [-11, -10] },
    ])
  })

  test('a move after a close starts from the closed point for relative commands', () => {
    const segs = parse('M0 0 L10 0 Z m5 5')
    expect(segs.at(-1)).toEqual({ c: 'M', p: [5, 5] })
  })
})

describe('pencil', () => {
  test('is deterministic', () => {
    expect(pencil('M0 0 L40 0 L40 20 Z')).toBe(pencil('M0 0 L40 0 L40 20 Z'))
  })

  test('draws every subpath twice and stays close to the original', () => {
    const drawn = pencil('M0 0 L40 0')
    expect(drawn.match(/M/g)).toHaveLength(2)
    const nums = drawn.match(/-?\d+(\.\d+)?/g)!.map(Number)
    const ys = nums.filter((_, k) => k % 2 === 1)
    for (const y of ys) expect(Math.abs(y)).toBeLessThan(3)
  })

  test('closes shapes by hand instead of with Z', () => {
    expect(pencil('M0 0 L10 0 L10 10 Z')).not.toContain('Z')
  })
})
