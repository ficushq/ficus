import { createHash } from 'node:crypto'
import { githubAccountIdSchema } from '@ficus/shared'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubPersonalIdentities,
  githubTrustedAuthors,
  integrationOutputEvents,
  memoryDocuments,
  squads,
  users,
} from '../../../db'
import { hasUserPermissionWithExecutor } from '../../rbac/permissions'
import type { GitHubIssueApiComment, GitHubIssueApiItem } from '../../github/api-client'
import { githubContentIdentity } from './feedback-envelope'
import { isGitHubFeedbackAdmitted } from './feedback-admission'

/**
 * Managed GitHub reads (memory indexing and every indexed-document read).
 *
 * With a squad's author filter ON, issue/PR prose is projected per content item: an item is
 * indexed only if its exact text was approved by a human for this squad, or its author (and
 * verified editor) is currently trusted. Everything else is replaced by a fixed, content-free
 * placeholder. Each indexed document records which items it contains and why
 * (`frontmatter.githubProjection`), and every read rechecks that provenance against the CALLER's
 * squad and the source squad, so trust revocation applies to later reads and an approval in one
 * squad is never a grant to another. Documents without that provenance fail closed.
 *
 * With the filter OFF nothing changes: content is indexed and read as it was before the filter.
 * Low-level authenticated GitHub fetches stay raw; only these agent-facing projections are gated.
 */

export const GITHUB_MEMORY_PROJECTION_SCHEMA = 1
const GITHUB_ISSUE_SOURCE_TYPE = 'github_issue'
/** Bounded revision lookup per fetched thread (one parent plus at most 100 comments). */
const REVISION_LOOKUP_LIMIT = 1000

type Executor = Pick<typeof db, 'select'>
type ItemKind = 'issue' | 'pull_request' | 'issue_comment'

export interface GitHubMemoryItem {
  kind: ItemKind
  nativeId: string | null
  /** Provider-native numeric account IDs; never logins. */
  author: string | null
  editor?: string
  /** `approved`: exact human-approved revision in the indexing squad; `trusted`: live author trust. */
  basis: 'approved' | 'trusted' | 'unfiltered'
  revisionId?: string
}

export interface GitHubMemoryProjection {
  schema: typeof GITHUB_MEMORY_PROJECTION_SCHEMA
  /** False when indexed with the filter OFF: such a document is never readable under an ON gate. */
  filtered: boolean
  items: GitHubMemoryItem[]
  withheldComments: number
  parentWithheld: boolean
}

export interface ProjectedGitHubThread {
  parentAdmitted: boolean
  comments: GitHubIssueApiComment[]
  projection: GitHubMemoryProjection
}

/** Fresh, uncached read of the author filter for several squads. Unknown squads fail closed (ON). */
async function authorFilterStates(executor: Executor, squadIds: string[]): Promise<Map<string, boolean>> {
  const unique = [...new Set(squadIds)]
  const rows = unique.length
    ? await executor
        .select({ id: squads.id, enabled: squads.githubAuthorFilter })
        .from(squads)
        .where(inArray(squads.id, unique))
    : []
  const states = new Map(unique.map((id) => [id, true]))
  for (const row of rows) states.set(row.id, row.enabled)
  return states
}

/**
 * Batched form of resolveGitHubAuthorTrust: the accounts in `accountIds` that are currently trusted
 * in `squadId`, manually or through a linked, enabled human with squads:update in that squad.
 */
