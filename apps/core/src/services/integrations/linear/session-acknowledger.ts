import { eq } from 'drizzle-orm'
import { db, linearAgentSessions } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { createLinearAgentActivity } from './app-api'

const log = createLogger('linear-session-ack')

/** Linear marks a session unresponsive without an activity within 10 seconds of `created`. */
export const LINEAR_ACK_BUDGET_MS = 9_000
const ACK_ATTEMPT_TIMEOUT_MS = 4_000
/** Acknowledgment calls one `acknowledgeLinearSession` makes at most: the first attempt and one retry. */
export const LINEAR_ACK_MAX_ATTEMPTS = 2
export const LINEAR_ACK_BODY = 'Received. Checking how to handle this request.'

export type LinearSessionRow = typeof linearAgentSessions.$inferSelect

export interface AcknowledgeDependencies {
  /** Milliseconds since the epoch; injectable for fake-clock tests. */
  now?: () => number
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
}
function text(value: unknown, max = 200) {
  return typeof value === 'string' && value ? value.slice(0, max) : null
}

/**
 * Runs for every `AgentSessionEvent` `created`, before any rule, decision predicate or squad fan-out:
 * records the session and posts the acknowledgment `thought` once, whatever the rules will do and
 * whether or not any squad is assigned to the connection. A deterministic activity ID keeps a
 * concurrent or retried acknowledgment from showing twice.
 *
 * A missed deadline is not fatal: Linear shows the session as unresponsive until the next activity.
 */
export async function acknowledgeLinearSession(
  input: { connectionId: string; organizationId: string; authorization: string; payload: Record<string, unknown> },
  dependencies: AcknowledgeDependencies = {}
): Promise<LinearSessionRow | null> {
  const now = dependencies.now ?? Date.now
  const session = record(input.payload.agentSession)
  const sessionId = text(session.id)
  if (!sessionId) return null
  const issue = record(session.issue)
  const commentId = text(session.commentId) ?? text(record(session.comment).id)
  await db
    .insert(linearAgentSessions)
    .values({
      id: sessionId,
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      issueId: text(session.issueId) ?? text(issue.id),
      issueIdentifier: text(issue.identifier, 100),
      teamId: text(issue.teamId) ?? text(record(issue.team).id),
      url: text(session.url, 2000),
      rootCommentId: commentId,
      creatorLinearUserId: text(session.creatorId) ?? text(record(session.creator).id),
      trigger: commentId ? 'mention' : 'delegation',
    })
    .onConflictDoNothing({ target: linearAgentSessions.id })
  const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
  // A session ID is unique in Linear; one recorded under another connection is never written to here.
  if (!row || row.connectionId !== input.connectionId) return null
  if (row.ackState === 'sent') return row
  const sentAt = typeof input.payload.webhookTimestamp === 'number' ? input.payload.webhookTimestamp : now()
  const deadline = Math.min(sentAt, now()) + LINEAR_ACK_BUDGET_MS
  let acknowledged = false
  for (let attempt = 0; attempt < LINEAR_ACK_MAX_ATTEMPTS && !acknowledged; attempt++) {
    const remaining = deadline - now()
    // The first attempt always runs: a late acknowledgment still recovers an unresponsive session.
    if (attempt > 0 && remaining <= 0) break
    try {
      await createLinearAgentActivity(
        input.authorization,
        { sessionId, projectionKey: 'ack', content: { type: 'thought', body: LINEAR_ACK_BODY } },
        AbortSignal.timeout(
          Math.max(1, Math.min(ACK_ATTEMPT_TIMEOUT_MS, attempt === 0 ? ACK_ATTEMPT_TIMEOUT_MS : remaining))
        )
      )
      acknowledged = true
    } catch (error) {
      log.warn(`Linear session ${sessionId} acknowledgment attempt ${attempt + 1} failed: ${errorCode(error)}`)
    }
  }
  const [updated] = await db
    .update(linearAgentSessions)
    .set({
      ackState: acknowledged ? 'sent' : 'failed',
      ...(acknowledged ? { lastActivityAt: new Date(now()) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(linearAgentSessions.id, sessionId))
    .returning()
  return updated ?? row
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 64) : 'error'
}
