import { createPeriodicRunner, type PeriodicRunner } from '@ficus/shared'
import { RELAY_MAX_RESPONSE_BYTES, relayStatusResponse, relaySuccessResponse } from '@ficus/shared/integration-relay'
import type { ZodType } from 'zod'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'

export interface RelayConnection {
  id: string
  revision: string
  accessToken: string
  /**
   * Changes whenever the access token rotates without a new connection revision
   * (OAuth refresh). Providers whose Platform side pins the token proven at
   * subscribe time set it so the next pass re-subscribes with the new token.
   */
  credentialRevision?: string | number
}

/** Common envelope fields every provider's relay delivery shares; provider-specific identity/eventType/payload shapes vary. */
export interface RelayDeliveryLike {
  id: string
  leaseToken: string
  connectionId: string
  connectionRevision: string
}

/**
 * What varies between a GitHub-flavored relay and a Slack-flavored one: the
 * route segment, poll cadence, wire schema for pulled deliveries, the
 * provider-specific fields a subscribe request adds beyond the shared
 * connectionId/connectionRevision/accessToken, and how a delivery is matched
 * against a declared interest. Everything else — discovery cadence, lease
 * lifecycle, revision fencing, orphan cleanup, backoff — is provider-agnostic
 * and lives in `HostedIntegrationRelayRunner` below.
 */
export interface HostedRelayProvider<Interest extends { connectionId: string }, Delivery extends RelayDeliveryLike> {
  /** Requests go to `/api/integration-relay/<key>/<op>`. */
  key: string
  runnerName: string
  intervalMs: number
  pullResponseSchema: ZodType<{ deliveries: Delivery[] }>
  /**
   * Extra subscribe-body fields for this connection's current interests
   * (e.g. GitHub's `repositories`; Slack has none). May throw to fail closed
   * instead of silently watching an arbitrary/unbounded subset.
   */
  subscribeExtra(interests: readonly Interest[]): Record<string, unknown>
  /** Whether a delivery belongs to the given declared interest. */
  matchesDelivery(interest: Interest, delivery: Delivery): boolean
  /** Pull answers meaning the subscription's token is stale: subscribe again at once, then pull. */
  resubscribeCodes?: readonly string[]
  /**
   * Subscribe answers that cannot change by retrying the same connection revision.
   * The runner stops subscribing that revision and reports it through `onSubscribeRejected`.
   */
  terminalSubscribeCodes?: readonly string[]
}

export interface HostedRelayDependencies<
  Interest extends { connectionId: string },
  Delivery extends RelayDeliveryLike,
> {
  managed(): boolean
  interests(): Promise<Interest[]>
  resolve(connectionId: string): Promise<RelayConnection | undefined>
  request: typeof platformRequest
  dispatch(delivery: Delivery, interests: Interest[]): Promise<void>
  /**
   * Runs once per pulled batch, before its deliveries are dispatched one after another, with the
   * deliveries that will be dispatched. For work with a deadline that must not wait behind the
   * batch's earlier deliveries (Linear's 10-second session acknowledgment). A failure is reported
   * and the batch is still dispatched.
   */
  prepare?(deliveries: Delivery[], interests: Interest[]): Promise<void>
  /** Durably records a terminal subscribe answer so the revision stays parked across restarts. */
  onSubscribeRejected?(rejection: { connectionId: string; connectionRevision: string; code: string }): Promise<void>
  now?(): number
  onError(code: string): void
}
const RENEW_MS = 5 * 60_000

/** Ephemeral discovery cache; durable ownership, queue and leases remain on Platform. */
export class HostedIntegrationRelayRunner<
  Interest extends { connectionId: string },
  Delivery extends RelayDeliveryLike,
