import { describe, expect, it } from 'bun:test'
import { layoutFarm, type FarmInput } from './layout'
import { along, newPlots, pathLength, plantingFor, routeTo, tendingSpot } from './plantingRoute'
import { at, makeAgent, makeSquad, makeStream } from './testFixtures'

const NOW = at(60 * 24 * 10).getTime()
const squad = makeSquad({ id: 'sq', name: 'Farm', managerAgentId: 'boss' })
const boss = makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' })
const consultant = makeAgent({ id: 'con', squadId: 'sq', agentTypeId: 'consultant', status: 'active' })

function farm(overrides: Partial<FarmInput> = {}): FarmInput {
  return {
    squads: [squad],
    streams: [],
    doneCount: 0,
    canceledCount: 0,
    agents: [boss, consultant],
    assistants: [],
    pendingActions: [],
    now: NOW,
    ...overrides,
  }
}

describe('newPlots', () => {
  it('finds only streams that just appeared, and none on the first layout', () => {
    const before = layoutFarm(farm({ streams: [makeStream({ id: 'old', squadId: 'sq' })] }))
    const after = layoutFarm(
      farm({ streams: [makeStream({ id: 'old', squadId: 'sq' }), makeStream({ id: 'new', squadId: 'sq' })] })
    )
    expect(newPlots(null, after)).toEqual([])
    expect(newPlots(before, after).map(({ plot }) => plot.stream.id)).toEqual(['new'])
    expect(newPlots(after, after)).toEqual([])
  })
})

describe('plantingFor', () => {
  const plant = (creatorAgentId: string | null) => {
    const layout = layoutFarm(farm({ streams: [makeStream({ id: 'new', squadId: 'sq', creatorAgentId })] }))
    const yard = layout.yards[0]!
    return { planting: plantingFor(yard.plots[0]!, yard), yard }
  }

  it('sends the robot that created the stream', () => {
    expect(plant('con').planting?.planter.agent.id).toBe('con')
    expect(plant('boss').planting?.planter.agent.id).toBe('boss')
  })

  it("falls back to the squad's farmer when the creator isn't on the farm (or a person made it)", () => {
    expect(plant('someone-else').planting?.planter.agent.id).toBe('boss')
    expect(plant(null).planting?.planter.agent.id).toBe('boss')
  })

  it('has nobody plant when the squad has no farmer awake and the creator is away', () => {
    const layout = layoutFarm(farm({ agents: [], streams: [makeStream({ id: 'new', squadId: 'sq' })] }))
    const yard = layout.yards[0]!
    expect(plantingFor(yard.plots[0]!, yard)).toBeNull()
  })

  it('walks from the planter to where tenders stand beside the plant', () => {
    const { planting, yard } = plant('con')
    const path = planting!.path
    expect(path[0]).toEqual([planting!.planter.i, planting!.planter.j])
    expect(path.at(-1)).toEqual(tendingSpot(yard.plots[0]!))
  })
})

describe('routeTo', () => {
  const yard = { i0: 0, j0: 0, w: 6, h: 3 } as Parameters<typeof routeTo>[0]

  it('comes in through the gate, rounding the front corner from beside the yard', () => {
    const path = routeTo(yard, [-1.25, 2.2], [2.1, 0.95])
    expect(path).toEqual([
      [-1.25, 2.2],
      [-0.6, 3.6],
      [3, 3.6],
      [3, 2.6],
      [2.1, 0.95],
    ])
  })

  it('goes straight to the gate from in front of the yard, and straight to the plant from inside it', () => {
    expect(routeTo(yard, [4.2, 3.55], [1, 1])).toEqual([
      [4.2, 3.55],
      [3, 3.6],
      [3, 2.6],
      [1, 1],
    ])
    expect(routeTo(yard, [2, 2], [1, 1])).toEqual([
      [2, 2],
      [1, 1],
    ])
  })
})

describe('along', () => {
  const path = [
    [0, 0],
    [3, 0],
    [3, 4],
  ] as const

  it('measures and walks a path', () => {
    expect(pathLength(path)).toBe(7)
    expect(along(path, 0)).toEqual({ at: [0, 0], segment: 0 })
    expect(along(path, 1.5)).toEqual({ at: [1.5, 0], segment: 0 })
    expect(along(path, 5)).toEqual({ at: [3, 2], segment: 1 })
    expect(along(path, 99)).toEqual({ at: [3, 4], segment: 1 })
  })
})
