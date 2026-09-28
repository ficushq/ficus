import { eq } from 'drizzle-orm'
import {
  deliveryPullRequests,
  readDeliveryState,
  trackedResourceMatches,
  type DeliveryPullRequestView,
  type TrackedResourcesView,
  type WorkStreamDeliveryState,
} from '@ficus/shared'
import { db, squads, workStreams, type DbTx, type integrationOutputEvents } from '../../db'
import { eventTrackedResource } from '../integrations/outputs/tracked-match'

type Event = typeof integrationOutputEvents.$inferSelect
type DeliveryState = WorkStreamDeliveryState['pullRequests'][string]['state']

/** The designated delivery pull requests joined with what has been observed about them. */
export function deliveryView(metadata: unknown): TrackedResourcesView['delivery'] {
  const state = readDeliveryState(metadata)
  const pullRequests: DeliveryPullRequestView[] = deliveryPullRequests(metadata).map((resource) => {
    const observed = state.pullRequests[resource.key]
    return {
      key: resource.key,
      repository: resource.repository,
      number: resource.number,
      ...(resource.url ? { url: resource.url } : {}),
      primary: resource.source === 'delivery',
      // Unobserved is open: delivery is only complete on positive evidence.
      state: observed?.state ?? 'open',
      ...(observed?.at ? { at: observed.at } : {}),
      ...(observed?.headSha ? { headSha: observed.headSha } : {}),
    }
  })
  return {
    pullRequests,
    complete: pullRequests.length > 0 && pullRequests.every((pullRequest) => pullRequest.state === 'merged'),
  }
}

/** The state an event asserts about its pull request, or null when it asserts nothing. */
function observedState(event: Event): DeliveryState | null {
  if (event.fact.output === 'pull_request.merged') return 'merged'
  if (event.fact.output === 'pull_request.closed') return 'closed'
  if (event.fact.output === 'pull_request.updated' && event.fact.data.action === 'reopened') return 'open'
  return null
}

function readString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

function writeDeliveryState(metadata: unknown, pullRequests: WorkStreamDeliveryState['pullRequests']) {
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  return { ...(record as Record<string, unknown>), delivery: { pullRequests } }
}

/**
 * Record what an integration event says about a delivery pull request. Runs inside the caller's
 * transaction, which already holds the stream row lock. Correlation only: matching an event never
 * grants access, and anything that is not a designated delivery pull request is ignored.
 */
export async function recordDeliveryObservation(
  tx: DbTx,
  stream: { id: string; metadata: unknown },
  event: Event
): Promise<boolean> {
  const state = observedState(event)
  if (!state) return false
  const target = eventTrackedResource(event)
  if (!target || target.kind !== 'pull_request') return false
  const connectionId = event.authority.kind === 'connection' ? event.authority.connectionId : undefined
  const resource = deliveryPullRequests(stream.metadata).find((candidate) =>
    trackedResourceMatches(candidate, { ...target, connectionId })
  )
  if (!resource) return false
  // Re-parsed, so state stored in a shape this version cannot read is replaced rather than thrown on.
  const current = readDeliveryState(stream.metadata).pullRequests
  const at = readString(event.fact.occurredAt, 64) ?? new Date().toISOString()
  const previous = current[resource.key]
  if (previous && Date.parse(previous.at) >= Date.parse(at)) return false
  const headSha = readString((event.fact.data.pullRequest as Record<string, unknown> | undefined)?.headSha, 64)
  const next = {
    ...current,
    [resource.key]: { state, at, ...(headSha ? { headSha } : {}), eventId: event.id },
  }
  await tx
    .update(workStreams)
    .set({ metadata: writeDeliveryState(stream.metadata, next), updatedAt: new Date() })
    .where(eq(workStreams.id, stream.id))
  return true
}

/** Record the live merge evidence gathered at completion. Squad row first, then the stream row. */
export async function recordDeliveryVerification(
  streamId: string,
  results: Array<{ key: string; state: DeliveryState; headSha?: string }>
): Promise<void> {
  if (!results.length) return
  const at = new Date().toISOString()
  await db.transaction(async (tx) => {
    const [reference] = await tx
      .select({ squadId: workStreams.squadId })
      .from(workStreams)
      .where(eq(workStreams.id, streamId))
    if (!reference) return
    await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, reference.squadId)).for('update')
    const [locked] = await tx.select().from(workStreams).where(eq(workStreams.id, streamId)).for('update')
    if (!locked) return
    const pullRequests = { ...readDeliveryState(locked.metadata).pullRequests }
    let changed = false
    for (const result of results) {
      const headSha = readString(result.headSha, 64)
      // `at` is a fresh verification timestamp on every call, so it cannot be part of the
      // comparison: state and head sha are what the verification actually asserts.
      const current = pullRequests[result.key]
      if (current?.state === result.state && current.headSha === headSha) continue
      changed = true
      pullRequests[result.key] = { state: result.state, at, ...(headSha ? { headSha } : {}) }
    }
    // Re-verifying evidence the row already carries must not touch it: the write would bump
    // `updatedAt` and wake every work-stream watcher for nothing.
    if (!changed) return
    await tx
      .update(workStreams)
      .set({ metadata: writeDeliveryState(locked.metadata, pullRequests), updatedAt: new Date() })
      .where(eq(workStreams.id, streamId))
  })
}
