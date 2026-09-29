import type { Agent, PresenceFocus } from '@ficus/shared'
import type { ChatTarget } from '../farm/cards/ChatSlot'
import { findPlot, findRobot } from '../farm/find'
import type { TilePoint } from '../farm/plantingRoute'
import type { Selection } from '../farm/selection'
import type { FarmLayout, YardLayout } from '../farm/types'

/*
 * Where people stand on the farm. You're "at" what you're working on: the
 * robot you're chatting with (the frontmost chat wins), else the card you have
 * open. Everyone else is drawn at their focus: beside that robot, at the edge
 * of that plant's bed, by that squad's sign, or around the farmhouse.
 */

/** What you're focused on, for others to see: your frontmost chat, else your open card. */
export function focusFor(selection: Selection | null, frontChat: ChatTarget | undefined): PresenceFocus | null {
  if (frontChat?.kind === 'agent') return { kind: 'agent', agentId: frontChat.agentId }
  if (frontChat?.kind === 'consultant') return { kind: 'squad', squadId: frontChat.squadId, at: 'stand' }
  // An Assistant conversation is private: you're simply around the farm.
  if (frontChat?.kind === 'assistant') return null
  switch (selection?.kind) {
    case 'plot':
      return { kind: 'workstream', workstreamId: selection.streamId }
    case 'robot':
      return { kind: 'agent', agentId: selection.agentId }
    case 'stand':
      return { kind: 'squad', squadId: selection.squadId, at: 'stand' }
    case 'yard':
    case 'hut':
    case 'rack':
      return { kind: 'squad', squadId: selection.squadId }
    default:
      return null
  }
}

export interface Spot {
  at: TilePoint
  facing: 'left' | 'right'
  /** The yard the spot is in (people walk in through its gate), if any. */
  yard: YardLayout | null
}

const yardOf = (layout: FarmLayout, squadId: string | null | undefined) =>
  squadId ? (layout.yards.find((yard) => yard.squad.id === squadId) ?? null) : null

/** By a yard's sign, just outside the gate, looking in. */
function bySign(yard: YardLayout): Spot {
  return { at: [yard.sign.i - 0.9, yard.sign.j + 0.45], facing: 'right', yard: null }
}

/** At a yard's consulting stand, in front of the counter, looking at it. */
function atStand(yard: YardLayout): Spot {
  return { at: [yard.stand.i + 0.55, yard.stand.j + 1.05], facing: 'left', yard: null }
}

/** Around the farmhouse: where people with nothing (visible) on stand. */
function aroundTheFarm(layout: FarmLayout): Spot {
  return { at: [layout.porch.i - 0.2, layout.porch.j + 1.7], facing: 'right', yard: null }
}

/** Where someone with this focus stands. */
export function spotFor(layout: FarmLayout, focus: PresenceFocus | null, agents: ReadonlyMap<string, Agent>): Spot {
  if (!focus) return aroundTheFarm(layout)
  switch (focus.kind) {
    case 'agent': {
      // A consultant (behind its squad's counter, or one of the chats its stand lists): at the stand.
      const standing = layout.yards.find((y) => y.stand.ids?.includes(focus.agentId))
      if (standing) return atStand(standing)
      const robot = findRobot(layout, focus.agentId)
      if (robot) {
        const yard = layout.yards.find((y) => y.plots.some((p) => p.tender?.agent.id === focus.agentId)) ?? null
        // Just left of the robot, turned to face it.
        return { at: [robot.i - 0.55, robot.j + 0.3], facing: 'right', yard }
      }
      // A robot that isn't out on the field (resting, asleep): by its squad's sign.
      const yard = yardOf(layout, agents.get(focus.agentId)?.squadId)
      return yard ? bySign(yard) : aroundTheFarm(layout)
    }
    case 'workstream': {
      const plot = findPlot(layout, focus.workstreamId)
      if (!plot) return aroundTheFarm(layout)
      const yard = layout.yards.find((y) => y.plots.some((p) => p.stream.id === focus.workstreamId)) ?? null
      // At the left edge of the bed (tenders stand on the right).
      return { at: [plot.i - 0.1, plot.j + 0.55], facing: 'right', yard }
    }
    case 'squad': {
      const yard = yardOf(layout, focus.squadId)
      if (!yard) return aroundTheFarm(layout)
      return focus.at === 'stand' ? atStand(yard) : bySign(yard)
    }
  }
}

/** Spreads people who'd stand on the same spot into a little huddle. */
export function huddle(spots: Array<{ key: string; spot: Spot }>): Map<string, Spot> {
  const seen = new Map<string, number>()
  const placed = new Map<string, Spot>()
  for (const { key, spot } of spots) {
    const id = `${spot.at[0].toFixed(2)}:${spot.at[1].toFixed(2)}`
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    // Side by side along the screen (each step is about a person's width), then a row behind.
    const offsets: TilePoint[] = [
      [0, 0],
      [-0.55, 0.55],
      [0.55, -0.55],
      [-1.1, 1.1],
      [0.55, 0.55],
      [-0.55, 1.65],
    ]
    const [di, dj] = offsets[n % offsets.length]!
    const ring = Math.floor(n / offsets.length) * 0.25
    placed.set(key, { ...spot, at: [spot.at[0] + di - ring, spot.at[1] + dj + ring] })
  }
  return placed
}
