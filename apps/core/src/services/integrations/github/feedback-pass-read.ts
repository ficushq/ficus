import { and, eq, sql } from 'drizzle-orm'
import { db, integrationOutputEvents, githubOutputProofs, type DbTx } from '../../../db'
import { githubOutputPass, GITHUB_PASS_READ_LIMIT } from './feedback-pass'

type Store = typeof db | DbTx
type Event = typeof integrationOutputEvents.$inferSelect

/** A cache stores immutable payloads, NEVER authorization. Each reuse verifies the current row
 * locally (also in acceptance transactions), then callers recheck trust/material/route/native TTL.
 * A changed snapshot waits for a new pass; it cannot replace reviewed content in this pass.
 */
export function outputSnapshotMatches(event: Event) {
  return and(
    eq(integrationOutputEvents.id, event.id),
    eq(integrationOutputEvents.integration, event.integration),
    eq(integrationOutputEvents.sourceKey, event.sourceKey),
    eq(integrationOutputEvents.eventKey, event.eventKey),
    sql`${integrationOutputEvents.fact} = ${JSON.stringify(event.fact)}::jsonb`,
    sql`${integrationOutputEvents.authority} = ${JSON.stringify(event.authority)}::jsonb`
  )
}

/** This reader materializes at most 25 full event rows per root pass, including raw aliases.
 * ID/equality queries return no body. No network calls or cached decisions occur here.
 */
export async function readOutputEvent(store: Store, id: string): Promise<Event | undefined> {
  const pass = githubOutputPass()
  const key = `event:${id}`
  const cached = pass?.bodies.get(key)
  if (cached) {
    const [current] = await store
      .select({
        id: integrationOutputEvents.id,
        matchedAt: integrationOutputEvents.matchedAt,
        lastErrorCode: integrationOutputEvents.lastErrorCode,
      })
      .from(integrationOutputEvents)
      .where(outputSnapshotMatches(cached))
    return current ? { ...structuredClone(cached), ...current } : undefined
  }
  const [identity] = await store
    .select({ integration: integrationOutputEvents.integration })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, id))
  if (!identity) return undefined
  if (pass && identity.integration === 'github') {
    if (pass.bodyRows >= GITHUB_PASS_READ_LIMIT) return undefined
    pass.bodyRows++ // reserve BEFORE I/O, including failed/concurrent reads
  }
  const [event] = await store
    .select()
    .from(integrationOutputEvents)
    .where(and(eq(integrationOutputEvents.id, id), eq(integrationOutputEvents.integration, identity.integration)))
  if (event?.integration === 'github' && pass) pass.bodies.set(key, structuredClone(event))
  return event
}

/** Materialize a candidate and its ORIGINAL source together, not 25 projections followed by
 * zero remaining source slots. This is preparation only: no access or routing decision is cached.
 */
export async function readOutputCandidate(store: Store, id: string) {
  const event = await readOutputEvent(store, id)
  if (event?.integration === 'github') {
    const [proof] = await store
      .select({ sourceId: githubOutputProofs.sourceEventId })
      .from(githubOutputProofs)
      .where(eq(githubOutputProofs.eventId, id))
    if (proof && !(await readOutputEvent(store, proof.sourceId))) return undefined
  }
  return event
}
