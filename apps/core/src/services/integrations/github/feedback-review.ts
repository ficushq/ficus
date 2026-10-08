import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type {
  GitHubFeedbackDetail,
  GitHubFeedbackListItem,
  GitHubFeedbackPage,
  GitHubFeedbackQueue,
  GitHubFeedbackScreening,
  GitHubFeedbackSummary,
  GitHubTrustedAuthor,
  GitHubTrustedAuthorList,
  GitHubTrustOrigin,
} from '@ficus/shared'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackScreenings,
  githubFeedbackSources,
  githubPersonalIdentities,
  githubTrustedAuthors,
  integrationAuditEvents,
  squads,
  users,
} from '../../../db'
import { hasUserPermissionWithExecutor, type Identity } from '../../rbac/permissions'
import { authorized } from '../outputs/authority'
import { decisionChain } from '../../decisions/service'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  lockGitHubHuman,
  requireGitHubHuman,
  requireGitHubHumanSquadUpdate,
  resolveGitHubAuthorTrust,
} from './feedback-trust'
import type { ScreenVerdict } from './feedback-screen-policy'

/**
 * Human moderation READ model. Every function requires the authenticated principal itself to be an
 * enabled human with fresh `squads:read` in THIS squad; agents (including delegated user credentials)
 * never read pending content here. Mutations live in feedback-moderation / feedback-trust /
 * author-filter-setting; `retryGitHubFeedbackRelease` is the only mutation defined here.
 */

const RELEASING = ['ready', 'retry', 'retained'] as const
const ALLOWED = ['allow_once', 'allow_trust', 'screened'] as const
/** Bounded scans: these are UI lists, not enumeration APIs. */
const MAX_SOURCES_CHECKED = 20
const MAX_TRUST_ROWS = 500

async function requireReader(identity: Identity | undefined, squadId: string) {
  const userId = await requireGitHubHuman(db, identity)
  if (!(await hasUserPermissionWithExecutor(db, userId, 'squads:read', squadId)))
    throw new GitHubFeedbackError('squad_read_required', 403)
  return { userId, canModerate: await hasUserPermissionWithExecutor(db, userId, 'squads:update', squadId) }
}

function queueCondition(queue: GitHubFeedbackQueue) {
  return queue === 'pending'
    ? eq(githubFeedbackRevisions.decision, 'pending')
    : and(
        inArray(githubFeedbackRevisions.decision, [...ALLOWED]),
        inArray(githubFeedbackRevisions.releaseState, [...RELEASING])
      )
}

