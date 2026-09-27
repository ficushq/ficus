import type {
  Agent,
  AgentErrorActionData,
  AssistantActivityPage,
  PendingAction,
  Squad,
  WorkStream,
} from '@ficus/shared'
import { cropFor, hash, propFor, robotLookFor, roleFor } from './appearance'
import { badgeFor, faceFor, haltedAgentIds, isAsleep, isRunning, plantStateFor } from './state'
import type {
  CrowdSpot,
  DecorKind,
  DecorPlacement,
  FarmLayout,
  PlotLayout,
  RobotPlacement,
  RobotRole,
  YardLayout,
} from './types'

export interface FarmInput {
  /** Active squads. */
  squads: Squad[]
  /** Live streams (queued + active) across squads. Done/canceled streams here are ignored. */
  streams: WorkStream[]
  /** For the harvest crates. */
  doneCount: number
  /** For the compost heap. */
  canceledCount: number
  /** Agents across all squads (managers, consultants, workers, subagents). */
  agents: Agent[]
  /** The user's assistant agents (porch). */
  assistants: Agent[]
  /** Recent Assistant conversations and what's waiting in them (the porch robot's card). */
  assistantActivity?: AssistantActivityPage
  /** For halted detection and needs-you counts. */
  pendingActions: PendingAction[]
  /** ms, for "recent consultant" (default Date.now()). */
  now?: number
}

/** Tile indices (inclusive) reserved for the farmhouse, seed shed and porch. */
export const HOMESTEAD = { minI: -6, maxI: -1, minJ: -4, maxJ: 2 } as const
export const FARMHOUSE = { i: -4.5, j: -2 } as const
export const SEED_SHED = { i: -5.5, j: 1.5 } as const
export const PORCH = { i: -3, j: 0.8 } as const
export const MAILBOX = { i: -1.2, j: 3.5 } as const
/** Top-left tile of the first yard. */
export const GRID_ORIGIN = { i: 1, j: -4 } as const
/** Tiles of lane between neighbouring yards. */
export const LANE = 4
/**
 * Soil squares sit on a 1.5-tile pitch inside a yard, so there's a walking path
 * between them for the robots tending them.
 */
export const PLOT_PITCH = 1.5
const PLOT_INSET = 0.25
export const BOUNDS_MARGIN = 3
export const MAX_DOCKED = 3
export const MAX_BENCHED = 2
export const MAX_PORCH = 3
export const MAX_DECOR = 40
/** Roughly one decor per this many free tiles. */
export const FREE_TILES_PER_DECOR = 12

const DAY_MS = 24 * 60 * 60 * 1000
/** Docked robots line up outside the right fence, one charging pad each, front to back. */
const DOCK_GAP = 1.0
const BENCH_OFFSETS = [
  [0, -0.3],
  [0, 0.3],
] as const
const PORCH_OFFSETS = [
  [-0.6, 0.1],
  [0, 0],
  [0.6, 0.1],
] as const

/** Yard size in tiles for n live streams: roughly 1.6:1, 3–6 columns, at least 2 rows. */
export function yardSize(n: number): { w: number; h: number } {
  const w = Math.min(6, Math.max(3, Math.ceil(Math.sqrt(n * 1.6))))
  // Always leave at least one empty square: room for the next seed, and air around the robots.
  return { w, h: Math.max(2, Math.ceil((n + 1) / w)) }
}

/** A unique numeric key for an integer tile. */
export function tileKey(ti: number, tj: number): number {
  return (ti + 32768) * 65536 + (tj + 32768)
}

/**
 * Tiles decor must avoid: each yard plus a 1-tile margin, the lane directly in
 * front of each gate, the homestead zone, and the tiles under the mailbox,
 * crates, compost, signs and robots.
 */
