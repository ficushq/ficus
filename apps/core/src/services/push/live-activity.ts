import {
  buildLiveActivityState,
  shouldShowLiveActivity,
  type LiveActivityState,
  type EventMap,
  type WorkInterestSnapshot,
  type WorkStream,
} from '@ficus/shared'
import { createLogger } from '../../lib/infra/logger'
import { getApnsConfig, sendApnsLiveActivity, type ApnsSendResult } from './apns'
import { deleteLiveActivityToken, listLiveActivityTokens } from './live-activity-tokens'
import { listSquadSubscriberIds } from '../squad/subscriptions'
import { listWorkStreamSubscriberIds } from '../work-streams/subscriptions'
import { loadWorkInterestSnapshot } from './work-interest'

const log = createLogger('live-activity-fanout')

/**
 * Push the aggregated work Live Activity when work-stream state changes.
 *
 * While the app is foregrounded it drives its own activity (see
 * the native companion). This is what keeps the lock-screen card honest
 * once the app is backgrounded, where ActivityKit can only be reached through APNs.
 *
 * SELF-GATING, no feature flag. The work is bounded by what actually exists:
 *   - no APNs configuration      -> nothing (re-checked per push; config is settings-backed and
 *                                   can appear after boot, so checking once at registration would
 *                                   strand an instance that configures APNs later)
 *   - no Live Activity tokens    -> nothing, and crucially this is checked BEFORE any stream query,
 *                                   so an instance where nobody uses the widget pays only a Map
 *                                   lookup per event
 *   - state unchanged            -> nothing (diffed against the last state actually pushed)
 *
 * Tokens only exist for users running a widget-capable build who started an activity, so the
 * blast radius is exactly the set of people using the feature — which is what a flag would have
 * approximated, less precisely and with an extra thing to forget to turn on.
 */

/** Work-stream events that can change what the card shows. */
export const LIVE_ACTIVITY_EVENTS = [
  'workStream.created',
  'workStream.assigned',
  'workStream.blocked',
  'workStream.review',
  'workStream.done',
  'workStream.canceled',
  'workStream.responded',
  'workStream.reopened',
  'workStream.updated',
  'workStream.deleted',
] as const

/**
 * Coalescing window. One operator action (approve → assign → start) emits several events within
 * milliseconds; without this each would be its own push. APNs also rate-limits Live Activity
 * updates, so spending that budget on intermediate states is actively harmful.
 */
export const FANOUT_DEBOUNCE_MS = 3_000
export const LIVE_ACTIVITY_RETRY_MS = 5_000
export const LIVE_ACTIVITY_MAX_ATTEMPTS = 3

type TimerHandle = ReturnType<typeof setTimeout>

export interface LiveActivityFanoutDeps {
  /** Subscribers of the changed stream ∪ of its squad — the same set the inbox notification uses. */
  resolveUserIds: (input: { workStreamId?: string; squadId?: string }) => Promise<string[]>
  /** Authoritative server snapshot. Legacy stream injection remains for focused unit tests. */
  loadSnapshot?: (userId: string) => Promise<WorkInterestSnapshot>
  loadUserStreams?: (userId: string) => Promise<WorkStream[]>
  origin: () => string
  listTokens?: typeof listLiveActivityTokens
  send?: typeof sendApnsLiveActivity
  deleteToken?: typeof deleteLiveActivityToken
  /** Injected so tests can exercise delivery without real APNs settings. */
  hasApnsConfig?: () => boolean
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

export interface LiveActivityFanout {
  /** Called per event; resolves once the debounce is SCHEDULED, not once the push is sent. */
  onWorkStreamEvent(payload: { workStreamId?: string; squadId?: string }): Promise<void>
  /** Schedule a refresh after a subscription-interest mutation. */
  refreshUser(userId: string): void
  /** Force the pending push for one user (tests; also used by flush). */
  flushUser(userId: string): Promise<void>
  stop(): void
}

/** Compare only what the card renders, so unrelated churn doesn't spend a push. */
function sameState(left: LiveActivityState | undefined, right: LiveActivityState): boolean {
  if (!left) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

export function createLiveActivityFanout(deps: LiveActivityFanoutDeps): LiveActivityFanout {
  const listTokens = deps.listTokens ?? listLiveActivityTokens
  const send = deps.send ?? sendApnsLiveActivity
  const removeToken = deps.deleteToken ?? deleteLiveActivityToken
  const hasApnsConfig = deps.hasApnsConfig ?? (() => getApnsConfig() !== null)
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))

