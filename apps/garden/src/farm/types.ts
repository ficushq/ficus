import type { Agent, Squad, WorkStream } from '@ficus/shared'

/** Crops vary by work stream (stable per id) so a yard isn't a field of clones. */
export type CropKind = 'tomato' | 'sunflower' | 'pumpkin'

/**
 * What a work stream's plant looks like. Done and canceled streams are not
 * plants; they are counted into the harvest crates and the compost heap.
 */
export type PlantState =
  | 'queued' // seed stake
  | 'growing' // young plant, sways
  | 'question' // young plant + "?" badge
  | 'review' // ripe, glowing produce + basket badge
  | 'blocked' // choked by weeds + "!" badge
  | 'paused' // under a glass cloche
  | 'waiting' // small plant: waiting on another work stream
  | 'idle' // withered
  | 'failed' // withered + crow

/** The only badges; shown only when the human can act. */
export type BadgeKind = 'question' | 'blocked' | 'harvest' | 'news'

/** Robot screen faces, driven by agent status. */
export type RobotFace = 'happy' | 'normal' | 'question' | 'sleepy' | 'error'

export type RobotRole = 'manager' | 'consultant' | 'assistant' | 'worker'

export type RobotHead = 'round' | 'box' | 'dome'
export type RobotMove = 'wheel' | 'treads' | 'hover' | 'legs'
export type RobotAntenna = 'sprout' | 'bulb' | 'twin' | 'none'
export type RobotHat = 'straw' | 'sun' | 'cap' | 'bandana' | 'beanie' | 'bucket'
export type RobotOutfit = 'overalls' | 'apron'
export type RobotProp = 'can' | 'clip' | 'hoe'

/** Everything that makes one robot look like itself. Stable per agent id. */
export interface RobotLook {
  shell: string
  panel: string
  glow: string
  head: RobotHead
  move: RobotMove
  antenna: RobotAntenna
  hat: RobotHat | null
  hatColor: string
  outfit: RobotOutfit | null
  outfitColor: string
  scarf: string | null
}

/** A robot standing somewhere on the farm. i/j may be fractional. */
export interface RobotPlacement {
  agent: Agent
  role: RobotRole
  i: number
  j: number
  look: RobotLook
  face: RobotFace
  prop: RobotProp | null
  /** Live subagents of this agent (drawn as one helper drone with a count). */
  helpers: number
}

export interface PlotLayout {
  stream: WorkStream
  i: number
  j: number
  crop: CropKind
  state: PlantState
  badge: BadgeKind | null
  /** The one robot drawn at this plant (the most relevant running participant). */
  tender: RobotPlacement | null
  /** Other running participants, shown as a "+N" tag on the tender. */
  extraTenders: number
}

export interface CrowdSpot {
  i: number
  j: number
  robots: RobotPlacement[]
  /** Robots that belong here but aren't drawn (shown as "+N"). */
  overflow: number
  /** Everyone at this spot, drawn or not (the charging hut lists them). */
  ids?: string[]
}

export interface YardLayout {
  squad: Squad
  /** Fenced rectangle, in tiles. */
  i0: number
  j0: number
  w: number
  h: number
  plots: PlotLayout[]
  /** Sign by the front gate. */
  sign: { i: number; j: number }
  /** The squad manager, standing outside the gate. */
  farmer: RobotPlacement | null
  /**
   * The charging hut at the yard's back corner, where idle workers rest. Only
   * the first is placed (it peeks out of the doorway); `ids` has them all.
   */
  dock: CrowdSpot
  /** Recent consultants on the bench. */
  bench: CrowdSpot
  needsYou: number
}

export type DecorKind = 'tree' | 'fruitTree' | 'bush' | 'flowers' | 'hay'

export interface DecorPlacement {
  kind: DecorKind
  i: number
  j: number
  /** Deterministic variety seed (colour, scale). */
  seed: number
}

export interface FarmLayout {
  /** Tile extent of everything placed (for the camera and the grass). */
  bounds: { minI: number; maxI: number; minJ: number; maxJ: number }
  yards: YardLayout[]
  farmhouse: { i: number; j: number }
  seedShed: { i: number; j: number }
  mailbox: { i: number; j: number }
  crates: { i: number; j: number; count: number }
  compost: { i: number; j: number; count: number }
  /** Assistant robots on the farmhouse porch, outside every yard. */
  porch: CrowdSpot
  decor: DecorPlacement[]
}