export function occupiedTiles(layout: Omit<FarmLayout, 'decor' | 'bounds'>): Set<number> {
  const occupied = new Set<number>()
  const fill = (tiMin: number, tiMax: number, tjMin: number, tjMax: number) => {
    for (let ti = tiMin; ti <= tiMax; ti++) for (let tj = tjMin; tj <= tjMax; tj++) occupied.add(tileKey(ti, tj))
  }
  const around = (i: number, j: number, radius: number) =>
    fill(Math.floor(i) - radius, Math.floor(i) + radius, Math.floor(j) - radius, Math.floor(j) + radius)

  fill(HOMESTEAD.minI, HOMESTEAD.maxI, HOMESTEAD.minJ, HOMESTEAD.maxJ)
  around(layout.mailbox.i, layout.mailbox.j, 1)
  around(layout.crates.i, layout.crates.j, 1)
  around(layout.compost.i, layout.compost.j, 1)
  for (const robot of layout.porch.robots) around(robot.i, robot.j, 0)
  for (const yard of layout.yards) {
    fill(Math.floor(yard.i0) - 1, Math.ceil(yard.i0 + yard.w), Math.floor(yard.j0) - 1, Math.ceil(yard.j0 + yard.h))
    const gate = Math.floor(yard.i0 + yard.w / 2)
    fill(gate - 2, gate + 1, yard.j0 + yard.h, yard.j0 + yard.h + 1)
    around(yard.sign.i, yard.sign.j, 0)
    around(yard.dock.i, yard.dock.j, 0)
    around(yard.bench.i, yard.bench.j, 0)
    for (const robot of robotsOfYard(yard)) around(robot.i, robot.j, 0)
  }
  return occupied
}

function robotsOfYard(yard: YardLayout): RobotPlacement[] {
  const robots: RobotPlacement[] = [...yard.dock.robots, ...yard.bench.robots]
  if (yard.farmer) robots.push(yard.farmer)
  for (const plot of yard.plots) if (plot.tender) robots.push(plot.tender)
  return robots
}

/** Milliseconds for a Date, ISO string or epoch number (API payloads arrive as strings); 0 if unknown. */
function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime() || 0
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime() || 0
  return 0
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function compareSquads(a: Squad, b: Squad): number {
  return toMs(a.createdAt) - toMs(b.createdAt) || a.name.localeCompare(b.name) || byId(a, b)
}

function compareStreams(a: WorkStream, b: WorkStream): number {
  return toMs(a.createdAt) - toMs(b.createdAt) || byId(a, b)
}

/** Most relevant tender first: asking a question, then halted, then working. */
function tenderRank(agent: Agent, halted: boolean): number {
  if (agent.status === 'waiting-input' && !halted) return 0
  if (halted) return 1
  if (agent.status === 'active') return 2
  return 3
}