  type Token = Awaited<ReturnType<typeof listLiveActivityTokens>>[number]
  type Payload = Parameters<typeof sendApnsLiveActivity>[1]
  interface PendingDelivery {
    token: Token
    payload: Payload
    attempts: number
  }

  const timers = new Map<string, TimerHandle>()
  const retryTimers = new Map<string, TimerHandle>()
  const retryBatches = new Map<
    string,
    { state: LiveActivityState; deliveries: PendingDelivery[]; hadUnhandled: boolean }
  >()
  /** Last state actually pushed per user — the diff that suppresses no-op sends. */
  const lastSent = new Map<string, LiveActivityState>()

  function isHandled(result: ApnsSendResult): boolean {
    return result.ok || result.status === 410
  }

  function isRetryable(result: ApnsSendResult): boolean {
    return !result.ok && (result.status === 0 || result.status === 429 || result.status >= 500)
  }

  function cancelRetry(userId: string): void {
    const timer = retryTimers.get(userId)
    if (timer) clearTimer(timer)
    retryTimers.delete(userId)
    retryBatches.delete(userId)
  }

  function scheduleRetry(userId: string): void {
    if (retryTimers.has(userId)) return
    retryTimers.set(
      userId,
      setTimer(() => {
        retryTimers.delete(userId)
        void retryUser(userId)
      }, LIVE_ACTIVITY_RETRY_MS)
    )
  }

  async function retryUser(userId: string): Promise<void> {
    const batch = retryBatches.get(userId)
    if (!batch) return
    const remaining: PendingDelivery[] = []
    let unhandled = batch.hadUnhandled
    for (const pending of batch.deliveries) {
      const result = await deliver(pending.token, pending.payload)
      const attempts = pending.attempts + 1
      if (isRetryable(result) && attempts < LIVE_ACTIVITY_MAX_ATTEMPTS) {
        remaining.push({ ...pending, attempts })
      } else if (!isHandled(result)) {
        unhandled = true
      }
    }
    if (remaining.length > 0) {
      batch.deliveries = remaining
      batch.hadUnhandled = unhandled
      scheduleRetry(userId)
    } else {
      retryBatches.delete(userId)
      if (!unhandled) lastSent.set(userId, batch.state)
    }
  }

  async function sendDeliveries(
    userId: string,
    state: LiveActivityState,
    deliveries: Array<{ token: Token; payload: Payload }>
  ): Promise<ApnsSendResult[]> {
    const results: ApnsSendResult[] = []
    const retryable: PendingDelivery[] = []
    for (const delivery of deliveries) {
      const result = await deliver(delivery.token, delivery.payload)
      results.push(result)
      if (isRetryable(result)) retryable.push({ ...delivery, attempts: 1 })
    }
    if (retryable.length > 0) {
      retryBatches.set(userId, { state, deliveries: retryable, hadUnhandled: false })
      scheduleRetry(userId)
    }
    return results
  }

