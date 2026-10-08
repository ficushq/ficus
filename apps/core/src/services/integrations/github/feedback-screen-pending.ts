import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  db,
  githubFeedbackRevisions,
  githubFeedbackScreenings,
  integrationAuditEvents,
  squads,
  type DbTx,
} from '../../../db'
import type { GitHubFeedbackScreenPendingResult } from '@ficus/shared'
import type { Identity } from '../../rbac/permissions'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  lockGitHubHuman,
  requireGitHubHumanSquadUpdate,
} from './feedback-trust'
import { enqueueGitHubFeedbackScreening, scheduleGitHubFeedbackScreenings } from './feedback-screening'

/*
 * "Screen what's pending now": queue decision-model screens for feedback a squad was already holding
 * when it switched to screening (new captures are queued automatically).
 *
 * Eligible: revisions still `pending` with reason `untrusted_author` and reviewable content, at
 * their current version and hash, that have no screen, or whose last screen ended WITHOUT a verdict:
 * `unavailable` (no model answered), `unconfigured` (none set up) or `skipped` (the squad had
 * stopped screening, or the content changed, before it ran). A verdict (`unsafe`, `uncertain`,
 * `too_long`) is final for that version: re-asking until a model says yes would defeat the screen.
 * Screens already queued or running are left alone, so a double click queues nothing twice.
 */

/** Screens queued per request; the response says when more remain. */
export const SCREEN_PENDING_BATCH = 200
/** Last outcomes that carry no verdict, so the same version may be screened again. */
export const RESCREENABLE_OUTCOMES = ['unavailable', 'unconfigured', 'skipped'] as const

type Store = typeof db | DbTx

const untrustedPending = (squadId: string) =>
  and(
    eq(githubFeedbackRevisions.squadId, squadId),
    eq(githubFeedbackRevisions.decision, 'pending'),
    eq(githubFeedbackRevisions.reason, 'untrusted_author'),
    isNotNull(githubFeedbackRevisions.envelope)
  )
const screenable = () =>
  or(
    isNull(githubFeedbackScreenings.revisionId),
    and(
      eq(githubFeedbackScreenings.state, 'held'),
      inArray(githubFeedbackScreenings.outcome, [...RESCREENABLE_OUTCOMES])
    )
  )

/** Held untrusted feedback "Screen what's pending now" would queue. Uncapped count, for the summary. */
export async function countScreenableGitHubFeedback(squadId: string, store: Store = db): Promise<number> {
  const [row] = await store
    .select({ count: sql<number>`count(*)::int` })
    .from(githubFeedbackRevisions)
    .leftJoin(githubFeedbackScreenings, eq(githubFeedbackScreenings.revisionId, githubFeedbackRevisions.id))
    .where(and(untrustedPending(squadId), screenable()))
  return row?.count ?? 0
}

/**
 * Human-only, with the same authority and audit as the untrusted-handling setting. Refused (409)
 * unless the squad's author filter is on and set to screen. Never releases anything itself: each
 * queued screen still has to pass on its own, and kicks run after this transaction commits.
 */
export async function screenPendingGitHubFeedback(
  identity: Identity | undefined,
  squadId: string,
  options: {
    limit?: number
    /** Runs the queued screens after commit; tests inject a recorder. */
    schedule?: (revisionIds: string[]) => void
  } = {}
): Promise<GitHubFeedbackScreenPendingResult> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? SCREEN_PENDING_BATCH), 1), SCREEN_PENDING_BATCH)
  try {
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    const outcome = await db.transaction(async (tx) => {
      // Serializes with other human trust/moderation writes, so a double click runs one at a time.
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      const [squad] = await tx
        .select({ filter: squads.githubAuthorFilter, handling: squads.githubUntrustedHandling })
        .from(squads)
        .where(eq(squads.id, squadId))
        .for('share')
      if (!squad) throw new GitHubFeedbackError('squad_unavailable', 409)
      if (!squad.filter) throw new GitHubFeedbackError('author_filter_off', 409)
      if (squad.handling !== 'screen') throw new GitHubFeedbackError('screening_not_enabled', 409)
      // Counted before queueing; the trust lock above also serializes with screens settling.
      const held = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(githubFeedbackRevisions)
        .where(untrustedPending(squadId))
      const eligible = await countScreenableGitHubFeedback(squadId, tx)
      const batch = await tx
        .select({ revision: githubFeedbackRevisions, screeningState: githubFeedbackScreenings.state })
        .from(githubFeedbackRevisions)
        .leftJoin(githubFeedbackScreenings, eq(githubFeedbackScreenings.revisionId, githubFeedbackRevisions.id))
        .where(and(untrustedPending(squadId), screenable()))
        .orderBy(asc(githubFeedbackRevisions.firstObservedAt), asc(githubFeedbackRevisions.id))
        .limit(limit)
      const queued: string[] = []
      for (const { revision, screeningState } of batch) {
        if (screeningState) {
          // A previous screen without a verdict: queue the current version again from scratch.
          const [reset] = await tx
            .update(githubFeedbackScreenings)
            .set({
              state: 'queued',
              attempts: 0,
              contentHash: revision.contentHash,
              decisionVersion: revision.decisionVersion,
              outcome: null,
              verdict: null,
              screenedAt: null,
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(githubFeedbackScreenings.revisionId, revision.id),
                eq(githubFeedbackScreenings.state, 'held'),
                inArray(githubFeedbackScreenings.outcome, [...RESCREENABLE_OUTCOMES])
              )
            )
            .returning({ revisionId: githubFeedbackScreenings.revisionId })
          if (reset) queued.push(revision.id)
        } else if (await enqueueGitHubFeedbackScreening(revision, tx)) queued.push(revision.id)
      }
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'squad',
        targetId: squadId,
        action: 'github.feedback.screen_pending',
        outcome: 'allowed',
        recordCount: queued.length,
      })
      return {
        ids: queued,
        result: {
          queued: queued.length,
          // Everything held for an untrusted author that this request did not queue or leave for a later batch.
          skipped: Math.max((held[0]?.count ?? 0) - queued.length - Math.max(eligible - batch.length, 0), 0),
          more: eligible > batch.length,
        },
      }
    })
    const schedule = options.schedule ?? scheduleGitHubFeedbackScreenings
    schedule(outcome.ids)
    return outcome.result
  } catch (error) {
    await db.insert(integrationAuditEvents).values({
      actorKey: githubAuthorityActor(identity),
      targetKind: 'squad',
      targetId: squadId,
      action: 'github.feedback.screen_pending',
      outcome: 'denied',
      code: error instanceof GitHubFeedbackError ? error.code : 'screen_pending_failed',
    })
    throw error
  }
}
