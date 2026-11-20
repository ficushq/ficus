import { createLogger } from '../../../lib/infra/logger'
import { EventPollingRetryError } from '../types'
import type {
  EventPollingCapability,
  EventPollingResult,
  EventPollingSignal,
  RuntimeConnection,
  VerifiedIngressEvent,
} from '../types'
import { linearDeliveryKey } from './delivery-receipts'
import {
  isLinearAppConfiguration,
  LinearRateLimitedError,
  linearQuery,
  parseLinearConfiguration,
  type LinearAppConfiguration,
} from './plugin'

const log = createLogger('linear-polling')

/**
 * The Linear agent app's polling fallback (design 5.7): a low-frequency safety net for the two
 * event types that start or continue a conversation, agent sessions and prompts, plus the app's own
 * undelegation. Issue and comment changes are never polled (Linear asks integrations not to), and
 * API-key connections stay webhook-only: this capability returns no events for them.
 */

/** Cadence while no verified app webhook arrived recently (for example no public URL). */
export const LINEAR_POLL_FAST_MS = 60_000
/** Cadence while app webhooks are arriving. */
export const LINEAR_POLL_SLOW_MS = 5 * 60_000
/** A verified app webhook this recent means webhooks are flowing. */
export const LINEAR_POLL_WEBHOOK_RECENCY_MS = 15 * 60_000
/** After downtime, the lookback is capped at the hosted relay's retention. */
export const LINEAR_POLL_MAX_LOOKBACK_MS = 72 * 3_600_000
export const LINEAR_POLL_PAGE_SIZE = 50
/** Requests one poll makes at most: sessions, prompts and notifications. */
export const LINEAR_POLL_REQUESTS_PER_TICK = 3
const MAX_BOUNDARY_IDS = 50
const REQUEST_TIMEOUT_MS = 10_000

