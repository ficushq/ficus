import { EventPollingRetryError } from './types'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import {
  consumeEventPollingBudget,
  createEventPollingBudget,
  EventPollingBudgetExceededError,
} from './event-polling-budget'
import type { EventPollingCapability, EventPollingSignal, RuntimeConnection, VerifiedIngressEvent } from './types'

export interface EventPollingWatch {
  providerKey: string
  resourceKey: string
  /** Active/in-review resources use the fast cadence. */
  active: boolean
  connection: RuntimeConnection
}

export interface ClaimedPollingCursor {
  cursor: Record<string, unknown> | null
  leaseToken: string
  leaseUntil: Date
}

export interface EventPollingCursorStore {
  claim(providerKey: string, resourceKey: string, now: Date, leaseMs: number): Promise<ClaimedPollingCursor | null>
  save(
    providerKey: string,
    resourceKey: string,
    leaseToken: string,
    cursor: Record<string, unknown>,
    nextPollAt: Date
  ): Promise<void>
  renew(providerKey: string, resourceKey: string, leaseToken: string, leaseMs: number): Promise<Date | null>
  fail(providerKey: string, resourceKey: string, leaseToken: string, retryAt: Date): Promise<boolean>
  release(providerKey: string, resourceKey: string, leaseToken: string): Promise<void>
}

export interface CompletedPollingDispatch {
  activityId: string
  eventFact: unknown
  eventOccurredAt: Date
}
export type EventPollingDispatchClaim =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'completed'; dispatch?: CompletedPollingDispatch }
  | { status: 'busy' }

export interface EventPollingDispatchStore {
  claim(providerKey: string, eventKey: string, leaseMs: number): Promise<EventPollingDispatchClaim>
  complete(
    providerKey: string,
    eventKey: string,
    leaseToken: string,
    fact?: { eventFact: unknown; eventOccurredAt: Date; activitySquadId: string }
  ): Promise<void | CompletedPollingDispatch>
  authorizeActivitySquad?(providerKey: string, eventKey: string, squadId: string): Promise<boolean | void>
  release(providerKey: string, eventKey: string, leaseToken: string): Promise<void>
}

export interface EventPollingRunnerOptions {
  /** Read-only projections may invalidate after (never before) durable cursor save. */
  onCursorSaved?: (watch: EventPollingWatch, previous: unknown, next: Record<string, unknown>) => Promise<void>
  listWatches: () => Promise<readonly EventPollingWatch[]>
  cursorStore: EventPollingCursorStore
  resolveCapability: (watch: EventPollingWatch) => EventPollingCapability | undefined
  dispatch: (event: VerifiedIngressEvent, watch: EventPollingWatch) => Promise<void>
  /** Publish connection-scoped outputs even when the compatibility dispatch is already complete. */
  observe?: (event: VerifiedIngressEvent, watch: EventPollingWatch) => Promise<void>
  dispatchStore?: EventPollingDispatchStore
  dispatchLeaseMs?: number
  extractDispatchFact?: (
    providerKey: string,
    event: VerifiedIngressEvent,
    watch: EventPollingWatch
  ) => { occurredAt: string } | null
  validateCompletedDispatch?: (dispatch: CompletedPollingDispatch, watch: EventPollingWatch) => boolean
  onCompletedDispatch?: (dispatch: CompletedPollingDispatch, watch: EventPollingWatch) => void | Promise<void>
  onError?: (error: unknown, watch: EventPollingWatch) => void
  maxResourcesPerTick?: number
  maxBudgetUnitsPerTick?: number
  leaseMs?: number
  /** Must remain below leaseMs so a timed-out claim is released before expiry. */
  pollTimeoutMs?: number
  failureBackoffMinMs?: number
  failureBackoffMaxMs?: number
  scanIntervalMs?: number
  now?: () => Date
  random?: () => number
}

/** Shared scheduler for every integration provider that supports event polling. */
export class EventPollingRunner {
  readonly #options: EventPollingRunnerOptions
  #runner: PeriodicRunner | null = null

  constructor(options: EventPollingRunnerOptions) {
    const leaseMs = options.leaseMs ?? 120_000
    const pollTimeoutMs = options.pollTimeoutMs ?? Math.floor(leaseMs * 0.75)
    if (!(leaseMs > 0) || !(pollTimeoutMs > 0 && pollTimeoutMs < leaseMs)) {
      throw new Error('Event polling timeout must be positive and shorter than its lease')
    }
    this.#options = options
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-event-polling',
      intervalMs: this.#options.scanIntervalMs ?? 30_000,
      task: () => this.runOnce(),
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }

