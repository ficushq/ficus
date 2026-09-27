import { createHash } from 'node:crypto'
import type { EventPollingCapability, EventPollingSignal, RuntimeConnection, VerifiedIngressEvent } from '../types'
import type { GitHubPollingFetch } from './event-poller'

export interface GitHubIssueEventPollingConfig {
  kind: 'issue-events'
  owner: string
  repo: string
}

interface Cursor extends Record<string, unknown> {
  watermark: number
  etag?: string
  scan?: { page: number; ceiling: number; etag?: string }
}

type Native = Record<string, any>

/** Repository assignment discovery, including issues that do not yet have a Ficus stream. */
export class GitHubIssueEventPoller implements EventPollingCapability<GitHubIssueEventPollingConfig> {
  constructor(
    private readonly credential: (
      connection: RuntimeConnection<GitHubIssueEventPollingConfig>
    ) => Promise<string | undefined>,
    private readonly request: GitHubPollingFetch = fetch
  ) {}

  async poll(
    connection: RuntimeConnection<GitHubIssueEventPollingConfig>,
    value: Readonly<Record<string, unknown>> | null,
    signal?: EventPollingSignal
  ) {
    const token = await this.credential(connection)
    if (!token) throw new Error(`GitHub credential unavailable for squad ${connection.squadId}`)
    const cursor = value as Cursor | null
    const page = cursor?.scan?.page ?? 1
    const { owner, repo } = connection.configuration
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    }
    if (page === 1 && cursor?.etag) headers['if-none-match'] = cursor.etag
    signal?.reserveRequest()
    const response = await this.request(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/events?per_page=100&page=${page}`,
      { headers, signal, redirect: 'error' }
    )
    if (response.status === 304 && cursor && page === 1)
      return { events: [], nextCursor: { ...cursor }, suggestedIntervalMs: 60_000, budgetUnitsConsumed: 1 }
    if (!response.ok) throw new Error(`GitHub issue event polling failed (${response.status})`)
    const items: unknown = await response.json()
    if (!Array.isArray(items) || items.some((item) => !Number.isSafeInteger(item?.id) || item.id <= 0))
      throw new Error('Invalid GitHub issue event page')
    const native = items as Native[]
    const ceiling = cursor?.scan?.ceiling ?? Math.max(cursor?.watermark ?? 0, ...native.map((item) => item.id))
    const etag = page === 1 ? (response.headers.get('etag') ?? undefined) : cursor?.scan?.etag
    // Establish a baseline on first observation; enabling a trigger must not replay old assignments.
    if (!cursor)
      return {
        events: [],
        nextCursor: { watermark: ceiling, etag },
        suggestedIntervalMs: 60_000,
        budgetUnitsConsumed: 1,
      }

    const events: VerifiedIngressEvent[] = []
    for (const item of [...native].reverse()) {
      if (item.id <= cursor.watermark || item.id > ceiling) continue
      const issue = item.issue
      if (!issue || issue.pull_request || !Number.isSafeInteger(issue.number) || issue.number <= 0) continue
      if (!['assigned', 'unassigned', 'closed', 'reopened', 'labeled', 'unlabeled', 'renamed'].includes(item.event))
        continue
      if (typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)))
        throw new Error('GitHub issue event has no valid occurrence time')
      // The embedded issue always reflects the issue's CURRENT state, which may be
      // several transitions later; this fact represents the event's own time. A
      // close is timed by `closed_at`, so restate that too or a late-polled first
      // close would carry a later close's time — and miss its webhook's row.
      // Collapsing a single close's webhook and poll onto one Activity row now
      // rests on this event's `created_at` equalling the issue's `closed_at`,
      // which GitHub holds to in practice; any skew would leave a permanent
      // duplicate row, since these Activity families never delete.
      const event: VerifiedIngressEvent = {
        type: 'issues',
        payload: {
          action: item.event,
          issue: {
            ...issue,
            updated_at: item.created_at,
            ...(item.event === 'closed'
              ? { closed_at: item.created_at }
              : item.event === 'reopened'
                ? { closed_at: null }
                : {}),
          },
          repository: { full_name: `${owner}/${repo}` },
          assignee: item.assignee,
          sender: item.actor,
          label: item.label,
        },
        metadata: { synthetic: true },
      }
      Object.defineProperty(event, 'logicalEventKey', {
        value: createHash('sha256')
          .update(`github:issue-event:${owner.toLowerCase()}/${repo.toLowerCase()}:${item.id}`)
          .digest('hex'),
        enumerable: false,
      })
      events.push(event)
    }
    const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')
    // GitHub's repository event feed is newest-first. Keep the old watermark until
    // the scan reaches it, so bounded page scans cannot skip a burst of assignments.
    const complete = !hasNext || native.some((item) => item.id <= cursor.watermark)
    const nextCursor: Cursor = complete
      ? { watermark: ceiling, etag }
      : { watermark: cursor.watermark, scan: { page: page + 1, ceiling, etag } }
    return { events, nextCursor, suggestedIntervalMs: 60_000, budgetUnitsConsumed: 1 }
  }
}
