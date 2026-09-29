import type { TilePoint } from '../farm/plantingRoute'
import type { FarmhouseDoor } from '../skins/types'

/*
 * People come onto the farm through the farmhouse's front door and leave the
 * same way: out of the doorway, across the porch and down its steps (or back
 * up them and in). The door and porch come from the skin; the house is where
 * the layout put it.
 */

/** How far inside the door a walk starts (or ends), so people step through it rather than off the wall. */
const INSIDE = 0.15
/** How far past the foot of the steps the doorway ends, where the rest of the walk picks up. */
const PAST_STEPS = 0.35
/** Over how many tiles of the doorway people fade in (coming out) or out (going in). */
export const FADE_TILES = 0.45

/** From just inside the door, straight out across the porch, to just past the foot of the steps. */
export function doorwayOut(house: TilePoint, door: FarmhouseDoor): TilePoint[] {
  const i = house[0] + door.i
  return [
    [i, house[1] + door.j - INSIDE],
    [i, house[1] + Math.max(door.j, door.steps[1]) + PAST_STEPS],
  ]
}

/** How high (px) someone standing here is: up on the porch floor in front of the door, stepping down to the ground. */
export function porchLift(house: TilePoint, door: FarmhouseDoor, [i, j]: TilePoint): number {
  if (!door.floor || Math.abs(i - (house[0] + door.i)) > 0.5) return 0
  const out = j - house[1]
  if (out < door.j - INSIDE - 0.01 || out >= door.steps[1]) return 0
  if (out <= door.steps[0]) return door.floor
  return (door.floor * (door.steps[1] - out)) / (door.steps[1] - door.steps[0])
}
