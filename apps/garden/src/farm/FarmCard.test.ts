import { describe, expect, it } from 'bun:test'
import { iso } from './iso'
import { selectionAnchor } from './FarmCard'
import type { FarmLayout } from './types'

const layout = {
  yards: [
    {
      squad: { id: 'sq' },
      plots: [],
      farmer: null,
      bench: { i: 0, j: 0, robots: [], overflow: 0 },
      dock: { i: 7, j: 2, robots: [], overflow: 0, ids: ['resting'] },
      sign: { i: 3, j: 5 },
    },
  ],
  porch: { i: 0, j: 0, robots: [], overflow: 0 },
} as unknown as FarmLayout

describe('selectionAnchor', () => {
  it('opens a resting robot’s card by its charging hut', () => {
    expect(selectionAnchor(layout, { kind: 'robot', agentId: 'resting' })).toEqual(iso(7, 2))
  })

  it('has no spot for a robot that is nowhere on the farm', () => {
    expect(selectionAnchor(layout, { kind: 'robot', agentId: 'gone' })).toBeNull()
  })
})