export async function trustedGitHubAccounts(
  executor: Executor,
  squadId: string,
  accountIds: Iterable<string | null | undefined>
): Promise<Set<string>> {
  const ids = [...new Set([...accountIds].filter((id): id is string => githubAccountIdSchema.safeParse(id).success))]
  const trusted = new Set<string>()
  if (!ids.length) return trusted
  const manual = await executor
    .select({ accountId: githubTrustedAuthors.accountId })
    .from(githubTrustedAuthors)
    .where(
      and(
        eq(githubTrustedAuthors.squadId, squadId),
        eq(githubTrustedAuthors.host, 'github.com'),
        inArray(githubTrustedAuthors.accountId, ids)
      )
    )
  for (const row of manual) trusted.add(row.accountId)
  const linked = await executor
    .select({ accountId: githubPersonalIdentities.accountId, userId: githubPersonalIdentities.userId })
    .from(githubPersonalIdentities)
    .innerJoin(users, eq(users.id, githubPersonalIdentities.userId))
    .where(
      and(
        eq(githubPersonalIdentities.host, 'github.com'),
        inArray(githubPersonalIdentities.accountId, ids),
        isNull(githubPersonalIdentities.unlinkedAt),
        isNull(users.disabledAt)
      )
    )
  const permitted = new Map<string, boolean>()
  for (const row of linked) {
    if (!row.accountId || trusted.has(row.accountId)) continue
    if (!permitted.has(row.userId))
      permitted.set(row.userId, await hasUserPermissionWithExecutor(executor, row.userId, 'squads:update', squadId))
    if (permitted.get(row.userId)) trusted.add(row.accountId)
  }
  return trusted
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
/** Hash of stored reviewed text, computed in SQL so bodies are never materialized for this check. */
const storedTextHash = (field: 'body' | 'title') =>
  sql<
    string | null
  >`case when ${githubFeedbackRevisions.envelope} is null then null else encode(sha256(convert_to(coalesce(${githubFeedbackRevisions.envelope} #>> ${`{data,content,${field}}`}, ''), 'UTF8')), 'hex') end`

interface Candidate {
  kind: ItemKind
  nativeId: string | null
  author: string | null
  bodyHash: string
  titleHash?: string
  /** Comments only: the REST clock shows the text never changed after creation. */
  unchanged: boolean
}

type RevisionMatch = {
  revisionId: string
  decision: string
  attribution: string
  author: string | null
  editor: string | null
}

/** Latest stored revision of each object whose reviewed text equals the fetched text. */
async function latestMatchingRevisions(
  executor: Executor,
  squadId: string,
  candidates: Candidate[]
): Promise<Map<Candidate, RevisionMatch> | null> {
  const nativeIds = [...new Set(candidates.map((item) => item.nativeId).filter((id): id is string => !!id))]
  const matches = new Map<Candidate, RevisionMatch>()
  if (!nativeIds.length) return matches
  const rows = await executor
    .select({
      kind: githubFeedbackObjects.objectKind,
      nativeId: githubFeedbackObjects.nativeId,
      revisionId: githubFeedbackRevisions.id,
      sequence: githubFeedbackRevisions.sequence,
      decision: githubFeedbackRevisions.decision,
      attribution: githubFeedbackRevisions.attribution,
      author: githubFeedbackRevisions.author,
      editor: githubFeedbackRevisions.editor,
      bodyHash: storedTextHash('body'),
      titleHash: storedTextHash('title'),
    })
    .from(githubFeedbackObjects)
    .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.objectId, githubFeedbackObjects.id))
    .where(
      and(
        eq(githubFeedbackObjects.squadId, squadId),
        inArray(githubFeedbackObjects.objectKind, ['issue', 'pull_request', 'issue_comment']),
        inArray(githubFeedbackObjects.nativeId, nativeIds)
      )
    )
    .orderBy(desc(githubFeedbackRevisions.sequence))
    .limit(REVISION_LOOKUP_LIMIT + 1)
  // Too much history to evaluate within the bound: fail closed rather than read a partial view.
  if (rows.length > REVISION_LOOKUP_LIMIT) return null
  for (const item of candidates) {
    const match = rows.find(
      (row) =>
        row.kind === item.kind &&
        row.nativeId === item.nativeId &&
        row.bodyHash === item.bodyHash &&
        (item.titleHash === undefined || row.titleHash === item.titleHash)
    )
    if (match)
      matches.set(item, {
        revisionId: match.revisionId,
        decision: match.decision,
        attribution: match.attribution,
        author: match.author?.accountId ?? null,
        editor: match.editor?.accountId ?? null,
      })
  }
  return matches
}

/**
 * Decide which items of a fetched issue/PR thread may be indexed for `squadId`.
 * Order for an item whose exact text was captured: the LATEST matching revision decides — deny or
 * pending withholds, a human allow admits exactly that text, an automatic admission is rechecked
 * against current author/editor trust. Uncaptured text needs a currently trusted author; an edited
 * comment (no editor available over REST) needs a captured, admitted revision.
 */