/** One query's position: the newest timestamp seen and the IDs seen at exactly that timestamp. */
export interface LinearPollingWatermark {
  at: string
  boundaryIds: string[]
}
export interface LinearPollingCursor {
  version: 1
  sessions: { updatedAfter: string; boundaryIds: string[] }
  prompts: { createdAfter: string; boundaryIds: string[] }
  notifications: { createdAfter: string; boundaryIds: string[] }
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}
function text(value: unknown, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
function stamp(value: unknown): number {
  const parsed = Date.parse(text(value, 64))
  return Number.isFinite(parsed) ? parsed : NaN
}
function boundary(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
        .slice(-MAX_BOUNDARY_IDS)
    : []
}

/**
 * Reads a stored cursor, starting at `initialAt` (the connection's install time) when there is none
 * or it is unreadable. Every watermark is raised to `now - 72 hours` at most, dropping its boundary.
 */
export function parseLinearPollingCursor(value: unknown, initialAt: Date, now: Date): LinearPollingCursor {
  const floor = now.getTime() - LINEAR_POLL_MAX_LOOKBACK_MS
  const start = new Date(Math.max(initialAt.getTime(), floor)).toISOString()
  const stored = record(value)
  const readable = stored.version === 1
  const read = (section: unknown, field: string): { at: string; boundaryIds: string[] } => {
    const entry = record(section)
    const at = stamp(entry[field])
    if (!readable || !Number.isFinite(at)) return { at: start, boundaryIds: [] }
    if (at < floor) return { at: new Date(floor).toISOString(), boundaryIds: [] }
    return { at: new Date(at).toISOString(), boundaryIds: boundary(entry.boundaryIds) }
  }
  const sessions = read(stored.sessions, 'updatedAfter')
  const prompts = read(stored.prompts, 'createdAfter')
  const notifications = read(stored.notifications, 'createdAfter')
  return {
    version: 1,
    sessions: { updatedAfter: sessions.at, boundaryIds: sessions.boundaryIds },
    prompts: { createdAfter: prompts.at, boundaryIds: prompts.boundaryIds },
    notifications: { createdAfter: notifications.at, boundaryIds: notifications.boundaryIds },
  }
}

/**
 * Splits fetched items into the ones not seen before and the advanced watermark. An item is new when
 * it is newer than the watermark, or exactly at it and not among the boundary IDs, so equal
 * timestamps are neither skipped nor repeated.
 */
export function advanceLinearWatermark<T extends { id: string; at: number }>(
  watermark: LinearPollingWatermark,
  items: readonly T[]
): { fresh: T[]; next: LinearPollingWatermark } {
  const current = Date.parse(watermark.at)
  const seen = new Set(watermark.boundaryIds)
  const fresh = items.filter(
    (item) => Number.isFinite(item.at) && (item.at > current || (item.at === current && !seen.has(item.id)))
  )
  if (!fresh.length) return { fresh, next: watermark }
  const newest = Math.max(...fresh.map((item) => item.at))
  const atNewest = fresh.filter((item) => item.at === newest).map((item) => item.id)
  const boundaryIds = newest === current ? [...watermark.boundaryIds, ...atNewest] : atNewest
  return {
    fresh,
    next: { at: new Date(newest).toISOString(), boundaryIds: [...new Set(boundaryIds)].slice(-MAX_BOUNDARY_IDS) },
  }
}

const ISSUE_FIELDS =
  'id number identifier title url team { id key } assignee { id } delegate { id } state { type } labels { nodes { name } }'

/** Newest first; the page is read down to the watermark. */
export const LINEAR_POLL_SESSIONS_QUERY = `query FicusLinearPollSessions($first: Int!) {
  agentSessions(first: $first, orderBy: updatedAt) {
    nodes { id status createdAt updatedAt url appUser { id } creator { id } comment { id } issue { ${ISSUE_FIELDS} } }
  }
}`
/** `last` returns the oldest first, so a full page is continued from its newest item on the next poll. */
export const LINEAR_POLL_PROMPTS_QUERY = `query FicusLinearPollPrompts($last: Int!, $after: DateTimeOrDuration!) {
  agentActivities(last: $last, orderBy: createdAt, filter: { type: { eq: "prompt" }, createdAt: { gte: $after } }) {
    nodes {
      id createdAt signal user { id } promptAuthor { id } sourceComment { id }
      content { ... on AgentActivityPromptContent { body } }
      agentSession { id url appUser { id } issue { ${ISSUE_FIELDS} } }
    }
  }
}`
export const LINEAR_POLL_NOTIFICATIONS_QUERY = `query FicusLinearPollNotifications($last: Int!, $after: DateTimeOrDuration!) {
  notifications(last: $last, orderBy: createdAt, filter: { createdAt: { gte: $after }, type: { in: ["issueUnassignedFromYou"] } }) {
    nodes { id type createdAt ... on IssueNotification { actor { id } issue { ${ISSUE_FIELDS} } } }
  }
}`

/** The issue as an `AgentSessionEvent` webhook payload carries it. */
function issuePayload(issue: Record<string, any>) {
  const team = record(issue.team)
  return {
    id: text(issue.id),
    ...(text(issue.identifier, 100) ? { identifier: text(issue.identifier, 100) } : {}),
    ...(typeof issue.number === 'number' ? { number: issue.number } : {}),
    ...(text(issue.title, 500) ? { title: text(issue.title, 500) } : {}),
    ...(text(issue.url, 2000) ? { url: text(issue.url, 2000) } : {}),
    ...(text(team.id) ? { teamId: text(team.id), team: { id: text(team.id), key: text(team.key, 100) } } : {}),
    assigneeId: text(record(issue.assignee).id),
    delegateId: text(record(issue.delegate).id),
    ...(issue.state ? { state: { type: text(record(issue.state).type, 100) } } : {}),
    ...(issue.labels ? { labels: issue.labels } : {}),
  }
}

/** What Ficus already recorded for a polled session. */
export interface KnownLinearSession {
  connectionId: string
  ackState: string
  dispositionState: string
}

export interface LinearPollingDependencies {
  /** The usable app connection's `Authorization` value, or null while it cannot be used. */
  resolveAuthorization(connectionId: string, configuration: LinearAppConfiguration): Promise<string | null>
  /** When the connection was installed: the first poll starts there. */
  installedAt(connectionId: string): Promise<Date | null>
  /** Whether a verified app webhook arrived for the workspace within the last `withinMs`. */
  receivedRecentWebhook(organizationId: string, withinMs: number): Promise<boolean>
  knownSessions(ids: readonly string[]): Promise<Map<string, KnownLinearSession>>
  query?: typeof linearQuery
  now?: () => Date
}

/** The cadence for a connection: slow while app webhooks arrive, fast otherwise. */
export function linearPollingInterval(receivedRecentWebhook: boolean) {
  return receivedRecentWebhook ? LINEAR_POLL_SLOW_MS : LINEAR_POLL_FAST_MS
}

/**
 * A polled session is handed to the webhook path only while it still needs Ficus: Linear still
 * shows it `pending` (never acknowledged), or Ficus recorded it but did not finish handling it.
 * Sessions Ficus has acknowledged and disposed of, and unknown sessions that are no longer pending,
 * are left alone.
 */
export function linearSessionNeedsHandling(
  status: string,
  known: KnownLinearSession | undefined,
  connectionId: string
): boolean {
  if (known) {
    if (known.connectionId !== connectionId) return false
    return known.ackState !== 'sent' || known.dispositionState === 'pending'
  }
  return status === 'pending'
}

export function createLinearAgentSessionPolling(
  dependencies: LinearPollingDependencies
): EventPollingCapability<unknown> {
  const query = dependencies.query ?? linearQuery
  const clock = dependencies.now ?? (() => new Date())

  return {
    async poll(connection: RuntimeConnection<unknown>, storedCursor, signal?: EventPollingSignal) {
      let configuration
      try {
        configuration = parseLinearConfiguration(connection.configuration)
      } catch {
        configuration = null
      }
      // API-key connections stay webhook-only.
      if (!configuration || !isLinearAppConfiguration(configuration))
        return { events: [], nextCursor: { ...(storedCursor ?? {}) }, suggestedIntervalMs: LINEAR_POLL_SLOW_MS }
      const now = clock()
      const recent = await dependencies.receivedRecentWebhook(
        configuration.organizationId,
        LINEAR_POLL_WEBHOOK_RECENCY_MS
      )
      const suggestedIntervalMs = linearPollingInterval(recent)
      const installedAt = (await dependencies.installedAt(connection.id)) ?? now
      const cursor = parseLinearPollingCursor(storedCursor, installedAt, now)
      const authorization = await dependencies.resolveAuthorization(connection.id, configuration)
      // Disabled, unhealthy or awaiting a token refresh: nothing is read, and the cursor keeps its place.
      if (!authorization) return { events: [], nextCursor: { ...cursor }, suggestedIntervalMs }

      const request = async <T>(document: string, variables: Record<string, unknown>): Promise<T> => {
        signal?.reserveRequest()
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        try {
          return await query<T>(
            authorization,
            document,
            variables,
            signal ? AbortSignal.any([signal, timeout]) : timeout
          )
        } catch (error) {
          if (error instanceof LinearRateLimitedError)
            throw new EventPollingRetryError('Linear rate limit reached while polling', error.retryAfterMs)
          throw error
        }
      }
      const appUserId = configuration.appUserId
      const base = { organizationId: configuration.organizationId, appUserId }
      const events: VerifiedIngressEvent[] = []

      // 1. Sessions, newest first, down to the watermark.
      const sessionPage = await request<{ agentSessions?: { nodes?: unknown[] } }>(LINEAR_POLL_SESSIONS_QUERY, {
        first: LINEAR_POLL_PAGE_SIZE,
      })
      const sessionNodes = (sessionPage.agentSessions?.nodes ?? []).map(record)
      const sessions = advanceLinearWatermark(
        { at: cursor.sessions.updatedAfter, boundaryIds: cursor.sessions.boundaryIds },
        sessionNodes.map((node) => ({ id: text(node.id), at: stamp(node.updatedAt), node })).filter((item) => item.id)
      )
      if (
        sessionNodes.length >= LINEAR_POLL_PAGE_SIZE &&
        sessions.fresh.length >= LINEAR_POLL_PAGE_SIZE &&
        Math.min(...sessions.fresh.map((item) => item.at)) > Date.parse(cursor.sessions.updatedAfter)
      )
        log.warn('More Linear agent sessions changed since the last poll than one page holds; older ones may be missed')
      const ownSessions = sessions.fresh.filter((item) => text(record(item.node.appUser).id) === appUserId)
      const known = await dependencies.knownSessions(ownSessions.map((item) => item.id))
      // Oldest first, so sessions are handled in the order they were opened.
      for (const { id, node } of [...ownSessions].sort((a, b) => stamp(a.node.createdAt) - stamp(b.node.createdAt))) {
        if (!linearSessionNeedsHandling(text(node.status, 32), known.get(id), connection.id)) continue
        const issue = record(node.issue)
        const commentId = text(record(node.comment).id)
        events.push({
          type: 'AgentSessionEvent',
          logicalEventKey: linearDeliveryKey.sessionCreated(id),
          payload: {
            type: 'AgentSessionEvent',
            action: 'created',
            createdAt: text(node.createdAt, 64),
            ...base,
            agentSession: {
              id,
              ...(text(issue.id) ? { issueId: text(issue.id), issue: issuePayload(issue) } : {}),
              ...(commentId ? { commentId } : {}),
              creatorId: text(record(node.creator).id),
              url: text(node.url, 2000),
              status: text(node.status, 32),
            },
          },
        })
      }

      // 2. Prompts, oldest first, from the watermark.
      const promptPage = await request<{ agentActivities?: { nodes?: unknown[] } }>(LINEAR_POLL_PROMPTS_QUERY, {
        last: LINEAR_POLL_PAGE_SIZE,
        after: cursor.prompts.createdAfter,
      })
      const prompts = advanceLinearWatermark(
        { at: cursor.prompts.createdAfter, boundaryIds: cursor.prompts.boundaryIds },
        (promptPage.agentActivities?.nodes ?? [])
          .map(record)
          .map((node) => ({ id: text(node.id), at: stamp(node.createdAt), node }))
          .filter((item) => item.id)
      )
      for (const { id, node } of [...prompts.fresh].sort((a, b) => a.at - b.at)) {
        const session = record(node.agentSession)
        if (!text(session.id) || text(record(session.appUser).id) !== appUserId) continue
        const issue = record(session.issue)
        const sourceCommentId = text(record(node.sourceComment).id)
        events.push({
          type: 'AgentSessionEvent',
          logicalEventKey: linearDeliveryKey.prompt(id),
          payload: {
            type: 'AgentSessionEvent',
            action: 'prompted',
            createdAt: text(node.createdAt, 64),
            ...base,
            agentSession: {
              id: text(session.id),
              ...(text(issue.id) ? { issueId: text(issue.id), issue: issuePayload(issue) } : {}),
              url: text(session.url, 2000),
            },
            agentActivity: {
              id,
              userId: text(record(node.promptAuthor).id) || text(record(node.user).id),
              body: text(record(node.content).body, 30000),
              ...(node.signal === 'stop' ? { signal: 'stop' } : {}),
              ...(sourceCommentId ? { sourceCommentId } : {}),
            },
          },
        })
      }

      // 3. The app's undelegations, oldest first, from the watermark.
      const notificationPage = await request<{ notifications?: { nodes?: unknown[] } }>(
        LINEAR_POLL_NOTIFICATIONS_QUERY,
        { last: LINEAR_POLL_PAGE_SIZE, after: cursor.notifications.createdAfter }
      )
      const notifications = advanceLinearWatermark(
        { at: cursor.notifications.createdAfter, boundaryIds: cursor.notifications.boundaryIds },
        (notificationPage.notifications?.nodes ?? [])
          .map(record)
          .map((node) => ({ id: text(node.id), at: stamp(node.createdAt), node }))
          .filter((item) => item.id)
      )
      for (const { id, node } of [...notifications.fresh].sort((a, b) => a.at - b.at)) {
        const issue = record(node.issue)
        if (text(node.type, 100) !== 'issueUnassignedFromYou' || !text(issue.id)) continue
        events.push({
          type: 'AppUserNotification',
          logicalEventKey: linearDeliveryKey.notification(id),
          payload: {
            type: 'AppUserNotification',
            action: 'issueUnassignedFromYou',
            createdAt: text(node.createdAt, 64),
            ...base,
            notification: {
              id,
              type: 'issueUnassignedFromYou',
              createdAt: text(node.createdAt, 64),
              issueId: text(issue.id),
              issue: issuePayload(issue),
              actorId: text(record(node.actor).id),
            },
          },
        })
      }

      const nextCursor: LinearPollingCursor = {
        version: 1,
        sessions: { updatedAfter: sessions.next.at, boundaryIds: sessions.next.boundaryIds },
        prompts: { createdAfter: prompts.next.at, boundaryIds: prompts.next.boundaryIds },
        notifications: { createdAfter: notifications.next.at, boundaryIds: notifications.next.boundaryIds },
      }
      const result: EventPollingResult = { events, nextCursor: { ...nextCursor }, suggestedIntervalMs }
      return result
    },
  }
}
