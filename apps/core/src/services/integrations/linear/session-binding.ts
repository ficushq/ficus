import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  db,
  integrationOutputEvents,
  linearActivityOutbox,
  linearAgentSessions,
  workStreamFlowRuns,
  workStreams,
  type DbTx,
} from '../../../db'
import { resolvePublicAppUrl } from '../../../lib/public-app-url'
import { createLogger } from '../../../lib/infra/logger'
import { addLinearSessionExternalUrls, createLinearAgentActivity } from './app-api'
import { enqueueLinearWrites } from './outbox'
import { isLinearInsufficientScope, LINEAR_INSUFFICIENT_SCOPE_CODE, markLinearScopeMissing } from './scope-health'
import { resolveLinearAppConnection } from './resolve-connection'
import { projectionAttemptFloor } from './session-projection'

const log = createLogger('linear-session-binding')

type Store = typeof db | DbTx
type FactLike = { data: Record<string, unknown> }

/** The Linear agent session a fact came from, if any (`session.id` on session-derived facts). */
export function linearSessionIdOf(integration: string, fact: FactLike): string | undefined {
  if (integration !== 'linear') return undefined
  const session = fact.data.session
  const id = session && typeof session === 'object' ? (session as Record<string, unknown>).id : undefined
  return typeof id === 'string' && id ? id : undefined
}

/**
 * Bind a session to a work stream. A session binds to at most one stream: the first committed
 * binding wins and later attempts return false. The winner's tracked Linear issue gets an
 * `agentSession` copy so `ficus workstream get`, the web view and agents can see it; the table
 * stays the source of truth.
 */
export async function bindLinearSession(tx: Store, sessionId: string, workStreamId: string): Promise<boolean> {
  // Flow attempts that finished before the binding are history the session never shows.
  const [run] = await tx
    .select({ state: workStreamFlowRuns.state })
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  const [session] = await tx
    .update(linearAgentSessions)
    .set({
      workStreamId,
      primary: true,
      disposition: 'bound',
      projectionAttemptFloor: projectionAttemptFloor(run?.state),
      updatedAt: new Date(),
    })
    .where(and(eq(linearAgentSessions.id, sessionId), isNull(linearAgentSessions.workStreamId)))
    .returning()
  if (!session) return false
  // Another session of this stream stops being the one that receives progress.
  await tx
    .update(linearAgentSessions)
    .set({ primary: false, updatedAt: new Date() })
    .where(
      and(
        eq(linearAgentSessions.workStreamId, workStreamId),
        sql`${linearAgentSessions.id} <> ${sessionId}`,
        eq(linearAgentSessions.primary, true)
      )
    )
  const [stream] = await tx
    .select({ metadata: workStreams.metadata })
    .from(workStreams)
    .where(eq(workStreams.id, workStreamId))
  const metadata = (stream?.metadata as Record<string, unknown> | null) ?? {}
  if (Array.isArray(metadata.tracked) && session.issueId) {
    const tracked = metadata.tracked.map((entry) =>
      entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).integration === 'linear' &&
      (entry as Record<string, unknown>).externalId === session.issueId
        ? { ...entry, agentSession: { id: session.id, ...(session.url ? { url: session.url } : {}) } }
        : entry
    )
    await tx
      .update(workStreams)
      .set({ metadata: { ...metadata, tracked } })
      .where(eq(workStreams.id, workStreamId))
  }
  return true
}

/** The final response a session gets when its stream stops tracking the session's issue. */
export const LINEAR_UNTRACKED_TEXT = 'Ficus stopped tracking this work.'

/** The Linear issue a stream stopped tracking: matched by its ID when known, else by its `KEY-12` identifier. */
export interface UntrackedLinearIssue {
  externalId?: string
  identifier: string
  connectionId?: string
}

/**
 * Untracking a Linear issue releases the sessions on that issue bound to the stream: each loses its
 * stream and its `primary` flag, so write-back no longer targets it and a later prompt goes through
 * the rules like any unbound session's, and gets the final response `LINEAR_UNTRACKED_TEXT` so
 * Linear shows it complete. The response goes through the outbox, after anything already queued for
 * the session. Releasing is conditional on the session still being bound to this stream, so a
 * repeated or concurrent untrack releases and posts once. A session Linear refused access to gets no
 * write; neither does one whose connection is marked for reconnect because it lacks a scope: its
 * response is recorded as `skipped` with `insufficient_scope`. Returns the released session IDs and
 * whether anything was queued to send.
 */