export async function projectGitHubThreadForMemory(
  squadId: string,
  detail: GitHubIssueApiItem,
  comments: GitHubIssueApiComment[],
  executor: Executor = db,
  options: {
    /** The pull request's own id (`/pulls/:number`), which the issues API does not report. */
    pullRequestId?: number | null
  } = {}
): Promise<ProjectedGitHubThread> {
  const parentKind: ItemKind = detail.pull_request ? 'pull_request' : 'issue'
  const nativeId = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null
  const unchanged = (createdAt: unknown, updatedAt: unknown) =>
    typeof createdAt === 'string' &&
    Number.isFinite(Date.parse(createdAt)) &&
    typeof updatedAt === 'string' &&
    Date.parse(createdAt) === Date.parse(updatedAt)
  const parent: Candidate = {
    kind: parentKind,
    // The issues API reports the ISSUE id; a pull request's captured object uses its PR id, which
    // the caller fetches separately. Without it an edited PR parent cannot match a revision.
    nativeId: parentKind === 'issue' ? nativeId(detail.id) : nativeId(options.pullRequestId),
    author: githubContentIdentity(detail.user)?.accountId ?? null,
    bodyHash: sha256Hex(detail.body ?? ''),
    titleHash: sha256Hex(detail.title ?? ''),
    // An edited title or description has no provable editor over REST (anyone with write access
    // may have rewritten it), so like an edited comment it is admitted only through a captured,
    // admitted revision, never on the original author's trust.
    unchanged: unchanged(detail.created_at, detail.updated_at),
  }
  const children: Candidate[] = comments.map((comment) => ({
    kind: 'issue_comment',
    nativeId: nativeId(comment.id),
    author: githubContentIdentity(comment.user)?.accountId ?? null,
    bodyHash: sha256Hex(comment.body ?? ''),
    unchanged: unchanged(comment.created_at, comment.updated_at),
  }))
  const unfiltered = (item: Candidate): GitHubMemoryItem => ({
    kind: item.kind,
    nativeId: item.nativeId,
    author: item.author,
    basis: 'unfiltered',
  })
  if (!(await authorFilterStates(executor, [squadId])).get(squadId))
    return {
      parentAdmitted: true,
      comments,
      projection: {
        schema: GITHUB_MEMORY_PROJECTION_SCHEMA,
        filtered: false,
        items: [parent, ...children].map(unfiltered),
        withheldComments: 0,
        parentWithheld: false,
      },
    }

  const all = [parent, ...children]
  const matches = await latestMatchingRevisions(executor, squadId, all)
  const trusted = await trustedGitHubAccounts(executor, squadId, [
    ...all.map((item) => item.author),
    ...[...(matches?.values() ?? [])].flatMap((match) => [match.author, match.editor]),
  ])
  const admit = (item: Candidate): GitHubMemoryItem | null => {
    if (!matches) return null
    const match = matches.get(item)
    if (match) {
      if (match.decision === 'allow_once' || match.decision === 'allow_trust' || match.decision === 'screened')
        return {
          kind: item.kind,
          nativeId: item.nativeId,
          author: match.author,
          basis: 'approved',
          revisionId: match.revisionId,
        }
      if (match.decision === 'automatic') {
        const editorTrusted = match.attribution === 'creation' || (!!match.editor && trusted.has(match.editor))
        return match.author && trusted.has(match.author) && editorTrusted
          ? {
              kind: item.kind,
              nativeId: item.nativeId,
              author: match.author,
              ...(match.attribution === 'verified_edit' && match.editor ? { editor: match.editor } : {}),
              basis: 'trusted',
            }
          : null
      }
      // deny and pending are final for this exact text; historical falls through to live trust.
      if (match.decision !== 'historical') return null
    }
    return item.author && trusted.has(item.author) && item.unchanged
      ? { kind: item.kind, nativeId: item.nativeId, author: item.author, basis: 'trusted' }
      : null
  }
  const parentItem = admit(parent)
  const items: GitHubMemoryItem[] = parentItem ? [parentItem] : []
  const admittedComments: GitHubIssueApiComment[] = []
  children.forEach((child, index) => {
    const item = admit(child)
    if (!item) return
    items.push(item)
    admittedComments.push(comments[index]!)
  })
  return {
    parentAdmitted: !!parentItem,
    comments: admittedComments,
    projection: {
      schema: GITHUB_MEMORY_PROJECTION_SCHEMA,
      filtered: true,
      items,
      withheldComments: comments.length - admittedComments.length,
      parentWithheld: !parentItem,
    },
  }
}

function parseProjection(value: unknown): GitHubMemoryProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const projection = value as Partial<GitHubMemoryProjection>
  return projection.schema === GITHUB_MEMORY_PROJECTION_SCHEMA &&
    typeof projection.filtered === 'boolean' &&
    Array.isArray(projection.items)
    ? (projection as GitHubMemoryProjection)
    : null
}

