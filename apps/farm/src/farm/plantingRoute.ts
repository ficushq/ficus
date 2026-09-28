import type { FarmLayout, PlotLayout, RobotPlacement, YardLayout } from './types'

/*
 * Planting: when a new work stream appears on the farm, the robot that
 * created it (the squad's farmer, or a consultant from the stand) walks over
 * and plants it. This file is the pure part: spotting new plots and planning
 * the walk. Planting.tsx draws it.
 */

export type TilePoint = readonly [i: number, j: number]

export interface Planting {
  streamId: string
  /** The robot doing the planting, where it normally stands. */
  planter: RobotPlacement
  /** Where it walks, from its spot to the plant (it walks the same way back). */
  path: TilePoint[]
}

/** Plots in `next` whose streams weren't on the farm in `prev` (none on the first layout). */
export function newPlots(prev: FarmLayout | null, next: FarmLayout): Array<{ plot: PlotLayout; yard: YardLayout }> {
  if (!prev) return []
  const before = new Set(prev.yards.flatMap((yard) => yard.plots.map((plot) => plot.stream.id)))
  return next.yards.flatMap((yard) =>
    yard.plots.filter((plot) => !before.has(plot.stream.id)).map((plot) => ({ plot, yard }))
  )
}

/** Every robot drawn in a yard, by agent id. */
function robotsIn(yard: YardLayout): Map<string, RobotPlacement> {
  const robots = new Map<string, RobotPlacement>()
  const add = (robot: RobotPlacement | null | undefined) => robot && robots.set(robot.agent.id, robot)
  add(yard.farmer)
  yard.stand.robots.forEach(add)
  yard.dock.robots.forEach(add)
  yard.plots.forEach((plot) => add(plot.tender))
  return robots
}

/** Where a robot stands to tend a plot (as layout.ts places tenders): just off the soil's right side. */
export const tendingSpot = (plot: PlotLayout): TilePoint => [plot.i + 1.1, plot.j + 0.7]

/**
 * The walk from a robot's spot to a plot: out to the front of the yard (round
 * a corner if it starts beside it), in through the gate, over to the plant.
 * A robot already inside the yard walks straight there.
 */
export function routeTo(yard: YardLayout, from: TilePoint, to: TilePoint): TilePoint[] {
  const { i0, j0, w, h } = yard
  const inside = from[0] > i0 && from[0] < i0 + w && from[1] > j0 && from[1] < j0 + h
  if (inside) return [from, to]
  const gateI = i0 + w / 2
  const front = j0 + h
  const path: TilePoint[] = [from]
  // Beside the yard, not in front of it: round the nearest front corner first.
  if (from[1] < front) path.push(from[0] < i0 + w / 2 ? [i0 - 0.6, front + 0.6] : [i0 + w + 0.6, front + 0.6])
  path.push([gateI, front + 0.6], [gateI, front - 0.4], to)
  return path
}

/**
 * Who plants a new plot, and how they get there: the robot that created the
 * stream if it's on the farm, otherwise the squad's farmer; null when nobody
 * is around (the plant just appears).
 */
export function plantingFor(plot: PlotLayout, yard: YardLayout): Planting | null {
  const robots = robotsIn(yard)
  const creator = plot.stream.creatorAgentId ? robots.get(plot.stream.creatorAgentId) : undefined
  const planter = creator ?? yard.farmer
  if (!planter) return null
  return { streamId: plot.stream.id, planter, path: routeTo(yard, [planter.i, planter.j], tendingSpot(plot)) }
}

/** Length of a path, in tiles. */
export function pathLength(path: readonly TilePoint[]): number {
  let total = 0
  for (let k = 1; k < path.length; k++)
    total += Math.hypot(path[k]![0] - path[k - 1]![0], path[k]![1] - path[k - 1]![1])
  return total
}

/** The point `distance` tiles along a path, and which segment it's on. */
export function along(path: readonly TilePoint[], distance: number): { at: TilePoint; segment: number } {
  let left = Math.max(0, distance)
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!
    const b = path[k]!
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (left <= length || k === path.length - 1) {
      const t = length ? Math.min(1, left / length) : 1
      return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], segment: k - 1 }
    }
    left -= length
  }
  return { at: path[path.length - 1] ?? [0, 0], segment: 0 }
}
