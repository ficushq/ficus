import { EventPollingRetryError } from '../types'
import type { EventPollingCapability, EventPollingSignal, RuntimeConnection, VerifiedIngressEvent } from '../types'
import type { GitHubPollingFetch } from './event-poller'
import { normalizeDependabot } from './dependabot-output'

export interface GitHubDependabotPollingConfig {
  kind: 'dependabot-alerts'
  owner: string
  repo: string
}
interface Cursor extends Record<string, unknown> {
  repositoryId?: number
  after?: string
}
export class DependabotDiscoveryError extends EventPollingRetryError {
  constructor(
    readonly status: number,
    retryAfterMs = 86_400_000
  ) {
    super(`Dependabot discovery unavailable (${status})`, retryAfterMs)
  }
}

/** Repository-scoped read-only backfill and daily reconciliation; one page per leased tick. */
export class GitHubDependabotPoller implements EventPollingCapability<GitHubDependabotPollingConfig> {
  constructor(
    private readonly credential: (
      connection: RuntimeConnection<GitHubDependabotPollingConfig>
    ) => Promise<string | undefined>,
    private readonly request: GitHubPollingFetch = fetch
  ) {}
  async poll(
    connection: RuntimeConnection<GitHubDependabotPollingConfig>,
    value: Readonly<Record<string, unknown>> | null,
    signal?: EventPollingSignal
  ) {
    const token = await this.credential(connection)
    if (!token) throw new DependabotDiscoveryError(401)
    const cursor = value as Cursor | null
    const { owner, repo } = connection.configuration
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    }
    let requests = 0
    const get = async (path: string) => {
      let url = new URL(path, 'https://api.github.com')
      for (let redirects = 0; ; redirects++) {
        signal?.reserveRequest()
        requests++
        const response = await this.request(url.toString(), { headers, signal, redirect: 'manual' })
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
        if (location) {
          const next = new URL(location, url)
          if (
            redirects >= 3 ||
            next.origin !== url.origin ||
            !/^\/repositories\/[1-9][0-9]*$/.test(next.pathname) ||
            next.search
          )
            throw new Error('Invalid Dependabot redirect')
          url = next
          continue
        }
        if (!response.ok) {
          const retry = Math.max(0, Number(response.headers.get('retry-after')) * 1000)
          const reset = Math.max(0, Number(response.headers.get('x-ratelimit-reset')) * 1000 - Date.now())
          throw new DependabotDiscoveryError(
            response.status,
            Math.min(
              86_400_000,
              Math.max(60_000, retry, reset, response.status === 403 || response.status === 404 ? 86_400_000 : 300_000)
            )
          )
        }
        return response
      }
    }
    // Refresh name and visibility on every page; the credential must still read this repository.
    // Once known, use the immutable endpoint to survive repository rename/transfer.
    let path = cursor?.repositoryId ? `/repositories/${cursor.repositoryId}` : `/repos/${owner}/${repo}`
    let response = await get(path)
    const repository = (await response.json()) as { id?: number; full_name?: string }
    if (
      !Number.isSafeInteger(repository.id) ||
      repository.id! <= 0 ||
      !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name ?? '') ||
      (cursor?.repositoryId && cursor.repositoryId !== repository.id)
    )
      throw new Error('Invalid Dependabot repository identity')
    path = `/repos/${repository.full_name}/dependabot/alerts`
    const query = new URLSearchParams({
      per_page: '100',
      state: 'open,fixed,dismissed,auto_dismissed',
      sort: 'updated',
      direction: 'desc',
    })
    if (cursor?.after) query.set('after', cursor.after)
    response = await get(`${path}?${query}`)
    const alerts: unknown = await response.json()
    if (!Array.isArray(alerts) || alerts.length > 100) throw new Error('Invalid Dependabot alert page')
    const events: VerifiedIngressEvent[] = alerts.map((alert) => ({
      type: 'dependabot_alert',
      payload: { action: 'observed', repository, alert },
      metadata: { synthetic: true },
    }))
    // Malformed pages must not advance a cursor and silently skip an alert.
    if (events.some((event) => normalizeDependabot(event).length !== 1))
      throw new Error('Invalid Dependabot alert snapshot')
    let after: string | undefined
    const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')
    if (link) {
      const next = new URL(link[1]!)
      after = next.searchParams.get('after') ?? undefined
      if (
        next.origin !== 'https://api.github.com' ||
        next.pathname !== path ||
        !after ||
        after.length > 2000 ||
        after === cursor?.after
      )
        throw new Error('Invalid Dependabot pagination')
    }
    return {
      events,
      nextCursor: { repositoryId: repository.id!, ...(after ? { after } : {}) },
      suggestedIntervalMs: after ? 60_000 : 86_400_000,
      budgetUnitsConsumed: requests,
    }
  }
}
