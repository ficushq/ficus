import { DERIVATION_SURFACES, type DerivationFilters, type DerivationSurface } from '@ficus/shared'
import { GitHubApiUnavailableError, githubApiGraphql } from '../github/api-client'

/**
 * Collects a GitHub user's own writing (pull requests, issue and review
 * comments, commit messages) through the squad's GitHub connection, with
 * GraphQL: one request for the first pages, a few more pages for pull requests
 * and comments when the date filters need them, and one aliased request for
 * commits. Two to eight requests in total. Field names verified live on
 * 2026-11-18.
 */

/** One piece of writing, before cleaning. */
export interface RawActivityItem {
  surface: DerivationSurface
  /** Pull request titles and commit headlines go here; bodies in `text`. */
  title?: string
  text: string
  repository: string
  isPrivate: boolean
  createdAt: string
}

export interface CollectedActivity {
  items: RawActivityItem[]
  /** True when paging stopped at the page limit while older matching items may exist. */
  pagingCapped: boolean
  requests: number
  /** Items seen but left out by the date and repository filters. */
  droppedByFilter: { date: number; repository: number }
}

export class DerivationError extends Error {
  constructor(
    readonly code:
      | 'derivation_github_unavailable'
      | 'derivation_login_not_visible'
      | 'derivation_too_few_samples'
      | 'derivation_invalid_output'
      | 'derivation_model_unavailable',
    readonly details: Record<string, unknown> = {}
  ) {
    super(code)
    this.name = 'DerivationError'
  }
}

export type GraphqlFn = <T>(query: string, variables: Record<string, unknown>) => Promise<T | null>

export const PULL_REQUEST_PAGE = 40
export const COMMENT_PAGE = 80
export const MAX_PAGES = 4
export const MAX_COMMIT_REPOSITORIES = 8
const COMMITS_PER_REPOSITORY = 15
const WANTED = { 'pull-requests': 30, 'issue-comments': 40 } as const

interface RepositoryRef {
  nameWithOwner: string
  isPrivate: boolean
}
interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: T[]
}
interface PullRequestNode {
  createdAt: string
  title: string
  body: string | null
  repository: RepositoryRef
}
interface CommentNode {
  createdAt: string
  updatedAt: string
  body: string | null
  repository: RepositoryRef
}
interface ReviewContribution {
  pullRequestReview: {
    createdAt: string
    body: string | null
    comments: { nodes: Array<{ body: string | null }> }
    repository: RepositoryRef
  } | null
}

const PULL_REQUESTS_FIELDS = `pullRequests(first: ${PULL_REQUEST_PAGE}, after: $prCursor, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { createdAt title body repository { nameWithOwner isPrivate } }
    }`
const COMMENTS_FIELDS = `issueComments(first: ${COMMENT_PAGE}, after: $commentCursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { createdAt updatedAt body repository { nameWithOwner isPrivate } }
    }`

export const USER_ACTIVITY_QUERY = `query VoiceUserActivity($login: String!, $from: DateTime!, $to: DateTime!, $prCursor: String, $commentCursor: String) {
  user(login: $login) {
    id
    ${PULL_REQUESTS_FIELDS}
    ${COMMENTS_FIELDS}
    contributionsCollection(from: $from, to: $to) {
      pullRequestReviewContributions(first: 40) {
        nodes { pullRequestReview { createdAt body comments(first: 10) { nodes { body } } repository { nameWithOwner isPrivate } } }
      }
      commitContributionsByRepository(maxRepositories: ${MAX_COMMIT_REPOSITORIES}) { repository { nameWithOwner isPrivate } }
    }
  }
}`

export const PULL_REQUESTS_PAGE_QUERY = `query VoicePullRequests($login: String!, $prCursor: String) {
  user(login: $login) { ${PULL_REQUESTS_FIELDS} }
}`

export const COMMENTS_PAGE_QUERY = `query VoiceComments($login: String!, $commentCursor: String) {
  user(login: $login) { ${COMMENTS_FIELDS} }
}`

