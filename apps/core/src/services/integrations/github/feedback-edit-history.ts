import type { GitHubAccountIdentity, GitHubEditorVerification, GitHubFeedbackContent } from '@ficus/shared'
import type { IntegrationOutputAuthority } from '../outputs/types'
import { githubApiGraphql } from '../../github/api-client'
import { githubContentIdentity, githubNativeId } from './feedback-envelope'

/**
 * Who wrote a GitHub content version, from GitHub's own edit history.
 *
 * A webhook or poll names a comment's, review's, issue's or pull request's AUTHOR, but not who
 * edited it since. GitHub records that history (GraphQL `Comment.userContentEdits`, `editor`, and
 * `RenamedTitleEvent` for titles). One bounded query through the squad's authorized connection
 * decides, for exactly the captured text:
 * - never edited: `creation` by the author;
 * - edited: `verified_edit`, listing the author's co-writers (every editor in the history, plus the
 *   signed webhook sender of an edit). Capture delivers it automatically only if the author AND every
 *   listed editor is trusted in the squad; trusting the author never vouches for other editors.
 * - anything uncertain (a different node, repository, author or text than captured, a truncated
 *   history, a deleted or unidentifiable editor, a refused query): null, and the content stays held.
 * GitHub not answering at all throws {@link import('../../github/api-client').GitHubApiUnavailableError}
 * so capture retries later instead of deciding.
 */

/** Bounded history: anything longer is truncated and therefore unverifiable (held). */
export const GITHUB_EDIT_HISTORY_LIMIT = 50

const ACTOR = '__typename login ... on User { databaseId } ... on Bot { databaseId }'
const HISTORY = `author { ${ACTOR} } body lastEditedAt editor { ${ACTOR} }
  userContentEdits(first: ${GITHUB_EDIT_HISTORY_LIMIT}) { totalCount nodes { editor { ${ACTOR} } } }`
const RENAMES = `title renames: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], first: ${GITHUB_EDIT_HISTORY_LIMIT}) {
  pageInfo { hasNextPage } nodes { ... on RenamedTitleEvent { actor { ${ACTOR} } } } }`
export const GITHUB_EDIT_HISTORY_QUERY = `query FicusEditHistory($id: ID!) {
  node(id: $id) {
    __typename
    ... on RepositoryNode { repository { databaseId } }
    ... on IssueComment { databaseId ${HISTORY} }
    ... on PullRequestReview { databaseId ${HISTORY} }
    ... on PullRequestReviewComment { databaseId ${HISTORY} }
    ... on Issue { databaseId ${HISTORY} ${RENAMES} }
    ... on PullRequest { databaseId ${HISTORY} ${RENAMES} }
  }
}`

const TYPENAMES: Record<string, string> = {
  issue_comment: 'IssueComment',
  review: 'PullRequestReview',
  review_comment: 'PullRequestReviewComment',
  issue: 'Issue',
  pull_request: 'PullRequest',
}

