import { eventEmitter } from '../../lib/infra/event-emitter'
import { listen, notify } from '../../lib/infra/local-events'
import { createLogger } from '../../lib/infra/logger'
import { decide, decisionChain, isDecisionFeatureEnabled } from '../decisions/service'
import { RobotMoodTracker, type MoodEvent } from './tracker'
import {
  decodeWatching,
  encodeWatching,
  FARM_WATCHING_CHANNEL,
  moodCache,
  watchedRobots,
  type WatchedSet,
} from './watching'

export { RobotMoodTracker } from './tracker'
export { moodCache, watchedRobots, WatchedSet, MoodCache, FARM_WATCHING_CHANNEL } from './watching'

const log = createLogger('robot-moods')

/** The switch, read at most once a second: the tracker asks on every tool event of a watched robot. */
let enabledCache = { value: false, until: 0 }
export function robotMoodsEnabled(): boolean {
  const now = Date.now()
  if (now >= enabledCache.until) enabledCache = { value: isDecisionFeatureEnabled('robot-moods'), until: now + 1_000 }
  return enabledCache.value
}

/** The worker's tracker, fed by every agent runner's event subscription. */
export const robotMoods = new RobotMoodTracker({
  // On with no decision model yet: the cheap signals still show, and nothing is asked (or logged).
  decide: (purpose, request, options) =>
    decisionChain(purpose).length
      ? decide(purpose, request, options)
      : Promise.resolve({ ok: false, reason: 'unconfigured', errors: [] }),
  isEnabled: robotMoodsEnabled,
  isWatched: (agentId) => watchedRobots.has(agentId),
  emit: (event) => eventEmitter.emit('agent.mood', event),
  onError: (error) => log.warn('Robot mood tracking failed', error),
})

/** Feed a runner's session event to the tracker. Never throws. */
export function observeRobotMood(agentId: string, squadId: string | null, event: unknown): void {
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') return
  robotMoods.observe(agentId, squadId, event as MoodEvent)
}

type NotifyFn = (channel: string, payload: string) => Promise<void>
type ListenFn = (channel: string, callback: (payload: string) => void) => Promise<() => Promise<void>>

/** API: these robots are on someone's screen. Keeps the API's copy and tells the worker. */
export function reportWatching(agentIds: string[], options: { notify?: NotifyFn; watched?: WatchedSet } = {}): void {
  if (!agentIds.length) return
  ;(options.watched ?? watchedRobots).watch(agentIds)
  ;(options.notify ?? notify)(FARM_WATCHING_CHANNEL, encodeWatching(agentIds)).catch((error) =>
    log.warn('Could not hand watched robots to the worker', error)
  )
}

/** Worker: take the API's watched-robot reports. */
export async function startRobotMoodWatchingListener(
  options: { listen?: ListenFn; watched?: WatchedSet; tracker?: Pick<RobotMoodTracker, 'prune'> } = {}
): Promise<() => Promise<void>> {
  const watched = options.watched ?? watchedRobots
  const tracker = options.tracker ?? robotMoods
  return (options.listen ?? listen)(FARM_WATCHING_CHANNEL, (payload) => {
    const message = decodeWatching(payload)
    if (!message) return
    watched.watch(message.agentIds, message.ttlMs)
    tracker.prune()
  })
}

/** API: remember the worker's latest moods for farms that open later. */
export function startRobotMoodCache(): () => void {
  return eventEmitter.on('agent.mood', (event) => {
    moodCache.record(event.agentId, { mood: event.mood, source: event.source, at: event.at })
  })
}