export async function releaseLinearSessionsForIssue(
  tx: Store,
  workStreamId: string,
  issue: UntrackedLinearIssue,
  now = new Date()
): Promise<{ released: string[]; queued: boolean }> {
  // The issue ID is stable; an identifier changes when the issue moves to another team.
  const matchesIssue = issue.externalId
    ? eq(linearAgentSessions.issueId, issue.externalId)
    : sql`upper(${linearAgentSessions.issueIdentifier}) = upper(${issue.identifier})`
  const sessions = await tx
    .update(linearAgentSessions)
    .set({ workStreamId: null, primary: false, updatedAt: now })
    .where(
      and(
        eq(linearAgentSessions.workStreamId, workStreamId),
        matchesIssue,
        issue.connectionId ? eq(linearAgentSessions.connectionId, issue.connectionId) : undefined
      )
    )
    .returning()
  let queued = false
  for (const session of sessions) {
    if (session.disposition === 'inaccessible') continue
    // Unique per release: a session bound again later and untracked again gets its own response.
    const projectionKey = `untracked:${workStreamId}:${now.getTime()}`
    const [key] = await enqueueLinearWrites(
      {
        connectionId: session.connectionId,
        scopeKey: session.id,
        sessionId: session.id,
        workStreamId,
        items: [
          {
            projectionKey,
            kind: 'activity',
            payload: { content: { type: 'response', body: LINEAR_UNTRACKED_TEXT } },
            collapsible: false,
          },
        ],
      },
      tx,
      () => now
    )
    if (!key) continue
    if (await linearConnectionLacksScope(session.connectionId)) {
      await tx
        .update(linearActivityOutbox)
        .set({ status: 'skipped', lastErrorCode: LINEAR_INSUFFICIENT_SCOPE_CODE, updatedAt: now })
        .where(
          and(
            eq(linearActivityOutbox.connectionId, session.connectionId),
            eq(linearActivityOutbox.scopeKey, session.id),
            eq(linearActivityOutbox.projectionKey, projectionKey)
          )
        )
      log.warn(`Linear session ${session.id} was released without a final response: its connection lacks a scope`)
      continue
    }
    queued = true
  }
  return { released: sessions.map((session) => session.id), queued }
}

/** Whether a connection is marked for reconnect because Linear refused it for a missing scope. */
async function linearConnectionLacksScope(connectionId: string): Promise<boolean> {
  try {
    const { integrationConnectionRepository } = await import('../runtime')
    const connection = await integrationConnectionRepository.get(connectionId)
    return (
      connection?.authState === 'reauthorization_required' &&
      connection.lastErrorCode === LINEAR_INSUFFICIENT_SCOPE_CODE
    )
  } catch {
    return false
  }
}

/**
 * Bind the session an output event came from, for `ficus workstream create --from-event` and
 * `ficus workstream track --event`, then tell Linear. Returns false when the event has no session
 * or the session is already bound to another stream.
 */
export async function bindLinearSessionForEvent(eventId: string, workStreamId: string): Promise<boolean> {
  const [event] = await db
    .select({ integration: integrationOutputEvents.integration, fact: integrationOutputEvents.fact })
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, eventId))
  const sessionId = event && linearSessionIdOf(event.integration, event.fact)
  if (!sessionId) return false
  const bound = await db.transaction((tx) => bindLinearSession(tx, sessionId, workStreamId))
  if (bound) await announceLinearSessionBinding(sessionId, workStreamId)
  return bound
}

/**
 * The stream's web address when the instance has an `https:` public URL (decision 9.5); otherwise
 * Ficus adds no link to Linear.
 */
export function linearOpenInFicusUrl(stream: { squadId: string; number: number | null }): string | undefined {
  const base = resolvePublicAppUrl()
  if (!base || stream.number === null) return undefined
  try {
    if (new URL(base).protocol !== 'https:') return undefined
  } catch {
    return undefined
  }
  return `${base}/squads/${stream.squadId}/work?ws=${stream.number}`
}

/**
 * After a binding commits: post the fixed "started tracking" thought and, with a public URL, the
 * "Open in Ficus" external link. Failures are logged; the session keeps its binding.
 */
export async function announceLinearSessionBinding(sessionId: string, workStreamId: string): Promise<void> {
  const [session] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
  const [stream] = await db
    .select({ squadId: workStreams.squadId, number: workStreams.number })
    .from(workStreams)
    .where(eq(workStreams.id, workStreamId))
  if (!session || !stream || session.workStreamId !== workStreamId) return
  const resolved = await resolveLinearAppConnection(session.organizationId)
  if (!resolved || resolved.connection.id !== session.connectionId) return
  try {
    await createLinearAgentActivity(resolved.authorization, {
      sessionId,
      projectionKey: `bound:${workStreamId}`,
      content: { type: 'thought', body: 'Ficus started tracking this work.' },
    })
    const url = linearOpenInFicusUrl(stream)
    if (url) await addLinearSessionExternalUrls(resolved.authorization, sessionId, [{ label: 'Open in Ficus', url }])
    await db
      .update(linearAgentSessions)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(linearAgentSessions.id, sessionId))
  } catch (error) {
    log.warn(
      `Linear session ${sessionId} binding announcement failed: ${error instanceof Error ? error.message : 'error'}`
    )
    if (isLinearInsufficientScope(error)) await markLinearScopeMissing(session.connectionId)
  }
}
