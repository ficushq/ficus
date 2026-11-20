import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import type { IntegrationOutputFact } from '@ficus/shared'
import {
  db,
  integrationConnectionAssignments,
  integrationConnections,
  integrationOutputDeliveries,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  linearAgentSessions,
  squads,
  workStreams,
} from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { publishIntegrationOutput } from '../outputs/runtime'
import { resolveEventRuleDecisions } from '../outputs/default-routing'
import type { IntegrationOutputAuthority } from '../outputs/types'
import { isLinearAppConfiguration, parseLinearConfiguration, type LinearAppConfiguration } from './plugin'
import { LINEAR_APP_USER_METADATA_KEY, linearOutputAdapter, normalizeLinearUndelegationNotification } from './outputs'
import { linearDeliveryKey, withLinearDeliveryReceipt } from './delivery-receipts'
import {
  isTrustedLinearUser,
  linearActorType,
  probeLinearAppEvent,
  probeLinearUser,
  type LinearAppProbe,
  type LinearProbedUser,
} from './app-api'
import { resolveLinearAppConnection } from './resolve-connection'
import { acknowledgeLinearSession, type AcknowledgeDependencies } from './session-acknowledger'
import {
  postLinearSessionDisposition,
  reduceLinearSessionOutcomes,
  type LinearSessionDisposition,
  type LinearSquadOutcome,
} from './session-disposition'
import { announceLinearSessionBinding, bindLinearSession } from './session-binding'
import {
  applyLinearPermissionChange,
  isTeamKnownInaccessible,
  recordLinearTeamAccessProbe,
  recordLinearTeamReadable,
} from './team-access'
import { handleLinearAppRevoked } from './app-revocation'
import { handleBoundSessionPrompt } from './session-prompts'
import { isProactiveLinearSession } from './proactive-session'

const log = createLogger('linear-app-ingress')

/** Events whose `appUserId` must name the connection's app user. */
const APP_USER_EVENTS = new Set(['AgentSessionEvent', 'AppUserNotification', 'PermissionChange'])
/** Abuse limit (7.2): sessions per workspace per hour that are routed beyond the acknowledgment. */
export const LINEAR_SESSIONS_PER_HOUR = 60
const USER_CACHE_MS = 10 * 60_000