> {
  private runner: PeriodicRunner | undefined
  private controller = new AbortController()
  private renewAt = new Map<string, { key: string; at: number }>()
  private retryAt = new Map<string, number>()
  /** Connection revisions Platform refused for good (`terminalSubscribeCodes`). */
  private rejected = new Map<string, string>()
  private remote: { connectionId: string; connectionRevision: string }[] = []
  private statusAt = 0
  private enabled = false
  private offset = 0
  private scan: Promise<void> | undefined
  constructor(
    private readonly provider: HostedRelayProvider<Interest, Delivery>,
    private readonly deps: HostedRelayDependencies<Interest, Delivery>
  ) {}
  start() {
    if (!this.deps.managed() || this.runner) return
    this.controller = new AbortController()
    this.runner = createPeriodicRunner({
      name: this.provider.runnerName,
      intervalMs: this.provider.intervalMs,
      task: () => this.tick(),
    })
    this.runner.start()
  }
  async stop() {
    this.controller.abort()
    const runner = this.runner
    this.runner = undefined
    await runner?.stop()
    await this.scan
  }
  tick(): Promise<void> {
    if (!this.deps.managed() || this.controller.signal.aborted) return Promise.resolve()
    if (!this.scan)
      this.scan = this.run().finally(() => {
        this.scan = undefined
      })
    return this.scan
  }
  private call<T>(
    path: string,
    body: unknown,
    schema: Parameters<typeof platformRequest<T>>[0]['schema'],
    timeoutMs = 30_000
  ) {
    return this.deps.request({
      path: `/api/integration-relay/${this.provider.key}/${path}`,
      body,
      schema,
      signal: this.controller.signal,
      timeoutMs,
      maxResponseBytes: RELAY_MAX_RESPONSE_BYTES,
    })
  }
  private async run() {
    const now = this.deps.now?.() ?? Date.now()
    try {
      if (now >= this.statusAt) {
        // Also back off when an older Platform has no relay route/scopes yet.
        this.statusAt = now + RENEW_MS
        const status = await this.call('status', {}, relayStatusResponse)
        this.enabled = status.enabled
        this.remote = status.connections
      }
      if (!this.enabled) return
      const interests = await this.deps.interests()
      const groups = new Map<string, Interest[]>()
      for (const interest of interests)
        groups.set(interest.connectionId, [...(groups.get(interest.connectionId) ?? []), interest])
      for (const connection of this.remote) {
        if (groups.has(connection.connectionId)) continue
        await this.call('unsubscribe', connection, relaySuccessResponse)
        this.renewAt.delete(connection.connectionId)
      }
      this.remote = this.remote.filter((connection) => groups.has(connection.connectionId))
      const ids = [...groups.keys()].sort()
      const selected = Array.from(
        { length: Math.min(4, ids.length) },
        (_, index) => ids[(this.offset + index) % ids.length]!
      )
      this.offset = ids.length ? (this.offset + selected.length) % ids.length : 0
      for (const id of selected) {
        if (this.controller.signal.aborted) break
        if ((this.retryAt.get(id) ?? 0) > now) continue
        try {
          await this.sync(id, groups.get(id)!, now)
          this.retryAt.delete(id)
        } catch (error) {
          this.retryAt.set(id, now + 60_000)
          this.report(error)
        }
      }
      for (const id of this.retryAt.keys()) if (!groups.has(id)) this.retryAt.delete(id)
      for (const id of this.renewAt.keys()) if (!groups.has(id)) this.renewAt.delete(id)
      for (const id of this.rejected.keys()) if (!groups.has(id)) this.rejected.delete(id)
    } catch (error) {
      this.report(error)
    }
  }
  /** Subscribes (or renews) one connection, then pulls, dispatches and acknowledges one batch. */
  private async sync(id: string, interests: Interest[], now: number) {
    const connection = await this.deps.resolve(id)
    if (!connection) return
    if (this.rejected.get(id) === connection.revision) return
    const extra = this.provider.subscribeExtra(interests)
    const revisionKey = JSON.stringify([id, connection.revision, connection.credentialRevision ?? null, extra])
    for (let attempt = 0; ; attempt++) {
      if (this.renewAt.get(id)?.key !== revisionKey || this.renewAt.get(id)!.at <= now) {
        if (!(await this.subscribe(connection, extra))) return
        this.renewAt.set(id, { key: revisionKey, at: now + RENEW_MS })
      }
      try {
        await this.pull(connection)
        return
      } catch (error) {
        const stale =
          error instanceof PlatformRequestError && this.provider.resubscribeCodes?.includes(error.code) === true
        if (!stale || attempt > 0) throw error
        // The token Platform proved at subscribe time is no longer this one: subscribe again now.
        this.renewAt.delete(id)
      }
    }
  }
  /** False when Platform refused this revision for good; the revision is parked, not retried. */
  private async subscribe(connection: RelayConnection, extra: Record<string, unknown>) {
    try {
      await this.call(
        'subscribe',
        {
          connectionId: connection.id,
          connectionRevision: connection.revision,
          accessToken: connection.accessToken,
          ...extra,
        },
        relaySuccessResponse,
        180_000
      )
      return true
    } catch (error) {
      if (!(error instanceof PlatformRequestError) || !this.provider.terminalSubscribeCodes?.includes(error.code))
        throw error
      this.rejected.set(connection.id, connection.revision)
      this.renewAt.delete(connection.id)
      this.report(error)
      await this.deps.onSubscribeRejected?.({
        connectionId: connection.id,
        connectionRevision: connection.revision,
        code: error.code,
      })
      return false
    }
  }
  private async pull(connection: RelayConnection) {
    const id = connection.id
    const owner = { connectionId: id, connectionRevision: connection.revision }
    const result = await this.call(
      'pull',
      { ...owner, accessToken: connection.accessToken },
      this.provider.pullResponseSchema,
      60_000
    )
    if (this.deps.prepare && result.deliveries.length && !this.controller.signal.aborted) {
      const interests = (await this.deps.interests()).filter((interest) => interest.connectionId === id)
      const ready = result.deliveries.filter(
        (delivery) =>
          delivery.connectionId === id &&
          delivery.connectionRevision === connection.revision &&
          interests.some((interest) => this.provider.matchesDelivery(interest, delivery))
      )
      if (ready.length) await this.deps.prepare(ready, interests).catch((error) => this.report(error))
    }
    const acknowledgments: { id: string; leaseToken: string }[] = []
    for (const delivery of result.deliveries) {
      if (this.controller.signal.aborted) break
      if (delivery.connectionId !== id || delivery.connectionRevision !== connection.revision)
        throw new PlatformRequestError('invalid_response', false)
      // Re-read after the network boundary: a detach/reconnect cannot receive a queued old event.
      const live = await this.deps.resolve(id)
      if (!live || live.revision !== connection.revision) break
      const current = (await this.deps.interests()).filter(
        (interest) => interest.connectionId === id && this.provider.matchesDelivery(interest, delivery)
      )
      if (current.length) await this.deps.dispatch(delivery, current)
      acknowledgments.push({ id: delivery.id, leaseToken: delivery.leaseToken })
    }
    if (acknowledgments.length) await this.call('ack', { ...owner, deliveries: acknowledgments }, relaySuccessResponse)
  }
  private report(error: unknown) {
    if (!this.controller.signal.aborted)
      this.deps.onError(error instanceof PlatformRequestError ? error.code : 'relay_unavailable')
  }
}
