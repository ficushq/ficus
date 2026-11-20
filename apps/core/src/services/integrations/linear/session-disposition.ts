import { and, eq, sql } from 'drizzle-orm'
import { db, linearAgentSessions } from '../../../db'
import { createLogger } from '../../../lib/infra/logger'
import { createLinearAgentActivity, type LinearActivityContent } from './app-api'
import { enqueueLinearWrites } from './outbox'

const log = createLogger('linear-session-disposition')

/** What one authorized squad did with a session's routed fact. */
export type LinearSquadOutcome = 'started' | 'notified' | 'ignored'

/** How the session as a whole was handled, which decides the one activity Linear shows (5.3). */
export type LinearSessionDisposition =
  | { kind: 'queued' }
  | { kind: 'notified' }
  | { kind: 'ignored'; unrouted: boolean }
  | { kind: 'inaccessible' }
  | { kind: 'no-issue' }
  | { kind: 'busy' }

/**
 * Public text read in Linear: fixed templates that never name squads, agents or internal state and
 * never include agent-written content.
 */
export const LINEAR_DISPOSITION_ACTIVITIES: Record<LinearSessionDisposition['kind'], LinearActivityContent> = {
  queued: { type: 'thought', body: 'Ficus queued this work. Progress will appear here.' },
  notified: {
    type: 'response',
    body: 'Ficus passed this request to the team. Updates will appear here if work starts.',
  },
  ignored: { type: 'response', body: 'Ficus is not set up to take requests like this here, so no work was started.' },
  inaccessible: {
    type: 'error',
    body: 'Ficus cannot access this issue\u2019s team. A Linear admin can grant access in the Ficus app settings.',
  },
  'no-issue': { type: 'response', body: 'Ficus works on Linear issues. Mention or delegate Ficus on an issue.' },
  busy: { type: 'response', body: 'Ficus is busy. Try again later.' },
}

const SESSION_DISPOSITION: Record<LinearSessionDisposition['kind'], string> = {
  queued: 'bound',
  notified: 'notified',
  ignored: 'ignored',
  inaccessible: 'inaccessible',
  'no-issue': 'closed',
  busy: 'closed',
}

/** One outcome per authorized squad, reduced: any started work wins, then any notification. */
export function reduceLinearSessionOutcomes(outcomes: readonly LinearSquadOutcome[]): LinearSessionDisposition {
  if (outcomes.includes('started')) return { kind: 'queued' }
  if (outcomes.includes('notified')) return { kind: 'notified' }
  return { kind: 'ignored', unrouted: outcomes.length === 0 }
}

/**
 * Posts the session's single disposition activity. `projectionKey` is `disposition` for the
 * `created` event and `disposition:<activityId>` for a prompt on an unbound session, so each is
 * posted at most once. A session already bound to a stream keeps its `bound` disposition.
 */
export async function postLinearSessionDisposition(input: {
  sessionId: string
  authorization: string
  disposition: LinearSessionDisposition
  projectionKey?: string
}): Promise<boolean> {
  const projectionKey = input.projectionKey ?? 'disposition'
  const disposition =
    input.disposition.kind === 'ignored' && input.disposition.unrouted
      ? 'unrouted'
      : SESSION_DISPOSITION[input.disposition.kind]
  if (projectionKey === 'disposition') {
    // Claim the one disposition for this session: only the first caller posts it.
    const [claimed] = await db
      .update(linearAgentSessions)
      .set({
        disposition: sql`CASE WHEN ${linearAgentSessions.disposition} = 'pending' THEN ${disposition} ELSE ${linearAgentSessions.disposition} END`,
        dispositionState: 'sent',
        updatedAt: new Date(),
      })
      .where(and(eq(linearAgentSessions.id, input.sessionId), eq(linearAgentSessions.dispositionState, 'pending')))
      .returning({ id: linearAgentSessions.id })
    if (!claimed) return false
  }
  try {
    await createLinearAgentActivity(input.authorization, {
      sessionId: input.sessionId,
      projectionKey,
      content: LINEAR_DISPOSITION_ACTIVITIES[input.disposition.kind],
    })
    await db
      .update(linearAgentSessions)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(eq(linearAgentSessions.id, input.sessionId))
    return true
  } catch (error) {
    log.warn(
      `Linear session ${input.sessionId} disposition failed: ${error instanceof Error ? error.message.slice(0, 64) : 'error'}`
    )
    if (projectionKey === 'disposition')
      await db
        .update(linearAgentSessions)
        .set({ dispositionState: 'failed', updatedAt: new Date() })
        .where(eq(linearAgentSessions.id, input.sessionId))
    // The write-back outbox retries it with backoff, under the same activity ID.
    const [session] = await db
      .select({ connectionId: linearAgentSessions.connectionId })
      .from(linearAgentSessions)
      .where(eq(linearAgentSessions.id, input.sessionId))
    if (session)
      await enqueueLinearWrites({
        connectionId: session.connectionId,
        scopeKey: input.sessionId,
        sessionId: input.sessionId,
        items: [
          {
            projectionKey,
            kind: 'activity',
            payload: { content: LINEAR_DISPOSITION_ACTIVITIES[input.disposition.kind] },
            collapsible: false,
          },
        ],
      }).catch(() => undefined)
    return false
  }
}
