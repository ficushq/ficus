import { routeTo, type TilePoint } from './plantingRoute'
import type { FarmLayout, RobotPlacement, YardLayout } from './types'

/*
 * Robots walk: when one starts on a work stream it walks out of its squad's
 * charging hut to the plant, when it stops it walks back in, and when work is
 * handed over it walks from one plant to the next. This is the pure part:
 * where each robot is, what changed between two layouts, and the path each
 * walk takes. RobotWalkers.tsx draws it.
 */

/** A robot standing somewhere on the farm (farmers and the robots tending plants; the hut and stand draw their own). */
export interface RobotSpot {
  placement: RobotPlacement
  at: TilePoint
  yard: YardLayout
  /** What it's doing there; the same job in a reflowed layout isn't a move. */
  job: string
}

export interface RobotMove {
  agentId: string
  /** How it looks on the way (where it's going, or where it was when it's leaving). */
  placement: RobotPlacement
  path: TilePoint[]
  /** Arriving from the hut, moving between jobs, or going back to rest. */
  kind: 'arrive' | 'move' | 'leave'
}

/** Every robot standing on the farm, by agent id. */
export function robotSpots(layout: FarmLayout): Map<string, RobotSpot> {
  const spots = new Map<string, RobotSpot>()
  for (const yard of layout.yards) {
    if (yard.farmer)
      spots.set(yard.farmer.agent.id, {
        placement: yard.farmer,
        at: [yard.farmer.i, yard.farmer.j],
        yard,
        job: `${yard.squad.id}:farmer`,
      })
    for (const plot of yard.plots)
      if (plot.tender)
        spots.set(plot.tender.agent.id, {
          placement: plot.tender,
          at: [plot.tender.i, plot.tender.j],
          yard,
          job: `${yard.squad.id}:plot:${plot.stream.id}`,
        })
  }
  return spots
}

/** Just outside a yard's charging hut door, where robots come and go. */
export function hutDoor(yard: YardLayout): TilePoint {
  return [yard.dock.i - 0.3, yard.dock.j + 1]
}

/** Just outside a yard's consulting stand, for consultants. */
function standFront(yard: YardLayout): TilePoint {
  return [yard.stand.i + 0.4, yard.stand.j + 0.9]
}

/** Where a robot comes from when it starts, or goes when it stops: consultants use the stand, the rest the hut. */
function home(placement: RobotPlacement, yard: YardLayout): TilePoint {
  return placement.role === 'consultant' ? standFront(yard) : hutDoor(yard)
}

function inside(yard: YardLayout, [i, j]: TilePoint): boolean {
  return i > yard.i0 && i < yard.i0 + yard.w && j > yard.j0 && j < yard.j0 + yard.h
}

function yardAt(layout: FarmLayout, point: TilePoint): YardLayout | null {
  return layout.yards.find((yard) => inside(yard, point)) ?? null
}

/**
 * A walk from one point to another: out of a yard through its gate (and round
 * its front corner if the way lies beside it), then in through the next yard's
 * gate. Within one yard, straight there.
 */
export function walkBetween(layout: FarmLayout, from: TilePoint, to: TilePoint): TilePoint[] {
  const a = yardAt(layout, from)
  const b = yardAt(layout, to)
  if (a && a === b) return [from, to]
  const path: TilePoint[] = [from]
  if (a) {
    const gateI = a.i0 + a.w / 2
    const front = a.j0 + a.h
    path.push([gateI, front - 0.4], [gateI, front + 0.6])
    // Heading somewhere beside this yard (its hut, its stand): round the near front corner.
    if (!b && to[1] < front) path.push(to[0] < gateI ? [a.i0 - 0.6, front + 0.6] : [a.i0 + a.w + 0.6, front + 0.6])
  }
  if (b) return [...path, ...routeTo(b, path[path.length - 1]!, to).slice(1)]
  path.push(to)
  return path
}

/** A point in `prev`'s farm, where it is now: yards shift when squads come and go. */
function carried(point: TilePoint, yard: YardLayout, next: FarmLayout): TilePoint {
  const now = next.yards.find((y) => y.squad.id === yard.squad.id)
  return now ? [point[0] + now.i0 - yard.i0, point[1] + now.j0 - yard.j0] : point
}

const moved = (a: TilePoint, b: TilePoint) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05

/**
 * The walks between two layouts. `current` says where a robot already walking
 * is right now, so a new walk starts from there. The first layout has none, and
 * a robot doing the same job in a reflowed farm (a squad was added) doesn't walk.
 */
export function robotMoves(
  prev: FarmLayout | null,
  next: FarmLayout,
  current: ReadonlyMap<string, TilePoint> = new Map()
): RobotMove[] {
  if (!prev) return []
  const before = robotSpots(prev)
  const after = robotSpots(next)
  const moves: RobotMove[] = []
  for (const [agentId, spot] of after) {
    const was = before.get(agentId)
    if (was && was.job === spot.job && !current.has(agentId)) continue
    const from = current.get(agentId) ?? (was ? carried(was.at, was.yard, next) : home(spot.placement, spot.yard))
    if (!moved(from, spot.at)) continue
    moves.push({
      agentId,
      placement: spot.placement,
      path: walkBetween(next, from, spot.at),
      kind: was ? 'move' : 'arrive',
    })
  }
  for (const [agentId, was] of before) {
    if (after.has(agentId)) continue
    // Back to its squad's hut (or stand) in the new layout, if the squad's still there.
    const yard = next.yards.find((y) => y.squad.id === was.yard.squad.id)
    if (!yard) continue
    const from = current.get(agentId) ?? carried(was.at, was.yard, next)
    moves.push({
      agentId,
      placement: was.placement,
      path: walkBetween(next, from, home(was.placement, yard)),
      kind: 'leave',
    })
  }
  return moves
}

/** Walking speed, tiles per second; long walks go faster, so none takes more than MAX_WALK_S. */
export const WALK_SPEED = 2.4
export const MAX_WALK_S = 6

export function walkSpeed(length: number): number {
  return Math.max(WALK_SPEED, length / MAX_WALK_S)
}