export async function getGitHubFeedbackSummary(
  identity: Identity | undefined,
  squadId: string
): Promise<GitHubFeedbackSummary> {
  const { canModerate } = await requireReader(identity, squadId)
  const [squad] = await db
    .select({ enabled: squads.githubAuthorFilter, handling: squads.githubUntrustedHandling })
    .from(squads)
    .where(eq(squads.id, squadId))
  const [counts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${githubFeedbackRevisions.decision} = 'pending')::int`,
      releasing: sql<number>`count(*) filter (where ${queueCondition('releasing')})::int`,
      failing: sql<number>`count(*) filter (where ${queueCondition('releasing')} and ${githubFeedbackRevisions.releaseState} = 'retry')::int`,
    })
    .from(githubFeedbackRevisions)
    .where(eq(githubFeedbackRevisions.squadId, squadId))
  return {
    // An unknown squad fails closed (ON), like isGitHubAuthorFilterEnabled.
    authorFilterEnabled: squad?.enabled ?? true,
    untrustedHandling: squad?.handling === 'screen' ? 'screen' : 'hold',
    decisionModelConfigured: decisionChain('github-firewall').length > 0,
    pending: counts?.pending ?? 0,
    releasing: counts?.releasing ?? 0,
    failing: counts?.failing ?? 0,
    canModerate,
  }
}

/**
 * Opaque keyset cursor over (firstObservedAt, id). It selects a position only, never authority.
 * The timestamp keeps Postgres microseconds: a millisecond JS Date would repeat or skip rows.
 */
const cursorTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function encodeCursor(row: { cursorAt: string; id: string }): string {
  return Buffer.from(`${row.cursorAt}|${row.id}`).toString('base64url')
}
function decodeCursor(cursor: string): { at: string; id: string } {
  const [at, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (extra !== undefined || !cursorTimestamp.test(at ?? '') || !uuidPattern.test(id ?? ''))
    throw new GitHubFeedbackError('invalid_cursor', 400)
  if (Number.isNaN(Date.parse(at!))) throw new GitHubFeedbackError('invalid_cursor', 400)
  return { at: at!, id: id! }
}

const listColumns = {
  id: githubFeedbackRevisions.id,
  contentHash: githubFeedbackRevisions.contentHash,
  decisionVersion: githubFeedbackRevisions.decisionVersion,
  decision: githubFeedbackRevisions.decision,
  releaseState: githubFeedbackRevisions.releaseState,
  reason: githubFeedbackRevisions.reason,
  objectKind: githubFeedbackObjects.objectKind,
  // Only scalar facts are projected for lists; the reviewed body is read by the detail view.
  repository: sql<string | null>`${githubFeedbackRevisions.envelope}->'data'->>'repository'`,
  pullNumber: sql<string | null>`${githubFeedbackRevisions.envelope}->'data'->'pullRequest'->>'number'`,
  issueNumber: sql<string | null>`${githubFeedbackRevisions.envelope}->'data'->'issue'->>'number'`,
  hasEnvelope: sql<boolean>`${githubFeedbackRevisions.envelope} is not null`,
  author: githubFeedbackRevisions.author,
  editor: githubFeedbackRevisions.editor,
  attribution: githubFeedbackRevisions.attribution,
  byteCount: githubFeedbackRevisions.byteCount,
  attempts: githubFeedbackRevisions.attempts,
  firstObservedAt: githubFeedbackRevisions.firstObservedAt,
  cursorAt: sql<string>`to_char(${githubFeedbackRevisions.firstObservedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  updatedAt: githubFeedbackRevisions.updatedAt,
  screeningState: githubFeedbackScreenings.state,
  screeningOutcome: githubFeedbackScreenings.outcome,
  screeningVerdict: githubFeedbackScreenings.verdict,
  screenedAt: githubFeedbackScreenings.screenedAt,
}
type ListRow = { [K in keyof typeof listColumns]: any }

function toListItem(row: ListRow): GitHubFeedbackListItem {
  const number = Number(row.pullNumber ?? row.issueNumber)
  return {
    id: row.id,
    contentHash: row.contentHash,
    decisionVersion: row.decisionVersion,
    decision: row.decision,
    releaseState: row.releaseState,
    reason: row.reason ?? null,
    objectKind: row.objectKind ?? null,
    repository: typeof row.repository === 'string' ? row.repository : null,
    number: Number.isSafeInteger(number) && number > 0 ? number : null,
    isPullRequest: row.pullNumber != null,
    author: row.author ?? null,
    editor: row.editor ?? null,
    attribution: row.attribution,
    byteCount: row.byteCount,
    contentAvailable: !!row.hasEnvelope && row.reason !== 'content_unavailable',
    firstObservedAt: new Date(row.firstObservedAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    attempts: row.attempts,
    screening: toScreening(row),
  }
}

/** The decision model's answers and who gave them; the screened text is never stored. */
function toScreening(row: ListRow): GitHubFeedbackScreening | null {
  if (!row.screeningState) return null
  const verdict = row.screeningVerdict as ScreenVerdict | null
  return {
    state: row.screeningState,
    outcome: row.screeningOutcome ?? null,
    instructsAgent: verdict?.instructsAgent ?? null,
    intent: verdict?.intent ?? null,
    intentConfidence: verdict?.intentConfidence ?? null,
    providerId: verdict?.providerId ?? null,
    model: verdict?.model ?? null,
    screenedAt: row.screenedAt ? new Date(row.screenedAt).toISOString() : null,
  }
}

export async function listGitHubFeedback(
  identity: Identity | undefined,
  squadId: string,
  query: { queue: GitHubFeedbackQueue; cursor?: string; limit: number }
): Promise<GitHubFeedbackPage> {
  const { canModerate } = await requireReader(identity, squadId)
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100)
  const after = query.cursor ? decodeCursor(query.cursor) : null
  const rows = await db
    .select(listColumns)
    .from(githubFeedbackRevisions)
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .leftJoin(githubFeedbackScreenings, eq(githubFeedbackScreenings.revisionId, githubFeedbackRevisions.id))
    .where(
      and(
        eq(githubFeedbackRevisions.squadId, squadId),
        queueCondition(query.queue),
        after
          ? sql`(${githubFeedbackRevisions.firstObservedAt}, ${githubFeedbackRevisions.id}) > (${after.at}::timestamptz, ${after.id}::uuid)`
          : undefined
      )
    )
    .orderBy(asc(githubFeedbackRevisions.firstObservedAt), asc(githubFeedbackRevisions.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    items: page.map(toListItem),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
    canModerate,
  }
}

const safeGitHubUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      ? url.toString()
      : null
  } catch {
    return null
  }
}

/**
 * Exact-resource gate for disclosure: at least one recorded source must still come from a connection
 * that is enabled, healthy, assigned to THIS squad and on the same material revision. A rotated or
 * revoked connection withholds the body (decision metadata stays visible so a human can still deny).
 */
async function hasCurrentSourceAccess(revisionId: string, squadId: string): Promise<boolean> {
  const sources = await db
    .select({ authority: githubFeedbackSources.authority })
    .from(githubFeedbackSources)
    .where(and(eq(githubFeedbackSources.revisionId, revisionId), eq(githubFeedbackSources.squadId, squadId)))
    .limit(MAX_SOURCES_CHECKED)
  for (const source of sources)
    if (source.authority.kind === 'connection' && (await authorized(db, 'github', source.authority, squadId)))
      return true
  return false
}

export async function getGitHubFeedbackDetail(
  identity: Identity | undefined,
  squadId: string,
  revisionId: string
): Promise<GitHubFeedbackDetail> {
  const { canModerate } = await requireReader(identity, squadId)
  const [row] = await db
    .select({
      ...listColumns,
      envelope: githubFeedbackRevisions.envelope,
      routingProvenance: githubFeedbackRevisions.routingProvenance,
      decidedByUserId: githubFeedbackRevisions.decidedByUserId,
      decidedAt: githubFeedbackRevisions.decidedAt,
    })
    .from(githubFeedbackRevisions)
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .leftJoin(githubFeedbackScreenings, eq(githubFeedbackScreenings.revisionId, githubFeedbackRevisions.id))
    // Squad-bound lookup: another squad's revision is indistinguishable from a missing one.
    .where(and(eq(githubFeedbackRevisions.id, revisionId), eq(githubFeedbackRevisions.squadId, squadId)))
    .limit(1)
  if (!row) throw new GitHubFeedbackError('revision_not_found', 404)
  const item = toListItem(row)
  const access = item.contentAvailable && (await hasCurrentSourceAccess(row.id, squadId))
  const envelope = access ? row.envelope : null
  const data = (envelope?.data ?? {}) as Record<string, any>
  const content = (data.content ?? {}) as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? value : '')
  return {
    ...item,
    content: envelope
      ? {
          title: text(content.title),
          body: text(content.body),
          ...(typeof content.path === 'string'
            ? { path: content.path, line: Number.isSafeInteger(content.line) ? (content.line as number) : null }
            : {}),
          reviewState: text(data.state),
          deliveryText: envelope.body,
          deliveryTruncated: data.notificationTruncated === true,
        }
      : null,
    contentWithheld: envelope ? null : item.contentAvailable ? 'source_access_unavailable' : 'content_unavailable',
    url: envelope ? safeGitHubUrl(envelope.url) : null,
    authorTrust: await resolveGitHubAuthorTrust(db, squadId, item.author?.accountId),
    editorTrust: item.editor ? await resolveGitHubAuthorTrust(db, squadId, item.editor.accountId) : [],
    routes: (row.routingProvenance ?? []).map((route) => ({
      kind: route.kind,
      id: route.id,
      workStreamId: route.workStreamId ?? null,
      recipientId: route.recipientId ?? null,
    })),
    decidedByUserId: row.decidedByUserId ?? null,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
    canModerate,
  }
}

