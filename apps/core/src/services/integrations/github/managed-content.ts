import { createHash } from 'node:crypto'
import { githubAccountIdSchema } from '@ficus/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
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
import { githubContentHash, githubContentIdentity } from './feedback-envelope'
import { isGitHubFeedbackAdmitted } from './feedback-admission'
import { enqueueGitHubMemoryReindex, type GitHubReindexReason } from './managed-reindex'
import { currentGitHubFeedbackRevisionSQL, gitHubFeedbackVersionSQL } from './feedback-obsolescence'

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

export const GITHUB_MEMORY_PROJECTION_SCHEMA = 2
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
  revisionHash?: string
  sequence: number
  bodyHash: string
  titleHash?: string
  providerVersion: string | null
}

export interface GitHubMemoryProjection {
  schema: typeof GITHUB_MEMORY_PROJECTION_SCHEMA
  /** False when indexed with the filter OFF: such a document is never readable under an ON gate. */
  filtered: boolean
  repositoryId: string | null
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
  providerVersion: string | null
}

type RevisionMatch = {
  squadId: string
  kind: string
  nativeId: string
  revisionId: string
  contentHash: string
  sequence: number
  providerVersion: string | null
  releaseState: string
  decision: string
  attribution: string
  author: { accountId: string } | null
  editor: { accountId: string } | null
  bodyHash: string | null
  titleHash: string | null
}

/** Current revisions only: matching old text is never currentness evidence. No body reads. */
async function currentMemoryRevisions(
  executor: Executor,
  squadIds: string[],
  repositoryId: string,
  items: Array<Pick<GitHubMemoryItem, 'nativeId'>>
): Promise<RevisionMatch[] | null> {
  const nativeIds = [...new Set(items.map((item) => item.nativeId).filter((id): id is string => !!id))]
  if (!nativeIds.length) return []
  const rows = await executor
    .select({
      squadId: githubFeedbackObjects.squadId,
      kind: githubFeedbackObjects.objectKind,
      nativeId: githubFeedbackObjects.nativeId,
      revisionId: githubFeedbackRevisions.id,
      contentHash: githubFeedbackRevisions.contentHash,
      sequence: githubFeedbackRevisions.sequence,
      providerVersion: sql<
        string | null
      >`${gitHubFeedbackVersionSQL(githubFeedbackRevisions, githubFeedbackObjects)}::text`,
      releaseState: githubFeedbackRevisions.releaseState,
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
        inArray(githubFeedbackObjects.squadId, squadIds),
        eq(githubFeedbackObjects.repositoryId, repositoryId),
        inArray(githubFeedbackObjects.objectKind, ['issue', 'pull_request', 'issue_comment']),
        inArray(githubFeedbackObjects.nativeId, nativeIds),
        currentGitHubFeedbackRevisionSQL(githubFeedbackRevisions.id, githubFeedbackObjects.squadId)
      )
    )
    .limit(REVISION_LOOKUP_LIMIT + 1)
  return rows.length > REVISION_LOOKUP_LIMIT ? null : rows
}

const sameText = (item: Pick<GitHubMemoryItem, 'bodyHash' | 'titleHash'>, row: RevisionMatch) =>
  item.bodyHash === row.bodyHash && (item.titleHash === undefined || item.titleHash === row.titleHash)