  async function pushFor(userId: string): Promise<void> {
    // Re-checked per push, not at registration: APNs config is settings-backed and can appear
    // after boot.
    if (!hasApnsConfig()) return

    // Tokens FIRST, before any stream query. This is what makes the feature free for everyone who
    // does not use it: loadUserStreams reads every active/queued stream on the instance, so doing
    // it for subscribers who have no Live Activity to update would put real load on servers that
    // have never shown a card.
    const tokens = await listTokens([userId])
    if (tokens.length === 0) {
      lastSent.delete(userId)
      return
    }

    const state = deps.loadSnapshot
      ? (await deps.loadSnapshot(userId)).liveActivity
      : buildLiveActivityState(await deps.loadUserStreams!(userId))
    const previous = lastSent.get(userId)
    if (sameState(previous, state) || retryBatches.has(userId)) return

    const show = shouldShowLiveActivity(state)
    const wasShowing = previous ? shouldShowLiveActivity(previous) : false
    const updateTokens = tokens.filter((row) => row.kind === 'update')
    const startTokens = tokens.filter((row) => row.kind === 'start')
    const contentState = state as unknown as Record<string, unknown>

    // Authoritative empty interest must reconcile activities even after a process restart, when
    // the in-memory previous state is absent but update tokens can still represent visible cards.
    if (!show) {
      if (updateTokens.length === 0) {
        lastSent.delete(userId)
        return
      }
      const results = await sendDeliveries(
        userId,
        state,
        updateTokens.map((token) => ({ token, payload: { event: 'end', contentState } }))
      )
      if (results.every(isHandled)) lastSent.set(userId, state)
      return
    }

    // On a cold process, an update token is evidence that an activity already exists. Reconcile it
    // before considering push-to-start, otherwise a restart can create a duplicate aggregate card.
    if (!previous && updateTokens.length > 0) {
      const results = await sendDeliveries(
        userId,
        state,
        updateTokens.map((token) => ({ token, payload: { event: 'update', contentState } }))
      )
      if (results.some((result) => result.ok)) {
        if (results.every(isHandled)) lastSent.set(userId, state)
        return
      }
      if (!results.every((result) => result.status === 410)) return
      const startResults = await sendDeliveries(
        userId,
        state,
        startTokens.map((token) => ({
          token,
          payload: {
            event: 'start' as const,
            contentState,
            attributesType: 'TauWorkAttributes',
            attributes: { origin: deps.origin() },
          },
        }))
      )
      if (startTokens.length > 0 && startResults.every(isHandled)) lastSent.set(userId, state)
      else lastSent.delete(userId)
      return
    }

    const deliveries: Array<{ token: Token; payload: Payload }> = []
    if (!wasShowing) {
      deliveries.push(
        ...startTokens.map((token) => ({
          token,
          payload: {
            event: 'start' as const,
            contentState,
            attributesType: 'TauWorkAttributes',
            attributes: { origin: deps.origin() },
          },
        }))
      )
    }
    deliveries.push(...updateTokens.map((token) => ({ token, payload: { event: 'update' as const, contentState } })))
    const results = await sendDeliveries(userId, state, deliveries)
    if (results.every(isHandled)) lastSent.set(userId, state)
  }

  async function deliver(
    token: { apnsToken: string; environment: string },
    payload: Parameters<typeof sendApnsLiveActivity>[1]
  ): Promise<ApnsSendResult> {
    const result = await send(token.apnsToken, payload, token.environment === 'sandbox' ? 'sandbox' : 'production')
    // 410 is the normal end of a Live Activity token's life (the activity ended, or the app was
    // removed) — prune rather than log it as a failure.
    if (!result.ok && result.status === 410) await removeToken(token.apnsToken)
    return result
  }

  async function flushUser(userId: string): Promise<void> {
    timers.delete(userId)
    try {
      await pushFor(userId)
    } catch (error) {
      // A push failure must never surface into the emitting work-stream transaction.
      log.warn(`Live Activity fan-out failed for user ${userId}`, error)
    }
  }

  function refreshUser(userId: string): void {
    cancelRetry(userId)
    const existing = timers.get(userId)
    if (existing) clearTimer(existing)
    timers.set(
      userId,
      setTimer(() => void flushUser(userId), FANOUT_DEBOUNCE_MS)
    )
  }

