import {
  isRobotMood,
  ROBOT_MOOD_LABELS,
  type FarmWatchingResponse,
  type RobotMood,
  type RobotMoodState,
} from '@ficus/shared'
import { iso } from './iso'
import type { FarmLayout, RobotPlacement } from './types'
import type { Camera } from './useCamera'

/*
 * Robot moods (packages/shared robot-moods.ts) on the farm: Core works them
 * out only for robots someone is looking at, so the farm reports which robots
 * are on screen (useRobotMoods.ts) and draws what comes back, live over the
 * `agents` topic as `agent.mood`. They are a small extra on the working face:
 * halted, asking and waiting robots show those instead.
 */

export type MoodSnapshot = { enabled: boolean; moods: ReadonlyMap<string, RobotMoodState> }

const EMPTY: MoodSnapshot = { enabled: false, moods: new Map() }

/** The farm's current moods: one store, fed by the watching reports and by live events. */
export function createMoodStore() {
  let snapshot = EMPTY
  const listeners = new Set<() => void>()
  const publish = (next: MoodSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    /** A watching report came back: whether moods are on, and the moods of the robots it named. */
    report(agentIds: readonly string[], response: FarmWatchingResponse) {
      if (!response.enabled) {
        if (snapshot.enabled || snapshot.moods.size) publish(EMPTY)
        return
      }
      const moods = new Map(snapshot.moods)
      // Core forgets a robot nobody watched; what it knows now replaces what the farm held.
      for (const id of agentIds) moods.delete(id)
      for (const [id, state] of Object.entries(response.moods ?? {})) if (isRobotMood(state?.mood)) moods.set(id, state)
      publish({ enabled: true, moods })
    },
    /** A live `agent.mood` event. */
    apply(data: unknown) {
      const event = data as Partial<{ agentId: string; mood: string; source: string; at: number }> | null
      if (!event || typeof event.agentId !== 'string' || !isRobotMood(event.mood)) return
      const at = typeof event.at === 'number' ? event.at : Date.now()
      const known = snapshot.moods.get(event.agentId)
      if (known && known.at > at) return
      const moods = new Map(snapshot.moods)
      moods.set(event.agentId, { mood: event.mood, source: event.source === 'model' ? 'model' : 'signal', at })
      publish({ enabled: true, moods })
    },
    reset: () => publish(EMPTY),
  }
}

export type MoodStore = ReturnType<typeof createMoodStore>

export const moodStore = createMoodStore()

const RUNNING = new Set(['active', 'compacting', 'resetting'])

/**
 * The mood a robot shows, or null. Halted, asking and waiting robots keep
 * those faces; only a robot at work shows a mood, and `idle` and `waiting`
 * have no drawing of their own (the robot's status already says so).
 */
export function displayMood(placement: RobotPlacement, state: RobotMoodState | undefined): RobotMood | null {
  if (!state) return null
  if (placement.face === 'error' || placement.asking || placement.agent.status === 'waiting-input') return null
  if (!RUNNING.has(placement.agent.status)) return null
  if (state.mood === 'idle' || state.mood === 'waiting') return null
  return state.mood
}

/** The moods the scene draws, by agent id: only robots that show one. */
export function shownMoods(layout: FarmLayout, snapshot: MoodSnapshot): ReadonlyMap<string, RobotMood> | null {
  if (!snapshot.enabled || !snapshot.moods.size) return null
  const shown = new Map<string, RobotMood>()
  for (const robot of fieldRobots(layout)) {
    const mood = displayMood(robot, snapshot.moods.get(robot.agent.id))
    if (mood) shown.set(robot.agent.id, mood)
  }
  return shown.size ? shown : null
}

/** A mood in words, for hover text and the robot's card. */
export function moodLabel(mood: RobotMood): string {
  return ROBOT_MOOD_LABELS[mood]
}

/** Every robot standing on the field (the ones a mood could show on). Hut robots rest out of sight. */
export function fieldRobots(layout: FarmLayout): RobotPlacement[] {
  const robots: RobotPlacement[] = []
  for (const yard of layout.yards) {
    if (yard.farmer) robots.push(yard.farmer)
    for (const plot of yard.plots) if (plot.tender) robots.push(plot.tender)
    robots.push(...yard.stand.robots)
  }
  robots.push(...layout.porch.robots)
  return robots
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The agents of the robots on screen, sorted so an unchanged view reads the
 * same. `margin` (screen pixels) counts robots just past the edge, about to
 * scroll in. Stand-ins that aren't agents (the porch Assistant) are left out.
 */
export function visibleRobotIds(
  layout: FarmLayout,
  camera: Camera,
  size: { width: number; height: number },
  margin = 48
): string[] {
  if (!size.width || !size.height) return []
  const ids = new Set<string>()
  for (const robot of fieldRobots(layout)) {
    if (!UUID.test(robot.agent.id)) continue
    const [x, y] = iso(robot.i, robot.j)
    const sx = (x - camera.x) * camera.zoom + size.width / 2
    // A robot's head is about 60 world pixels above its feet.
    const top = (y - 60 - camera.y) * camera.zoom + size.height / 2
    const bottom = (y - camera.y) * camera.zoom + size.height / 2
    if (sx < -margin || sx > size.width + margin || bottom < -margin || top > size.height + margin) continue
    ids.add(robot.agent.id)
  }
  return [...ids].sort()
}
