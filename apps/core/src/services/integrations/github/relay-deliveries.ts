import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../../../db'
import { githubRelayDeliveries } from '../../../db/schema'

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The event types the PR poller would otherwise observe; only these prove its events arrive live. */
const LIVENESS_EVENTS: readonly string[] = [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
  'issues',
]

/**
 * The repository a relay delivery proves live, or null: only an event type the PR poller would
 * otherwise observe (never Dependabot or CI), for the repository the relay routed it by.
 */
export function githubRelayLivenessRepository(delivery: {
  eventType: string
  resourceKey: string
  payload: Record<string, unknown>
}): string | null {
  const repository = (delivery.payload.repository as { full_name?: unknown } | undefined)?.full_name
  return LIVENESS_EVENTS.includes(delivery.eventType) &&
    typeof repository === 'string' &&
    repository.toLowerCase() === delivery.resourceKey &&
    REPOSITORY.test(delivery.resourceKey)
    ? delivery.resourceKey
    : null
}

/**
 * Record that the hosted relay delivered a GitHub event for this connection and repository. Called
 * only after the relay's connection revision and authorization checks accepted the delivery, so it is
 * live webhook evidence: the watch policy stops polling the repository through this connection while
 * such deliveries keep arriving, and resumes polling when they go stale. One row per pair; the
 * timestamp only moves forward.
 */
export async function recordGitHubRelayDelivery(connectionId: string, repository: string): Promise<void> {
  const normalized = repository.toLowerCase()
  if (!REPOSITORY.test(normalized)) return
  await db
    .insert(githubRelayDeliveries)
    .values({ connectionId, repository: normalized })
    .onConflictDoUpdate({
      target: [githubRelayDeliveries.connectionId, githubRelayDeliveries.repository],
      set: { deliveredAt: sql`GREATEST(${githubRelayDeliveries.deliveredAt}, now())` },
    })
}

/** Latest relay delivery per `connectionId:repository` (lowercase), for the requested pairs only. */
export async function getLastGitHubRelayDeliveries(
  pairs: readonly { connectionId: string; repository: string }[]
): Promise<Map<string, Date>> {
  const deliveries = new Map<string, Date>()
  const unique = [
    ...new Map(
      pairs
        .filter((pair) => UUID.test(pair.connectionId))
        .map((pair) => {
          const repository = pair.repository.toLowerCase()
          return [`${pair.connectionId}:${repository}`, { connectionId: pair.connectionId, repository }]
        })
    ).values(),
  ]
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200)
    const byConnection = new Map<string, string[]>()
    for (const pair of chunk)
      byConnection.set(pair.connectionId, [...(byConnection.get(pair.connectionId) ?? []), pair.repository])
    const rows = await db
      .select()
      .from(githubRelayDeliveries)
      .where(
        or(
          ...[...byConnection].map(([connectionId, repositories]) =>
            and(
              eq(githubRelayDeliveries.connectionId, connectionId),
              inArray(githubRelayDeliveries.repository, repositories)
            )
          )
        )
      )
    for (const row of rows) deliveries.set(`${row.connectionId}:${row.repository}`, row.deliveredAt)
  }
  return deliveries
}
