import { isPlatformManaged } from '../../secrets/managed'
import { platformRequest } from '../../platform/instance-client'
import { slackRelayPullResponse } from '@ficus/shared/integration-relay'
import type { SlackRelayDelivery } from '@ficus/shared/integration-relay'
import { channelConnections } from '../channels/connections'
import { resolveManagedSlackConnection } from '../channels/resolve-managed-slack'
import type { SlackConfiguration } from '../channels/plugins'
import { slackProvider } from '../../../channels/slack'
import { dispatchParsedChannelEvent, type HandlerResult } from '../../../channels/handler'
import type { ChannelProvider } from '../../../channels/provider'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbIntegrationAuditRecorder } from '../db-audit'
import { createLogger } from '../../../lib/infra/logger'
import { HostedIntegrationRelayRunner, type HostedRelayProvider } from './runner'

const log = createLogger('hosted-slack-relay')

export interface SlackRelayInterest {
  connectionId: string
  teamId: string
}

/**
 * Exactly one interest — a managed Slack connection has a single team — when
 * a usable ("Add to Slack") connection is active; otherwise none, so the
 * runner unsubscribes any remote leftover for this instance.
 */
async function slackRelayInterests(): Promise<SlackRelayInterest[]> {
  const state = channelConnections.get('slack')
  if (!state || state.authority !== 'platform_broker') return []
  const teamId = (state.configuration as SlackConfiguration).teamId
  return teamId ? [{ connectionId: state.id, teamId }] : []
}

export const slackRelayProvider: HostedRelayProvider<SlackRelayInterest, SlackRelayDelivery> = {
  key: 'slack',
  runnerName: 'hosted-slack-relay',
  // Chat latency matters more here than for GitHub's issue/PR polling: a
  // slower cadence would make every mention and slash command feel laggy.
  intervalMs: 2_000,
  pullResponseSchema: slackRelayPullResponse,
  // No provider-specific subscribe fields: the platform derives team
  // identity from the token itself (see slackRelaySubscribeRequest).
  subscribeExtra: () => ({}),
  matchesDelivery: (interest, delivery) => interest.teamId === delivery.resourceId,
}

/**
 * Wraps `resolveManagedSlackConnection` for the relay runner's `resolve` hook.
 * The snapshot (`slackRelayInterests`) can keep advertising an interest while
 * the live, revision-fenced lookup returns nothing — e.g. mid degraded
 * revalidation. That's expected to self-heal on its own and shouldn't spam a
 * log on every ~2s tick, but a stall that never recovers needs to be
 * diagnosable: log once on the transition into "unresolvable", not again
 * until it either recovers or fails afresh.
 */
export function createManagedSlackRelayResolver(
  resolveConnection: (
    id: string
  ) => Promise<
    { connection: { id: string; materialRevision: string }; credential: { accessToken: string } } | undefined
  > = resolveManagedSlackConnection
) {
  let unresolvable = false
  return async (id: string) => {
    const resolved = await resolveConnection(id)
    if (!resolved) {
      if (!unresolvable) {
        log.warn(
          `Managed Slack connection ${id} is advertised but not currently resolvable; relay delivery is stalled for it`
        )
        unresolvable = true
      }
      return undefined
    }
    unresolvable = false
    return { id, revision: resolved.connection.materialRevision, accessToken: resolved.credential.accessToken }
  }
}

export const hostedSlackRelayRuntime = new HostedIntegrationRelayRunner(slackRelayProvider, {
  managed: isPlatformManaged,
  interests: slackRelayInterests,
  resolve: createManagedSlackRelayResolver(),
  request: platformRequest,
  dispatch: (delivery, interests) => dispatchHostedSlackDelivery(delivery, interests),
  onError: (code) => log.warn(`Hosted Slack delivery deferred: ${code}`),
})

// ── Dispatch ─────────────────────────────────────────────────────────────

export interface ManagedSlackConnection {
  connection: { id: string; materialRevision: string }
  configuration: SlackConfiguration
}

