import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, githubFeedbackDecisions, githubFeedbackRevisions, integrationAuditEvents, squads } from '../../../db'
import type { Identity } from '../../rbac/permissions'
import { githubContentHash } from './feedback-envelope'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  lockGitHubHuman,
  requireGitHubHumanSquadUpdate,
} from './feedback-trust'

/** 8 bind parameters per decision row; Postgres allows 65,535 per statement. */
const DECISION_INSERT_CHUNK = 2000

/**
 * Human-only squad setting, the same authority as trusted-author edits: a literal enabled human
 * with effective squads:update in THIS squad. Agents (including delegated user credentials) are
 * rejected and audited. Turning the filter OFF releases the squad's held events through normal
 * routing: each pending revision with reviewable content becomes a one-time allow by this human
 * (reason filter_disabled), delivered once by the release worker to its current recipients.
 * Held events whose content could not be read stay pending and visible for an explicit decision.
 * Turning the filter back ON never re-holds released events.
 */
export async function setGitHubAuthorFilter(identity: Identity | undefined, squadId: string, enabled: boolean) {
  try {
    if (typeof enabled !== 'boolean') throw new GitHubFeedbackError('invalid_author_filter', 400)
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    return await db.transaction(async (tx) => {
      // Same order as moderation and effects: trust authority, user, squad, revisions.
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      const [squad] = await tx
        .select({ enabled: squads.githubAuthorFilter })
        .from(squads)
        .where(eq(squads.id, squadId))
        .for('update')
      if (!squad) throw new GitHubFeedbackError('squad_unavailable', 409)
      let released = 0
      if (squad.enabled !== enabled) {
        await tx
          .update(squads)
          .set({ githubAuthorFilter: enabled, updatedAt: new Date() })
          .where(eq(squads.id, squadId))
        if (!enabled) {
          const rows = await tx
            .update(githubFeedbackRevisions)
            .set({
              decision: 'allow_once',
              decisionVersion: sql`${githubFeedbackRevisions.decisionVersion} + 1`,
              decidedByUserId: userId,
              decidedAt: new Date(),
              releaseState: 'ready',
              nextAttemptAt: null,
              reason: 'filter_disabled',
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(githubFeedbackRevisions.squadId, squadId),
                eq(githubFeedbackRevisions.decision, 'pending'),
                isNotNull(githubFeedbackRevisions.envelope),
                sql`${githubFeedbackRevisions.reason} IS DISTINCT FROM 'content_unavailable'`
              )
            )
            .returning({
              id: githubFeedbackRevisions.id,
              contentHash: githubFeedbackRevisions.contentHash,
              decisionVersion: githubFeedbackRevisions.decisionVersion,
            })
          if (rows.length) {
            const requestId = crypto.randomUUID()
            const requestHash = githubContentHash({ squadId, userId, action: 'author_filter_off', requestId })
            // Chunked: one statement per ~8k rows would exceed Postgres's bind-parameter limit.
            for (let offset = 0; offset < rows.length; offset += DECISION_INSERT_CHUNK)
              await tx.insert(githubFeedbackDecisions).values(
                rows.slice(offset, offset + DECISION_INSERT_CHUNK).map((row) => ({
                  requestId,
                  revisionId: row.id,
                  squadId,
                  requestHash,
                  contentHash: row.contentHash,
                  decisionVersion: row.decisionVersion,
                  action: 'allow_once' as const,
                  userId,
                }))
              )
          }
          released = rows.length
        }
      }
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'squad',
        targetId: squadId,
        action: enabled ? 'github.author_filter.enable' : 'github.author_filter.disable',
        outcome: 'allowed',
        recordCount: released,
      })
      return { enabled, released }
    })
  } catch (error) {
    await db.insert(integrationAuditEvents).values({
      actorKey: githubAuthorityActor(identity),
      targetKind: 'squad',
      targetId: squadId,
      action: enabled ? 'github.author_filter.enable' : 'github.author_filter.disable',
      outcome: 'denied',
      code: error instanceof GitHubFeedbackError ? error.code : 'author_filter_failed',
    })
    throw error
  }
}
