import { inspectWorktreeCleanup } from '../services/work-streams/worktree-cleanup-inspection'
import { WorktreeCleanupConflictError } from '../services/work-streams/worktree-cleanup-store'
import { HTTPException } from 'hono/http-exception'
import { AmbiguousPrefixError } from '../db/prefix-match'
import { RepositorySetupError } from '../services/work-streams/repository-setup'
import { resolveCreationWorkflow } from '../services/workflows/creation-source'
import { z } from 'zod'
import { pauseWorkStream, resumeWorkStream } from '../services/work-streams/pause'
import { resolveActingUser } from '../services/rbac'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { zValidator } from '@hono/zod-validator'
import {
  approveWorkStreamSchema,
  createWorkStreamSchema,
  updateWorkStreamSchema,
  resolveWorkStreamWaitSchema,
  requestReviewWorkStreamSchema,
  sendBackWorkStreamSchema,
  requestInputWorkStreamSchema,
  unblockWorkStreamSchema,
  parkWorkStreamSchema,
  mapLegacyWorkStreamStatus,
  sortCanonicalWorkStreams,
  attentionSchema,
  DEFAULT_ATTENTION,
  type Attention,
} from '@ficus/shared'
import type { WorkStreamStatus, WorkStreamWaitCreatedBy, WorkStreamPriority } from '@ficus/shared'
import {
  WorkStream,
  WorkStreamEventAlreadyHandledError,
  WorkStreamNotReopenableError,
  WorkStreamOpenWaitsError,
  WorkStreamTerminalTransitionError,
  WorkStreamWaitResolveError,
  type TerminalWorkStreamCursorKey,
} from '../entities/WorkStream'
import {
  TrackedResourceError,
  addTrackedResources,
  listTrackedResources,
  mergeTracked,
  removeTrackedResource,
  resolveEventTrackedResource,
  resolveTrackedResourceRequest,
  trackedResourceRequestIdentity,
  trackedResourceRequestSchema,
} from '../services/work-streams/tracked-resources'
import { Squad } from '../entities/Squad'
import { Agent } from '../entities/Agent'
import { User } from '../entities/User'
import { resolveAgentChatSenderUserId } from '../services/inbox/agent-human-recipient'
import { requirePermission } from '../middleware'
import { requireEntityPermission, filterToAccessibleSquads } from '../middleware/require-entity-permission'
import { hasPermission, getAccessibleSquadIds } from '../services/rbac'
import type { Identity } from '../services/rbac'
import {
  subscribeToWorkStream,
  unsubscribeFromWorkStream,
  getWorkStreamAttention,
  countWorkStreamSubscribers,
} from '../services/work-streams/subscriptions'
import { getSquadAttention } from '../services/squad/subscriptions'
import { loadUserAttention } from '../services/attention/resolver'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { computePriorityAnnotations } from '../services/work-streams/priority-annotations'
import { computeAutomatedReviewGates } from '../services/work-streams/automated-review-gate'
import { WorkStreamBusyError, WorkStreamNotParkableError, parkWorkStream } from '../services/work-streams/admission'
import { computeDerivedStates } from '../services/work-streams/derived-state'
import { listWaitHistory, toWaitJson } from '../services/work-streams/waits'
import { db, workStreamFlowRuns } from '../db'
import { inArray } from 'drizzle-orm'
import { userSessionRequired } from '../services/auth/user-session-required'
import { ciNotificationSchema, settleCiNotification } from '../services/work-streams/ci-notifications'
import {
  cleanupExpiredWorkStreamOrderSnapshots,
  createWorkStreamOrderSnapshot,
  getWorkStreamOrderSnapshotBoundary,
  loadWorkStreamOrderSnapshotPage,
} from '../services/work-streams/order-snapshots'

const resolvedRouteIds = new WeakMap<Context, Promise<string>>()
async function routeWorkStreamId(c: Context): Promise<string> {
  let resolved = resolvedRouteIds.get(c)
  if (!resolved) {
    const input = c.req.param('id') ?? ''
    resolved = WorkStream.find(input)
      .then((work) => {
        if (!work) throw new HTTPException(404, { res: c.json({ error: 'Work stream not found' }, 404) })
        return work.id
      })
      .catch((error) => {
        if (error instanceof AmbiguousPrefixError)
          throw new HTTPException(400, { res: c.json({ error: error.message }, 400) })
        throw error
      })
    resolvedRouteIds.set(c, resolved)
  }
  return resolved
}

// Preserve the existing system-scope authorization check for missing entities.
// Authorized handlers then report the cached resolution error as JSON.
async function routeWorkStreamSquadId(c: Context): Promise<string | null> {
  try {
    return await workStreamSquadId(await routeWorkStreamId(c))
  } catch (error) {
    if (error instanceof HTTPException && (error.status === 404 || error.status === 400)) return null
    throw error
  }
}

async function annotateWorkStreams(streams: WorkStream[]) {
  const [runtimes, priorityAnnotations, derived] = await Promise.all([
    WorkStream.computeRuntimes(streams),
    computePriorityAnnotations(streams),
    computeDerivedStates(streams),
  ])
  const flowRows = streams.length
    ? await db
        .select({ id: workStreamFlowRuns.workStreamId, state: workStreamFlowRuns.state })
        .from(workStreamFlowRuns)
        .where(
          inArray(
            workStreamFlowRuns.workStreamId,
            streams.map((stream) => stream.id)
          )
        )
    : []
  const sources = new Map(
    flowRows.map((row) => [
      row.id,
      [...new Set((row.state.definition.subscriptions ?? []).map((subscription) => subscription.source.integration))],
    ])
  )
  const automatedReviewGates = await computeAutomatedReviewGates(streams, derived)
  return streams.map((stream) => ({
    ...stream.toJson(),
    integrationEventSources: sources.get(stream.id) ?? [],
    runtime: runtimes.get(stream.id),
    ...(priorityAnnotations.get(stream.id) ?? {}),
    ...(derived.get(stream.id) ?? {}),
    ...(automatedReviewGates.has(stream.id) ? { automatedReviewGate: true } : {}),
  }))
}

async function serializeCanonicalWorkStreams(streams: WorkStream[]) {
  return sortCanonicalWorkStreams(await annotateWorkStreams(streams))
}

const ALL_STATUSES: WorkStreamStatus[] = ['active', 'queued', 'done', 'canceled']
const TERMINAL_STATUSES = new Set<WorkStreamStatus>(['done', 'canceled'])
const PRIORITIES = new Set<WorkStreamPriority>(['critical', 'high', 'normal', 'low'])