/** A 32-bit mix of a seed and two integers (murmur3 finaliser). */
function mix(seed: number, a: number, b: number): number {
  let h = seed ^ Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x3c6ef372, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

interface LiveStream {
  stream: WorkStream
  state: NonNullable<ReturnType<typeof plantStateFor>>
}

export function layoutFarm(input: FarmInput): FarmLayout {
  const now = input.now ?? Date.now()
  const halted = haltedAgentIds(input.pendingActions)

  // --- Lookup maps (one pass each) ---
  const agentsById = new Map<string, Agent>()
  const helpers = new Map<string, number>()
  const membersBySquad = new Map<string, Agent[]>()
  for (const agent of input.agents) {
    if (agentsById.has(agent.id)) continue
    agentsById.set(agent.id, agent)
    if (agent.parentAgentId) {
      if (!isAsleep(agent) && isRunning(agent, halted.has(agent.id)))
        helpers.set(agent.parentAgentId, (helpers.get(agent.parentAgentId) ?? 0) + 1)
      continue
    }
    if (!agent.squadId) continue
    const members = membersBySquad.get(agent.squadId)
    if (members) members.push(agent)
    else membersBySquad.set(agent.squadId, [agent])
  }
  for (const members of membersBySquad.values()) members.sort(byId)

  const haltedBySquad = new Map<string, number>()
  const countedHalted = new Set<string>()
  for (const action of input.pendingActions) {
    if (action.type !== 'agent-error') continue
    const data = action.data as AgentErrorActionData | undefined
    if (!data?.agentId || countedHalted.has(data.agentId)) continue
    countedHalted.add(data.agentId)
    const known = agentsById.get(data.agentId)
    const squadId = known ? known.squadId : (data.squadId ?? action.squadId ?? null)
    if (squadId) haltedBySquad.set(squadId, (haltedBySquad.get(squadId) ?? 0) + 1)
  }

  const streamsBySquad = new Map<string, LiveStream[]>()
  for (const stream of input.streams) {
    const state = plantStateFor(stream)
    if (!state) continue
    const list = streamsBySquad.get(stream.squadId)
    if (list) list.push({ stream, state })
    else streamsBySquad.set(stream.squadId, [{ stream, state }])
  }
  for (const list of streamsBySquad.values()) list.sort((a, b) => compareStreams(a.stream, b.stream))

  const place = (agent: Agent, role: RobotRole, i: number, j: number): RobotPlacement => {
    const face = faceFor(agent, halted.has(agent.id))
    return {
      agent,
      role,
      i,
      j,
      look: robotLookFor(agent, role),
      face,
      prop: propFor(role, face),
      helpers: helpers.get(agent.id) ?? 0,
    }
  }

  // --- Yard grid ---
  const squads = [...new Map(input.squads.map((squad) => [squad.id, squad])).values()].sort(compareSquads)
  const grids = squads.map((squad) => yardSize(streamsBySquad.get(squad.id)?.length ?? 0))
  const sizes = grids.map((g) => ({ w: g.w * PLOT_PITCH, h: g.h * PLOT_PITCH }))
  const columns = Math.max(1, Math.ceil(Math.sqrt(squads.length)))
  const columnWidths: number[] = []
  const rowHeights: number[] = []
  sizes.forEach((size, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    columnWidths[column] = Math.max(columnWidths[column] ?? 0, size.w)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, size.h)
  })
  const columnStarts: number[] = []
  for (let c = 0, i = GRID_ORIGIN.i; c < columnWidths.length; c++) {
    columnStarts.push(i)
    i += columnWidths[c]! + LANE
  }
  const rowStarts: number[] = []
  for (let r = 0, j = GRID_ORIGIN.j; r < rowHeights.length; r++) {
    rowStarts.push(j)
    j += rowHeights[r]! + LANE
  }

  const drawn = new Set<string>()
  const yards: YardLayout[] = squads.map((squad, index) => {
    const { w, h } = sizes[index]!
    const i0 = columnStarts[index % columns]!
    const j0 = rowStarts[Math.floor(index / columns)]!
    const members = membersBySquad.get(squad.id) ?? []

    const manager =
      (squad.managerAgentId ? agentsById.get(squad.managerAgentId) : undefined) ??
      members.find((agent) => agent.agentTypeId === 'manager')
    const managerId = manager?.id
    const sign = { i: i0 + w / 2, j: j0 + h + 0.35 }
    let farmer: RobotPlacement | null = null
    if (manager && !isAsleep(manager)) {
      farmer = place(manager, 'manager', sign.i + 1.2, j0 + h + 0.55)
      drawn.add(manager.id)
    }

    const isWorker = (agent: Agent) => agent.id !== managerId && roleFor(agent, squad) === 'worker'

    let needsYou = haltedBySquad.get(squad.id) ?? 0
    const plots: PlotLayout[] = (streamsBySquad.get(squad.id) ?? []).map(({ stream, state }, k) => {
      const columnsInYard = grids[index]!.w
      const i = i0 + PLOT_INSET + (k % columnsInYard) * PLOT_PITCH
      const j = j0 + PLOT_INSET + Math.floor(k / columnsInYard) * PLOT_PITCH
      const badge = badgeFor(state, stream)
      if (badge) needsYou++

      const ids = new Set<string>(stream.agentIds ?? [])
      if (stream.assigneeAgentId) ids.add(stream.assigneeAgentId)
      if (stream.ownerAgentId) ids.add(stream.ownerAgentId)
      const candidates: { agent: Agent; rank: number }[] = []
      for (const id of ids) {
        const agent = agentsById.get(id)
        if (!agent || agent.parentAgentId || isAsleep(agent) || !isWorker(agent)) continue
        const agentHalted = halted.has(id)
        if (isRunning(agent, agentHalted)) candidates.push({ agent, rank: tenderRank(agent, agentHalted) })
      }
      candidates.sort((a, b) => a.rank - b.rank || byId(a.agent, b.agent))
      // One robot per agent: someone already tending an earlier plot isn't drawn twice.
      const chosen = candidates.find((candidate) => !drawn.has(candidate.agent.id))
      let tender: RobotPlacement | null = null
      if (chosen) {
        tender = place(chosen.agent, 'worker', i + 1.1, j + 0.7)
        drawn.add(chosen.agent.id)
      }
      return {
        stream,
        i,
        j,
        crop: cropFor(stream.id),
        state,
        badge,
        tender,
        extraTenders: tender ? candidates.length - 1 : 0,
      }
    })

    const dockAt = { i: i0 + w + 1.05, j: j0 + h - 0.55 }
    const docked = members.filter(
      (agent) => agent.status === 'idle' && !halted.has(agent.id) && !drawn.has(agent.id) && isWorker(agent)
    )
    const dock: CrowdSpot = {
      ...dockAt,
      robots: docked.slice(0, MAX_DOCKED).map((agent, n) => place(agent, 'worker', dockAt.i, dockAt.j - n * DOCK_GAP)),
      overflow: Math.max(0, docked.length - MAX_DOCKED),
    }

    const benchAt = { i: i0 - 1.1, j: j0 + h - 0.6 }
    const recent = members.filter(
      (agent) =>
        agent.id !== managerId &&
        roleFor(agent, squad) === 'consultant' &&
        (!isAsleep(agent) || now - Math.max(toMs(agent.updatedAt), toMs(agent.lastMessageAt)) <= DAY_MS)
    )
    // Who sits: consultants waiting on you first, then the most recently active (ties by id, for stability).
    const lastActive = (agent: Agent) => Math.max(toMs(agent.updatedAt), toMs(agent.lastMessageAt))
    const seated = recent
      .filter((agent) => !isAsleep(agent))
      .sort(
        (a, b) =>
          Number(b.status === 'waiting-input') - Number(a.status === 'waiting-input') ||
          lastActive(b) - lastActive(a) ||
          byId(a, b)
      )
      .slice(0, MAX_BENCHED)
    const bench: CrowdSpot = {
      ...benchAt,
      robots: seated.map((agent, n) =>
        place(agent, 'consultant', benchAt.i + BENCH_OFFSETS[n]![0], benchAt.j + BENCH_OFFSETS[n]![1])
      ),
      overflow: recent.length - seated.length,
    }
    for (const robot of [...dock.robots, ...bench.robots]) drawn.add(robot.agent.id)

    return { squad, i0, j0, w, h, plots, sign, farmer, dock, bench, needsYou }
  })

  // --- Porch ---
  const assistants = [...new Map(input.assistants.map((agent) => [agent.id, agent])).values()]
    .filter((agent) => !isAsleep(agent))
    .sort(byId)
  const porch: CrowdSpot = {
    ...PORCH,
    robots: assistants
      .slice(0, MAX_PORCH)
      .map((agent, n) => place(agent, 'assistant', PORCH.i + PORCH_OFFSETS[n]![0], PORCH.j + PORCH_OFFSETS[n]![1])),
    overflow: Math.max(0, assistants.length - MAX_PORCH),
  }

  // --- Crates and compost along the bottom edge ---
  const bottomJ = yards.reduce((max, yard) => Math.max(max, yard.j0 + yard.h), HOMESTEAD.maxJ + 1)
  const crates = { i: GRID_ORIGIN.i + 1.5, j: bottomJ + 2.5, count: input.doneCount }
  const compost = { i: GRID_ORIGIN.i + 4.5, j: bottomJ + 2.5, count: input.canceledCount }

  const placed = {
    yards,
    farmhouse: { ...FARMHOUSE },
    seedShed: { ...SEED_SHED },
    mailbox: { ...MAILBOX },
    crates,
    compost,
    porch,
  }

  // --- Bounds of everything structural, plus margin ---
  let minI: number = HOMESTEAD.minI
  let maxI = HOMESTEAD.maxI + 1
  let minJ: number = HOMESTEAD.minJ
  let maxJ = HOMESTEAD.maxJ + 1
  const include = (i: number, j: number) => {
    if (i < minI) minI = i
    if (i > maxI) maxI = i
    if (j < minJ) minJ = j
    if (j > maxJ) maxJ = j
  }
  for (const point of [placed.farmhouse, placed.seedShed, placed.mailbox, crates, compost, porch]) {
    include(point.i, point.j)
  }
  for (const robot of porch.robots) include(robot.i, robot.j)
  for (const yard of yards) {
    include(yard.i0, yard.j0)
    include(yard.i0 + yard.w, yard.j0 + yard.h)
    include(yard.sign.i, yard.sign.j)
    include(yard.dock.i, yard.dock.j)
    include(yard.bench.i, yard.bench.j)
    for (const robot of robotsOfYard(yard)) include(robot.i, robot.j)
  }
  const used = { minI, maxI, minJ, maxJ }
  const bounds = {
    minI: minI - BOUNDS_MARGIN,
    maxI: maxI + BOUNDS_MARGIN,
    minJ: minJ - BOUNDS_MARGIN,
    maxJ: maxJ + BOUNDS_MARGIN,
  }

  return { bounds, ...placed, decor: placeDecor(squads, used, bounds, occupiedTiles(placed)) }
}