export interface SlackRelayDispatchDependencies {
  /** Live (not snapshot-cached) lookup of the managed connection, fenced by id. */
  resolveConnection(connectionId: string): Promise<ManagedSlackConnection | undefined>
  /** Injected so tests can supply a fake channel provider instead of the real Slack API client. */
  provider: ChannelProvider
  /** `slackProvider.parseWebhook` → ignore null/challenge → `dispatchParsedChannelEvent`, the same chain the direct webhook runs. */
  dispatchWebhook(provider: ChannelProvider, payload: Record<string, unknown>): Promise<HandlerResult | undefined>
  /** Durable dedup, claimed before side effects, released on failure, completed after success. */
  receipts: Pick<DbEventPollingDispatchStore, 'claim' | 'complete' | 'release'>
  /** POSTs a slash command's synchronous response body to Slack's `response_url`. */
  postResponseUrl(responseUrl: string, body: unknown): Promise<void>
  markReauthorizationRequired(input: { id: string; materialRevision: string; code: string }): Promise<boolean>
  /** Refreshes the in-memory snapshot transports read from, so they stop using a revoked connection immediately. */
  refreshChannelConnections(): Promise<void>
  audit(event: { connectionId: string; action: string; outcome: 'succeeded' | 'failed'; code?: string }): Promise<void>
}

function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com'
  } catch {
    return false
  }
}

async function handleSlashCommandDelivery(
  deps: SlackRelayDispatchDependencies,
  payload: Record<string, unknown>
): Promise<void> {
  const result = await deps.dispatchWebhook(deps.provider, payload)
  if (!result || result.emptyResponse || result.response == null) return
  // Slack already got its ack from the platform relay within its 3s budget;
  // a synchronous response body (sync commands, immediate replies, the
  // configuration error) can only reach the user through response_url now.
  const responseUrl = payload.response_url
  if (!isSlackResponseUrl(responseUrl)) {
    log.warn('Slack slash command relay delivery has no usable response_url; dropping the visible reply')
    return
  }
  // Nothing has been posted to Slack for this reply yet — response_url is
  // the only delivery path for it — so a failed POST is safe to retry.
  await deps.postResponseUrl(responseUrl, result.response)
}

async function markConnectionRevoked(
  deps: SlackRelayDispatchDependencies,
  live: ManagedSlackConnection,
  code: string
): Promise<void> {
  const updated = await deps.markReauthorizationRequired({
    id: live.connection.id,
    materialRevision: live.connection.materialRevision,
    code,
  })
  // Already reauthorization_required (e.g. a duplicate uninstall/revocation
  // notice), or the connection changed under us: nothing new to do, and
  // nothing to re-revoke against an already-revoked token.
  if (!updated) return
  await deps.audit({ connectionId: live.connection.id, action: 'slack_relay_revocation', outcome: 'failed', code })
  await deps.refreshChannelConnections()
}

async function handleSlackRelayDelivery(
  deps: SlackRelayDispatchDependencies,
  delivery: SlackRelayDelivery,
  live: ManagedSlackConnection
): Promise<void> {
  switch (delivery.eventType) {
    case 'event_callback': {
      const payload = delivery.payload as { team_id?: string }
      if (payload.team_id !== delivery.resourceId || payload.team_id !== live.configuration.teamId) {
        log.warn('Dropping Slack event_callback for a team that does not match the delivery or the connection')
        return
      }
      await deps.dispatchWebhook(deps.provider, delivery.payload)
      return
    }
    case 'slash_command': {
      const payload = delivery.payload as { team_id?: string }
      if (payload.team_id !== delivery.resourceId || payload.team_id !== live.configuration.teamId) {
        log.warn('Dropping Slack slash_command for a team that does not match the delivery or the connection')
        return
      }
      await handleSlashCommandDelivery(deps, delivery.payload as Record<string, unknown>)
      return
    }
    case 'app_uninstalled':
      await markConnectionRevoked(deps, live, 'provider_access_revoked')
      return
    case 'tokens_revoked': {
      const payload = delivery.payload as { event?: { tokens?: { bot?: unknown } } }
      const revokedBots = payload.event?.tokens?.bot
      const botUserId = live.configuration.botUserId
      if (botUserId && Array.isArray(revokedBots) && revokedBots.includes(botUserId)) {
        await markConnectionRevoked(deps, live, 'provider_access_revoked')
      }
      return
    }
    default:
      return
  }
}