type EncodedTerminalCursor = {
  v: 1
  completedAt: string | null
  priority: WorkStreamPriority
  createdAt: string
  id: string
}

function encodeTerminalCursor(stream: WorkStream): string {
  const completedAt = stream.completedAt
  const key: EncodedTerminalCursor = {
    v: 1,
    completedAt: completedAt && Number.isFinite(completedAt.getTime()) ? completedAt.toISOString() : null,
    priority: stream.priority,
    createdAt: stream.createdAt.toISOString(),
    id: stream.id,
  }
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

function decodeTerminalCursor(cursor?: string): TerminalWorkStreamCursorKey | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<EncodedTerminalCursor>
    const completedAt = value.completedAt === null ? null : new Date(value.completedAt ?? '')
    const createdAt = new Date(value.createdAt ?? '')
    if (
      value.v !== 1 ||
      typeof value.id !== 'string' ||
      !PRIORITIES.has(value.priority as WorkStreamPriority) ||
      !Number.isFinite(createdAt.getTime()) ||
      (completedAt !== null && !Number.isFinite(completedAt.getTime()))
    )
      return undefined
    return { completedAt, priority: value.priority as WorkStreamPriority, createdAt, id: value.id }
  } catch {
    return undefined
  }
}

type EncodedMixedCursor = {
  v: 4
  snapshotId: string
  nextOrdinal: number
  terminalCursor?: string
  signature: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function mixedCursorPayload(value: Omit<EncodedMixedCursor, 'signature'>): string {
  return JSON.stringify(value)
}

function encodeMixedCursor(value: Omit<EncodedMixedCursor, 'signature'>, secret: string): string {
  const signature = createHmac('sha256', secret).update(mixedCursorPayload(value)).digest('base64url')
  return Buffer.from(JSON.stringify({ ...value, signature })).toString('base64url')
}

function verifyMixedCursor(value: EncodedMixedCursor, secret: string): boolean {
  const { signature, ...unsigned } = value
  const expected = createHmac('sha256', secret).update(mixedCursorPayload(unsigned)).digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function decodeMixedCursor(cursor?: string): EncodedMixedCursor | undefined {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<EncodedMixedCursor>
    if (
      value.v !== 4 ||
      typeof value.snapshotId !== 'string' ||
      !UUID_PATTERN.test(value.snapshotId) ||
      !Number.isSafeInteger(value.nextOrdinal) ||
      (value.nextOrdinal ?? -1) < 0 ||
      (value.terminalCursor !== undefined && typeof value.terminalCursor !== 'string') ||
      typeof value.signature !== 'string'
    )
      return undefined
    return value as EncodedMixedCursor
  } catch {
    return undefined
  }
}

function workStreamOrderOwnerKey(identity: Identity): string {
  if (identity.type === 'user') return `user:${identity.userId}`
  if (identity.type === 'agent') return `agent:${identity.agentId}`
  if (identity.type === 'system') return `system:${identity.systemTokenId}`
  return 'legacy'
}

function workStreamOrderFingerprint(input: {
  statuses: WorkStreamStatus[]
  squadId?: string
  accessibleSquadIds?: string[]
}): string {
  const canonical = JSON.stringify({
    statuses: [...input.statuses].sort(),
    squadId: input.squadId ?? null,
    accessibleSquads: input.accessibleSquadIds ? [...input.accessibleSquadIds].sort() : 'all',
  })
  return createHash('sha256').update(canonical).digest('hex')
}

async function orderNonTerminalCandidates(
  streams: Awaited<ReturnType<typeof WorkStream.listNonTerminalOrderCandidates>>
) {
  const [priorityAnnotations, derived] = await Promise.all([
    computePriorityAnnotations(streams),
    computeDerivedStates(streams),
  ])
  const automatedReviewGates = await computeAutomatedReviewGates(streams, derived)
  return sortCanonicalWorkStreams(
    streams.map((stream) => ({
      ...stream,
      ...(priorityAnnotations.get(stream.id) ?? {}),
      ...(derived.get(stream.id) ?? {}),
      ...(automatedReviewGates.has(stream.id) ? { automatedReviewGate: true } : {}),
    }))
  )
}

async function serializeSnapshotPage(orderedIds: string[]) {
  const rows = await WorkStream.listSnapshotRowsByIds(orderedIds)
  const annotated = await annotateWorkStreams(rows)
  const byId = new Map(annotated.map((row) => [row.id, row]))
  return orderedIds.flatMap((id) => {
    const row = byId.get(id)
    return row ? [row] : []
  })
}

async function serializeTerminalWorkStreams(streams: WorkStream[]) {
  const runtimes = await WorkStream.computeRuntimes(streams)
  return streams.map((stream) => ({ ...stream.toJson(), runtime: runtimes.get(stream.id) }))
}

function completeVolatilePage<T>(items: T[]) {
  return { items, hasMore: false, nextCursor: null, totalCount: items.length }
}

/**
 * The calling AGENT, when the caller is one. Passed into every lifecycle
 * mutation so its notifications can skip the caller: an agent that cancels,
 * approves, or completes a stream does not need a system message — often a
 * steer, which interrupts mid-turn — telling it what it just did. A user or
 * system caller yields null and everyone is notified, as before.
 */
function actorAgentIdFrom(identity: Identity | undefined): string | null {
  return identity?.type === 'agent' ? identity.agentId : null
}

/** Map who-is-calling onto the wait record's created_by vocabulary. */
async function waitAttribution(
  identity: Identity | undefined,
  squadId: string
): Promise<{
  createdBy: WorkStreamWaitCreatedBy
  createdByAgentId: string | null
  createdByUserId: string | null
}> {
  if (identity?.type === 'agent') {
    try {
      const squad = await Squad.find(squadId)
      const isManager = squad?.managerAgentId === identity.agentId
      return {
        createdBy: isManager ? 'manager' : 'agent',
        createdByAgentId: identity.agentId,
        createdByUserId: null,
      }
    } catch {
      return { createdBy: 'agent', createdByAgentId: identity.agentId, createdByUserId: null }
    }
  }
  if (identity?.type === 'user') {
    return { createdBy: 'operator', createdByAgentId: null, createdByUserId: identity.userId }
  }
  return { createdBy: 'system', createdByAgentId: null, createdByUserId: null }
}

/**
 * Load squadId from a workstream identified by route param `:id`.
 * Returns null when the workstream is not found or the id format is invalid —
 * requireEntityPermission will then do an unscoped check (admins pass through
 * to the handler's 404/400 response; unprivileged callers get 403).
 */
async function workStreamSquadId(id: string): Promise<string | null> {
  try {
    const ws = await WorkStream.find(id)
    if (!ws) return null
    return ws.squadId ?? null
  } catch {
    return null
  }
}

// Responding to a blocked/review work stream is allowed for holders of
// workstreams:respond (assigned workers) OR workstreams:update (managers; admins
// via '*'). requireEntityPermission is single-permission, so check both here.
const requireWorkStreamRespondPermission = createMiddleware(async (c, next) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const id = await routeWorkStreamId(c)
  if (!id) return c.json({ error: 'Work stream not found' }, 404)
  const squadId = await workStreamSquadId(id)
  const check = (perm: string) => (squadId ? hasPermission(identity, perm, squadId) : hasPermission(identity, perm))
  if ((await check('workstreams:respond')) || (await check('workstreams:update'))) return next()
  return c.json({ error: 'Forbidden' }, 403)
})