type Resolved = NonNullable<Awaited<ReturnType<typeof resolveLinearAppConnection>>>
type OutputEvent = typeof integrationOutputEvents.$inferSelect

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}
function text(value: unknown, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** The actor's trust, cached 10 minutes per connection and user (5.6). */
const userCache = new Map<string, { user: LinearProbedUser | null; expiresAt: number }>()
export function clearLinearUserCacheForTest() {
  userCache.clear()
}

export interface LinearAppIngressDependencies extends AcknowledgeDependencies {
  /** Set by the polling fallback (5.7): a delivery being processed elsewhere fails the poll for a retry. */
  polled?: boolean
}

/**
 * Processes one verified Linear agent app delivery (direct webhook today, the hosted relay later),
 * after the HTTP response. The connection is selected by `organizationId`; `appUserId` must match it
 * for session, notification and permission events.
 */
export async function processLinearAppEvent(
  event: { type: string; payload: Record<string, unknown> },
  dependencies: LinearAppIngressDependencies = {}
): Promise<void> {
  const organizationId = text(event.payload.organizationId)
  if (!organizationId) return
  if (event.type === 'OAuthApp') {
    if (event.payload.action === 'revoked') await handleLinearAppRevoked(organizationId)
    return
  }
  const resolved = await resolveLinearAppConnection(organizationId)
  if (!resolved) {
    log.info(`No usable Linear app connection for a ${event.type} delivery`)
    return
  }
  if (APP_USER_EVENTS.has(event.type) && text(event.payload.appUserId) !== resolved.configuration.appUserId) return
  if (event.type === 'PermissionChange') {
    if (event.payload.action === 'teamAccessChanged')
      await applyLinearPermissionChange(resolved.connection.id, event.payload, resolved.authorization)
    return
  }
  // Inbox notifications feed Activity only in this phase; mentions and delegations come from sessions.
  if (event.type === 'AppUserNotification') return
  if (event.type === 'AgentSessionEvent') return processSessionEvent(resolved, event.payload, dependencies)
  if (event.type === 'Issue' || event.type === 'Comment') await routeLinearAppEvent(resolved, event)
}

async function processSessionEvent(
  resolved: Resolved,
  payload: Record<string, unknown>,
  dependencies: LinearAppIngressDependencies
) {
  const session = record(payload.agentSession)
  const sessionId = text(session.id)
  if (!sessionId) return
  const options = { retryWhenBusy: dependencies.polled === true }
  // Webhook and poll claim the same receipt, so a session or prompt seen both ways is handled once.
  const activityId = text(record(payload.agentActivity).id)
  if (payload.action === 'created') {
    await withLinearDeliveryReceipt(
      linearDeliveryKey.sessionCreated(sessionId),
      () => processSessionCreated(resolved, sessionId, session, payload, dependencies),
      options
    )
    // A `created` event that names its opening prompt activity settles that activity's receipt, so the
    // prompt is never delivered again as `prompted` (by a later poll or a stray webhook).
    if (activityId) await withLinearDeliveryReceipt(linearDeliveryKey.prompt(activityId), async () => undefined)
    return
  }
  if (payload.action !== 'prompted') return
  if (!activityId) return
  await withLinearDeliveryReceipt(
    linearDeliveryKey.prompt(activityId),
    () => processSessionPrompted(resolved, sessionId, activityId, payload),
    options
  )
}

/**
 * A polled `issueUnassignedFromYou` notification (5.7): the app's own undelegation, recovered when
 * the `Issue` webhook that normally reports it never arrived. Webhook notifications still produce
 * no outputs (5.2); the `Issue` webhook's `issue.undelegated` for the same change is recognized by
 * `withoutRepeatedUndelegations`, so the change is recorded once whichever path reports it first.
 */
export async function processPolledLinearNotification(payload: Record<string, unknown>): Promise<void> {
  const organizationId = text(payload.organizationId)
  const notificationId = text(record(payload.notification).id)
  if (!organizationId || !notificationId) return
  const resolved = await resolveLinearAppConnection(organizationId)
  if (!resolved || text(payload.appUserId) !== resolved.configuration.appUserId) return
  const facts = normalizeLinearUndelegationNotification(payload, resolved.configuration.appUserId)
  if (!facts.length) return
  await withLinearDeliveryReceipt(
    linearDeliveryKey.notification(notificationId),
    async () => void (await routeLinearAppEvent(resolved, { type: 'AppUserNotification', payload }, facts)),
    { retryWhenBusy: true }
  )
}

/**
 * The acknowledgment alone, for an `AgentSessionEvent` `created` delivery that would otherwise wait
 * its turn: the hosted relay handles a pulled batch one delivery at a time, and a mention's `Comment`
 * delivery usually comes first, so its enrichment probes and fan-out would run before the session is
 * acknowledged. The relay calls this for the whole batch first; processing the delivery later finds
 * the acknowledgment sent and does not post it again.
 */
export async function acknowledgeLinearSessionEvent(
  payload: Record<string, unknown>,
  dependencies: AcknowledgeDependencies = {}
): Promise<void> {
  if (payload.type !== 'AgentSessionEvent' || payload.action !== 'created') return
  const organizationId = text(payload.organizationId)
  const session = record(payload.agentSession)
  const sessionId = text(session.id)
  if (!organizationId || !sessionId) return
  const resolved = await resolveLinearAppConnection(organizationId)
  if (!resolved || text(payload.appUserId) !== resolved.configuration.appUserId) return
  await acknowledgeSessionCreated(resolved, sessionId, session, payload, dependencies)
}

/** The acknowledgment step of `created`; null when there is nothing to acknowledge or route. */
async function acknowledgeSessionCreated(
  resolved: Resolved,
  sessionId: string,
  session: Record<string, any>,
  payload: Record<string, unknown>,
  dependencies: AcknowledgeDependencies
) {
  // Ficus's own `--linear-session` session is bound by the request that opened it: no rules run.
  if (
    await isProactiveLinearSession({
      connectionId: resolved.connection.id,
      sessionId,
      issueId: text(session.issueId) || text(record(session.issue).id) || undefined,
    })
  )
    return null
  // Before any rule, decision predicate or squad fan-out.
  const row = await acknowledgeLinearSession(
    {
      connectionId: resolved.connection.id,
      organizationId: resolved.configuration.organizationId,
      authorization: resolved.authorization,
      payload,
    },
    dependencies
  )
  // No row, or a session the app opened on itself: there is no request to route.
  return row && row.trigger !== 'proactive' ? row : null
}

async function processSessionCreated(
  resolved: Resolved,
  sessionId: string,
  session: Record<string, any>,
  payload: Record<string, unknown>,
  dependencies: LinearAppIngressDependencies
) {
  const row = await acknowledgeSessionCreated(resolved, sessionId, session, payload, dependencies)
  if (!row) return
  const dispose = (disposition: LinearSessionDisposition) =>
    postLinearSessionDisposition({ sessionId, authorization: resolved.authorization, disposition })
  if (!text(session.issueId) && !text(record(session.issue).id)) return void (await dispose({ kind: 'no-issue' }))
  const [recent] = await db
    .select({ value: count() })
    .from(linearAgentSessions)
    .where(
      and(
        eq(linearAgentSessions.organizationId, resolved.configuration.organizationId),
        gte(linearAgentSessions.createdAt, new Date(Date.now() - 3_600_000)),
        sql`${linearAgentSessions.id} <> ${sessionId}`
      )
    )
  if ((recent?.value ?? 0) >= LINEAR_SESSIONS_PER_HOUR) return void (await dispose({ kind: 'busy' }))
  const routed = await routeLinearAppEvent(resolved, { type: 'AgentSessionEvent', payload })
  if (!routed) return
  if (!routed.accessible) return void (await dispose({ kind: 'inaccessible' }))
  const outcomes = [...routed.outcomes]
  if (await bindTrackingStream(resolved, sessionId, routed.authorizedSquadIds)) outcomes.push('started')
  await dispose(reduceLinearSessionOutcomes(outcomes))
}

async function processSessionPrompted(
  resolved: Resolved,
  sessionId: string,
  activityId: string,
  payload: Record<string, unknown>
) {
  const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
  if (row?.workStreamId && row.connectionId === resolved.connection.id) {
    // A bound session's prompts belong to its stream (6.4) and are delivered there directly, never
    // through the rules or the tracked issue's subscriptions, so a flow that does not follow
    // integration changes still hears them, and one that does hears them once.
    const outcome = await handleBoundSessionPrompt({ authorization: resolved.authorization, session: row, payload })
    if (outcome === 'consumed') return
    // The stream is done or canceled: the prompt goes through the rules like an unbound session's.
  }
  const routed = await routeLinearAppEvent(resolved, { type: 'AgentSessionEvent', payload })
  if (!routed) return
  await postLinearSessionDisposition({
    sessionId,
    authorization: resolved.authorization,
    projectionKey: `disposition:${activityId}`,
    disposition: routed.accessible ? reduceLinearSessionOutcomes(routed.outcomes) : { kind: 'inaccessible' },
  })
}

/**
 * The routing half of 5.4 for app connections: one enrichment probe with the app token, shared by
 * every squad on the connection, then publication under each assigned squad's authority. Returns
 * undefined when the event has nothing to route, and each authorized squad's outcome for the fact
 * a session event routes on (`issue.delegated`, `issue.mentioned` or `agent_session.prompted`).
 */
export async function routeLinearAppEvent(
  resolved: Resolved,
  event: { type: string; payload: Record<string, unknown> },
  normalized?: IntegrationOutputFact[]
): Promise<{ accessible: boolean; outcomes: LinearSquadOutcome[]; authorizedSquadIds: string[] } | undefined> {
  const appUserId = resolved.configuration.appUserId
  const facts = await withoutRepeatedUndelegations(
    resolved.connection.id,
    normalized ??
      linearOutputAdapter.normalize({
        type: event.type,
        payload: event.payload,
        metadata: { [LINEAR_APP_USER_METADATA_KEY]: appUserId },
      })
  )
  if (!facts.length) return undefined
  const first = facts[0]!
  const issueId = first.resourceKey
  const teamId = text(first.data.teamId)
  if (teamId && (await isTeamKnownInaccessible(resolved.connection.id, teamId)))
    return { accessible: false, outcomes: [], authorizedSquadIds: [] }
  const actorId = text(first.data.actor)
  const commentId = event.type === 'Comment' ? text(record(first.data.comment).id) : ''
  let probe: LinearAppProbe
  try {
    probe = await probeLinearAppEvent(resolved.authorization, { issueId, ...(commentId ? { commentId } : {}) })
  } catch (error) {
    // A GraphQL error is Linear refusing the read: the app cannot see this issue.
    if (error instanceof Error && error.message === 'provider_query_failed')
      return { accessible: false, outcomes: [], authorizedSquadIds: [] }
    throw error
  }
  if (!probe.issue || probe.issue.id !== issueId) return { accessible: false, outcomes: [], authorizedSquadIds: [] }
  await recordLinearTeamAccessProbe(resolved.connection.id, resolved.authorization).catch(() => undefined)
  if (probe.issue.team?.id) await recordLinearTeamReadable(resolved.connection.id, probe.issue.team.id)
  let user: LinearProbedUser | null = null
  if (commentId) user = probe.comment?.user ?? null
  else if (actorId) {
    const cacheKey = `${resolved.connection.id}:${actorId}`
    const cached = userCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) user = cached.user
    else {
      user = await probeLinearUser(resolved.authorization, actorId)
      // Only a definite answer is cached; a failed lookup is asked again next time.
      if (user) userCache.set(cacheKey, { user, expiresAt: Date.now() + USER_CACHE_MS })
    }
  }
  const enriched = facts.flatMap((fact) => {
    const next = enrichFact(fact, probe, user, appUserId, event.type === 'AgentSessionEvent')
    return next ? [next] : []
  })
  const actorTrust = isTrustedLinearUser(user) ? 'trusted' : 'untrusted'
  const assignments = await db
    .select({ squadId: integrationConnectionAssignments.squadId })
    .from(integrationConnectionAssignments)
    .innerJoin(squads, eq(squads.id, integrationConnectionAssignments.squadId))
    .where(
      and(
        eq(integrationConnectionAssignments.connectionId, resolved.connection.id),
        eq(integrationConnectionAssignments.providerKey, 'linear'),
        eq(squads.status, 'active')
      )
    )
  const routedOutput = enriched.find((fact) =>
    ['issue.delegated', 'issue.mentioned', 'agent_session.prompted'].includes(fact.output)
  )
  const outcomes: LinearSquadOutcome[] = []
  const authorizedSquadIds: string[] = []
  for (const { squadId } of assignments) {
    const authority: IntegrationOutputAuthority = {
      kind: 'connection',
      connectionId: resolved.connection.id,
      squadId,
      connectionRevision: resolved.connection.materialRevision,
      accountId: appUserId,
      actorTrust,
    }
    let routedEventId: string | undefined
    try {
      for (const fact of enriched) {
        const eventId = await publishIntegrationOutput('linear', fact, authority)
        if (fact === routedOutput) routedEventId = eventId
      }
    } catch (error) {
      log.warn(`Linear app event not published for a squad: ${error instanceof Error ? error.message : 'error'}`)
      continue
    }
    authorizedSquadIds.push(squadId)
    if (routedEventId) outcomes.push(await squadOutcome(routedEventId, squadId, appUserId))
  }
  return { accessible: true, outcomes, authorizedSquadIds }
}

