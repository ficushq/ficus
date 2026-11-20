import { and, eq, ne, sql } from 'drizzle-orm'
import { LINEAR_RELAY_CODES, linearRelayPullResponse, type LinearRelayDelivery } from '@ficus/shared/integration-relay'
import { db, integrationConnections, webhookEvents } from '../../../db'
import { publicErrorMessage } from '../../../db/errors'
import { createLogger } from '../../../lib/infra/logger'
import { platformRequest } from '../../platform/instance-client'
import { isPlatformManaged } from '../../secrets/managed'
import { materializeWebhookActivity } from '../../squad-activity/materialize'
import { dispatchVerifiedWebhookContext } from '../../webhooks/dispatch'
import {
  DuplicateWebhookDeliveryError,
  markWebhookError,
  markWebhookProcessed,
  storeWebhookEvent,
} from '../../webhooks/store'
import { DbIntegrationAuditRecorder } from '../db-audit'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { integrationEnabledPredicate } from '../provider-state'
import { acknowledgeLinearSessionEvent } from '../linear/app-ingress'
import { isLinearAppConfiguration, parseLinearConfiguration } from '../linear/plugin'
import { resolveManagedLinearConnection } from '../linear/resolve-connection'
import { HostedIntegrationRelayRunner, type HostedRelayProvider, type RelayConnection } from './runner'

const log = createLogger('hosted-linear-relay')

/** One per hosted Linear agent app connection: its workspace (organization) ID. */
export interface LinearRelayInterest {
  connectionId: string
  organizationId: string
}

export const linearRelayProvider: HostedRelayProvider<LinearRelayInterest, LinearRelayDelivery> = {
  key: 'linear',
  runnerName: 'hosted-linear-relay',
  // Linear shows a session as unresponsive unless it is acknowledged within 10 seconds of
  // creation, so the relay pulls as often as Slack's chat relay does.
  intervalMs: 2_000,
  pullResponseSchema: linearRelayPullResponse,
  // Platform derives the organization and app user from the token (linearRelaySubscribeRequest).
  subscribeExtra: () => ({}),
  matchesDelivery: (interest, delivery) => interest.organizationId === delivery.resourceId,
  // Platform pins the token proven at subscribe time; Linear rotates it daily.
  resubscribeCodes: [LINEAR_RELAY_CODES.authorizationRequired],
  // Another hosted instance holds this workspace (one hosted instance per Linear workspace).
  terminalSubscribeCodes: [LINEAR_RELAY_CODES.organizationClaimed],
}

/**
 * Enabled hosted (`platform_broker`) Linear agent app connections. A connection that needs
 * reauthorization (for example after `OAuthApp` `revoked`) or whose current revision Platform refused
 * as claimed by another instance is left out, so the runner unsubscribes it and never retries it.
 * Squad assignment is not required: every session the app receives is acknowledged.
 */
export async function linearRelayInterests(): Promise<LinearRelayInterest[]> {
  const rows = await db
    .select({ id: integrationConnections.id, configuration: integrationConnections.configuration })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        eq(integrationConnections.authorizationKind, 'oauth2'),
        eq(integrationConnections.clientAuthority, 'platform_broker'),
        eq(integrationConnections.enabled, true),
        integrationEnabledPredicate(),
        ne(integrationConnections.authState, 'reauthorization_required'),
        sql`not (${integrationConnections.relaySubscribeErrorCode} is not null
          and ${integrationConnections.relaySubscribeErrorRevision} = ${integrationConnections.materialRevision})`
      )
    )
  return rows.flatMap((row) => {
    try {
      const configuration = parseLinearConfiguration(row.configuration)
      return isLinearAppConfiguration(configuration)
        ? [{ connectionId: row.id, organizationId: configuration.organizationId }]
        : []
    } catch {
      return []
    }
  })
}

/**
 * The runner's `resolve` hook. `credentialRevision` is the OAuth bundle's token revision, so a refresh
 * (which rotates the token without a new material revision) re-subscribes on the next pass.
 */
export function createManagedLinearRelayResolver(
  resolveConnection: (id: string) => Promise<
    | {
        connection: { id: string; materialRevision: string }
        credential: { accessToken: string; tokenRevision: number }
      }
    | undefined
  > = resolveManagedLinearConnection
) {
  return async (id: string): Promise<RelayConnection | undefined> => {
    const resolved = await resolveConnection(id)
    return (
      resolved && {
        id,
        revision: resolved.connection.materialRevision,
        accessToken: resolved.credential.accessToken,
        credentialRevision: resolved.credential.tokenRevision,
      }
    )
  }
}

