import { describe, expect, it } from 'bun:test'
import { layoutFarm, type FarmInput } from '../farm/layout'
import { at, makeAgent, makeSquad, makeStream } from '../farm/testFixtures'
import { focusFor, huddle, spotFor } from './spots'

const squad = makeSquad({ id: 'sq', name: 'Garden', managerAgentId: 'boss' })
const boss = makeAgent({ id: 'boss', squadId: 'sq', agentTypeId: 'manager', status: 'active' })
const resting = makeAgent({ id: 'rest', squadId: 'sq', status: 'idle' })
// Two consultant chats: one behind the stand's counter, one only on its card.
const consultants = ['c1', 'c2'].map((id) =>
  makeAgent({ id, squadId: 'sq', agentTypeId: 'consultant', status: 'idle' })
)
const input: FarmInput = {
  squads: [squad],
  streams: [makeStream({ id: 'ws', squadId: 'sq' })],
  doneCount: 0,
  canceledCount: 0,
  agents: [boss, resting, ...consultants],
  assistants: [],
  pendingActions: [],
  now: at(60 * 24 * 10).getTime(),
}
const layout = layoutFarm(input)
const agents = new Map([boss, resting, ...consultants].map((agent) => [agent.id, agent]))
const yard = layout.yards[0]!

describe('focusFor', () => {
  it('follows your frontmost chat first', () => {
    expect(focusFor({ kind: 'plot', streamId: 'ws' }, { kind: 'agent', agentId: 'boss' })).toEqual({
      kind: 'agent',
      agentId: 'boss',
    })
    expect(focusFor(null, { kind: 'consultant', squadId: 'sq' })).toEqual({ kind: 'squad', squadId: 'sq', at: 'stand' })
  })

  it('keeps Assistant chats private: you are around the farm', () => {
    expect(focusFor({ kind: 'plot', streamId: 'ws' }, { kind: 'assistant', conversationId: 'c' })).toBeNull()
  })

  it('else follows your open card', () => {
    expect(focusFor({ kind: 'plot', streamId: 'ws' }, undefined)).toEqual({ kind: 'workstream', workstreamId: 'ws' })
    expect(focusFor({ kind: 'robot', agentId: 'boss' }, undefined)).toEqual({ kind: 'agent', agentId: 'boss' })
    for (const kind of ['yard', 'hut', 'rack'] as const)
      expect(focusFor({ kind, squadId: 'sq' }, undefined)).toEqual({ kind: 'squad', squadId: 'sq' })
    // The consulting stand's card: at the stand, not the gate.
    expect(focusFor({ kind: 'stand', squadId: 'sq' }, undefined)).toEqual({ kind: 'squad', squadId: 'sq', at: 'stand' })
    expect(focusFor({ kind: 'mailbox' }, undefined)).toBeNull()
    expect(focusFor(null, undefined)).toBeNull()
  })
})

describe('spotFor', () => {
  it('stands beside a robot on the field, turned to face it', () => {
    const spot = spotFor(layout, { kind: 'agent', agentId: 'boss' }, agents)
    expect(spot.at).toEqual([yard.farmer!.i - 0.55, yard.farmer!.j + 0.3])
    expect(spot.facing).toBe('right')
  })

  it("stands by the squad's sign for a robot that isn't out, or for the squad", () => {
    const bySign = [yard.sign.i - 0.9, yard.sign.j + 0.45] as const
    expect(spotFor(layout, { kind: 'agent', agentId: 'rest' }, agents).at).toEqual(bySign)
    expect(spotFor(layout, { kind: 'squad', squadId: 'sq' }, agents).at).toEqual(bySign)
  })

  it('stands in front of the consulting stand for the stand, or a consultant chat', () => {
    const front = [yard.stand.i + 0.55, yard.stand.j + 1.05] as const
    expect(spotFor(layout, { kind: 'squad', squadId: 'sq', at: 'stand' }, agents).at).toEqual(front)
    expect([...(yard.stand.ids ?? [])].sort()).toEqual(['c1', 'c2'])
    for (const agentId of yard.stand.ids ?? [])
      expect(spotFor(layout, { kind: 'agent', agentId }, agents).at).toEqual(front)
  })

  it("stands at the edge of a plant's bed, inside its yard", () => {
    const plot = yard.plots[0]!
    const spot = spotFor(layout, { kind: 'workstream', workstreamId: 'ws' }, agents)
    expect(spot.at).toEqual([plot.i - 0.1, plot.j + 0.55])
    expect(spot.yard?.squad.id).toBe('sq')
  })

  it('is around the farmhouse with no focus, or one that is gone', () => {
    const around = [layout.porch.i - 0.2, layout.porch.j + 1.7] as const
    expect(spotFor(layout, null, agents).at).toEqual(around)
    expect(spotFor(layout, { kind: 'workstream', workstreamId: 'gone' }, agents).at).toEqual(around)
    expect(spotFor(layout, { kind: 'agent', agentId: 'gone' }, agents).at).toEqual(around)
  })
})

describe('huddle', () => {
  it('spreads people on one spot and leaves a lone person where they are', () => {
    const spot = spotFor(layout, null, agents)
    const placed = huddle([
      { key: 'a', spot },
      { key: 'b', spot },
      { key: 'c', spot: spotFor(layout, { kind: 'squad', squadId: 'sq' }, agents) },
    ])
    expect(placed.get('a')!.at).toEqual(spot.at)
    expect(placed.get('b')!.at).not.toEqual(spot.at)
    expect(placed.get('c')!.at).toEqual([yard.sign.i - 0.9, yard.sign.j + 0.45])
  })
})