/** Snapshot proofs without a captured revision may only outrank known text by a valid clock. */
function freshSnapshot(item: GitHubMemoryItem, row: RevisionMatch | undefined, ownSquad: boolean): boolean {
  if (item.revisionId && ownSquad)
    return (
      !!row &&
      row.releaseState !== 'obsolete' &&
      row.revisionId === item.revisionId &&
      row.contentHash === item.revisionHash &&
      row.sequence === item.sequence &&
      sameText(item, row)
    )
  if (!row) return true
  if (row.releaseState === 'obsolete') return false
  if (sameText(item, row)) return true
  return (
    !!item.providerVersion &&
    !!row.providerVersion &&
    Date.parse(item.providerVersion) > Date.parse(row.providerVersion)
  )
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
    repositoryId?: number | null
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
    providerVersion: Number.isFinite(Date.parse(detail.updated_at)) ? detail.updated_at : null,
  }
  const children: Candidate[] = comments.map((comment) => ({
    kind: 'issue_comment',
    nativeId: nativeId(comment.id),
    author: githubContentIdentity(comment.user)?.accountId ?? null,
    bodyHash: sha256Hex(comment.body ?? ''),
    unchanged: unchanged(comment.created_at, comment.updated_at),
    providerVersion: Number.isFinite(Date.parse(comment.updated_at)) ? comment.updated_at : null,
  }))
  const repositoryId = nativeId(options.repositoryId)
  const filtered = (await authorFilterStates(executor, [squadId])).get(squadId) ?? true
  const all = [parent, ...children]
  const versions = repositoryId ? await currentMemoryRevisions(executor, [squadId], repositoryId, all) : null
  const trusted = filtered
    ? await trustedGitHubAccounts(executor, squadId, [
        ...all.map((item) => item.author),
        ...(versions ?? []).flatMap((row) => [row.author?.accountId, row.editor?.accountId]),
      ])
    : new Set<string>()
  const admit = (item: Candidate): GitHubMemoryItem | null => {
    if (!versions || !item.nativeId) return null
    const row = versions.find((row) => row.kind === item.kind && row.nativeId === item.nativeId)
    const match = row && sameText(item, row) ? row : undefined
    const proof: GitHubMemoryItem = {
      kind: item.kind,
      nativeId: item.nativeId,
      author: item.author,
      basis: 'unfiltered',
      bodyHash: item.bodyHash,
      ...(item.titleHash === undefined ? {} : { titleHash: item.titleHash }),
      providerVersion: item.providerVersion,
      sequence: row?.sequence ?? 0,
      ...(match ? { revisionId: match.revisionId, revisionHash: match.contentHash } : {}),
    }
    if ((!proof.providerVersion && !proof.revisionId) || !freshSnapshot(proof, row, true)) return null
    if (!filtered) return proof
    if (match) {
      if (['allow_once', 'allow_trust', 'screened'].includes(match.decision))
        return { ...proof, author: match.author?.accountId ?? null, basis: 'approved' }
      if (match.decision === 'automatic') {
        const author = match.author?.accountId
        const editor = match.editor?.accountId
        const editorTrusted = match.attribution === 'creation' || (!!editor && trusted.has(editor))
        return author && trusted.has(author) && editorTrusted
          ? {
              ...proof,
              author,
              ...(match.attribution === 'verified_edit' && editor ? { editor } : {}),
              basis: 'trusted',
            }
          : null
      }
      if (match.decision !== 'historical') return null
    }
    return item.author && trusted.has(item.author) && item.unchanged ? { ...proof, basis: 'trusted' } : null
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
      filtered,
      repositoryId,
      items,
      withheldComments: comments.length - admittedComments.length,
      parentWithheld: !parentItem,
    },
  }
}

const numericId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const hashValue = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const uuidValue = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
function parseProjection(value: unknown): GitHubMemoryProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const projection = value as GitHubMemoryProjection
  if (
    projection.schema !== GITHUB_MEMORY_PROJECTION_SCHEMA ||
    typeof projection.filtered !== 'boolean' ||
    !numericId(projection.repositoryId) ||
    !Array.isArray(projection.items) ||
    projection.items.length > 101 ||
    typeof projection.parentWithheld !== 'boolean' ||
    !Number.isSafeInteger(projection.withheldComments) ||
    projection.withheldComments < 0
  )
    return null
  for (const item of projection.items) {
    if (
      !item ||
      !['issue', 'pull_request', 'issue_comment'].includes(item.kind) ||
      !numericId(item.nativeId) ||
      (item.author !== null && !numericId(item.author)) ||
      (item.editor !== undefined && !numericId(item.editor)) ||
      !['trusted', 'approved', 'unfiltered'].includes(item.basis) ||
      !hashValue(item.bodyHash) ||
      (item.kind !== 'issue_comment' && !hashValue(item.titleHash)) ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence < 0 ||
      (item.providerVersion !== null &&
        (typeof item.providerVersion !== 'string' || !Number.isFinite(Date.parse(item.providerVersion)))) ||
      (!item.providerVersion && !item.revisionId) ||
      (item.revisionId !== undefined &&
        (!uuidValue(item.revisionId) || !hashValue(item.revisionHash) || item.sequence < 1)) ||
      (item.basis === 'approved' && !item.revisionId)
    )
      return null
  }
  return projection
}