/** How far apart an `Issue` webhook's undelegation and the polled notification for it may be timed. */
export const LINEAR_UNDELEGATION_MATCH_MS = 2 * 60_000

/**
 * Drops an `issue.undelegated` fact when this connection already recorded the same undelegation
 * (issue and removed delegate, within two minutes) under another event key. The `Issue` webhook keys
 * it by the issue's `updatedAt` and the polled notification by its own `createdAt`, so the two paths
 * cannot share a key; this keeps the change recorded once in either order.
 *
 * The check reads before it records, so a webhook and a poll processed at the same moment could both
 * record it. That is accepted: the webhook is processed within seconds of the change while a poll
 * usually reads it much later, and a duplicate only repeats a manager notice.
 */
async function withoutRepeatedUndelegations(
  connectionId: string,
  facts: IntegrationOutputFact[]
): Promise<IntegrationOutputFact[]> {
  const kept: IntegrationOutputFact[] = []
  for (const fact of facts) {
    const at = Date.parse(fact.occurredAt)
    if (fact.output !== 'issue.undelegated' || !Number.isFinite(at)) {
      kept.push(fact)
      continue
    }
    const earlier = await db
      .select({ occurredAt: sql<string>`${integrationOutputEvents.fact}->>'occurredAt'` })
      .from(integrationOutputEvents)
      .where(
        and(
          eq(integrationOutputEvents.integration, 'linear'),
          sql`${integrationOutputEvents.fact}->>'resourceKey' = ${fact.resourceKey}`,
          sql`${integrationOutputEvents.fact}->>'output' = 'issue.undelegated'`,
          sql`${integrationOutputEvents.fact}->'data'->>'delegate' = ${text(fact.data.delegate)}`,
          sql`${integrationOutputEvents.eventKey} <> ${fact.eventKey}`,
          sql`${integrationOutputEvents.authority}->>'connectionId' = ${connectionId}`
        )
      )
      .orderBy(desc(integrationOutputEvents.createdAt))
      .limit(50)
    // Times are compared here: Postgres does not parse every timestamp form Linear payloads may use.
    if (!earlier.some((row) => Math.abs(Date.parse(row.occurredAt) - at) <= LINEAR_UNDELEGATION_MATCH_MS))
      kept.push(fact)
  }
  return kept
}