export interface GitHubEditHistoryTarget {
  nodeId: string
  objectKind: GitHubFeedbackContent['objectKind']
  nativeId: string
  repositoryId: string
  author: GitHubAccountIdentity
  /** The exact captured text; the history only speaks for it if GitHub's current text is identical. */
  body: string
  /** Issues and pull requests only. */
  title?: string
  editedBy?: GitHubAccountIdentity
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A GraphQL actor by numeric ID; null for a deleted (ghost), mannequin or otherwise unidentifiable one. */
function actorIdentity(value: unknown): GitHubAccountIdentity | null {
  const actor = record(value)
  const type = actor.__typename === 'User' ? 'User' : actor.__typename === 'Bot' ? 'Bot' : null
  if (!type) return null
  // GraphQL names an App's bot account without the `[bot]` suffix REST and webhooks use.
  const login = type === 'Bot' && !text(actor.login).endsWith('[bot]') ? `${text(actor.login)}[bot]` : actor.login
  return githubContentIdentity({ id: actor.databaseId, login, type })
}

/** A complete page of history entries, or null when GitHub reports more than it returned. */
function complete(connection: unknown): unknown[] | null {
  const page = record(connection)
  const nodes = Array.isArray(page.nodes) ? page.nodes : null
  if (!nodes || !Number.isSafeInteger(page.totalCount) || page.totalCount !== nodes.length) return null
  return nodes
}

/** Timeline totalCount includes non-rename events even with itemTypes filtering. */
function completeRenames(connection: unknown): unknown[] | null {
  const page = record(connection)
  // The query starts at the first page: only an explicit end proves all rename actors were read.
  if (!Array.isArray(page.nodes) || record(page.pageInfo).hasNextPage !== false) return null
  return page.nodes
}

/** Pure decision over one GraphQL `node` response. Exported for tests. */
export function decideGitHubEditors(
  target: GitHubEditHistoryTarget,
  response: unknown
): GitHubEditorVerification | null {
  const node = record(record(response).node)
  const isParent = target.objectKind === 'issue' || target.objectKind === 'pull_request'
  if (
    node.__typename !== TYPENAMES[target.objectKind] ||
    githubNativeId(node.databaseId) !== target.nativeId ||
    githubNativeId(record(node.repository).databaseId) !== target.repositoryId ||
    actorIdentity(node.author)?.accountId !== target.author.accountId ||
    // Bound to the exact captured version: a later edit is a new version, verified on its own.
    text(node.body) !== target.body ||
    (isParent && text(node.title) !== (target.title ?? ''))
  )
    return null
  const edits = complete(node.userContentEdits)
  const renames = isParent ? completeRenames(node.renames) : []
  if (!edits || !renames) return null
  const editors = new Map<string, GitHubAccountIdentity>()
  const add = (identity: GitHubAccountIdentity | null) => {
    if (!identity) return false
    editors.set(identity.accountId, identity)
    return true
  }
  for (const edit of edits) if (!add(actorIdentity(record(edit).editor))) return null
  for (const rename of renames) if (!add(actorIdentity(record(rename).actor))) return null
  const lastEditor = node.lastEditedAt ? actorIdentity(node.editor) : null
  if (node.lastEditedAt && !add(lastEditor)) return null
  if (target.editedBy) add(target.editedBy)
  if (editors.size === 0) return { attribution: 'creation', editor: null, editors: [] }
  const renameActors = renames.map((rename) => actorIdentity(record(rename).actor))
  const editor = target.editedBy ?? lastEditor ?? renameActors.at(-1) ?? [...editors.values()][0]!
  return {
    attribution: 'verified_edit',
    editor,
    // Sorted so the same history always produces the same reviewed hash (idempotent replays).
    editors: [...editors.values()].sort((a, b) => Number(a.accountId) - Number(b.accountId)),
  }
}

/** The text an edit-history read must match, or null when the content cannot be verified at all. */
export function githubEditHistoryTarget(content: GitHubFeedbackContent): GitHubEditHistoryTarget | null {
  if (
    content.objectKind === 'action' ||
    content.attribution !== 'unknown' ||
    content.reason ||
    !content.nodeId ||
    !content.nativeId ||
    !content.repositoryId ||
    !content.author ||
    !content.delivery ||
    // A dismissal is a state change by someone other than the reviewer; it stays with a person.
    content.delivery.data.action === 'dismissed'
  )
    return null
  const written = record(content.delivery.data.content)
  return {
    nodeId: content.nodeId,
    objectKind: content.objectKind,
    nativeId: content.nativeId,
    repositoryId: content.repositoryId,
    author: content.author,
    body: text(written.body),
    ...(['issue', 'pull_request'].includes(content.objectKind) ? { title: text(written.title) } : {}),
    ...(content.editedBy ? { editedBy: content.editedBy } : {}),
  }
}

/** The parent issue or PR an action's `parentText` variant would quote, or null if not offered. */
export function githubParentEditHistoryTarget(content: GitHubFeedbackContent): GitHubEditHistoryTarget | null {
  const parent = content.parentText
  if (content.objectKind !== 'action' || !parent || parent.unchanged || !parent.nodeId || !content.repositoryId)
    return null
  return {
    nodeId: parent.nodeId,
    objectKind: parent.objectKind,
    nativeId: parent.nativeId,
    repositoryId: content.repositoryId,
    author: parent.author,
    body: parent.body,
    title: parent.title,
  }
}

/**
 * One GraphQL query through the observing squad's connection (the caller has already authorized the
 * exact source). Null when GitHub refuses it or the answer does not prove the captured version.
 */
export async function readGitHubEditorVerification(
  authority: IntegrationOutputAuthority,
  target: GitHubEditHistoryTarget,
  graphql: typeof githubApiGraphql = githubApiGraphql
): Promise<GitHubEditorVerification | null> {
  if (authority.kind !== 'connection') return null
  const response = await graphql(
    GITHUB_EDIT_HISTORY_QUERY,
    { id: target.nodeId },
    authority.squadId,
    authority.connectionId
  )
  return response ? decideGitHubEditors(target, response) : null
}
