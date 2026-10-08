import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { db, githubFeedbackDecisions, githubFeedbackRevisions, integrationAuditEvents, squads } from '../../../db'
import { GITHUB_UNTRUSTED_HANDLING, type GitHubUntrustedHandling } from '@ficus/shared'
import type { Identity } from '../../rbac/permissions'
import { githubContentHash } from './feedback-envelope'
import {
  GitHubFeedbackError,
  githubAuthorityActor,
  lockGitHubHuman,
  requireGitHubHumanSquadUpdate,
} from './feedback-trust'

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
            await tx.insert(githubFeedbackDecisions).values(
              rows.map((row) => ({
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

/**
 * Human-only squad setting with the same authority as the filter toggle: what the author filter
 * does with feedback from untrusted authors. 'hold' keeps it for a person; 'screen' asks a decision
 * model first and releases it once only when confidently safe (see feedback-screening). Changing
 * it never releases or re-holds anything already captured: it applies to new feedback, and a screen
 * already queued re-reads it before releasing, so switching back to 'hold' stops pending screens.
 */
export async function setGitHubUntrustedHandling(
  identity: Identity | undefined,
  squadId: string,
  handling: GitHubUntrustedHandling
) {
  try {
    if (!GITHUB_UNTRUSTED_HANDLING.includes(handling)) throw new GitHubFeedbackError('invalid_untrusted_handling', 400)
    await requireGitHubHumanSquadUpdate(db, identity, squadId)
    return await db.transaction(async (tx) => {
      await lockGitHubHuman(tx, identity)
      const userId = await requireGitHubHumanSquadUpdate(tx, identity, squadId)
      const [squad] = await tx
        .select({ handling: squads.githubUntrustedHandling })
        .from(squads)
        .where(eq(squads.id, squadId))
        .for('update')
      if (!squad) throw new GitHubFeedbackError('squad_unavailable', 409)
      if (squad.handling !== handling)
        await tx
          .update(squads)
          .set({ githubUntrustedHandling: handling, updatedAt: new Date() })
          .where(eq(squads.id, squadId))
      await tx.insert(integrationAuditEvents).values({
        squadId,
        userId,
        actorKey: `user:${userId}`,
        targetKind: 'squad',
        targetId: squadId,
        action: `github.untrusted_handling.${handling}`,
        outcome: 'allowed',
      })
      return { handling }
    })
  } catch (error) {
    await db.insert(integrationAuditEvents).values({
      actorKey: githubAuthorityActor(identity),
      targetKind: 'squad',
      targetId: squadId,
      action: `github.untrusted_handling.${GITHUB_UNTRUSTED_HANDLING.includes(handling) ? handling : 'invalid'}`,
      outcome: 'denied',
      code: error instanceof GitHubFeedbackError ? error.code : 'untrusted_handling_failed',
    })
    throw error
  }
}