/**
 * Builds the relay dispatcher with injected dependencies (tests) or the real
 * ones (production, see `dispatchHostedSlackDelivery` below).
 */
export function createSlackRelayDispatcher(deps: SlackRelayDispatchDependencies) {
  return async function dispatch(delivery: SlackRelayDelivery, interests: SlackRelayInterest[]): Promise<void> {
    if (!interests.length) return
    const live = await deps.resolveConnection(delivery.connectionId)
    // Expiry may race a successful pull. Leave the lease unacknowledged so fresh authorization can retry.
    if (!live) throw new Error('relay_authorization_unavailable')
    // The connection moved on (rotated/re-authorized) since this delivery was queued: stale, ack without dispatch.
    if (live.connection.materialRevision !== delivery.connectionRevision) return

    if (delivery.eventType === 'event_callback') {
      // Parse before claiming: most relayed events are filtered out here as
      // non-actionable and would otherwise insert a durable receipt row for
      // nothing (mirrors the same rule in routes/webhooks.ts for the direct
      // webhook path). The team cross-check still happens in
      // `handleSlackRelayDelivery` below, once there is something to dispatch.
      const parsed = await deps.provider.parseWebhook(delivery.payload, {})
      if (!parsed || ('type' in parsed && (parsed.type === 'pong' || parsed.type === 'challenge'))) return
    }

    const key = `relay:${delivery.connectionId}:${delivery.deliveryId}`
    const claim = await deps.receipts.claim('slack', key, 120_000)
    if (claim.status === 'busy') throw new Error('relay_receipt_busy')
    if (claim.status === 'completed') return

    try {
      await handleSlackRelayDelivery(deps, delivery, live)
      await deps.receipts.complete('slack', key, claim.leaseToken)
    } catch (error) {
      // A transient handler failure must not strand the claim for the rest of
      // its 120s lease: the relay's own redelivery of this deliveryId needs to
      // see this as reclaimable, or the event is silently lost forever.
      await deps.receipts.release('slack', key, claim.leaseToken)
      throw error
    }
  }
}

export async function defaultDispatchWebhook(
  provider: ChannelProvider,
  payload: Record<string, unknown>
): Promise<HandlerResult | undefined> {
  const parsed = await provider.parseWebhook(payload, {})
  if (!parsed) return undefined
  if ('type' in parsed && (parsed.type === 'pong' || parsed.type === 'challenge')) return undefined
  return dispatchParsedChannelEvent(provider, payload, parsed)
}

async function defaultPostResponseUrl(responseUrl: string, body: unknown): Promise<void> {
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`slack_response_url_failed:${response.status}`)
}

const slackRelayReceipts = new DbEventPollingDispatchStore()
const slackRelayConnectionRepository = new DbIntegrationConnectionRepository()
const slackRelayAudit = new DbIntegrationAuditRecorder()

export const dispatchHostedSlackDelivery = createSlackRelayDispatcher({
  resolveConnection: resolveManagedSlackConnection,
  provider: slackProvider,
  dispatchWebhook: defaultDispatchWebhook,
  receipts: slackRelayReceipts,
  postResponseUrl: defaultPostResponseUrl,
  markReauthorizationRequired: (input) => slackRelayConnectionRepository.markReauthorizationRequired(input),
  refreshChannelConnections: () => channelConnections.refresh(),
  audit: (event) => slackRelayAudit.record({ ...event, at: new Date() }),
})
