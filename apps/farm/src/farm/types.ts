import type { Agent, Squad, WorkStream } from '@ficus/shared'
import type { FarmApp } from './apps'

/**
 * What a work stream's plant looks like. Done and canceled streams are not
 * plants; they are counted into the harvest crates and the compost heap.
 */
export type PlantState =
  | 'queued' // seed stake
  | 'growing' // young plant, sways
  | 'question' // young plant + "?" badge
  | 'review' // ripe, glowing produce + basket badge
  | 'delivering' // ripe, handed to the code host (PR open): an hourglass hovers over it
  | 'blocked' // choked by weeds + "!" badge
  | 'paused' // under a glass cloche
  | 'waiting' // small plant: waiting on another work stream
  | 'idle' // withered
  | 'failed' // withered + crow

/** The only badges; shown only when the human can act. */
export type BadgeKind = 'question' | 'blocked' | 'harvest'

/** Robot screen faces, driven by agent status. */
export type RobotFace = 'happy' | 'normal' | 'question' | 'sleepy' | 'error'

export type RobotRole = 'manager' | 'consultant' | 'assistant' | 'worker'

/** A robot standing somewhere on the farm. i/j may be fractional. */
export interface RobotPlacement {
  agent: Agent
  role: RobotRole
  i: number
  j: number
  face: RobotFace
  /** Live subagents of this agent (drawn as one helper drone with a count). */
  helpers: number
  /** Which way the robot looks on screen: toward the plant it tends, otherwise the default right. */
  facing: 'left' | 'right'
  /** It has a question open for you, blocking or not: a "?" floats over it. */
  asking: boolean
}

export interface PlotLayout {
  stream: WorkStream
  i: number
  j: number
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
  /** Those of them with a question open for you (the consulting stand wears a "?"). */
  asking?: string[]
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
  /** The consulting stand: `ids` has every consultant chat started for the squad; one stands behind the counter. */
  stand: CrowdSpot
  /** The server rack by the yard's back-left corner, while the squad has apps to open. */
  rack: { i: number; j: number; apps: FarmApp[] } | null
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
