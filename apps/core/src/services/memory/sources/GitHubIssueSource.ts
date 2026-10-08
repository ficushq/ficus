import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments } from '../../../db/schema'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { githubApiGet, type GitHubIssueApiComment, type GitHubIssueApiItem } from '../../github/api-client'
import { BaseMemorySourceAdapter, sourceCapabilities, type DiscoveredItem, type FetchedContent } from './adapter'
import { IndexedDocumentWriter } from './IndexedDocumentWriter'
import { projectGitHubThreadForMemory } from '../../integrations/github/managed-content'
import { mergePolicyErrors, validateBaseIngestionPolicy, validateStringArrayScope } from './policy'
import type { IndexResult } from './types'

export interface GithubRef {
  repo: string
  number: number
  kind: 'issue' | 'pull_request'
}

const GITHUB_URL_RE = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/
const SOURCE_ID_RE = /^([^/]+\/[^#]+)#(\d+)$/

export function parseGithubUrl(url: string): GithubRef | null {
  const match = GITHUB_URL_RE.exec(url)
  if (!match) return null
  return { repo: match[1], number: Number(match[3]), kind: match[2] === 'pull' ? 'pull_request' : 'issue' }
}

export function githubIssueSourceId(ref: Pick<GithubRef, 'repo' | 'number'>): string {
  return `${ref.repo}#${ref.number}`
}

export function parseGithubIssueSourceId(sourceId: string): Pick<GithubRef, 'repo' | 'number'> | null {
  const match = SOURCE_ID_RE.exec(sourceId)
  if (!match) return null
  return { repo: match[1], number: Number(match[2]) }
}

/** Comment bodies cannot forge the generated per-comment provenance marker. */
function neutralizeMarkers(text: string): string {
  return text.replace(/<!--(\s*comment-meta)/gi, '&lt;!--$1')
}

/** Content-free placeholders for prose withheld by the squad's GitHub author filter. */
export interface WithheldIssueContent {
  parent?: boolean
  comments?: number
}

export function renderIssueMarkdown(
  detail: GitHubIssueApiItem,
  comments: GitHubIssueApiComment[] = [],
  withheld: WithheldIssueContent = {}
): string {
  const lines = withheld.parent
    ? [
        `# ${detail.pull_request ? 'Pull request' : 'Issue'} #${detail.number}`,
        '',
        '_The title and description are withheld until they are reviewed in Ficus._',
        '',
      ]
    : [
        `# ${detail.title}`,
        '',
        `<!-- comment-meta actor=${detail.user?.login ?? 'unknown'} ts=${detail.updated_at} -->`,
        '',
      ]
  if (!withheld.parent && detail.body) lines.push(neutralizeMarkers(detail.body), '')
  for (const comment of comments) {
    lines.push(
      `## Comment by ${comment.user?.login ?? 'unknown'} at ${comment.updated_at}`,
      '',
      `<!-- comment-meta actor=${comment.user?.login ?? 'unknown'} ts=${comment.updated_at} -->`,
      '',
      neutralizeMarkers(comment.body ?? ''),
      ''
    )
  }
  if (withheld.comments)
    lines.push(
      `_${withheld.comments} ${withheld.comments === 1 ? 'comment is' : 'comments are'} withheld until reviewed in Ficus._`,
      ''
    )
  return lines.join('\n')
}

export class GitHubIssueSource extends BaseMemorySourceAdapter {
  private static _instance: GitHubIssueSource | null = null

  readonly sourceType = 'github_issue'
  readonly capabilities = sourceCapabilities(['searchable', 'readable', 'incremental', 'external'])
  readonly defaultSensitivity = 'internal' as const

  static instance(): GitHubIssueSource {
    if (!GitHubIssueSource._instance) GitHubIssueSource._instance = new GitHubIssueSource()
    return GitHubIssueSource._instance
  }

  static _reset(): void {
    GitHubIssueSource._instance = null
  }

  validatePolicy(policy: unknown): string[] | null {
    return mergePolicyErrors(
      validateBaseIngestionPolicy(policy),
      validateStringArrayScope(policy, 'repos'),
      validateStringArrayScope(policy, 'labels')
    )
  }

  validateGrantFilter(filter: unknown): string[] | null {
    if (filter === undefined || filter === null) return null
    if (typeof filter !== 'object' || Array.isArray(filter)) return ['filter must be an object']
    const repos = (filter as { repos?: unknown }).repos
    if (repos !== undefined && (!Array.isArray(repos) || repos.some((repo) => typeof repo !== 'string'))) {
      return ['repos must be an array of strings']
    }
    return null
  }

  buildSearchSqlFilter(filter: unknown): ReturnType<typeof sql> | null {
    const repos =
      typeof filter === 'object' && filter && !Array.isArray(filter) ? (filter as { repos?: unknown }).repos : undefined
    if (!Array.isArray(repos) || repos.length === 0 || repos.some((repo) => typeof repo !== 'string')) return null
    return sql`${memoryDocuments.frontmatter}->>'repo' = ANY(${repos})`
  }

  async list(squadId: string, opts: { since?: string } = {}): Promise<DiscoveredItem[]> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, this.sourceType)
    if (config?.enabled === false) return []
    const repos = getPolicyStringArray(config?.policy, 'repos') ?? []
    const labels = getPolicyStringArray(config?.policy, 'labels') ?? []
    const since = opts.since ?? timeWindowSince(config?.policy)
    const out: DiscoveredItem[] = []
    for (const repo of repos) {
      const params = new URLSearchParams({ state: 'all', per_page: '100' })
      if (since) params.set('since', since)
      if (labels.length > 0) params.set('labels', labels.join(','))
      const issues = await githubApiGet<GitHubIssueApiItem[]>(`/repos/${repo}/issues?${params.toString()}`, squadId)
      for (const issue of issues ?? []) {
        if (!matchesConfiguredLabels(issue, labels)) continue
        out.push({ sourceId: githubIssueSourceId({ repo, number: issue.number }), cursor: issue.updated_at })
      }
    }
    return out
  }

  async fetch(squadId: string, sourceId: string): Promise<FetchedContent | null> {
    const ref = parseGithubIssueSourceId(sourceId)
    if (!ref) return null
    const detail = await githubApiGet<GitHubIssueApiItem>(`/repos/${ref.repo}/issues/${ref.number}`, squadId)
    if (!detail) return null
    const comments =
      (await githubApiGet<GitHubIssueApiComment[]>(
        `/repos/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
        squadId
      )) ?? []
    const kind = detail.pull_request ? 'pull_request' : 'issue'
    // Only prose the squad's author filter admits is indexed; the projection records why.
    const projected = await projectGitHubThreadForMemory(squadId, detail, comments)
    return {
      content: renderIssueMarkdown(detail, projected.comments, {
        parent: !projected.parentAdmitted,
        comments: projected.projection.withheldComments,
      }),
      title: projected.parentAdmitted ? `${ref.repo}#${ref.number} ${detail.title}` : `${ref.repo}#${ref.number}`,
      frontmatter: {
        kind,
        sourceLinks: [detail.html_url],
        repo: ref.repo,
        number: ref.number,
        state: detail.state,
        labels: (detail.labels ?? []).map((label) => label.name).filter(Boolean),
        author: projected.parentAdmitted ? (detail.user?.login ?? null) : null,
        githubProjection: projected.projection,
      },
      chunkMetadata: { sourceType: this.sourceType, parent: { repo: ref.repo, number: ref.number } },
      chunkMetadataForChunk: (chunk) => {
        const match = chunk.content.match(/<!-- comment-meta actor=(\S+) ts=(\S+) -->/)
        return match ? { event: { actor: match[1], ts: match[2] } } : {}
      },
    }
  }

  async index(squadId: string, sourceId: string): Promise<IndexResult> {
    const config = await SquadSourceConfig.findBySquadAndType(squadId, this.sourceType)
    if (config?.enabled === false) return { success: true, chunksCreated: 0, linksCreated: 0, skipped: true }
    const ref = parseGithubIssueSourceId(sourceId)
    if (!ref)
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `Invalid GitHub issue source id: ${sourceId}` }

    const allowedRepos = getPolicyStringArray(config?.policy, 'repos') ?? []
    if (!allowedRepos.includes(ref.repo)) {
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `GitHub repo not configured: ${ref.repo}` }
    }

    const fetched = await this.fetch(squadId, sourceId)
    if (!fetched)
      return { success: false, chunksCreated: 0, linksCreated: 0, error: `GitHub issue not found: ${sourceId}` }

    const allowedLabels = getPolicyStringArray(config?.policy, 'labels') ?? []
    if (!frontmatterMatchesConfiguredLabels(fetched.frontmatter, allowedLabels)) {
      return {
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: `GitHub issue labels not configured: ${sourceId}`,
      }
    }
    return IndexedDocumentWriter.instance().writeDocument({
      squadId,
      sourceType: this.sourceType,
      sourceId,
      fetched,
      adapterDefaultSensitivity: this.defaultSensitivity,
      policy: config?.policy,
      chunker: 'markdown',
    })
  }

  async exists(squadId: string, sourceId: string): Promise<boolean> {
    const [doc] = await db
      .select({ id: memoryDocuments.id })
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, this.sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
      .limit(1)
    return Boolean(doc)
  }

  async remove(squadId: string, sourceId: string): Promise<void> {
    await db
      .delete(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, this.sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
  }
}

function getPolicyStringArray(policy: Record<string, unknown> | null | undefined, key: string): string[] | null {
  const value =
    policy?.scope && typeof policy.scope === 'object' ? (policy.scope as Record<string, unknown>)[key] : undefined
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

function timeWindowSince(policy: Record<string, unknown> | null | undefined): string | undefined {
  const days = typeof policy?.timeWindowDays === 'number' ? policy.timeWindowDays : undefined
  if (!days) return undefined
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

function matchesConfiguredLabels(issue: GitHubIssueApiItem, configuredLabels: string[]): boolean {
  if (configuredLabels.length === 0) return true
  const issueLabels = new Set((issue.labels ?? []).map((label) => label.name).filter(Boolean))
  return configuredLabels.some((label) => issueLabels.has(label))
}

function frontmatterMatchesConfiguredLabels(
  frontmatter: Record<string, unknown> | undefined,
  configuredLabels: string[]
): boolean {
  if (configuredLabels.length === 0) return true
  const labels = frontmatter?.labels
  if (!Array.isArray(labels)) return false
  const issueLabels = new Set(labels.filter((label): label is string => typeof label === 'string'))
  return configuredLabels.some((label) => issueLabels.has(label))
}
