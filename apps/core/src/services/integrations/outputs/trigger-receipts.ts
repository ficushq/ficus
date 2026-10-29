import { and, eq, or, sql } from 'drizzle-orm'
import { integrationSubscriptionMatches, type WorkflowEventTrigger } from '@ficus/shared'
import { db, integrationOutputTriggerRuns, integrationOutputEvents, workStreams, type DbTx } from '../../../db'
import { integrationOutputRegistry } from './registry'
type Event = typeof integrationOutputEvents.$inferSelect

/** Query the existing resource receipt without claiming it; delivery uses the identical query. */
export function outputTriggerSourceKey(event: Event, trigger: WorkflowEventTrigger) {
  return `${event.integration}:${trigger.source.connectionId ?? 'any-account'}`
}
export async function findOutputTriggerRun(
  store: typeof db | DbTx,
  squadId: string,
  trigger: WorkflowEventTrigger,
  event: Event
) {
  const [prior] = await store
    .select()
    .from(integrationOutputTriggerRuns)
    .where(
      and(
        eq(integrationOutputTriggerRuns.squadId, squadId),
        eq(integrationOutputTriggerRuns.triggerId, trigger.id),
        or(
          eq(integrationOutputTriggerRuns.sourceKey, outputTriggerSourceKey(event, trigger)),
          sql`${integrationOutputTriggerRuns.sourceKey} LIKE ${`${event.integration}:${trigger.source.connectionId ? `connection:${trigger.source.connectionId}:` : ''}%`}`
        ),
        eq(integrationOutputTriggerRuns.resourceKey, event.fact.resourceKey)
      )
    )
    .limit(1)
  return prior
}
/** A later review request needs attention even when its original review stream is terminal.
 * Compare provider occurrence times as well as event keys: replays and alternate feedback
 * projections of the original request must not manufacture another review round.
 */
export async function completedReviewRequest(
  store: typeof db | DbTx,
  squadId: string,
  trigger: WorkflowEventTrigger,
  event: Event
) {
  if (event.integration !== 'github' || event.fact.output !== 'pull_request.review_requested') return undefined
  const descriptor = integrationOutputRegistry.descriptor(trigger.source)
  const subscription = { ...trigger, deliver: { to: 'active' as const, whenInactive: 'retain' as const } }
  if (!descriptor || !integrationSubscriptionMatches(subscription, event.fact, {}, descriptor)) return undefined
  const receipt = await findOutputTriggerRun(store, squadId, trigger, event)
  if (!receipt?.workStreamId) return undefined
  const [stream] = await store
    .select({ id: workStreams.id, number: workStreams.number, status: workStreams.status })
    .from(workStreams)
    .where(and(eq(workStreams.id, receipt.workStreamId), eq(workStreams.squadId, squadId)))
  if (!stream || !['done', 'canceled'].includes(stream.status)) return undefined
  const [original] = await store
    .select({ fact: integrationOutputEvents.fact })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, receipt.eventId))
  if (
    !original ||
    original.fact.eventKey === event.fact.eventKey ||
    !(Date.parse(event.fact.occurredAt) > Date.parse(original.fact.occurredAt))
  )
    return undefined
  return stream
}
