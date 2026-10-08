import { FARM_WATCHING_MAX_AGENTS, FARM_WATCHING_TTL_MS, isRobotMood, type RobotMoodState } from '@ficus/shared'

/*
 * Which robots the farm shows someone right now, and their latest moods.
 *
 * The farm reports the robots on screen to the API (`POST /api/farm/watching`)
 * on every view change and every 20s while its tab is visible. The API keeps
 * its own copy and hands each report to the worker, where the tracker runs,
 * over the `farm_watching` local-events channel. That channel is best-effort
 * on purpose: a report lives 45s, a little over two heartbeats, so one lost
 * post (or a worker restart) heals by the next heartbeat, and a farm that goes
 * away simply stops reporting and its robots lapse. A table would add writes
 * for every viewer every 20s and a poll in the worker, for state nobody needs
 * to outlive a restart.
 */

export const FARM_WATCHING_CHANNEL = 'farm_watching'

/** The most robots watched at once across every viewer; past it the oldest reports lapse first. */
export const MAX_WATCHED_ROBOTS = 2_000

/** Agent ids with an expiry, each report pushing its robots' expiry out by `ttlMs`. */
export class WatchedSet {
  private until = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly max = MAX_WATCHED_ROBOTS
  ) {}

  watch(agentIds: Iterable<string>, ttlMs = FARM_WATCHING_TTL_MS): void {
    const expires = this.now() + Math.min(Math.max(ttlMs, 0), FARM_WATCHING_TTL_MS)
    for (const id of agentIds) {
      // Re-inserted so the map stays oldest-report-first for trimming.
      this.until.delete(id)
      this.until.set(id, expires)
    }
    this.prune()
    for (const id of this.until.keys()) {
      if (this.until.size <= this.max) break
      this.until.delete(id)
    }
  }

  has(agentId: string): boolean {
    const expires = this.until.get(agentId)
    if (expires === undefined) return false
    if (expires > this.now()) return true
    this.until.delete(agentId)
    return false
  }

  size(): number {
    this.prune()
    return this.until.size
  }

  clear(): void {
    this.until.clear()
  }

  private prune(): void {
    const now = this.now()
    for (const [id, expires] of this.until) if (expires <= now) this.until.delete(id)
  }
}

/** This process's watched robots: the API's copy (from reports) or the worker's (from the channel). */
export const watchedRobots = new WatchedSet()

export interface WatchingMessage {
  agentIds: string[]
  ttlMs: number
}

export function encodeWatching(agentIds: string[], ttlMs = FARM_WATCHING_TTL_MS): string {
  return JSON.stringify({ agentIds: agentIds.slice(0, FARM_WATCHING_MAX_AGENTS), ttlMs } satisfies WatchingMessage)
}

/** A `farm_watching` payload, or null if it isn't one. */
export function decodeWatching(payload: string): WatchingMessage | null {
  try {
    const parsed = JSON.parse(payload) as Partial<WatchingMessage>
    if (!Array.isArray(parsed.agentIds) || typeof parsed.ttlMs !== 'number') return null
    const agentIds = parsed.agentIds
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100)
      .slice(0, FARM_WATCHING_MAX_AGENTS)
    return { agentIds, ttlMs: parsed.ttlMs }
  } catch {
    return null
  }
}

/**
 * The API's view of the latest moods, from the worker's `agent.mood` events,
 * so a farm that opens now sees moods before the next change. Only moods of
 * robots still watched count: the worker forgets the rest too.
 */
export class MoodCache {
  private moods = new Map<string, RobotMoodState>()

  constructor(
    private readonly watched: Pick<WatchedSet, 'has'>,
    private readonly max = MAX_WATCHED_ROBOTS
  ) {}

  record(agentId: string, state: RobotMoodState): void {
    if (!isRobotMood(state.mood)) return
    this.moods.delete(agentId)
    this.moods.set(agentId, { mood: state.mood, source: state.source === 'model' ? 'model' : 'signal', at: state.at })
    for (const id of this.moods.keys()) {
      if (this.moods.size <= this.max) break
      this.moods.delete(id)
    }
  }

  get(agentIds: Iterable<string>): Record<string, RobotMoodState> {
    const out: Record<string, RobotMoodState> = {}
    for (const id of agentIds) {
      const state = this.moods.get(id)
      if (!state) continue
      if (!this.watched.has(id)) {
        this.moods.delete(id)
        continue
      }
      out[id] = state
    }
    return out
  }

  clear(): void {
    this.moods.clear()
  }
}

export const moodCache = new MoodCache(watchedRobots)