// State transitions (PATCH /:id: in_progress / handoff / review / done) are allowed for
// holders of workstreams:update on the squad (managers; admins via '*'), OR for an agent
// BOUND to this work stream that holds workstreams:respond on its squad (assigned workers).
// The scoped permission check enforces same-squad; binding enforces assignment. The worker
// path forbids canceling and re-scoping the bound-agent set — those stay manager-only.
const requireWorkStreamUpdatePermission = createMiddleware(async (c, next) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const id = await routeWorkStreamId(c)
  const ws = id ? await WorkStream.find(id) : null
  const squadId = ws?.squadId ?? null
  const check = (perm: string) => (squadId ? hasPermission(identity, perm, squadId) : hasPermission(identity, perm))

  if (await check('workstreams:update')) return next()

  if (ws && identity.type === 'agent' && (await check('workstreams:respond'))) {
    const bound =
      ws.assigneeAgentId === identity.agentId ||
      ws.ownerAgentId === identity.agentId ||
      (ws.agentIds ?? []).includes(identity.agentId)
    if (bound) {
      const body = (await c.req.json()) as { status?: string; agentIds?: unknown; assignedReviewerIds?: unknown }
      if (body.status === 'canceled') return c.json({ error: 'Workers cannot cancel work streams' }, 403)
      if (body.assignedReviewerIds !== undefined)
        return c.json({ error: 'Workers cannot change assigned reviewers' }, 403)
      if (body.agentIds !== undefined) return c.json({ error: 'Workers cannot change the agent list' }, 403)
      return next()
    }
  }

  return c.json({ error: 'Forbidden' }, 403)
})

const requireWorkStreamListPermission = createMiddleware(async (c, next) => {
  const identity = c.get('identity') as Identity | undefined
  if (!identity) return c.json({ error: 'Unauthorized' }, 401)
  c.set('authzChecked', true)
  const squadId = c.req.query('squadId')
  if (squadId) {
    if (!(await hasPermission(identity, 'workstreams:read', squadId))) return c.json({ error: 'Forbidden' }, 403)
    return next()
  }
  const accessible = await getAccessibleSquadIds(identity)
  if (accessible !== 'all' && accessible.length === 0) return c.json({ error: 'Forbidden' }, 403)
  return next()
})

/** Tracked-link failures carry their own status; the delivery conflict is code-tagged for clients. */
function trackedResourceFailure(c: Context, error: unknown) {
  if (!(error instanceof TrackedResourceError)) throw error
  return c.json(
    error.status === 409 ? { error: error.message, code: 'delivery_change_request' } : { error: error.message },
    error.status
  )
}

/** The caller's effective levels for one stream: its row, else the squad's row, else the default. */
async function resolveStreamSubscription(
  workStreamId: string,
  squadId: string,
  identity: Awaited<ReturnType<typeof resolveActingUser>>
): Promise<{ subscribed: boolean; attention: Attention; inherited: boolean }> {
  if (identity?.type !== 'user') return { subscribed: false, attention: DEFAULT_ATTENTION, inherited: true }
  const streamRow = await getWorkStreamAttention(workStreamId, identity.userId)
  if (streamRow) return { subscribed: true, attention: streamRow, inherited: false }
  const squadRow = await getSquadAttention(squadId, identity.userId)
  return { subscribed: false, attention: squadRow ?? DEFAULT_ATTENTION, inherited: true }
}

/** Drop streams the caller has muted for `progress`. Non-user identities carry no attention rows. */
async function filterToAttendedStreams<T extends { id: string; squadId: string }>(
  identity: Identity,
  streams: T[]
): Promise<T[]> {
  if (identity.type !== 'user' || streams.length === 0) return streams
  const attention = await loadUserAttention(identity.userId)
  return streams.filter((stream) => attention.forWorkStream(stream.id, stream.squadId).progress !== 'mute')
}

