import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, integrationOutputEvents } from '../../../db'
import { authorized } from '../outputs/authority'
import { withGitHubOutputPass, reserveGitHubEvent, githubOutputPass } from './feedback-pass'
import { isGitHubFeedbackAdmitted } from './feedback-admission'
import { isGitHubOutputAdmitted, isOriginalGitHubRoute, prepareGitHubOutput } from './feedback-routing'

export const GITHUB_RENEWAL_READ_LIMIT = 25
export const GITHUB_RENEWAL_RESOURCE_LIMIT = 8
// verifyGitHubOutputResource has at most three fixed assigned endpoints per resource.
export const GITHUB_RENEWAL_PROVIDER_CALL_LIMIT = 24

/**
 * Renew only explicitly known records, never discover objects or scan retained history. Each
 * invocation reads at most 25 distinct events and verifies at most 8 resources (24 provider reads).
 * Dedupe BEFORE the read/budget. No transaction/queue/authority locks enclose provider work.
 * Material, content/trust and ORIGINAL route checks precede I/O; preparation rechecks them before
 * committing the 60s witness. Failure/expiry is withheld, not an authorization fallback.
 */
export async function renewKnownGitHubOutputs(eventIds: string[]) {
  return withGitHubOutputPass(() => renewKnownInPass(eventIds))
}

async function renewKnownInPass(eventIds: string[]) {
  const ids = [...new Set(eventIds)]
  if (ids.length > GITHUB_RENEWAL_READ_LIMIT || ids.some((id) => !z.string().uuid().safeParse(id).success))
    throw new Error('invalid_github_renewal_batch')
  const result = { renewed: [] as string[], withheld: [] as string[], deferred: [] as string[] }
  const selected = ids.filter((id) => {
    if (reserveGitHubEvent(id)) return true
    result.deferred.push(id)
    return false
  })
  if (!selected.length) return result
  const events = await db
    .select()
    .from(integrationOutputEvents)
    .where(and(eq(integrationOutputEvents.integration, 'github'), inArray(integrationOutputEvents.id, selected)))
  for (const event of events) {
    if (
      event.authority.kind !== 'connection' ||
      !(await authorized(db, 'github', event.authority, event.authority.squadId)) ||
      (event.fact.github?.revisionId && !(await isGitHubFeedbackAdmitted(db, event))) ||
      !(await isOriginalGitHubRoute(db, event))
    ) {
      await withholdRevokedAutomaticGitHubOutput(event.id)
      result.withheld.push(event.id)
      continue
    }
    if (await isGitHubOutputAdmitted(db, event)) continue // fresh known proof costs no provider work
    if (githubOutputPass()!.resources >= GITHUB_RENEWAL_RESOURCE_LIMIT) {
      result.deferred.push(event.id)
      continue
    }
    try {
      if (await prepareGitHubOutput(event, { reverifyAdopted: false })) result.renewed.push(event.id)
      else result.withheld.push(event.id)
    } catch {
      result.withheld.push(event.id)
    }
  }
  return result
}

/** Observed automatic revocation is held history, not a grant when trust returns later. */
export async function withholdRevokedAutomaticGitHubOutput(eventId: string) {
  if (!z.string().uuid().safeParse(eventId).success) return
  const { githubFeedbackRevisions } = await import('../../../db')
  const { lockGitHubTrustAuthority } = await import('./trust-authority-lock')
  const { isTrustedGitHubFeedbackContent } = await import('./feedback-trust')
  const { hasAcceptedGitHubFeedbackReceipts } = await import('./feedback-release')
  await db.transaction(async (tx) => {
    await lockGitHubTrustAuthority(tx)
    const [event] = await tx.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, eventId))
    if (event?.integration !== 'github' || !event.fact.github?.revisionId || event.authority.kind !== 'connection')
      return
    const [revision] = await tx
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, event.fact.github.revisionId))
      .for('update')
    if (
      !revision ||
      revision.decision !== 'automatic' ||
      event.eventKey !== revision.id ||
      event.sourceKey !== `github-feedback:${revision.squadId}:${revision.id}` ||
      event.authority.squadId !== revision.squadId ||
      (await isTrustedGitHubFeedbackContent(tx, revision.squadId, revision)) ||
      (await hasAcceptedGitHubFeedbackReceipts(event.id))
    )
      return
    await tx
      .update(githubFeedbackRevisions)
      .set({
        decision: 'pending',
        decisionVersion: revision.decisionVersion + 1,
        releaseState: 'held',
        reason: 'trust_revoked',
        nextAttemptAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(githubFeedbackRevisions.id, revision.id))
  })
}