/** Facts gain the probed issue details and actor type; a session delegation must be confirmed live. */
function enrichFact(
  fact: IntegrationOutputFact,
  probe: LinearAppProbe,
  user: LinearProbedUser | null,
  appUserId: string,
  fromSession: boolean
): IntegrationOutputFact | null {
  const issue = probe.issue!
  const delegate = issue.delegate?.id ?? ''
  // Mirrors canReceiveLinearEvent's live assignee check: the issue must really be delegated to the app.
  if (fromSession && fact.output === 'issue.delegated' && delegate !== appUserId) return null
  const data: Record<string, unknown> = { ...fact.data }
  const current = record(data.issue)
  data.issue = {
    ...current,
    ...(typeof issue.number === 'number' ? { number: issue.number } : {}),
    ...(issue.identifier ? { identifier: issue.identifier } : {}),
  }
  if (issue.team?.id) data.teamId = issue.team.id
  if (issue.team?.key) data.teamKey = issue.team.key.toLowerCase()
  if (issue.labels?.nodes) data.labels = issue.labels.nodes.map((label) => text(label.name)).filter(Boolean)
  // Assignment and delegation outputs report the user who changed; everything else reports the issue's current state.
  if (!['issue.assigned', 'issue.unassigned'].includes(fact.output)) data.assignee = issue.assignee?.id ?? ''
  if (!['issue.delegated', 'issue.undelegated'].includes(fact.output)) data.delegate = delegate
  data.actorType = linearActorType(user)
  if (fact.output === 'issue.comment' && probe.comment?.user?.id)
    data.comment = { ...record(data.comment), author: probe.comment.user.id }
  if (fact.output === 'issue.comment' && probe.comment) {
    const owned = [probe.comment.agentSession, probe.comment.parent?.agentSession].find(
      (session) => session?.appUser?.id === appUserId
    )
    if (owned) {
      data.session = { id: owned.id }
      // Delivered to a tracking stream once, as agent_session.prompted, never also as a comment (6.4).
      data.comment = { ...record(data.comment), inSession: true }
    }
  }
  return {
    ...fact,
    data,
    ...(!fact.url && issue.url ? { url: issue.url } : {}),
  }
}

