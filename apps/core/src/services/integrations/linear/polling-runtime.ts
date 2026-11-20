import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, integrationConnections, linearAgentSessions, webhookEvents } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { DbEventPollingCursorStore } from '../db-event-polling-cursor-store'
import { isIntegrationEnabled } from '../provider-state'
import { EventPollingRunner, type EventPollingWatch } from '../event-polling-runner'
import { processLinearAppEvent, processPolledLinearNotification } from './app-ingress'
import { isLinearAppConfiguration, linearPlugin, parseLinearConfiguration } from './plugin'
import {
  createLinearAgentSessionPolling,
  LINEAR_POLL_REQUESTS_PER_TICK,
  LINEAR_SESSION_RETRY_REQUESTS,
  LINEAR_POLL_WEBHOOK_RECENCY_MS,
  type LinearPollingDependencies,
} from './polling'
import { resolveLinearAppConnection } from './resolve-connection'
import { LINEAR_SESSION_RETRY_LIMIT, listUnfinishedLinearSessions, retryLinearSession } from './session-retry'

const log = createLogger('linear-polling')

/** The cursor key for one app connection in `integration_event_polling_cursors`. */
export function linearPollingResourceKey(connectionId: string) {
  return `linear-app:${connectionId}`
}

async function receivedRecentWebhook(organizationId: string, withinMs: number): Promise<boolean> {
  // `created_at` is written by the database clock, so the window is measured on it too.
  const [row] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, 'linear-app'),
        eq(webhookEvents.verified, true),
        sql`${webhookEvents.createdAt} >= now() - (${withinMs} * interval '1 millisecond')`,
        sql`${webhookEvents.payload}->>'organizationId' = ${organizationId}`
      )
    )
    .limit(1)
  return !!row
}

export const linearPollingDependencies: LinearPollingDependencies = {
  async resolveAuthorization(connectionId, configuration) {
    const resolved = await resolveLinearAppConnection(configuration.organizationId)
    return resolved?.connection.id === connectionId ? resolved.authorization : null
  },
  async installedAt(connectionId) {
    const [row] = await db
      .select({ createdAt: integrationConnections.createdAt })
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId))
    return row?.createdAt ?? null
  },
  receivedRecentWebhook,
  async knownSessions(ids) {
    if (!ids.length) return new Map()
    const rows = await db
      .select({
        id: linearAgentSessions.id,
        connectionId: linearAgentSessions.connectionId,
        ackState: linearAgentSessions.ackState,
        dispositionState: linearAgentSessions.dispositionState,
      })
      .from(linearAgentSessions)
      .where(inArray(linearAgentSessions.id, [...ids]))
    return new Map(rows.map((row) => [row.id, row]))
  },
  unfinishedSessions: (connectionId) => listUnfinishedLinearSessions(connectionId),
  retrySession: retryLinearSession,
}

/** The Linear provider's `event_polling` capability, with its database-backed dependencies. */
export const linearAgentSessionPolling = createLinearAgentSessionPolling(linearPollingDependencies)

/**
 * One watch per enabled Linear agent app connection. `active` selects the runner's fast cadence:
 * it is set while no verified app webhook arrived for the workspace in the last 15 minutes.
 */
export async function listLinearPollingWatches(): Promise<EventPollingWatch[]> {
  // Like the webhook route: a disabled Linear integration receives nothing.
  if (!(await isIntegrationEnabled('linear'))) return []
  const rows = await db
    .select({
      id: integrationConnections.id,
      adapterVersion: integrationConnections.adapterVersion,
      configuration: integrationConnections.configuration,
    })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        eq(integrationConnections.authorizationKind, 'oauth2'),
        eq(integrationConnections.enabled, true)
      )
    )
  const watches: EventPollingWatch[] = []
  for (const row of rows) {
    let configuration
    try {
      configuration = parseLinearConfiguration(row.configuration)
    } catch {
      continue
    }
    if (!isLinearAppConfiguration(configuration)) continue
    const recent = await receivedRecentWebhook(configuration.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)
    watches.push({
      providerKey: 'linear',
      resourceKey: linearPollingResourceKey(row.id),
      active: !recent,
      // Connection-scoped, not squad-scoped: every session is acknowledged, routed or not.
      connection: { id: row.id, squadId: '', providerKey: 'linear', adapterVersion: row.adapterVersion, configuration },
    })
  }
  return watches
}

/** Hands a polled event to the same processing as the direct webhook. */
export async function dispatchPolledLinearEvent(event: { type: string; payload: unknown }): Promise<void> {
  const payload =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null
  if (!payload) return
  if (event.type === 'AppUserNotification') return processPolledLinearNotification(payload)
  if (event.type === 'AgentSessionEvent') await processLinearAppEvent({ type: event.type, payload }, { polled: true })
}

/**
 * The Linear polling fallback's scheduler, separate from the GitHub poller so neither's budget or
 * cadence affects the other. Polls run every 60 seconds (5 minutes while app webhooks arrive), with
 * no jitter, and make at most three queries each: at most 180 queries per connection per hour. Retries
 * of unfinished sessions add at most three calls per session (two acknowledgment attempts and the
 * disposition), for at most five spaced-out sessions.
 */
export const linearAgentSessionPollingRuntime = new EventPollingRunner({
  listWatches: listLinearPollingWatches,
  cursorStore: new DbEventPollingCursorStore(),
  resolveCapability: (watch) =>
    watch.providerKey === 'linear' ? linearPlugin.runtime.provider.capabilities.event_polling : undefined,
  // Deduplication is the delivery receipt the webhook path also claims (`withLinearDeliveryReceipt`).
  dispatch: (event) => dispatchPolledLinearEvent(event),
  onError: (error) => {
    log.warn(`Linear polling failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`)
  },
  scanIntervalMs: 15_000,
  maxResourcesPerTick: 20,
  // Room for every watch's queries plus one connection's full retry sweep.
  maxBudgetUnitsPerTick:
    20 * LINEAR_POLL_REQUESTS_PER_TICK + LINEAR_SESSION_RETRY_LIMIT * LINEAR_SESSION_RETRY_REQUESTS,
  // Routing a backlog (probe, rules, decision conditions) runs inside the poll's deadline.
  leaseMs: 300_000,
  pollTimeoutMs: 240_000,
  failureBackoffMinMs: 60_000,
  failureBackoffMaxMs: 300_000,
  random: () => 0,
})