/**
 * Both trust origins grouped by stable account ID. Dynamic entries are computed live (linked, enabled
 * human with fresh squads:update here); nothing derived is persisted.
 */
export async function listGitHubTrustedAuthors(
  identity: Identity | undefined,
  squadId: string
): Promise<GitHubTrustedAuthorList> {
  const { canModerate } = await requireReader(identity, squadId)
  const authors = new Map<string, GitHubTrustedAuthor>()
  const add = (account: Omit<GitHubTrustedAuthor, 'origins'>, origin: GitHubTrustOrigin) => {
    const entry = authors.get(account.accountId) ?? { ...account, origins: [] }
    entry.origins.push(origin)
    authors.set(account.accountId, entry)
  }
  const manual = await db
    .select()
    .from(githubTrustedAuthors)
    .where(and(eq(githubTrustedAuthors.squadId, squadId), eq(githubTrustedAuthors.host, 'github.com')))
    .orderBy(asc(githubTrustedAuthors.createdAt))
    .limit(MAX_TRUST_ROWS)
  for (const row of manual)
    add(
      { accountId: row.accountId, login: row.login, accountType: row.accountType },
      { kind: 'manual', addedByUserId: row.addedByUserId }
    )
  const linked = await db
    .select({
      userId: githubPersonalIdentities.userId,
      accountId: githubPersonalIdentities.accountId,
      login: githubPersonalIdentities.login,
    })
    .from(githubPersonalIdentities)
    .innerJoin(users, eq(users.id, githubPersonalIdentities.userId))
    .where(
      and(
        eq(githubPersonalIdentities.host, 'github.com'),
        isNull(githubPersonalIdentities.unlinkedAt),
        isNull(users.disabledAt)
      )
    )
    .limit(MAX_TRUST_ROWS)
  for (const row of linked) {
    if (!row.accountId || !row.login) continue
    if (!(await hasUserPermissionWithExecutor(db, row.userId, 'squads:update', squadId))) continue
    add(
      { accountId: row.accountId, login: row.login, accountType: 'User' },
      { kind: 'linked_user', userId: row.userId }
    )
  }
  return { authors: [...authors.values()], canManage: canModerate }
}