/** What a squad did with the routed fact: a stream took it, the manager or a consultant heard, or nothing. */
async function squadOutcome(eventId: string, squadId: string, appUserId: string): Promise<LinearSquadOutcome> {
  const [run] = await db
    .select({ workStreamId: integrationOutputTriggerRuns.workStreamId })
    .from(integrationOutputTriggerRuns)
    .where(and(eq(integrationOutputTriggerRuns.eventId, eventId), eq(integrationOutputTriggerRuns.squadId, squadId)))
    .limit(1)
  if (run?.workStreamId) return 'started'
  const [delivered] = await db
    .select({ id: integrationOutputDeliveries.id })
    .from(integrationOutputDeliveries)
    .innerJoin(workStreams, eq(workStreams.id, integrationOutputDeliveries.workStreamId))
    .where(and(eq(integrationOutputDeliveries.eventId, eventId), eq(workStreams.squadId, squadId)))
    .limit(1)
  if (delivered) return 'started'
  const [event] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
  const [squad] = await db
    .select({ id: squads.id, metadata: squads.metadata, managerAgentId: squads.managerAgentId })
    .from(squads)
    .where(eq(squads.id, squadId))
  if (!event || !squad) return 'ignored'
  // Answers to decision conditions are cached per event, so this asks no model a second time.
  const { rule } = await resolveEventRuleDecisions(event as OutputEvent, squad, appUserId, [
    'notify-manager',
    'notify-consultant',
    'start-workstream',
  ])
  if (!rule || rule.action.type === 'ignore') return 'ignored'
  // A held start-workstream (untrusted author) still notifies the manager.
  if (rule.action.type === 'notify-consultant') return 'notified'
  return squad.managerAgentId ? 'notified' : 'ignored'
}

