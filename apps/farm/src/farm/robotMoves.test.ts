import { describe, expect, it } from 'bun:test'
import type { Agent } from '@ficus/shared'
import { layoutFarm, type FarmInput } from './layout'
import { tendingSpot } from './plantingRoute'
import { hutDoor, robotMoves, walkBetween } from './robotMoves'
import { makeAgent, makeSquad, makeStream } from './testFixtures'

const squad = makeSquad({ id: 'sq', name: 'Platform', managerAgentId: 'boss' })
const boss = makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' })
const worker = (id: string, status: Agent['status'] = 'active') => makeAgent({ id, squadId: 'sq', status })

function farm(agents: Agent[], agentIds: string[], extra: Partial<FarmInput> = {}): FarmInput {
  return {
    squads: [squad],
    streams: [makeStream({ id: 'ws', squadId: 'sq', agentIds })],
    doneCount: 0,
    canceledCount: 0,
    agents: [boss, ...agents],
    assistants: [],
    pendingActions: [],
    ...extra,
  }
}

describe('robots walking between jobs', () => {
  it('has nobody walk on the first look at the farm', () => {
    expect(robotMoves(null, layoutFarm(farm([worker('w')], ['w'])))).toEqual([])
  })

  it('walks a robot starting work out of the hut, through the gate, to its plant', () => {
    const before = layoutFarm(farm([worker('w', 'idle')], ['w']))
    const after = layoutFarm(farm([worker('w')], ['w']))
    const [move, ...rest] = robotMoves(before, after)
    expect(rest).toEqual([])
    const yard = after.yards[0]!
    expect(move).toMatchObject({ agentId: 'w', kind: 'arrive' })
    expect(move!.path[0]).toEqual(hutDoor(yard))
    expect(move!.path.at(-1)).toEqual(tendingSpot(yard.plots[0]!))
    // In through the front gate, not over the fence.
    expect(move!.path.some(([i, j]) => i === yard.i0 + yard.w / 2 && j > yard.j0 + yard.h)).toBe(true)
  })

  it('walks a robot that stops back to the hut, and hands work over plant to robot', () => {
    const working = layoutFarm(farm([worker('a'), worker('b', 'idle')], ['a']))
    const resting = layoutFarm(farm([worker('a', 'idle'), worker('b', 'idle')], ['a']))
    const [leave] = robotMoves(working, resting)
    expect(leave).toMatchObject({ agentId: 'a', kind: 'leave' })
    expect(leave!.path.at(-1)).toEqual(hutDoor(resting.yards[0]!))

    const handedOver = layoutFarm(farm([worker('a', 'idle'), worker('b')], ['b']))
    const moves = robotMoves(working, handedOver)
    expect(moves.map((m) => [m.agentId, m.kind]).sort()).toEqual([
      ['a', 'leave'],
      ['b', 'arrive'],
    ])
  })

  it("doesn't walk anyone when the farm just reflows, and continues walks from where robots are", () => {
    const one = layoutFarm(farm([worker('w')], ['w']))
    const other = makeSquad({ id: 'aa', name: 'Another', managerAgentId: null })
    const two = layoutFarm(farm([worker('w')], ['w'], { squads: [other, squad] }))
    expect(robotMoves(one, two)).toEqual([])

    // Mid-walk, a new layout sends it on from where it is now.
    const midway: [number, number] = [0, 0]
    const [move] = robotMoves(one, one, new Map([['w', midway]]))
    expect(move!.path[0]).toEqual(midway)
  })

  it('walks straight across a yard, and out through the gate to go beside it', () => {
    const layout = layoutFarm(farm([worker('w')], ['w']))
    const yard = layout.yards[0]!
    const a: [number, number] = [yard.i0 + 0.5, yard.j0 + 0.5]
    const b: [number, number] = [yard.i0 + 1.5, yard.j0 + 1]
    expect(walkBetween(layout, a, b)).toEqual([a, b])
    const out = walkBetween(layout, a, hutDoor(yard))
    expect(out[1]).toEqual([yard.i0 + yard.w / 2, yard.j0 + yard.h - 0.4])
    expect(out.at(-1)).toEqual(hutDoor(yard))
  })
})
