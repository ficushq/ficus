import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import type { ClaimedIntegrationProjection } from './state-repository'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { IntegrationProjectionFailure } from './reconciler'

const LEASE_MS = 60_000
/**
 * A projection can install tools in every target sandbox, which can take far
 * longer than the lease. Without renewal the next pass re-claimed the same
 * projection while the first install was still running, started it again on
 * every target, and dropped the first result at the stale-lease fence, so the
 * projection could stay `installing` for as long as installs outlasted the
 * lease.
 */
const LEASE_RENEW_MS = 20_000
const MAX_BACKOFF_MS = 15 * 60_000

export interface IntegrationProjectionWorkerDependencies {
  repository: {
    sweepMissing?(now: Date): Promise<void>
    claim(now: Date, leaseExpiresAt: Date, leaseToken: string): Promise<ClaimedIntegrationProjection | null>
    renew?(input: {
      squadId: string
      providerKey: string
      generation: bigint
      leaseToken: string
      leaseExpiresAt: Date
      now: Date
    }): Promise<boolean>
    complete(input: {
      squadId: string
      providerKey: string
      generation: bigint
      leaseToken: string
      fingerprint: string
      credentialRevision: bigint | null
      now: Date
    }): Promise<unknown>
    fail(input: {
      squadId: string
      providerKey: string
      generation: bigint
      leaseToken: string
      code: string
      nextAttemptAt: Date
      now: Date
    }): Promise<unknown>
  }
  reconcile(claim: ClaimedIntegrationProjection): Promise<{ fingerprint: string; credentialRevision: bigint | null }>
  discoverDrift?(now: Date): Promise<void>
  now?: () => Date
  uuid?: () => string
  /** How often a running reconcile extends its lease; tests shorten it. */
  leaseRenewMs?: number
}

/**
 * How many maintenance passes may skip `sweepMissing` before it runs anyway.
 * At the 30s tick that is roughly every 10 minutes — the backstop for an
 * assignment written without an `integration.projection-invalidated` event
 * reaching this process (a dropped cross-process event, a direct DB write).
 */
export const PROJECTION_SWEEP_BACKSTOP_TICKS = 20

export class IntegrationProjectionWorker {
  readonly #dependencies: IntegrationProjectionWorkerDependencies
  readonly #now: () => Date
  readonly #uuid: () => string
  #runner: PeriodicRunner | null = null
  #unsubscribe: (() => void) | null = null
  /** Starts dirty so the first pass of a fresh process still reconciles. */
  #assignmentsChanged = true
  #passesSinceSweep = 0

  constructor(dependencies: IntegrationProjectionWorkerDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date())
    this.#uuid = dependencies.uuid ?? (() => crypto.randomUUID())
  }

  /**
   * `sweepMissing` is an `INSERT ... SELECT` over the whole
   * `integration_connection_assignments` table and it used to run on every 30s
   * tick, finding nothing the overwhelming majority of the time. It now runs
   * when an assignment has actually changed, and every
   * `PROJECTION_SWEEP_BACKSTOP_TICKS` passes regardless as the safety net.
   *
   * The flag is cleared BEFORE the sweep runs, so an invalidation that lands
   * while a sweep is in flight leaves the next pass dirty rather than being
   * swallowed by it.
   */
  #claimSweepMissing(): boolean {
    this.#passesSinceSweep += 1
    if (!this.#assignmentsChanged && this.#passesSinceSweep < PROJECTION_SWEEP_BACKSTOP_TICKS) return false
    this.#assignmentsChanged = false
    this.#passesSinceSweep = 0
    return true
  }

  async runMaintenance(): Promise<void> {
    const now = this.#now()
    await Promise.allSettled([
      this.#claimSweepMissing()
        ? (this.#dependencies.repository.sweepMissing?.(now) ?? Promise.resolve())
        : Promise.resolve(),
      this.#dependencies.discoverDrift?.(now) ?? Promise.resolve(),
    ])
  }

  async runOnce(): Promise<boolean> {
    const now = this.#now()
    const claim = await this.#dependencies.repository.claim(now, new Date(now.getTime() + LEASE_MS), this.#uuid())
    if (!claim) return false
    const stopRenewing = this.#renewWhileRunning(claim)
    try {
      const result = await this.#dependencies.reconcile(claim)
      stopRenewing()
      await this.#dependencies.repository.complete({
        squadId: claim.squadId,
        providerKey: claim.providerKey,
        generation: claim.generation,
        leaseToken: claim.leaseToken,
        fingerprint: result.fingerprint,
        credentialRevision: result.credentialRevision,
        now: this.#now(),
      })
    } catch (error) {
      stopRenewing()
      const attempts = claim.attempts + 1
      const backoff = Math.min(1_000 * 2 ** Math.min(attempts - 1, 20), MAX_BACKOFF_MS)
      const failedAt = this.#now()
      await this.#dependencies.repository.fail({
        squadId: claim.squadId,
        providerKey: claim.providerKey,
        generation: claim.generation,
        leaseToken: claim.leaseToken,
        code: error instanceof IntegrationProjectionFailure ? error.code : 'projection_failed',
        nextAttemptAt: new Date(failedAt.getTime() + backoff),
        now: failedAt,
      })
    }
    return true
  }

  #renewWhileRunning(claim: ClaimedIntegrationProjection): () => void {
    const renew = this.#dependencies.repository.renew
    if (!renew) return () => {}
    let stopped = false
    let inFlight = false
    const timer = setInterval(() => {
      if (stopped || inFlight) return
      inFlight = true
      const now = this.#now()
      renew
        .call(this.#dependencies.repository, {
          squadId: claim.squadId,
          providerKey: claim.providerKey,
          generation: claim.generation,
          leaseToken: claim.leaseToken,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          now,
        })
        // A lost claim (newer generation, or a peer took over) is fenced at
        // complete/fail; renewal stops being useful but is harmless.
        .then((held) => {
          if (!held) stop()
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false
        })
    }, this.#dependencies.leaseRenewMs ?? LEASE_RENEW_MS)
    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    return stop
  }

  async runBatch(limit = 20): Promise<number> {
    await this.runMaintenance()
    let count = 0
    while (count < limit && (await this.runOnce())) count += 1
    return count
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-projection',
      intervalMs: 30_000,
      runImmediately: true,
      task: async () => {
        await this.runBatch()
      },
    })
    this.#unsubscribe = eventEmitter.on('integration.projection-invalidated', () => {
      // Every assignment write (assign/unassign/retry/reproject/deproject)
      // emits this, so it is a superset of "an assignment changed" — the sweep
      // can over-run, never under-run.
      this.#assignmentsChanged = true
      void this.runOnce().catch(() => {})
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    this.#unsubscribe?.()
    this.#unsubscribe = null
    await runner?.stop()
  }
}