const audit = new DbIntegrationAuditRecorder()

/**
 * Records a terminal subscribe answer on the connection for the revision it was given for, so
 * Integrations can explain it and `linearRelayInterests` stops offering that revision. A reconnect
 * (new material revision) makes it stale and subscribes again.
 */
export async function recordLinearRelaySubscribeRejection(rejection: {
  connectionId: string
  connectionRevision: string
  code: string
}): Promise<void> {
  const updated = await db
    .update(integrationConnections)
    .set({ relaySubscribeErrorCode: rejection.code, relaySubscribeErrorRevision: rejection.connectionRevision })
    .where(
      and(
        eq(integrationConnections.id, rejection.connectionId),
        eq(integrationConnections.materialRevision, rejection.connectionRevision)
      )
    )
    .returning({ id: integrationConnections.id })
  if (!updated.length) return
  log.warn(`Hosted Linear relay refused connection ${rejection.connectionId}: ${rejection.code}`)
  await audit
    .record({
      connectionId: rejection.connectionId,
      action: 'linear_relay_subscribe',
      outcome: 'failed',
      code: rejection.code,
      at: new Date(),
    })
    .catch(() => undefined)
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export interface ManagedLinearConnection {
  connection: { id: string; materialRevision: string }
  configuration: { organizationId: string }
}

export interface LinearRelayDispatchDependencies {
  /** Live (not cached) lookup of the hosted app connection, fenced by ID. */
  resolveConnection(connectionId: string): Promise<ManagedLinearConnection | undefined>
  /** Durable deduplication: claimed before side effects, released on failure, completed after. */
  receipts: Pick<DbEventPollingDispatchStore, 'claim' | 'complete' | 'release'>
  /** The direct path's processing for one verified delivery (`processRelayedLinearDelivery`). */
  process(delivery: LinearRelayDelivery): Promise<void>
}

/** Receipt key for a relayed Linear delivery: Linear's `Linear-Delivery` ID. */
export function linearRelayReceiptKey(deliveryId: string) {
  return `linear:${deliveryId}`
}

export function createLinearRelayDispatcher(deps: LinearRelayDispatchDependencies) {
  return async function dispatch(delivery: LinearRelayDelivery, interests: LinearRelayInterest[]): Promise<void> {
    if (!interests.length) return
    const live = await deps.resolveConnection(delivery.connectionId)
    // Expiry or a refresh may race a successful pull. Leave the lease unacknowledged so a fresh token can retry.
    if (!live) throw new Error('relay_authorization_unavailable')
    // The connection moved on (reconnected) since this delivery was queued: stale, ack without dispatch.
    if (live.connection.materialRevision !== delivery.connectionRevision) return
    const payload = delivery.payload
    if (
      payload.organizationId !== delivery.resourceId ||
      payload.organizationId !== live.configuration.organizationId ||
      payload.type !== delivery.eventType
    ) {
      log.warn('Dropping a relayed Linear delivery whose body does not match its envelope or connection')
      return
    }
    const key = linearRelayReceiptKey(delivery.deliveryId)
    const claim = await deps.receipts.claim('linear', key, 120_000)
    if (claim.status === 'busy') throw new Error('relay_receipt_busy')
    if (claim.status === 'completed') return
    try {
      await deps.process(delivery)
      await deps.receipts.complete('linear', key, claim.leaseToken)
    } catch (error) {
      // A transient failure must not strand the claim for its lease: the relay redelivers this delivery ID.
      await deps.receipts.release('linear', key, claim.leaseToken)
      throw error
    }
  }
}

export interface LinearRelayAcknowledgeDependencies {
  resolveConnection: LinearRelayDispatchDependencies['resolveConnection']
  /** The acknowledgment step alone (`acknowledgeLinearSessionEvent`). */
  acknowledge(payload: Record<string, unknown>): Promise<void>
}

/**
 * The relay's `prepare` step: acknowledges every agent session `created` delivery in a pulled batch,
 * concurrently, before the batch is dispatched one delivery at a time. Without it a session waits
 * for the full processing of the deliveries ahead of it (a mention's `Comment` delivery arrives
 * first), which took a live mention 9.8 seconds against Linear's 10-second limit. The same fences
 * as dispatch apply: the live connection revision and the payload's organization.
 */
export function createLinearRelayAcknowledger(deps: LinearRelayAcknowledgeDependencies) {
  return async function acknowledgeBatch(deliveries: LinearRelayDelivery[]): Promise<void> {
    const sessions = deliveries.filter(
      (delivery) => delivery.eventType === 'AgentSessionEvent' && delivery.payload.action === 'created'
    )
    if (!sessions.length) return
    const results = await Promise.allSettled(
      sessions.map(async (delivery) => {
        const live = await deps.resolveConnection(delivery.connectionId)
        if (!live || live.connection.materialRevision !== delivery.connectionRevision) return
        const payload = delivery.payload
        if (
          payload.organizationId !== delivery.resourceId ||
          payload.organizationId !== live.configuration.organizationId
        )
          return
        await deps.acknowledge(payload)
      })
    )
    // The delivery's own processing acknowledges it again if this failed.
    for (const result of results)
      if (result.status === 'rejected') log.warn('Early acknowledgment of a relayed Linear session failed')
  }
}

/**
 * Runs a relayed delivery through the direct webhook's processing: the verified `linear-app` webhook
 * row (delivery ID deduplicated, Activity projected from it), then the registered `linear-app`
 * handlers (`processLinearAppEvent`). Platform verified the signature, freshness, type and client ID
 * before ingesting. Like the direct path, a handler failure is recorded on the row, not retried;
 * failing to store the row throws so the delivery is pulled again.
 *
 * A redelivery whose row is already finished (processed, or carrying a recorded handler error) was
 * handled by an earlier attempt that could not complete its receipt: it returns without running the
 * handlers again, so the receipt completes and the delivery is acknowledged. A stored row that was
 * never finished is processed.
 */
export async function processRelayedLinearDelivery(
  delivery: LinearRelayDelivery,
  dispatch: typeof dispatchVerifiedWebhookContext = dispatchVerifiedWebhookContext
): Promise<void> {
  const headers = { 'linear-delivery': delivery.deliveryId, 'linear-event': delivery.eventType }
  let eventId: string
  try {
    eventId = await storeWebhookEvent({
      provider: 'linear-app',
      eventType: delivery.eventType,
      payload: delivery.payload,
      headers,
      signature: null,
      verified: true,
      deliveryId: delivery.deliveryId,
    })
  } catch (error) {
    if (!(error instanceof DuplicateWebhookDeliveryError)) throw error
    // Stored by an earlier attempt that did not complete its receipt: process the stored row again.
    const [existing] = await db
      .select({ id: webhookEvents.id, processedAt: webhookEvents.processedAt, error: webhookEvents.error })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, delivery.deliveryId)))
    if (!existing) throw error
    // Already handled (or failed in a handler, which is never retried): do not handle it twice.
    if (existing.processedAt || existing.error) return
    eventId = existing.id
  }
  await materializeWebhookActivity('linear', eventId).catch((error) =>
    log.error(`Activity materialization failed for a relayed Linear ${delivery.eventType} delivery:`, error)
  )
  try {
    await dispatch({
      provider: 'linear-app',
      eventType: delivery.eventType,
      payload: delivery.payload,
      headers,
      rawBody: JSON.stringify(delivery.payload),
    })
    await markWebhookProcessed(eventId)
  } catch (error) {
    log.error(`Handler error for a relayed Linear ${delivery.eventType} delivery:`, error)
    await markWebhookError(eventId, publicErrorMessage(error))
  }
}

export const dispatchHostedLinearDelivery = createLinearRelayDispatcher({
  resolveConnection: resolveManagedLinearConnection,
  receipts: new DbEventPollingDispatchStore(),
  process: (delivery) => processRelayedLinearDelivery(delivery),
})

export const acknowledgeHostedLinearSessions = createLinearRelayAcknowledger({
  resolveConnection: resolveManagedLinearConnection,
  acknowledge: (payload) => acknowledgeLinearSessionEvent(payload),
})

export const hostedLinearRelayRuntime = new HostedIntegrationRelayRunner(linearRelayProvider, {
  managed: isPlatformManaged,
  interests: linearRelayInterests,
  resolve: createManagedLinearRelayResolver(),
  request: platformRequest,
  dispatch: (delivery, interests) => dispatchHostedLinearDelivery(delivery, interests),
  prepare: (deliveries) => acknowledgeHostedLinearSessions(deliveries),
  onSubscribeRejected: recordLinearRelaySubscribeRejection,
  onError: (code) => log.warn(`Hosted Linear delivery deferred: ${code}`),
})
