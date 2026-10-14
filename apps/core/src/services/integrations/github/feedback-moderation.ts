import { and, eq, inArray } from 'drizzle-orm'
import { moderateGitHubFeedbackSchema, type ModerateGitHubFeedback } from '@ficus/shared'
import {
  db,
  githubFeedbackRevisions,
  githubFeedbackDecisions,
  githubTrustedAuthors,
  integrationAuditEvents,
} from '../../../db'
import type { Identity } from '../../rbac/permissions'
import { githubContentHash } from './feedback-envelope'
import { hasCurrentSourceAccess } from './feedback-review'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  lockGitHubHuman,
  requireGitHubHumanSquadUpdate,
} from './feedback-trust'

const ALLOWED = ['allow_once', 'allow_trust']
const RELEASING = ['ready', 'retry', 'retained']

/**
 * All-or-nothing, human-only compare-and-set against the exact displayed snapshots.
 * The transaction commits decision, content-free audit, future trust and durable release intent together.
 * It never fetches provider content or routes an event. Adding trust never releases other history.
 *
 * `deny` also accepts an allowed revision that is still releasing (ready, retry or retained): the
 * human's only way out of a release that can no longer reach anyone. Allowing requires the squad to
 * still be able to read the source, so nobody approves or trusts text that was withheld from view.
 */
export async function moderateGitHubFeedback(
  identity: Identity | undefined,
  squadId: string,
  input: ModerateGitHubFeedback
) {
  try {
    // Reject non-humans before snapshot reads, including idempotent request replays.
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    const parsed = moderateGitHubFeedbackSchema.safeParse(input)
    if (!parsed.success) throw new GitHubFeedbackError('invalid_moderation_request', 400)
    const request = parsed.data
    const selections = [...request.selections].sort((a, b) => a.revisionId.localeCompare(b.revisionId))
    return await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      const requestHash = githubContentHash({ squadId, userId, action: request.action, selections })
      const prior = await tx
        .select()
        .from(githubFeedbackDecisions)
        .where(eq(githubFeedbackDecisions.requestId, request.requestId))
      if (prior.length) {
        if (
          prior.length !== selections.length ||
          prior.some((row) => row.requestHash !== requestHash || row.squadId !== squadId || row.userId !== userId)
        )
          throw new GitHubFeedbackError('moderation_request_conflict', 409)
        return prior.sort((a, b) => a.revisionId.localeCompare(b.revisionId))
      }
      const rows = await tx
        .select()
        .from(githubFeedbackRevisions)
        .where(
          and(
            eq(githubFeedbackRevisions.squadId, squadId),
            inArray(
              githubFeedbackRevisions.id,
              selections.map((s) => s.revisionId)
            )
          )
        )
        .orderBy(githubFeedbackRevisions.id)
        .for('update')
      const decidable = (row: (typeof rows)[number]) =>
        row.decision === 'pending' ||
        (request.action === 'deny' && ALLOWED.includes(row.decision) && RELEASING.includes(row.releaseState))
      if (
        rows.length !== selections.length ||
        selections.some((selection) => {
          const row = rows.find((row) => row.id === selection.revisionId)
          return (
            !row ||
            !decidable(row) ||
            row.contentHash !== selection.contentHash ||
            row.decisionVersion !== selection.decisionVersion
          )
        })
      )
        throw new GitHubFeedbackError('moderation_selection_conflict', 409)
      if (request.action !== 'deny') {
        if (rows.some((row) => !row.envelope || row.reason === 'content_unavailable'))
          throw new GitHubFeedbackError('moderation_content_unavailable', 409)
        // The detail view withholds the body when no squad connection can read the source any
        // more; an allow (and especially allow-and-trust) on unseen text is refused the same way.
        for (const row of rows)
          if (!(await hasCurrentSourceAccess(row.id, squadId, tx)))
            throw new GitHubFeedbackError('moderation_content_unavailable', 409)
      }
      if (request.action === 'allow_trust' && rows.some((row) => !row.author))
        throw new GitHubFeedbackError('moderation_author_unavailable', 409)
      const decisions = []
      for (const row of rows) {
        const [updated] = await tx
          .update(githubFeedbackRevisions)
          .set({
            decision: request.action,
            decisionVersion: row.decisionVersion + 1,
            decidedByUserId: userId,
            decidedAt: new Date(),
            releaseState: request.action === 'deny' ? 'held' : 'ready',
            nextAttemptAt: null,
            // Denying a releasing row takes its lease away: a worker mid-attempt can no longer
            // settle it, and every send rechecks the decision under its own lock.
            ...(request.action === 'deny' ? { leaseToken: null, leaseExpiresAt: null } : {}),
            reason: request.action === 'deny' ? 'human_denied' : 'human_allowed',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(githubFeedbackRevisions.id, row.id),
              eq(githubFeedbackRevisions.decision, row.decision),
              eq(githubFeedbackRevisions.decisionVersion, row.decisionVersion)
            )
          )
          .returning()
        if (!updated) throw new GitHubFeedbackError('moderation_selection_conflict', 409)
        if (request.action === 'allow_trust') {
          await tx
            .insert(githubTrustedAuthors)
            .values({ squadId, ...row.author!, addedByUserId: userId })
            .onConflictDoNothing()
        }
        const [decision] = await tx
          .insert(githubFeedbackDecisions)
          .values({
            requestId: request.requestId,
            revisionId: row.id,
            squadId,
            requestHash,
            contentHash: row.contentHash,
            decisionVersion: updated.decisionVersion,
            action: request.action,
            userId,
          })
          .returning()
        decisions.push(decision!)
      }
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'squad',
        targetId: squadId,
        action: 'github.feedback.moderate',
        outcome: 'allowed',
        // Which decision was taken, and on how many revisions; the rows themselves hold the ids.
        code: request.action,
        recordCount: rows.length,
      })
      return decisions
    })
  } catch (error) {
    await db.insert(integrationAuditEvents).values({
      actorKey: githubAuthorityActor(identity),
      targetKind: 'squad',
      targetId: squadId,
      action: 'github.feedback.moderate',
      outcome: 'denied',
      code: error instanceof GitHubFeedbackError ? error.code : 'moderation_failed',
    })
    throw error
  }
}