/**
 * The subset of `documentIds` that `callerSquadId` must not see: GitHub documents whose recorded
 * provenance no longer satisfies an ON gate (the source squad's and, for shared memory, the
 * caller's). Non-GitHub documents are never withheld. Bounded by the caller's own result window.
 */
export async function withheldGitHubMemoryDocuments(
  callerSquadId: string,
  documentIds: Iterable<string>,
  executor: Executor = db
): Promise<Set<string>> {
  const ids = [...new Set(documentIds)]
  const withheld = new Set<string>()
  if (!ids.length) return withheld
  const documents = await executor
    .select({
      id: memoryDocuments.id,
      squadId: memoryDocuments.squadId,
      projection: sql<unknown>`${memoryDocuments.frontmatter} -> 'githubProjection'`,
    })
    .from(memoryDocuments)
    .where(and(inArray(memoryDocuments.id, ids), eq(memoryDocuments.sourceType, GITHUB_ISSUE_SOURCE_TYPE)))
  if (!documents.length) return withheld
  const filterOn = await authorFilterStates(executor, [callerSquadId, ...documents.map((doc) => doc.squadId)])

  const plans: Array<{ id: string; gates: string[]; squadId: string; projection: GitHubMemoryProjection }> = []
  for (const doc of documents) {
    const gates = [...new Set([doc.squadId, callerSquadId])].filter((squadId) => filterOn.get(squadId))
    if (!gates.length) continue
    const projection = parseProjection(doc.projection)
    // Missing provenance (legacy or OFF-time index) never satisfies an ON gate; reindex restores it.
    if (!projection?.filtered) {
      withheld.add(doc.id)
      continue
    }
    plans.push({ id: doc.id, gates, squadId: doc.squadId, projection })
  }

  const accountsBySquad = new Map<string, Set<string>>()
  const revisionIds = new Set<string>()
  for (const plan of plans)
    for (const item of plan.projection.items)
      for (const gate of plan.gates) {
        if (item.basis === 'approved' && gate === plan.squadId && item.revisionId) revisionIds.add(item.revisionId)
        else
          for (const account of [item.author, item.editor])
            if (account) {
              const accounts = accountsBySquad.get(gate) ?? new Set<string>()
              accounts.add(account)
              accountsBySquad.set(gate, accounts)
            }
      }
  const trusted = new Map<string, Set<string>>()
  for (const [squadId, accounts] of accountsBySquad)
    trusted.set(squadId, await trustedGitHubAccounts(executor, squadId, accounts))
  const approved = new Set(
    revisionIds.size
      ? (
          await executor
            .select({ id: githubFeedbackRevisions.id, squadId: githubFeedbackRevisions.squadId })
            .from(githubFeedbackRevisions)
            .where(
              and(
                inArray(githubFeedbackRevisions.id, [...revisionIds]),
                inArray(githubFeedbackRevisions.decision, ['allow_once', 'allow_trust', 'screened'])
              )
            )
        ).map((row) => `${row.squadId}:${row.id}`)
      : []
  )

  for (const plan of plans) {
    const visible = plan.gates.every((gate) =>
      plan.projection.items.every((item) => {
        // A source-squad approval is not a grant to another squad reading shared memory.
        if (item.basis === 'approved')
          return gate === plan.squadId && !!item.revisionId && approved.has(`${gate}:${item.revisionId}`)
        if (item.basis !== 'trusted' || !item.author) return false
        const accounts = trusted.get(gate)
        return !!accounts?.has(item.author) && (!item.editor || accounts.has(item.editor))
      })
    )
    if (!visible) withheld.add(plan.id)
  }
  return withheld
}

/**
 * Whether an integration event may seed agent-facing work (`--from-event` tracking/creation) in
 * `squadId`. Under an ON filter agents only ever see content-free status projections and admitted
 * canonical feedback, so a raw provider event or a held/denied revision is refused even when its ID
 * is guessed. Local check only: no provider I/O and no reliance on a short-lived witness.
 */
export async function isGitHubEventUsableForSquad(
  event: typeof integrationOutputEvents.$inferSelect,
  squadId: string,
  executor: typeof db = db
): Promise<boolean> {
  if (event.integration !== 'github') return true
  if (!(await authorFilterStates(executor, [squadId])).get(squadId)) return true
  if (event.sourceKey.startsWith('github-status:')) return true
  if (event.sourceKey.startsWith('github-feedback:')) return isGitHubFeedbackAdmitted(executor, event)
  return false
}