  async runOnce(): Promise<void> {
    const watches = await this.#options.listWatches()
    const budget = Math.max(0, this.#options.maxResourcesPerTick ?? 100)
    const maxUnits = Math.max(0, this.#options.maxBudgetUnitsPerTick ?? Number.POSITIVE_INFINITY)
    const unitBudget = createEventPollingBudget(maxUnits)
    let polled = 0
    for (const watch of watches) {
      if (polled >= budget || unitBudget.remaining <= 0) break
      const consumedBefore = unitBudget.consumed
      try {
        const reportedUnits = await this.#pollWatch(watch, unitBudget.signal)
        if (reportedUnits !== null) {
          polled++
          if (unitBudget.consumed === consumedBefore && Number.isFinite(unitBudget.remaining)) {
            const normalized =
              Number.isFinite(reportedUnits) && reportedUnits > 0 ? Math.ceil(reportedUnits) : unitBudget.remaining
            consumeEventPollingBudget(unitBudget.signal, Math.min(normalized, unitBudget.remaining))
          }
        }
      } catch (error) {
        // The tick ran out of shared budget mid-poll: the watch was released
        // unchanged and stays due for the next tick instead of backing off.
        if (error instanceof EventPollingBudgetExceededError) break
        polled++
        // Providers that fail before reserving a request still consume one unit.
        if (unitBudget.consumed === consumedBefore && unitBudget.remaining > 0) {
          consumeEventPollingBudget(unitBudget.signal)
        }
        this.#options.onError?.(error, watch)
      }
    }
  }

  async #pollWatch(watch: EventPollingWatch, signal: EventPollingSignal): Promise<number | null> {
    const capability = this.#options.resolveCapability(watch)
    if (!capability) return null
    const claimedAt = this.#options.now?.() ?? new Date()
    const claimed = await this.#options.cursorStore.claim(
      watch.providerKey,
      watch.resourceKey,
      claimedAt,
      this.#options.leaseMs ?? 120_000
    )
    if (!claimed) return null

    const timeoutController = new AbortController()
    const watchSignal = timeoutController.signal as EventPollingSignal
    Object.defineProperties(watchSignal, {
      remainingBudgetUnits: { get: () => signal.remainingBudgetUnits },
      reserveRequest: { value: (units?: number) => signal.reserveRequest(units) },
    })
    const leaseMs = this.#options.leaseMs ?? 120_000
    const configuredTimeout = this.#options.pollTimeoutMs ?? Math.floor(leaseMs * 0.75)
    const remainingLeaseMs = claimed.leaseUntil.getTime() - Date.now()
    const safetyMarginMs = Math.min(5_000, Math.floor(leaseMs * 0.1))
    const timeoutMs = Math.min(configuredTimeout, remainingLeaseMs - safetyMarginMs)
    if (timeoutMs <= 0) {
      await this.#options.cursorStore.release(watch.providerKey, watch.resourceKey, claimed.leaseToken)
      throw new Error(`Event polling lease already expired for ${watch.providerKey}:${watch.resourceKey}`)
    }
    const timeoutError = new Error(`Event polling timed out after ${timeoutMs}ms`)
    timeoutError.name = 'EventPollingTimeoutError'
    let rejectTimeout!: (error: Error) => void
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timer = setTimeout(() => {
      timeoutController.abort(timeoutError)
      rejectTimeout(timeoutError)
    }, timeoutMs)
    let inFlight: Promise<unknown> | null = null
    let deferredRelease = false
    const deadline = async <T>(operation: Promise<T>): Promise<T> => {
      inFlight = operation
      const result = await Promise.race([operation, timeoutPromise])
      inFlight = null
      return result
    }

    try {
      const result = await deadline(capability.poll(watch.connection, claimed.cursor, watchSignal))
      for (const event of result.events) await deadline(this.#dispatchOnce(event, watch))
      const completedAt = this.#options.now?.() ?? new Date()
      const nextPollAt = new Date(completedAt.getTime() + this.#interval(watch.active, result.suggestedIntervalMs))
      await deadline(
        this.#options.cursorStore.save(
          watch.providerKey,
          watch.resourceKey,
          claimed.leaseToken,
          result.nextCursor,
          nextPollAt
        )
      )
      if (this.#options.onCursorSaved)
        await deadline(this.#options.onCursorSaved(watch, claimed.cursor, result.nextCursor))
      return result.budgetUnitsConsumed ?? 1
    } catch (error) {
      if (error instanceof EventPollingBudgetExceededError && error !== timeoutError) {
        // Budget exhaustion is capacity, not a provider failure. Nothing was
        // dispatched or saved, so the unchanged cursor is simply retried.
        await this.#options.cursorStore.release(watch.providerKey, watch.resourceKey, claimed.leaseToken)
        throw error
      }
      const failureDelayMs =
        error instanceof EventPollingRetryError && Number.isFinite(error.retryAfterMs)
          ? Math.min(86_400_000, Math.max(this.#failureInterval(), error.retryAfterMs))
          : this.#failureInterval()
      const failedAt = this.#options.now?.() ?? new Date()
      const retryAt = new Date(failedAt.getTime() + failureDelayMs)
      if (error === timeoutError && inFlight) {
        deferredRelease = true
        void this.#retainLeaseUntilSettled(
          watch,
          claimed.leaseToken,
          claimed.leaseUntil,
          leaseMs,
          failureDelayMs,
          inFlight
        )
      }
      if (!deferredRelease) {
        await this.#options.cursorStore.fail(watch.providerKey, watch.resourceKey, claimed.leaseToken, retryAt)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async #dispatchOnce(event: VerifiedIngressEvent, watch: EventPollingWatch): Promise<void> {
    await this.#options.observe?.(event, watch)
    const eventKey = event.logicalEventKey
    const store = this.#options.dispatchStore
    if (!eventKey || !store) {
      await this.#options.dispatch(event, watch)
      return
    }
    const claim = await store.claim(watch.providerKey, eventKey, this.#options.dispatchLeaseMs ?? 120_000)
    if (claim.status === 'completed') {
      if (
        claim.dispatch &&
        (!this.#options.validateCompletedDispatch || this.#options.validateCompletedDispatch(claim.dispatch, watch))
      ) {
        const authorized = await store.authorizeActivitySquad?.(watch.providerKey, eventKey, watch.connection.squadId)
        if (authorized === false) return
        this.#notifyCompleted(claim.dispatch, watch)
      }
      return
    }
    if (claim.status === 'busy')
      throw new Error(`Synthetic event dispatch is already leased: ${watch.providerKey}:${eventKey}`)
    let handlerCompleted = false
    try {
      await this.#options.dispatch(event, watch)
      handlerCompleted = true
      const eventFact = this.#options.extractDispatchFact?.(watch.providerKey, event, watch) ?? null
      const completed = await store.complete(
        watch.providerKey,
        eventKey,
        claim.leaseToken,
        eventFact
          ? {
              eventFact,
              eventOccurredAt: new Date(eventFact.occurredAt),
              activitySquadId: watch.connection.squadId,
            }
          : undefined
      )
      if (completed) this.#notifyCompleted(completed, watch)
    } catch (error) {
      if (!handlerCompleted) await store.release(watch.providerKey, eventKey, claim.leaseToken)
      throw error
    }
  }

  #notifyCompleted(dispatch: CompletedPollingDispatch, watch: EventPollingWatch): void {
    queueMicrotask(() => {
      void Promise.resolve(this.#options.onCompletedDispatch?.(dispatch, watch)).catch((error) =>
        this.#options.onError?.(error, watch)
      )
    })
  }

  async #retainLeaseUntilSettled(
    watch: EventPollingWatch,
    leaseToken: string,
    leaseUntil: Date,
    leaseMs: number,
    failureDelayMs: number,
    operation: Promise<unknown>
  ): Promise<void> {
    let lostOwnership = false
    let renewing = false
    const report = (error: unknown) => this.#options.onError?.(error, watch)
    const renew = async () => {
      if (renewing || lostOwnership) return
      renewing = true
      try {
        const renewedUntil = await this.#options.cursorStore.renew(
          watch.providerKey,
          watch.resourceKey,
          leaseToken,
          leaseMs
        )
        if (!renewedUntil) {
          lostOwnership = true
          report(new Error(`Event polling lease ownership lost for ${watch.providerKey}:${watch.resourceKey}`))
        }
      } catch (error) {
        // A DB outage also prevents competitors from claiming. Preserve the
        // ownership intent and retry while the side effect remains in flight.
        report(error)
      } finally {
        renewing = false
      }
    }
    const remainingMs = Math.max(1, leaseUntil.getTime() - Date.now())
    const heartbeatMs = Math.max(10, Math.min(Math.floor(leaseMs / 6), Math.floor(remainingMs / 2)))
    const heartbeat = setInterval(() => void renew(), heartbeatMs)
    await renew()
    await operation.catch(() => undefined)
    clearInterval(heartbeat)
    if (!lostOwnership) {
      try {
        const settledAt = this.#options.now?.() ?? new Date()
        const retryAt = new Date(settledAt.getTime() + failureDelayMs)
        await this.#options.cursorStore.fail(watch.providerKey, watch.resourceKey, leaseToken, retryAt)
      } catch (error) {
        report(error)
      }
    }
  }

  #failureInterval(): number {
    const min = Math.max(1_000, this.#options.failureBackoffMinMs ?? 60_000)
    const max = Math.max(min, this.#options.failureBackoffMaxMs ?? 300_000)
    const random = Math.max(0, Math.min(1, this.#options.random?.() ?? Math.random()))
    return Math.round(min + (max - min) * random)
  }

  #interval(active: boolean, suggested: number): number {
    const min = active ? 60_000 : 300_000
    const max = active ? 120_000 : 600_000
    const base = Math.max(min, Math.min(max, Number.isFinite(suggested) ? suggested : min))
    const random = Math.max(0, Math.min(1, this.#options.random?.() ?? Math.random()))
    return Math.round(base + (max - base) * random)
  }
}