  return {
    async onWorkStreamEvent(payload) {
      const userIds = await deps.resolveUserIds(payload)
      for (const userId of userIds) refreshUser(userId)
    },
    refreshUser,
    flushUser,
    stop() {
      for (const handle of timers.values()) clearTimer(handle)
      for (const handle of retryTimers.values()) clearTimer(handle)
      timers.clear()
      retryTimers.clear()
      retryBatches.clear()
      lastSent.clear()
    },
  }
}

/** Best-effort privacy cleanup used before user deletion removes token rows by cascade. */
export async function endLiveActivitiesForUser(
  userId: string,
  deps: {
    listTokens?: typeof listLiveActivityTokens
    send?: typeof sendApnsLiveActivity
    deleteToken?: typeof deleteLiveActivityToken
    hasApnsConfig?: () => boolean
  } = {}
): Promise<void> {
  const hasConfig = deps.hasApnsConfig ?? (() => getApnsConfig() !== null)
  if (!hasConfig()) return
  let tokens: Awaited<ReturnType<typeof listLiveActivityTokens>>
  try {
    tokens = await (deps.listTokens ?? listLiveActivityTokens)([userId])
  } catch (error) {
    log.warn(`Failed to list Live Activity tokens before deleting user ${userId}`, error)
    return
  }
  const emptyState: LiveActivityState = { activeCount: 0, needsYouCount: 0, top: [] }
  for (const token of tokens.filter((row) => row.kind === 'update')) {
    try {
      const result = await (deps.send ?? sendApnsLiveActivity)(
        token.apnsToken,
        { event: 'end', contentState: emptyState as unknown as Record<string, unknown> },
        token.environment === 'sandbox' ? 'sandbox' : 'production'
      )
      if (!result.ok && result.status === 410) await (deps.deleteToken ?? deleteLiveActivityToken)(token.apnsToken)
    } catch (error) {
      log.warn(`Failed to end Live Activity before deleting user ${userId}`, error)
    }
  }
}

/**
 * Wire the fan-out to the event bus with real dependencies.
 *
 * Registration is cheap and unconditional so the flag can be flipped at runtime — the gate is
 * re-evaluated per event and again per push, rather than deciding once at boot.
 */
export function registerLiveActivityFanout(emitter: {
  on<K extends keyof EventMap>(event: K, handler: (payload: EventMap[K]) => void): () => void
}): LiveActivityFanout {
  const fanout = createLiveActivityFanout({
    // The RECOMPUTE set, not a recipient set: every user with a subscription row on the stream or
    // its squad, at any level. Deliberately wider than the inbox notice (which resolves effective
    // `notify` and checks permission) because a row at any level can change what the card should
    // show — including dropping the stream off it. Each user's own snapshot then decides what, if
    // anything, they see: `loadWorkInterestSnapshot` keeps only work whose effective attention is
    // `notify` and whose squad the user may read, so a mute or a lost role ends the card instead
    // of leaking content into it.
    resolveUserIds: async ({ workStreamId, squadId }) => {
      const [streamWatchers, squadWatchers] = await Promise.all([
        workStreamId ? listWorkStreamSubscriberIds(workStreamId) : Promise.resolve([]),
        squadId ? listSquadSubscriberIds(squadId) : Promise.resolve([]),
      ])
      return [...new Set([...streamWatchers, ...squadWatchers])]
    },
    loadSnapshot: loadWorkInterestSnapshot,
    origin: () => process.env.PUBLIC_URL ?? '',
  })

  const unsubscribes: Array<() => void> = []
  for (const event of LIVE_ACTIVITY_EVENTS) {
    const unsubscribe = emitter.on(event, (payload) => {
      void fanout.onWorkStreamEvent(payload ?? {})
    })
    if (unsubscribe) unsubscribes.push(unsubscribe)
  }
  const unsubscribeInterest = emitter.on('liveActivity.interestChanged', ({ userId }) => fanout.refreshUser(userId))
  if (unsubscribeInterest) unsubscribes.push(unsubscribeInterest)

  return {
    ...fanout,
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe()
      fanout.stop()
    },
  }
}
