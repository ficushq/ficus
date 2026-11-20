import { createLogger } from '../../../lib/infra/logger'
import { resolveLinearConnection } from '../../integrations/linear/resolve-connection'
import { sourceCapabilities } from './adapter'
import type { LiveMemorySourceAdapter, LiveSearchResult, LiveSearchScope } from './live-adapter'

const log = createLogger('linear-live-source')
const ENDPOINT = 'https://api.linear.app/graphql'
const MAX_RESULTS = 10

const SEARCH_QUERY = `
  query Search($query: String!, $first: Int!) {
    issueSearch(query: $query, first: $first) {
      nodes {
        id
        identifier
        title
        description
        url
        state { name }
        team { key }
        assignee { displayName }
        updatedAt
      }
    }
  }
`

interface LinearIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  state?: { name: string | null } | null
  team?: { key: string | null } | null
  assignee?: { displayName: string | null } | null
  updatedAt: string
}

interface LinearSearchResponse {
  data?: { issueSearch?: { nodes?: LinearIssue[] | null } | null }
  errors?: unknown[]
}

export class LinearLiveSource implements LiveMemorySourceAdapter {
  constructor(
    /** The Authorization header value for the squad's Linear connection (an API key or `Bearer <token>`). */
    private readonly resolveAuthorization = async (squadId: string) =>
      (await resolveLinearConnection(squadId))?.authorization
  ) {}

  private static _instance: LinearLiveSource | null = null

  readonly sourceType = 'linear_issue'
  readonly capabilities = sourceCapabilities(['searchable', 'live', 'external'])
  readonly defaultSensitivity = 'internal' as const
  readonly timeoutMs = 2_500
  readonly rateLimit = { perMinute: 30 }

  static instance(): LinearLiveSource {
    if (!LinearLiveSource._instance) LinearLiveSource._instance = new LinearLiveSource()
    return LinearLiveSource._instance
  }

  static _reset(): void {
    LinearLiveSource._instance = null
  }

  async search(query: string, opts: LiveSearchScope): Promise<LiveSearchResult[]> {
    const authorization = await this.resolveAuthorization(opts.callerSquadId)
    if (!authorization) return []

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization,
      },
      body: JSON.stringify({
        query: SEARCH_QUERY,
        variables: { query: withTeamKeyFilter(query, collectTeamKeys(opts.scopes)), first: MAX_RESULTS },
      }),
    })

    if (!response.ok) {
      log.warn(`Linear search HTTP ${response.status}`)
      return []
    }

    const body = (await response.json()) as LinearSearchResponse
    if (body.errors?.length) {
      log.warn('Linear search returned GraphQL errors')
      return []
    }

    return (body.data?.issueSearch?.nodes ?? []).map((issue, index) => ({
      sourceSquadId: opts.callerSquadId,
      sourceType: this.sourceType,
      sourceId: issue.id,
      title: `${issue.identifier} — ${issue.title}`,
      snippet: (issue.description ?? '').slice(0, 400),
      score: Math.max(0, 1 - index * 0.05),
      sensitivity: this.defaultSensitivity,
      provenance: {
        url: issue.url,
        teamKey: issue.team?.key ?? null,
        state: issue.state?.name ?? null,
        assignee: issue.assignee?.displayName ?? null,
      },
      event: { ts: issue.updatedAt },
    }))
  }

  validateGrantFilter(filter: unknown): string[] | null {
    if (filter === undefined || filter === null) return null
    if (typeof filter !== 'object' || Array.isArray(filter)) return ['filter must be an object']
    const teamKeys = (filter as { teamKeys?: unknown }).teamKeys
    if (teamKeys !== undefined && (!Array.isArray(teamKeys) || teamKeys.some((item) => typeof item !== 'string'))) {
      return ['teamKeys must be a string array']
    }
    return null
  }
}

function collectTeamKeys(scopes: LiveSearchScope['scopes']): string[] {
  const keys = new Set<string>()
  for (const scope of scopes) {
    const linearFilter = scope.filters.sourceFilters?.linear_issue as { teamKeys?: string[] } | undefined
    for (const key of linearFilter?.teamKeys ?? []) keys.add(key)
  }
  return [...keys]
}

function withTeamKeyFilter(query: string, teamKeys: string[]): string {
  return teamKeys.length === 0 ? query : `${query} team:${teamKeys.join(',')}`
}