/**
 * Human "retry now" for an allowed revision whose release is waiting to retry. It only clears the
 * backoff; the release worker still re-routes and rechecks every gate. No decision changes.
 */
export async function retryGitHubFeedbackRelease(
  identity: Identity | undefined,
  squadId: string,
  revisionId: string
): Promise<void> {
  try {
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      const updated = await tx
        .update(githubFeedbackRevisions)
        .set({ nextAttemptAt: null, updatedAt: new Date() })
        .where(
          and(
            eq(githubFeedbackRevisions.id, revisionId),
            eq(githubFeedbackRevisions.squadId, squadId),
            inArray(githubFeedbackRevisions.decision, [...ALLOWED]),
            inArray(githubFeedbackRevisions.releaseState, ['retry', 'retained']),
            isNull(githubFeedbackRevisions.leaseToken)
          )
        )
        .returning({ id: githubFeedbackRevisions.id })
      if (!updated.length) throw new GitHubFeedbackError('retry_not_applicable', 409)
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'squad',
        targetId: squadId,
        action: 'github.feedback.retry',
        outcome: 'allowed',
      })
    })
  } catch (error) {
    await db.insert(integrationAuditEvents).values({
      actorKey: githubAuthorityActor(identity),
      targetKind: 'squad',
      targetId: squadId,
      action: 'github.feedback.retry',
      outcome: 'denied',
      code: error instanceof GitHubFeedbackError ? error.code : 'retry_failed',
    })
    throw error
  }
}