/** All managed reads check freshness, even with the author filter OFF. No provider calls. */
export async function withheldGitHubMemoryDocuments(
  callerSquadId: string,
  documentIds: Iterable<string>,
  executor: Pick<typeof db, 'select' | 'update'> = db,
  options: { enqueue?: boolean; snapshots?: ReadonlyMap<string, unknown> } = {}
): Promise<Set<string>> {
  const ids = [...new Set(documentIds)]
  const withheld = new Set<string>()
  if (!ids.length) return withheld
  const documents = await executor
    .select({
      id: memoryDocuments.id,
      squadId: memoryDocuments.squadId,
      contentHash: memoryDocuments.contentHash,
      pendingHash: sql<string | null>`${memoryDocuments.frontmatter} #>> '{githubReindex,contentHash}'`,
      projection: sql<unknown>`${memoryDocuments.frontmatter} -> 'githubProjection'`,
    })
    .from(memoryDocuments)
    .where(and(inArray(memoryDocuments.id, ids), eq(memoryDocuments.sourceType, GITHUB_ISSUE_SOURCE_TYPE)))
  // A result/chunk generation cannot borrow the proof of a concurrent reindex (or deletion).
  for (const id of options.snapshots?.keys() ?? []) if (!documents.some((doc) => doc.id === id)) withheld.add(id)
  const states = await authorFilterStates(executor, [callerSquadId, ...documents.map((doc) => doc.squadId)])
  const recovery: Array<{ id: string; contentHash: string; reason: GitHubReindexReason }> = []
  const hideForRecovery = (doc: (typeof documents)[number], reason: GitHubReindexReason) => {
    withheld.add(doc.id)
    if (doc.pendingHash !== doc.contentHash) recovery.push({ id: doc.id, contentHash: doc.contentHash, reason })
  }
  for (const doc of documents) {
    if (
      options.snapshots?.has(doc.id) &&
      githubContentHash(options.snapshots.get(doc.id) ?? null) !== githubContentHash(doc.projection ?? null)
    ) {
      withheld.add(doc.id)
      continue
    }
    const projection = parseProjection(doc.projection)
    if (!projection) {
      hideForRecovery(doc, 'legacy')
      continue
    }
    const squads = [...new Set([doc.squadId, callerSquadId])]
    const rows = await currentMemoryRevisions(executor, squads, projection.repositoryId!, projection.items)
    if (!rows) {
      hideForRecovery(doc, 'stale')
      continue
    }
    const gates = squads.filter((squad) => states.get(squad))
    if (gates.length && !projection.filtered) {
      withheld.add(doc.id)
      continue
    }
    let visible = true
    for (const squad of squads) {
      const trusted = states.get(squad)
        ? await trustedGitHubAccounts(
            executor,
            squad,
            projection.items.flatMap((item) => [item.author, item.editor])
          )
        : new Set<string>()
      for (const item of projection.items) {
        const row = rows.find(
          (row) => row.squadId === squad && row.kind === item.kind && row.nativeId === item.nativeId
        )
        if (!freshSnapshot(item, row, squad === doc.squadId)) {
          hideForRecovery(doc, 'stale')
          visible = false
          break
        }
        if (!states.get(squad)) continue
        if (row && sameText(item, row) && ['pending', 'deny'].includes(row.decision)) {
          visible = false
          break
        }
        if (item.basis === 'approved') {
          if (squad !== doc.squadId || !row || !['allow_once', 'allow_trust', 'screened'].includes(row.decision))
            visible = false
        } else if (
          item.basis !== 'trusted' ||
          !item.author ||
          !trusted.has(item.author) ||
          (item.editor && !trusted.has(item.editor))
        )
          visible = false
      }
      if (!visible) break
    }
    if (!visible) withheld.add(doc.id)
  }
  if (options.enqueue !== false) await enqueueGitHubMemoryReindex(recovery, executor)
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
