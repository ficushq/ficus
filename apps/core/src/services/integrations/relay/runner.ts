import { createPeriodicRunner, type PeriodicRunner } from '@ficus/shared'
import { RELAY_MAX_RESPONSE_BYTES, relayStatusResponse, relaySuccessResponse } from '@ficus/shared/integration-relay'
import type { ZodType } from 'zod'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'

export interface RelayConnection {
  id: string
  revision: string
  accessToken: string
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
          const connection = await this.deps.resolve(id)
          if (!connection) continue
          const extra = this.provider.subscribeExtra(groups.get(id)!)
          const revisionKey = JSON.stringify([id, connection.revision, extra])
          if (this.renewAt.get(id)?.key !== revisionKey || this.renewAt.get(id)!.at <= now) {
            await this.call(
              'subscribe',
              {
                connectionId: id,
                connectionRevision: connection.revision,
                accessToken: connection.accessToken,
                ...extra,
              },
              relaySuccessResponse,
              180_000
            )
            this.renewAt.set(id, { key: revisionKey, at: now + RENEW_MS })
          }
          const owner = { connectionId: id, connectionRevision: connection.revision }
          const result = await this.call(
            'pull',
            { ...owner, accessToken: connection.accessToken },
            this.provider.pullResponseSchema,
            60_000
          )
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
          if (acknowledgments.length)
            await this.call('ack', { ...owner, deliveries: acknowledgments }, relaySuccessResponse)
          this.retryAt.delete(id)
        } catch (error) {
          this.retryAt.set(id, now + 60_000)
          this.report(error)
        }
      }
      for (const id of this.retryAt.keys()) if (!groups.has(id)) this.retryAt.delete(id)
      for (const id of this.renewAt.keys()) if (!groups.has(id)) this.renewAt.delete(id)
    } catch (error) {
      this.report(error)
    }
  }
  private report(error: unknown) {
    if (!this.controller.signal.aborted)
      this.deps.onError(error instanceof PlatformRequestError ? error.code : 'relay_unavailable')
  }
}