type Box = { minI: number; maxI: number; minJ: number; maxJ: number }

/**
 * Sparse, stable decor: trees in the border between the used area and the edge
 * of the grass, and the odd bush, flower patch or hay bale in free lane tiles.
 * Each free tile rolls a deterministic die seeded by the squad ids; the lowest
 * rolls win up to ~1 per 12 free tiles (at most 40).
 */
function placeDecor(squads: readonly Squad[], used: Box, bounds: Box, occupied: Set<number>): DecorPlacement[] {
  const seed = hash(squads.map((squad) => squad.id).join('|'))
  const candidates: { score: number; ti: number; tj: number; border: boolean }[] = []
  let free = 0
  for (let tj = Math.ceil(bounds.minJ); tj < Math.floor(bounds.maxJ); tj++) {
    for (let ti = Math.ceil(bounds.minI); ti < Math.floor(bounds.maxI); ti++) {
      if (occupied.has(tileKey(ti, tj))) continue
      free++
      const border = ti + 0.5 < used.minI || ti + 0.5 > used.maxI || tj + 0.5 < used.minJ || tj + 0.5 > used.maxJ
      const chance = border ? 0.14 : 0.025
      const roll = mix(seed, ti, tj) / 0x100000000
      if (roll < chance) candidates.push({ score: roll / chance, ti, tj, border })
    }
  }
  const cap = Math.min(MAX_DECOR, Math.round(free / FREE_TILES_PER_DECOR))
  candidates.sort((a, b) => a.score - b.score || a.tj - b.tj || a.ti - b.ti)
  return candidates
    .slice(0, cap)
    .sort((a, b) => a.tj - b.tj || a.ti - b.ti)
    .map(({ ti, tj, border }) => {
      const variety = mix(seed ^ 0x9e3779b9, ti, tj)
      const roll = variety % 20
      const kind: DecorKind = border
        ? roll < 14
          ? 'tree'
          : roll < 17
            ? 'fruitTree'
            : 'bush'
        : roll < 9
          ? 'bush'
          : roll < 17
            ? 'flowers'
            : 'hay'
      // Jitter within the tile (never across its edge) so rows of trees don't look planted.
      const jitterI = (((variety >>> 8) & 0xff) / 0xff - 0.5) * 0.4
      const jitterJ = (((variety >>> 16) & 0xff) / 0xff - 0.5) * 0.4
      return { kind, i: ti + 0.5 + jitterI, j: tj + 0.5 + jitterJ, seed: variety }
    })
}