export const workStreamsRouter = new Hono()
  .post(
    '/:id/ci-notification',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    requirePermission('inbox:system'),
    zValidator('json', ciNotificationSchema),
    async (c) => {
      const stream = await WorkStream.find(await routeWorkStreamId(c))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      return c.json(await settleCiNotification(stream.id, c.req.valid('json')))
    }
  )
  .get('/by-metadata', requirePermission('workstreams:read'), async (c) => {
    const matchParams = c.req.queries('match') ?? []
    const rawStatus = c.req.query('status')
    const status = rawStatus ? mapLegacyWorkStreamStatus(rawStatus) : undefined

    if (matchParams.length === 0) {
      return c.json({ error: 'At least one match parameter required (format: path:value)' }, 400)
    }

    const matches: Record<string, string> = {}
    for (const m of matchParams) {
      const colonIdx = m.indexOf(':')
      if (colonIdx === -1) {
        return c.json({ error: `Invalid match format: "${m}". Expected "path:value"` }, 400)
      }
      matches[m.slice(0, colonIdx)] = m.slice(colonIdx + 1)
    }

    const streams = await WorkStream.findByMetadata(matches, { status })
    const identity: Identity = c.get('identity')
    const filtered = await filterToAccessibleSquads(identity, streams, (s) => s.squadId ?? null)
    return c.json(await serializeCanonicalWorkStreams(filtered))
  })
  .get('/', requireWorkStreamListPermission, async (c) => {
    const squadId = c.req.query('squadId')
    const squadIdsParam = c.req.query('squadIds')
    const requestedSquadIds = squadId
      ? undefined
      : [
          ...new Set(
            (squadIdsParam ?? '')
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          ),
        ]
    const rawStatus = c.req.query('status')
    const status = rawStatus ? mapLegacyWorkStreamStatus(rawStatus) : undefined
    const statusesParam = c.req.query('statuses')
    const limitParam = c.req.query('limit')
    const countOnly = c.req.query('countOnly') === 'true'
    const respectAttention = c.req.query('respectAttention') === 'true'
    const cursor = c.req.query('cursor')
    const completionRange = z
      .object({
        completedAfter: z.string().datetime().optional(),
        completedBefore: z.string().datetime().optional(),
      })
      .safeParse({ completedAfter: c.req.query('completedAfter'), completedBefore: c.req.query('completedBefore') })
    if (!completionRange.success) return c.json({ error: 'Invalid completion date range' }, 400)
    const completedAfter = completionRange.data.completedAfter
      ? new Date(completionRange.data.completedAfter)
      : undefined
    const completedBefore = completionRange.data.completedBefore
      ? new Date(completionRange.data.completedBefore)
      : undefined
    if ((completedAfter || completedBefore) && limitParam === undefined)
      return c.json({ error: 'Completion dates require a paginated terminal-status query' }, 400)
    if (completedAfter && completedBefore && completedAfter > completedBefore)
      return c.json({ error: 'Invalid completion date range' }, 400)

    // Filters accept BOTH the current vocabulary and the legacy one
    // (pending→queued, in_progress/blocked/review→active) for one release.
    const statuses = statusesParam
      ? [
          ...new Set(
            statusesParam
              .split(',')
              .map((s) => mapLegacyWorkStreamStatus(s.trim()))
              .filter((s): s is WorkStreamStatus => s !== undefined)
          ),
        ]
      : undefined

    if (statusesParam !== undefined && statuses?.length === 0) {
      return c.json({ error: 'statuses must contain at least one valid status' }, 400)
    }

    const identity: Identity = c.get('identity')

    // The feed's cross-squad query is the only caller. Paginated responses are cursor-snapshotted
    // server-side, so a per-viewer filter would silently shorten pages and break `totalCount`;
    // refuse the combination instead of returning a quietly wrong page.
    if (respectAttention && limitParam !== undefined)
      return c.json({ error: 'respectAttention is not supported with pagination' }, 400)

    // When a specific squadId is requested, verify the identity can access it.
    // When no squadId is given, filter results to accessible squads (filtered-list).
    if (squadId) {
      const allowed = await hasPermission(identity, 'workstreams:read', squadId)
      if (!allowed) return c.json({ error: 'Forbidden' }, 403)
    }

    if (limitParam !== undefined) {
      const limit = Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200)
      const requestedStatuses = statuses ?? (status ? [status] : ALL_STATUSES)
      const terminalStatuses = requestedStatuses.filter((value) => TERMINAL_STATUSES.has(value))
      const nonTerminalStatuses = requestedStatuses.filter((value) => !TERMINAL_STATUSES.has(value))
      const terminalOnly = terminalStatuses.length > 0 && nonTerminalStatuses.length === 0
      if ((completedAfter || completedBefore) && !terminalOnly)
        return c.json({ error: 'Completion dates require terminal statuses' }, 400)
      let accessibleSquadIds: string[] | undefined
      const accessible = await getAccessibleSquadIds(identity)
      if (accessible === 'all') {
        if (requestedSquadIds?.length) accessibleSquadIds = requestedSquadIds
      } else {
        if (accessible.length === 0) return c.json({ error: 'Forbidden' }, 403)
        accessibleSquadIds = requestedSquadIds?.length
          ? accessible.filter((id) => requestedSquadIds.includes(id))
          : accessible
      }

      if (accessibleSquadIds?.length === 0) return c.json(completeVolatilePage([]))

      if (countOnly) {
        const totalCount = await WorkStream.countList({
          squadId,
          squadIds: accessibleSquadIds,
          completedAfter,
          completedBefore,
          statuses: statuses ? requestedStatuses : undefined,
          status: statuses ? undefined : status,
        })
        return c.json({ totalCount })
      }

      if (terminalOnly) {
        const decodedCursor = decodeTerminalCursor(cursor)
        const page = await WorkStream.listTerminalPage({
          squadId,
          squadIds: accessibleSquadIds,
          statuses: terminalStatuses,
          limit,
          cursor: decodedCursor,
          completedAfter,
          completedBefore,
        })
        const items = await serializeTerminalWorkStreams(page.items)
        return c.json({
          items,
          hasMore: page.hasMore,
          nextCursor:
            page.hasMore && page.items.length > 0 ? encodeTerminalCursor(page.items[page.items.length - 1]!) : null,
          totalCount: page.totalCount,
        })
      }

      if (nonTerminalStatuses.length > 0) {
        const ownerKey = workStreamOrderOwnerKey(identity)
        const requestFingerprint = workStreamOrderFingerprint({
          statuses: requestedStatuses,
          squadId,
          accessibleSquadIds,
        })
        const decodedCursor = decodeMixedCursor(cursor)
        if (cursor && !decodedCursor) return c.json({ error: 'Invalid work-stream cursor' }, 400)

        let loadedSnapshotPage: Awaited<ReturnType<typeof loadWorkStreamOrderSnapshotPage>>
        if (decodedCursor) {
          loadedSnapshotPage = await loadWorkStreamOrderSnapshotPage(
            decodedCursor.snapshotId,
            decodedCursor.nextOrdinal,
            limit + 1
          )
          if (!loadedSnapshotPage || loadedSnapshotPage.snapshot.expiresAt.getTime() <= Date.now()) {
            return c.json({ error: 'Work-stream cursor expired' }, 410)
          }
          const candidateSnapshot = loadedSnapshotPage.snapshot
          const nestedTerminalCursor = decodedCursor.terminalCursor
            ? decodeTerminalCursor(decodedCursor.terminalCursor)
            : undefined
          if (
            !verifyMixedCursor(decodedCursor, candidateSnapshot.cursorSecret) ||
            decodedCursor.nextOrdinal > candidateSnapshot.nonTerminalCount ||
            (decodedCursor.terminalCursor !== undefined && !nestedTerminalCursor) ||
            (decodedCursor.terminalCursor !== undefined &&
              decodedCursor.nextOrdinal < candidateSnapshot.nonTerminalCount)
          ) {
            return c.json({ error: 'Invalid work-stream cursor' }, 400)
          }
          if (candidateSnapshot.ownerKey !== ownerKey || candidateSnapshot.requestFingerprint !== requestFingerprint) {
            return c.json({ error: 'Work-stream cursor does not match this request' }, 400)
          }
        } else {
          const snapshotAt = await getWorkStreamOrderSnapshotBoundary()
          const candidates = await WorkStream.listNonTerminalOrderCandidates({
            squadId,
            squadIds: accessibleSquadIds,
            statuses: nonTerminalStatuses,
            createdBefore: snapshotAt,
          })
          const orderedCandidates = await orderNonTerminalCandidates(candidates)
          const terminalCountPage =
            terminalStatuses.length > 0
              ? await WorkStream.listTerminalPage({
                  squadId,
                  squadIds: accessibleSquadIds,
                  statuses: terminalStatuses,
                  limit: 1,
                  completedBefore: snapshotAt,
                })
              : { totalCount: 0 }
          await cleanupExpiredWorkStreamOrderSnapshots(snapshotAt)
          const created = await createWorkStreamOrderSnapshot({
            ownerKey,
            requestFingerprint,
            snapshotAt,
            terminalTotalCount: terminalCountPage.totalCount,
            orderedWorkStreamIds: orderedCandidates.map((candidate) => candidate.id),
          })
          loadedSnapshotPage = await loadWorkStreamOrderSnapshotPage(created.id, 0, limit + 1)
          if (!loadedSnapshotPage) throw new Error('Created work-stream snapshot disappeared')
        }

        const snapshot = loadedSnapshotPage.snapshot
        const nextOrdinal = decodedCursor?.nextOrdinal ?? 0
        let advancedOrdinal = nextOrdinal
        let ordinalRows = loadedSnapshotPage.items
        let nonTerminalItems: Awaited<ReturnType<typeof serializeSnapshotPage>> = []
        const MAX_SNAPSHOT_FILL_CHUNKS = 8
        for (
          let chunk = 0;
          chunk < MAX_SNAPSHOT_FILL_CHUNKS &&
          nonTerminalItems.length < limit &&
          advancedOrdinal < snapshot.nonTerminalCount;
          chunk += 1
        ) {
          if (chunk > 0) {
            const continuation = await loadWorkStreamOrderSnapshotPage(
              snapshot.id,
              advancedOrdinal,
              limit - nonTerminalItems.length + 1
            )
            if (!continuation || continuation.snapshot.expiresAt.getTime() <= Date.now()) {
              return c.json({ error: 'Work-stream cursor expired' }, 410)
            }
            ordinalRows = continuation.items
          }
          const consumedOrdinalRows = ordinalRows.slice(0, limit - nonTerminalItems.length)
          if (consumedOrdinalRows.length === 0) {
            advancedOrdinal = snapshot.nonTerminalCount
            break
          }
          advancedOrdinal = consumedOrdinalRows[consumedOrdinalRows.length - 1]!.ordinal + 1
          nonTerminalItems = [
            ...nonTerminalItems,
            ...(await serializeSnapshotPage(consumedOrdinalRows.map((row) => row.workStreamId))),
          ]
        }
        const nonTerminalPending = advancedOrdinal < snapshot.nonTerminalCount
        if (nonTerminalItems.length === 0 && nonTerminalPending) {
          return c.json({ error: 'Work-stream cursor requires restart' }, 410)
        }
        const capacity = limit - nonTerminalItems.length
        const priorTerminalCursor = decodedCursor?.terminalCursor
        const mayEnterTerminal = !nonTerminalPending && terminalStatuses.length > 0
        const terminalPage = mayEnterTerminal
          ? await WorkStream.listTerminalPage({
              squadId,
              squadIds: accessibleSquadIds,
              statuses: terminalStatuses,
              limit: Math.max(capacity, 1),
              cursor: decodeTerminalCursor(priorTerminalCursor),
              completedBefore: snapshot.snapshotAt,
            })
          : { items: [], totalCount: snapshot.terminalTotalCount, hasMore: false }
        const consumedTerminalRows = mayEnterTerminal && capacity > 0 ? terminalPage.items.slice(0, capacity) : []
        const terminalItems =
          consumedTerminalRows.length > 0 ? await serializeTerminalWorkStreams(consumedTerminalRows) : []
        const terminalPending = mayEnterTerminal
          ? capacity === 0
            ? snapshot.terminalTotalCount > 0
            : terminalPage.hasMore
          : snapshot.terminalTotalCount > 0
        const nextTerminalCursor =
          consumedTerminalRows.length > 0
            ? terminalPending
              ? encodeTerminalCursor(consumedTerminalRows[consumedTerminalRows.length - 1]!)
              : undefined
            : priorTerminalCursor
        const hasMore = nonTerminalPending || terminalPending
        return c.json({
          items: [...nonTerminalItems, ...terminalItems],
          hasMore,
          nextCursor: hasMore
            ? encodeMixedCursor(
                {
                  v: 4,
                  snapshotId: snapshot.id,
                  nextOrdinal: advancedOrdinal,
                  terminalCursor: nextTerminalCursor,
                },
                snapshot.cursorSecret
              )
            : null,
          totalCount: snapshot.nonTerminalCount + snapshot.terminalTotalCount,
        })
      }

      let streams = await WorkStream.list({ squadId, status: statuses ? undefined : status, statuses })
      if (accessibleSquadIds) {
        const accessibleSet = new Set(accessibleSquadIds)
        streams = streams.filter((stream) => accessibleSet.has(stream.squadId))
      }
      return c.json(completeVolatilePage(await serializeCanonicalWorkStreams(streams)))
    }

    if (squadId) {
      const streams = await WorkStream.list({
        squadId,
        status: statuses ? undefined : status,
        statuses,
      })
      const attended = respectAttention ? await filterToAttendedStreams(identity, streams) : streams
      return c.json(await serializeCanonicalWorkStreams(attended))
    }

    // No squadId — filtered-list
    const streams = await WorkStream.list({
      status: statuses ? undefined : status,
      statuses,
    })
    const requestedSet = requestedSquadIds?.length ? new Set(requestedSquadIds) : null
    const requestedStreams = requestedSet ? streams.filter((stream) => requestedSet.has(stream.squadId)) : streams
    const filtered = await filterToAccessibleSquads(identity, requestedStreams, (s) => s.squadId ?? null)
    const attended = respectAttention ? await filterToAttendedStreams(identity, filtered) : filtered
    return c.json(await serializeCanonicalWorkStreams(attended))
  })
  .post('/', zValidator('json', createWorkStreamSchema), async (c) => {
    const input = c.req.valid('json')

    // Handler-scope check: verify identity has workstreams:create on the target squad
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)

    const allowed = await hasPermission(identity, 'workstreams:create', input.squadId)
    c.set('authzChecked', true)
    if (!allowed) return c.json({ error: 'Forbidden' }, 403)

    // Verify squad exists
    const squad = await Squad.find(input.squadId)
    if (!squad) {
      return c.json({ error: 'Squad not found' }, 404)
    }

    if (input.workflow) {
      const { authorizeWorkflowSource } = await import('../services/workflows/access')
      try {
        await authorizeWorkflowSource(identity, input.workflow, input.squadId)
      } catch {
        return c.json({ error: 'Workflow is not accessible' }, 403)
      }
    }
    input.workflow = await resolveCreationWorkflow(input.workflow, squad)
    if (
      input.agents !== undefined ||
      input.agentIds !== undefined ||
      input.assigneeAgentId !== undefined ||
      input.assigneeAgentIndex !== undefined ||
      input.agentModelOverrides !== undefined ||
      input.completionMode !== undefined
    )
      return c.json(
        {
          error:
            'Legacy creation flags are no longer supported. Use --workflow or --flow to define participants, models, and delivery policy.',
        },
        400
      )

    try {
      if (input.ownerAgentId) {
        const owner = await Agent.find(input.ownerAgentId)
        if (!owner) {
          return c.json({ error: `Owner agent not found: ${input.ownerAgentId}` }, 404)
        }
        input.ownerAgentId = owner.id
      }

      // Record the requesting human (provenance) so agents can address them later.
      // - A user creating directly is always the requester (self-attribution; no spoofing).
      // - An agent creating on a user's behalf attributes via explicit requestingUserId, else
      //   auto-defaults to whoever it's currently chatting with (most recent attributed message).
      let requestingUserId: string | null
      if (identity.type === 'user') {
        requestingUserId = identity.userId
      } else {
        const candidate =
          identity.type === 'agent'
            ? (input.requestingUserId ?? (await resolveAgentChatSenderUserId(identity.agentId)))
            : (input.requestingUserId ?? null)
        // Only attribute/auto-subscribe a user who can actually read this squad's work streams.
        // Otherwise an agent could inject this stream's notifications into an arbitrary user's inbox.
        requestingUserId =
          candidate && (await hasPermission({ type: 'user', userId: candidate }, 'workstreams:read', input.squadId))
            ? candidate
            : null
      }
      const creatorAgentId = identity.type === 'agent' ? identity.agentId : null
      // Identity comes from the event; access still comes from the squad's own connection.
      if (input.integrationEventId) {
        const tracked = await resolveEventTrackedResource(input.integrationEventId, input.squadId)
        // The server-resolved entry goes FIRST: a client echoing the same identity without the
        // origin must not shadow it, or a replay of this event would create a second stream.
        input.metadata = {
          ...input.metadata,
          tracked: mergeTracked([tracked], input.metadata?.tracked),
        }
      }
      const stream = await WorkStream.create({ ...input, requestingUserId, creatorAgentId })
      // Auto-subscribe the requester to the stream's lifecycle updates (like watching a GitHub PR).
      if (requestingUserId) await subscribeToWorkStream(stream.id, requestingUserId)
      return c.json(stream.toJson(), 201)
    } catch (error) {
      if (error instanceof WorkStreamEventAlreadyHandledError) {
        const existing = await WorkStream.mustFind(error.workStreamId)
        return c.json({ ...existing.toJson(), reusedFromEvent: true }, 200)
      }
      if (error instanceof TrackedResourceError) return c.json({ error: error.message }, error.status)
      if (error instanceof WorktreeCleanupConflictError)
        return c.json({ error: error.message, code: 'worktree_cleanup_conflict' }, 409)
      const message = error instanceof Error ? error.message : String(error)
      const { WorkflowError } = await import('../services/workflows/catalog')
      if (error instanceof WorkflowError) return c.json({ error: message }, error.status)
      if (error instanceof RepositorySetupError || message.includes('metadata.sources')) {
        return c.json({ error: message }, 400)
      }
      throw error
    }
  })
  .get(
    '/:id/worktree-cleanup',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const inspection = await inspectWorktreeCleanup(await routeWorkStreamId(c))
      return inspection ? c.json(inspection) : c.json({ error: 'Work stream not found' }, 404)
    }
  )
  .get(
    '/:id',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)
      const includeMetrics = c.req.query('metrics') === 'true'

      const stream = await WorkStream.find(id)
      if (!stream) {
        return c.json({ error: 'Work stream not found' }, 404)
      }

      const runtime = (await WorkStream.computeRuntimes([stream])).get(stream.id)
      const priorityAnnotations = (await computePriorityAnnotations([stream])).get(stream.id) ?? {}
      const derived = (await computeDerivedStates([stream])).get(stream.id) ?? {}
      // Full audit trail (every wait, open + closed, newest first); reviewHistory
      // is the review-typed subset, so one query feeds both.
      const waitHistory = (await listWaitHistory(db, stream.id)).map(toWaitJson)
      const reviewHistory = waitHistory.filter((w) => w.type === 'review')
      const reviewRounds = reviewHistory.filter((w) => w.closedAt !== null).length
      const requestingUserName = stream.requestingUserId
        ? await User.findById(stream.requestingUserId)
            .then((u) => u?.displayName || u?.email || null)
            .catch(() => null)
        : null
      const json = {
        ...stream.toJson(),
        runtime,
        requestingUserName,
        ...priorityAnnotations,
        ...derived,
        reviewHistory,
        reviewRounds,
        waitHistory,
      }

      if (includeMetrics) {
        const metrics = await stream.getMetrics()
        return c.json({ ...json, metrics })
      }

      return c.json(json)
    }
  )
  // --- Work-stream attention (levels for this stream; a row here overrides the squad's) ---
  .get(
    '/:id/subscription',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)
      const stream = await WorkStream.find(id)
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      const identity = await resolveActingUser(c.get('identity'))
      const resolved = await resolveStreamSubscription(id, stream.squadId, identity)
      return c.json({ ...resolved, count: await countWorkStreamSubscribers(id) })
    }
  )
  .post(
    '/:id/subscribe',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)
      const identity = await resolveActingUser(c.get('identity'))
      if (identity?.type !== 'user') return userSessionRequired(c, c.get('identity'), 'follow work streams')
      const stream = await WorkStream.find(id)
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      const body = await parseOptionalJsonObjectBody(c, {} as Record<string, unknown>)
      const requested = body.attention === undefined ? undefined : attentionSchema.safeParse(body.attention)
      if (requested && !requested.success) return c.json({ error: 'Invalid attention levels' }, 400)
      await subscribeToWorkStream(id, identity.userId, requested?.data)
      const resolved = await resolveStreamSubscription(id, stream.squadId, identity)
      return c.json({ ...resolved, count: await countWorkStreamSubscribers(id) })
    }
  )
  .delete(
    '/:id/subscribe',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)
      const identity = await resolveActingUser(c.get('identity'))
      if (identity?.type !== 'user') return userSessionRequired(c, c.get('identity'), 'follow work streams')
      const stream = await WorkStream.find(id)
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      await unsubscribeFromWorkStream(id, identity.userId)
      const resolved = await resolveStreamSubscription(id, stream.squadId, identity)
      return c.json({ ...resolved, count: await countWorkStreamSubscribers(id) })
    }
  )
  // --- Tracked links (issues and pull requests this stream follows alongside its delivery) ---
  .get(
    '/:id/tracked',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      try {
        return c.json(await listTrackedResources(await routeWorkStreamId(c)))
      } catch (error) {
        return trackedResourceFailure(c, error)
      }
    }
  )
  .post(
    '/:id/tracked',
    requireWorkStreamUpdatePermission,
    zValidator('json', trackedResourceRequestSchema),
    async (c) => {
      const stream = await WorkStream.find(await routeWorkStreamId(c))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      try {
        const resource = await resolveTrackedResourceRequest(stream.squadId, c.req.valid('json'))
        const { added, changed, view } = await addTrackedResources(stream.id, [resource])
        return c.json({ added, changed, ...view })
      } catch (error) {
        return trackedResourceFailure(c, error)
      }
    }
  )
  .delete(
    '/:id/tracked',
    requireWorkStreamUpdatePermission,
    zValidator('json', trackedResourceRequestSchema),
    async (c) => {
      const stream = await WorkStream.find(await routeWorkStreamId(c))
      if (!stream) return c.json({ error: 'Work stream not found' }, 404)
      const request = c.req.valid('json')
      // Untracking is identity-only: a squad can always unlink, even after losing the connection.
      if ('event' in request) return c.json({ error: 'Untrack a link by url, reference or resource' }, 400)
      const target = trackedResourceRequestIdentity(request)
      if (!target) return c.json({ error: 'Link is not a supported issue or pull request URL or reference' }, 400)
      try {
        const { removed, view } = await removeTrackedResource(stream.id, target)
        return c.json({ removed, ...view })
      } catch (error) {
        return trackedResourceFailure(c, error)
      }
    }
  )
  .patch('/:id', requireWorkStreamUpdatePermission, zValidator('json', updateWorkStreamSchema), async (c) => {
    const id = await routeWorkStreamId(c)
    const input = c.req.valid('json')

    const existing = await WorkStream.find(id)
    if (!existing) {
      return c.json({ error: 'Work stream not found' }, 404)
    }

    // Resolve agent ID prefix for assignee
    if (input.assigneeAgentId) {
      const agent = await Agent.find(input.assigneeAgentId)
      if (!agent) {
        return c.json({ error: `Agent not found: ${input.assigneeAgentId}` }, 404)
      }
      input.assigneeAgentId = agent.id

      // Validate assignee is in agent list (if set)
      // Use input.agentIds if provided, otherwise fall back to existing
      // Supports both full UUIDs and UUID prefixes in the agent list
      const agentIdsList = input.agentIds !== undefined ? input.agentIds : existing.agentIds
      if (agentIdsList && agentIdsList.length > 0) {
        const isAllowed = agentIdsList.some((allowedId) => agent.id === allowedId || agent.id.startsWith(allowedId))
        if (!isAllowed) {
          return c.json(
            {
              error: `Agent ${agent.id} is not in the agents list for this work stream. Agents: ${agentIdsList.join(', ')}`,
            },
            400
          )
        }
      }
    }

    if (input.ownerAgentId) {
      const owner = await Agent.find(input.ownerAgentId)
      if (!owner) {
        return c.json({ error: `Owner agent not found: ${input.ownerAgentId}` }, 404)
      }
      input.ownerAgentId = owner.id
    }

    try {
      await existing.update(input, { actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined) })
      return c.json(existing.toJson())
    } catch (error) {
      if (error instanceof WorktreeCleanupConflictError)
        return c.json({ error: error.message, code: 'worktree_cleanup_conflict' }, 409)
      // done with open waits (spec §5) and terminal-status backdoor writes
      // (spec §6) are state conflicts, not bad requests.
      if (error instanceof WorkStreamOpenWaitsError) {
        return c.json({ error: error.message, code: 'open_waits', openWaits: error.openWaits }, 409)
      }
      if (error instanceof WorkStreamTerminalTransitionError) {
        return c.json({ error: error.message, code: 'terminal_status' }, 409)
      }
      if (error instanceof TrackedResourceError) return c.json({ error: error.message }, error.status)
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  // --- Wait verbs ---
  // Typed wait resolution (replaces the legacy free-text POST /:id/respond).
  .post(
    '/:id/waits/:waitId/resolve',
    requireWorkStreamRespondPermission,
    zValidator('json', resolveWorkStreamWaitSchema),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) return c.json({ error: 'Work stream not found' }, 404)
      const input = c.req.valid('json')
      try {
        const wait = await existing.resolveWait(c.req.param('waitId'), {
          ...input,
          actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined),
        })
        return c.json({ ...existing.toJson(), wait: toWaitJson(wait) })
      } catch (error) {
        if (error instanceof WorkStreamWaitResolveError) {
          const status =
            error.code === 'wait_not_found'
              ? 404
              : error.code === 'wait_already_closed' || error.code === 'work_stream_terminal'
                ? 409
                : 400
          return c.json({ error: error.message, code: error.code }, status)
        }
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  // Opens the (unique) review wait; idempotent while one is open.
  .post(
    '/:id/request-review',
    requireWorkStreamUpdatePermission,
    zValidator('json', requestReviewWorkStreamSchema),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) return c.json({ error: 'Work stream not found' }, 404)
      const input = c.req.valid('json')
      try {
        const attribution = await waitAttribution(c.get('identity') as Identity | undefined, existing.squadId)
        const { wait, alreadyOpen } = await existing.handoffForReview({
          message: input.message,
          ...(input.completesOnApproval !== undefined ? { completesOnApproval: input.completesOnApproval } : {}),
          ...attribution,
        })
        return c.json({ ...existing.toJson(), wait: toWaitJson(wait), alreadyOpen })
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .post('/:id/approve', requireWorkStreamRespondPermission, async (c) => {
    const existing = await WorkStream.find(await routeWorkStreamId(c))
    if (!existing) return c.json({ error: 'Work stream not found' }, 404)
    // Tolerant body parse (like park): an empty body stays valid for existing
    // callers; a note, when present, is validated and passed through (§4b).
    let body: unknown = {}
    try {
      const text = await c.req.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const parsed = approveWorkStreamSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400)
    }
    try {
      await existing.approveReview({
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
        actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined),
      })
      return c.json(existing.toJson())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return c.json({ error: message }, message.includes('no open review wait') ? 409 : 400)
    }
  })
  .post(
    '/:id/send-back',
    requireWorkStreamRespondPermission,
    zValidator('json', sendBackWorkStreamSchema),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) return c.json({ error: 'Work stream not found' }, 404)
      const input = c.req.valid('json')
      try {
        await existing.sendBackReview(input.note, {
          actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined),
        })
        return c.json(existing.toJson())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return c.json({ error: message }, message.includes('no open review wait') ? 409 : 400)
      }
    }
  )
  // Opens a manual wait: the stream needs input/action from the owner/operator.
  .post(
    '/:id/request-input',
    requireWorkStreamUpdatePermission,
    zValidator('json', requestInputWorkStreamSchema),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) return c.json({ error: 'Work stream not found' }, 404)
      const input = c.req.valid('json')
      try {
        const attribution = await waitAttribution(c.get('identity') as Identity | undefined, existing.squadId)
        const wait = await existing.block({ ...input, ...attribution })
        return c.json({ ...existing.toJson(), wait: toWaitJson(wait) })
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .post('/:id/unblock', requireWorkStreamUpdatePermission, zValidator('json', unblockWorkStreamSchema), async (c) => {
    const existing = await WorkStream.find(await routeWorkStreamId(c))
    if (!existing) return c.json({ error: 'Work stream not found' }, 404)
    const input = c.req.valid('json')
    try {
      const closed = await existing.unblock({
        note: input.note,
        actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined),
      })
      if (closed.length === 0) {
        return c.json({ error: 'Work stream has no open manual wait to clear' }, 409)
      }
      return c.json({ ...existing.toJson(), closedWaits: closed.map(toWaitJson) })
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  .post(
    '/:id/pause',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      try {
        const text = await c.req.text()
        const stream = await pauseWorkStream(await routeWorkStreamId(c), text ? JSON.parse(text) : {})
        return c.json(stream.toJson())
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .post(
    '/:id/resume',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      try {
        return c.json((await resumeWorkStream(await routeWorkStreamId(c))).toJson())
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .post(
    '/:id/park',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) {
        return c.json({ error: 'Work stream not found' }, 404)
      }
      let body: unknown = {}
      try {
        const text = await c.req.text()
        body = text ? JSON.parse(text) : {}
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      const parsed = parkWorkStreamSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400)
      }
      try {
        const { stream, reAdmitted } = await parkWorkStream(existing.id, parsed.data)
        const annotations = (await computePriorityAnnotations([stream])).get(stream.id) ?? {}
        return c.json({ ...stream.toJson(), ...annotations, reAdmitted })
      } catch (error) {
        if (error instanceof WorkStreamBusyError) {
          return c.json(
            {
              code: 'WORK_STREAM_BUSY',
              error: error.message,
              workStreamId: error.workStreamId,
              agentId: error.agentId,
              executionId: error.executionId,
              executionStatus: error.executionStatus,
            },
            409
          )
        }
        const status = error instanceof WorkStreamNotParkableError ? 409 : 400
        return c.json({ error: error instanceof Error ? error.message : String(error) }, status)
      }
    }
  )
  // Reopen a terminal stream back into admission (spec §6). Same permission
  // class as cancel/park: workstreams:update on the squad.
  .post(
    '/:id/reopen',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) {
        return c.json({ error: 'Work stream not found' }, 404)
      }
      try {
        await existing.reopen({ actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined) })
        return c.json(existing.toJson())
      } catch (error) {
        if (error instanceof WorktreeCleanupConflictError)
          return c.json({ error: error.message, code: 'worktree_cleanup_conflict' }, 409)
        if (error instanceof WorkStreamNotReopenableError) {
          return c.json({ error: error.message, code: 'not_reopenable' }, 409)
        }
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .post(
    '/:id/cancel',
    requireEntityPermission('workstreams:update', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const existing = await WorkStream.find(await routeWorkStreamId(c))
      if (!existing) {
        return c.json({ error: 'Work stream not found' }, 404)
      }

      try {
        const { stopResults } = await existing.cancelWithSideEffects({
          actorAgentId: actorAgentIdFrom(c.get('identity') as Identity | undefined),
        })
        return c.json({ ...existing.toJson(), cancellation: { stopResults } })
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
      }
    }
  )
  .delete(
    '/:id',
    requireEntityPermission('workstreams:delete', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)

      const existing = await WorkStream.find(id)
      if (!existing) {
        return c.json({ error: 'Work stream not found' }, 404)
      }

      try {
        await existing.delete()
        return c.body(null, 204)
      } catch (error) {
        if (error instanceof WorktreeCleanupConflictError)
          return c.json({ error: error.message, code: 'worktree_cleanup_conflict' }, 409)
        throw error
      }
    }
  )
  .get(
    '/:id/ready',
    requireEntityPermission('workstreams:read', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const id = await routeWorkStreamId(c)

      const existing = await WorkStream.find(id)
      if (!existing) {
        return c.json({ error: 'Work stream not found' }, 404)
      }

      const ready = await existing.areDependenciesMet()
      return c.json({ ready })
    }
  )
  .post(
    '/:id/agents/:agentId',
    requireEntityPermission('workstreams:manage-agents', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const ws = await WorkStream.mustFind(await routeWorkStreamId(c))
      const agentId = c.req.param('agentId')

      if (ws.status === 'canceled') {
        return c.json({ error: 'Work stream has been canceled' }, 400)
      }

      try {
        await ws.addAgent(agentId)
        return c.json(ws.toJson())
      } catch {
        return c.json({ error: 'Failed to add agent' }, 400)
      }
    }
  )
  .delete(
    '/:id/agents/:agentId',
    requireEntityPermission('workstreams:manage-agents', async (c) => routeWorkStreamSquadId(c)),
    async (c) => {
      const ws = await WorkStream.mustFind(await routeWorkStreamId(c))
      const agentId = c.req.param('agentId')

      try {
        await ws.removeAgent(agentId)
        return c.json(ws.toJson())
      } catch {
        return c.json({ error: 'Failed to remove agent' }, 400)
      }
    }
  )