/**
 * A session opened on an issue an active stream of an assigned squad already tracks under this
 * connection binds to that stream (a later mention of an issue Ficus is working on).
 */
async function bindTrackingStream(resolved: Resolved, sessionId: string, squadIds: string[]): Promise<boolean> {
  if (!squadIds.length) return false
  const [session] = await db
    .select()
    .from(linearAgentSessions)
    .where(and(eq(linearAgentSessions.id, sessionId), isNull(linearAgentSessions.workStreamId)))
  if (!session?.issueId) return false
  const [stream] = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.squadId, squadIds),
        inArray(workStreams.status, ['active', 'queued']),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(${workStreams.metadata}->'tracked')='array'
            THEN ${workStreams.metadata}->'tracked' ELSE '[]'::jsonb END) t
          WHERE t->>'integration'='linear' AND t->>'externalId'=${session.issueId}
            AND t->>'connectionId'=${resolved.connection.id})`
      )
    )
    .orderBy(workStreams.createdAt)
    .limit(1)
  if (!stream) return false
  const bound = await db.transaction((tx) => bindLinearSession(tx, sessionId, stream.id))
  if (bound) await announceLinearSessionBinding(sessionId, stream.id)
  return bound
}

/** The Linear app connection for a workspace in any state, for lifecycle events such as uninstall. */
export async function findLinearAppConnectionRow(organizationId: string) {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.providerKey, 'linear'),
        eq(integrationConnections.authorizationKind, 'oauth2'),
        sql`${integrationConnections.configuration}->>'organizationId' = ${organizationId}`
      )
    )
  return rows.filter((row) => {
    try {
      return isLinearAppConfiguration(parseLinearConfiguration(row.configuration))
    } catch {
      return false
    }
  })
}

export type { LinearAppConfiguration }
