import type { FarmLayout } from '../farm/types'
import type { Chime } from './chimes'

export interface FarmTally {
  badges: number
  plots: number
  harvested: number
}

export function tallyFarm(layout: FarmLayout, needsYou: number): FarmTally {
  let plots = 0
  for (const yard of layout.yards) plots += yard.plots.length
  return { badges: needsYou, plots, harvested: layout.crates.count }
}

/** Which chime (if any) a change between two farm snapshots deserves; one at a time, most important first. */
export function chimeFor(before: FarmTally | null, after: FarmTally): Chime | null {
  if (!before) return null
  if (after.badges > before.badges) return 'needsYou'
  if (after.harvested > before.harvested) return 'harvested'
  if (after.plots > before.plots) return 'planted'
  return null
}