/** One aliased block per repository: default-branch commits by the user inside the date range. */
export function buildCommitsQuery(repositories: string[]): string {
  const blocks = repositories.map((name, index) => {
    const [owner, repo] = name.split('/')
    return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
    nameWithOwner isPrivate
    defaultBranchRef { target { ... on Commit {
      history(first: ${COMMITS_PER_REPOSITORY}, since: $since, until: $until, author: { id: $userId }) {
        nodes { committedDate messageHeadline messageBody }
      }
    } } }
  }`
  })
  return `query VoiceCommits($userId: ID!, $since: GitTimestamp, $until: GitTimestamp) {\n  ${blocks.join('\n  ')}\n}`
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** The one-year contributions window: the latest year inside the filter range. */
export function contributionsWindow(filters: DerivationFilters, now: Date): { from: string; to: string } {
  const to = filters.before ? new Date(`${filters.before}T00:00:00Z`) : now
  const after = filters.after ? new Date(`${filters.after}T00:00:00Z`) : null
  const from = new Date(Math.max(to.getTime() - YEAR_MS, after?.getTime() ?? 0))
  return { from: from.toISOString(), to: to.toISOString() }
}

function inRange(createdAt: string, filters: DerivationFilters): boolean {
  const day = createdAt.slice(0, 10)
  if (filters.before && day >= filters.before) return false
  if (filters.after && day < filters.after) return false
  return true
}

function repositoryAllowed(name: string, filters: DerivationFilters): boolean {
  const lower = name.toLowerCase()
  if (filters.repositories?.length && !filters.repositories.some((r) => r.toLowerCase() === lower)) return false
  if (filters.excludeRepositories?.some((r) => r.toLowerCase() === lower)) return false
  return true
}

/**
 * Whether paging a newest-first list should continue: stop once enough items in
 * range are kept, the page reaches back before `after` (by `orderedAt`, the
 * field the list is ordered by), or there is no next page.
 */
function shouldPageOn<T>(
  page: Connection<T>,
  kept: number,
  wanted: number,
  filters: DerivationFilters,
  orderedAt: (node: T) => string
): boolean {
  if (!page.pageInfo.hasNextPage || kept >= wanted) return false
  const oldest = page.nodes.at(-1)
  if (oldest && filters.after && orderedAt(oldest).slice(0, 10) < filters.after) return false
  return true
}

export async function collectGitHubActivity(
  input: { squadId: string; login: string; filters: DerivationFilters; now?: Date },
  deps: { graphql?: GraphqlFn } = {}
): Promise<CollectedActivity> {
  const graphql: GraphqlFn = deps.graphql ?? ((query, variables) => githubApiGraphql(query, variables, input.squadId))
  const { filters, login } = input
  const surfaces = new Set<DerivationSurface>(filters.surfaces ?? DERIVATION_SURFACES)
  let requests = 0
  const call = async <T>(query: string, variables: Record<string, unknown>): Promise<T | null> => {
    requests++
    try {
      return await graphql<T>(query, variables)
    } catch (error) {
      if (error instanceof GitHubApiUnavailableError)
        throw new DerivationError('derivation_github_unavailable', { reason: error.reason })
      throw error
    }
  }

  type UserData = {
    user: {
      id: string
      pullRequests: Connection<PullRequestNode>
      issueComments: Connection<CommentNode>
      contributionsCollection: {
        pullRequestReviewContributions: { nodes: ReviewContribution[] }
        commitContributionsByRepository: Array<{ repository: RepositoryRef }>
      }
    } | null
  }
  const window = contributionsWindow(filters, input.now ?? new Date())
  const first = await call<UserData>(USER_ACTIVITY_QUERY, { login, ...window, prCursor: null, commentCursor: null })
  const user = first?.user
  if (!user) throw new DerivationError('derivation_login_not_visible', { login })

  const items: RawActivityItem[] = []
  let pagingCapped = false
  const droppedByFilter = { date: 0, repository: 0 }
  const accept = (createdAt: string, repository: string): boolean => {
    if (!inRange(createdAt, filters)) {
      droppedByFilter.date++
      return false
    }
    if (!repositoryAllowed(repository, filters)) {
      droppedByFilter.repository++
      return false
    }
    return true
  }

  // Pull requests, newest first, paging only as far as the date filters need.
  if (surfaces.has('pull-requests')) {
    let page = user.pullRequests
    let pages = 1
    let kept = 0
    for (;;) {
      for (const node of page.nodes) {
        if (!accept(node.createdAt, node.repository.nameWithOwner)) continue
        items.push({
          surface: 'pull-requests',
          title: node.title,
          text: node.body ?? '',
          repository: node.repository.nameWithOwner,
          isPrivate: node.repository.isPrivate,
          createdAt: node.createdAt,
        })
        kept++
      }
      if (!shouldPageOn(page, kept, WANTED['pull-requests'], filters, (n) => n.createdAt)) break
      if (pages >= MAX_PAGES) {
        pagingCapped = true
        break
      }
      const next = await call<{ user: { pullRequests: Connection<PullRequestNode> } | null }>(
        PULL_REQUESTS_PAGE_QUERY,
        {
          login,
          prCursor: page.pageInfo.endCursor,
        }
      )
      if (!next?.user) break
      page = next.user.pullRequests
      pages++
    }
  }

  // Issue and pull request conversation comments, ordered by last update.
  if (surfaces.has('issue-comments')) {
    let page = user.issueComments
    let pages = 1
    let kept = 0
    for (;;) {
      for (const node of page.nodes) {
        if (!accept(node.createdAt, node.repository.nameWithOwner)) continue
        items.push({
          surface: 'issue-comments',
          text: node.body ?? '',
          repository: node.repository.nameWithOwner,
          isPrivate: node.repository.isPrivate,
          createdAt: node.createdAt,
        })
        kept++
      }
      if (!shouldPageOn(page, kept, WANTED['issue-comments'], filters, (n) => n.updatedAt)) break
      if (pages >= MAX_PAGES) {
        pagingCapped = true
        break
      }
      const next = await call<{ user: { issueComments: Connection<CommentNode> } | null }>(COMMENTS_PAGE_QUERY, {
        login,
        commentCursor: page.pageInfo.endCursor,
      })
      if (!next?.user) break
      page = next.user.issueComments
      pages++
    }
  }

  // Review bodies and their inline comments, from the contributions window.
  if (surfaces.has('reviews')) {
    for (const contribution of user.contributionsCollection.pullRequestReviewContributions.nodes) {
      const review = contribution.pullRequestReview
      if (!review || !accept(review.createdAt, review.repository.nameWithOwner)) continue
      const base = {
        surface: 'reviews' as const,
        repository: review.repository.nameWithOwner,
        isPrivate: review.repository.isPrivate,
        createdAt: review.createdAt,
      }
      if (review.body) items.push({ ...base, text: review.body })
      for (const comment of review.comments.nodes) if (comment.body) items.push({ ...base, text: comment.body })
    }
  }

  // Commit messages on the default branch of the repositories the user committed to.
  if (surfaces.has('commits')) {
    const candidates = filters.repositories?.length
      ? filters.repositories
      : user.contributionsCollection.commitContributionsByRepository.map((entry) => entry.repository.nameWithOwner)
    const repositories = [...new Set(candidates)]
      .filter((name) => repositoryAllowed(name, filters))
      .slice(0, MAX_COMMIT_REPOSITORIES)
    if (repositories.length > 0) {
      type CommitBlock = {
        nameWithOwner: string
        isPrivate: boolean
        defaultBranchRef: {
          target: {
            history?: { nodes: Array<{ committedDate: string; messageHeadline: string; messageBody: string }> }
          } | null
        } | null
      } | null
      const data = await call<Record<string, CommitBlock>>(buildCommitsQuery(repositories), {
        userId: user.id,
        since: filters.after ? `${filters.after}T00:00:00Z` : null,
        until: filters.before ? `${filters.before}T00:00:00Z` : null,
      })
      for (const block of Object.values(data ?? {})) {
        for (const commit of block?.defaultBranchRef?.target?.history?.nodes ?? []) {
          if (!accept(commit.committedDate, block!.nameWithOwner)) continue
          items.push({
            surface: 'commits',
            title: commit.messageHeadline,
            text: commit.messageBody ?? '',
            repository: block!.nameWithOwner,
            isPrivate: block!.isPrivate,
            createdAt: commit.committedDate,
          })
        }
      }
    }
  }

  return { items, pagingCapped, requests, droppedByFilter }
}
