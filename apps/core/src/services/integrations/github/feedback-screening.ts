import { and, eq, gte, lt, lte, or, sql } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackScreenings,
  integrationAuditEvents,
  squads,
  type DbTx,
} from '../../../db'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import { createLogger } from '../../../lib/infra/logger'
import { decide as defaultDecide, type DecisionOutcome } from '../../decisions/service'
import { buildScreenState, evaluateScreen, SCREEN_QUESTIONS, type ScreenEvaluation } from './feedback-screen-policy'
import { lockGitHubTrustAuthority } from './trust-authority-lock'

/*
 * Decision-model screening of held GitHub feedback, for squads whose author filter is ON and whose
 * untrusted handling is 'screen'.
 *
 * Capture holds the feedback exactly as it would without screening (decision 'pending'), then a
 * screening row is queued and run off the webhook path. The feedback stays held the whole time, so
 * a person can allow or deny it at any point, and nothing here ever trusts its author.
 *
 * Only a confidently safe verdict changes anything: one compare-and-set moves the revision from
 * 'pending' at the queued decision version and content hash to 'screened', the same one-time,
 * snapshot-bound release a human "allow once" makes, then the existing release worker delivers it.
 * Any other verdict, no model, an error, a crash, a person deciding first, or the squad switching
 * back to 'hold' leaves the revision pending for a person. A late verdict can never undo a denial.
 */

const log = createLogger('github-feedback-screening')

/** Longer than the decision layer's maximum timeout, so a live screen is never taken over. */
const LEASE = sql.raw(`interval '90 seconds'`)
/** Crashed screens are retried this many times in total, then left held as unavailable. */
export const SCREEN_MAX_ATTEMPTS = 3
/** The audit actor for screening outcomes; there is no user. */
export const SCREEN_AUDIT_ACTOR = 'decision-model'
/** The revision reason a passing screen records. */
export const SCREEN_RELEASE_REASON = 'decision_model_allowed'

export interface ScreeningDependencies {
  /** The decision layer; tests inject a fake. */
  decide?: typeof defaultDecide
}

type Revision = typeof githubFeedbackRevisions.$inferSelect
type Store = typeof db | DbTx

const claimable = () =>
  and(
    lt(githubFeedbackScreenings.attempts, SCREEN_MAX_ATTEMPTS),
    or(
      eq(githubFeedbackScreenings.state, 'queued'),
      and(
        eq(githubFeedbackScreenings.state, 'running'),
        lte(githubFeedbackScreenings.leaseExpiresAt, sql`clock_timestamp()`)
      )
    )
  )

async function squadScreens(squadId: string, store: Store = db): Promise<boolean> {
  const [squad] = await store
    .select({ filter: squads.githubAuthorFilter, handling: squads.githubUntrustedHandling })
    .from(squads)
    .where(eq(squads.id, squadId))
  return !!squad?.filter && squad.handling === 'screen'
}

/**
 * Queue a just-held revision for screening if its squad screens untrusted feedback. Capture calls
 * this in the transaction that creates the revision, so a held revision in a screening squad always
 * has its row; it is idempotent. Only feedback held solely because its author is not trusted is
 * eligible; events held for other reasons (unverified source, unknown editor, stale or unreadable
 * content) stay with a person. Returns whether a screen is waiting to run.
 */
export async function enqueueGitHubFeedbackScreening(revision: Revision, store: Store = db): Promise<boolean> {
  if (revision.decision !== 'pending' || revision.reason !== 'untrusted_author' || !revision.envelope) return false
  if (!(await squadScreens(revision.squadId, store))) return false
  await store
    .insert(githubFeedbackScreenings)
    .values({
      revisionId: revision.id,
      squadId: revision.squadId,
      contentHash: revision.contentHash,
      decisionVersion: revision.decisionVersion,
    })
    .onConflictDoNothing()
  const [row] = await store
    .select({ revisionId: githubFeedbackScreenings.revisionId })
    .from(githubFeedbackScreenings)
    .where(and(eq(githubFeedbackScreenings.revisionId, revision.id), claimable()))
  return !!row
}

/** Whether a revision has a screen nobody has finished, so a kick is worth scheduling. */
export async function isGitHubFeedbackScreenWaiting(revisionId: string): Promise<boolean> {
  const [row] = await db
    .select({ revisionId: githubFeedbackScreenings.revisionId })
    .from(githubFeedbackScreenings)
    .where(and(eq(githubFeedbackScreenings.revisionId, revisionId), claimable()))
  return !!row
}

/**
 * Run a queued screen soon, off the caller's path (the webhook is acknowledged without waiting).
 * A lost run is harmless: the revision stays held and the worker's sweep picks the row up.
 */
export function scheduleGitHubFeedbackScreening(revisionId: string, deps: ScreeningDependencies = {}) {
  setTimeout(() => {
    screenGitHubFeedback(revisionId, deps).catch((error) =>
      log.warn('GitHub feedback screen failed; it stays held', {
        revisionId,
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }, 0)
}

/**
 * Run several queued screens one after another, off the caller's path, so a bulk request never
 * opens a burst of concurrent model calls. Anything left over is picked up by the worker's sweep.
 */
export function scheduleGitHubFeedbackScreenings(revisionIds: string[], deps: ScreeningDependencies = {}) {
  if (!revisionIds.length) return
  setTimeout(() => {
    void (async () => {
      for (const revisionId of revisionIds)
        await screenGitHubFeedback(revisionId, deps).catch((error) =>
          log.warn('GitHub feedback screen failed; it stays held', {
            revisionId,
            error: error instanceof Error ? error.message : String(error),
          })
        )
    })()
  }, 0)
}

export type ScreenRunResult =
  | { status: 'not_claimed' }
  | { status: 'settled'; released: boolean; outcome: ScreenEvaluation['outcome'] }

/**
 * Claim one screen, ask the decision model (outside any transaction), and settle the verdict.
 * Safe to call any number of times for the same revision: only one caller holds the lease, and a
 * settled row is never claimed again.
 */
export async function screenGitHubFeedback(
  revisionId: string,
  deps: ScreeningDependencies = {}
): Promise<ScreenRunResult> {
  const decide = deps.decide ?? defaultDecide
  const leaseToken = crypto.randomUUID()
  const [claimed] = await db
    .update(githubFeedbackScreenings)
    .set({
      state: 'running',
      leaseToken,
      leaseExpiresAt: sql`clock_timestamp() + ${LEASE}`,
      attempts: sql`${githubFeedbackScreenings.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(githubFeedbackScreenings.revisionId, revisionId), claimable()))
    .returning()
  if (!claimed) return { status: 'not_claimed' }

  const [row] = await db
    .select({ revision: githubFeedbackRevisions, objectKind: githubFeedbackObjects.objectKind })
    .from(githubFeedbackRevisions)
    .innerJoin(githubFeedbackObjects, eq(githubFeedbackObjects.id, githubFeedbackRevisions.objectId))
    .where(eq(githubFeedbackRevisions.id, revisionId))
  const revision = row?.revision
  let evaluation: ScreenEvaluation
  if (
    !revision ||
    !stillScreenable(revision, claimed) ||
    !(await squadScreens(claimed.squadId)) ||
    !revision.envelope
  ) {
    evaluation = { pass: false, outcome: 'skipped', verdict: emptyVerdict() }
  } else {
    const built = buildScreenState(revision, row.objectKind)
    if (!built) evaluation = { pass: false, outcome: 'skipped', verdict: emptyVerdict() }
    else if ('tooLong' in built) evaluation = { pass: false, outcome: 'too_long', verdict: emptyVerdict() }
    else {
      let outcome: DecisionOutcome
      try {
        outcome = await decide(
          'github-firewall',
          { state: built.state, questions: SCREEN_QUESTIONS },
          { source: { kind: 'github', squadId: claimed.squadId, revisionId } }
        )
      } catch (error) {
        // decide() reports provider failures itself; anything thrown here is still "no answer".
        outcome = {
          ok: false,
          reason: 'unavailable',
          errors: [{ providerId: '', error: error instanceof Error ? error.message : String(error) }],
        }
      }
      evaluation = evaluateScreen(outcome)
    }
  }
  return settle(claimed, leaseToken, evaluation)
}

function stillScreenable(revision: Revision, claimed: typeof githubFeedbackScreenings.$inferSelect) {
  return (
    revision.squadId === claimed.squadId &&
    revision.decision === 'pending' &&
    revision.decisionVersion === claimed.decisionVersion &&
    revision.contentHash === claimed.contentHash &&
    revision.reason === 'untrusted_author'
  )
}

function emptyVerdict(): ScreenEvaluation['verdict'] {
  return {
    instructsAgent: null,
    intent: null,
    intentConfidence: null,
    intentProbabilities: null,
    providerId: null,
    model: null,
    latencyMs: null,
  }
}

async function settle(
  claimed: typeof githubFeedbackScreenings.$inferSelect,
  leaseToken: string,
  evaluation: ScreenEvaluation
): Promise<ScreenRunResult> {
  const result = await db.transaction(async (tx) => {
    // Same order as the author filter toggle and moderation: trust authority, squad, revision.
    await lockGitHubTrustAuthority(tx)
    const [squad] = await tx
      .select({ filter: squads.githubAuthorFilter, handling: squads.githubUntrustedHandling })
      .from(squads)
      .where(eq(squads.id, claimed.squadId))
      .for('share')
    const [revision] = await tx
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, claimed.revisionId))
      .for('update')
    const [screening] = await tx
      .select()
      .from(githubFeedbackScreenings)
      .where(eq(githubFeedbackScreenings.revisionId, claimed.revisionId))
      .for('update')
    // Another runner took the lease over; this one settles nothing.
    if (!screening || screening.leaseToken !== leaseToken) return null
    let outcome = evaluation.outcome
    let released = false
    if (evaluation.pass) {
      const eligible =
        !!revision &&
        !!squad?.filter &&
        squad.handling === 'screen' &&
        !!revision.envelope &&
        stillScreenable(revision, screening)
      const [updated] = eligible
        ? await tx
            .update(githubFeedbackRevisions)
            .set({
              decision: 'screened',
              decisionVersion: screening.decisionVersion + 1,
              releaseState: 'ready',
              nextAttemptAt: null,
              reason: SCREEN_RELEASE_REASON,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(githubFeedbackRevisions.id, screening.revisionId),
                eq(githubFeedbackRevisions.decision, 'pending'),
                eq(githubFeedbackRevisions.decisionVersion, screening.decisionVersion),
                eq(githubFeedbackRevisions.contentHash, screening.contentHash)
              )
            )
            .returning({ id: githubFeedbackRevisions.id })
        : []
      released = !!updated
      if (!released) outcome = 'skipped'
    }
    await tx
      .update(githubFeedbackScreenings)
      .set({
        state: released ? 'passed' : 'held',
        outcome,
        verdict: evaluation.verdict,
        screenedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(githubFeedbackScreenings.revisionId, screening.revisionId),
          eq(githubFeedbackScreenings.leaseToken, leaseToken)
        )
      )
    await tx.insert(integrationAuditEvents).values({
      squadId: screening.squadId,
      actorKey: SCREEN_AUDIT_ACTOR,
      targetKind: 'github_feedback_revision',
      targetId: screening.revisionId,
      action: 'github.feedback.screen',
      outcome: released ? 'allowed' : 'held',
      code: outcome,
    })
    return { released, outcome }
  })
  if (!result) return { status: 'not_claimed' }
  // Content-free, post-commit: the queue counts or the shown verdict changed.
  eventEmitter.emit('githubFeedback.updated', { squadId: claimed.squadId })
  return { status: 'settled', ...result }
}

/**
 * Worker sweep: run screens nobody is running (a lost kick, a restart mid-screen), and give up on
 * screens that crashed SCREEN_MAX_ATTEMPTS times, leaving them held for a person.
 */
export async function reconcileGitHubFeedbackScreenings(
  deps: ScreeningDependencies = {},
  options: { limit?: number } = {}
): Promise<number> {
  const abandoned = await db
    .update(githubFeedbackScreenings)
    .set({
      state: 'held',
      outcome: 'unavailable',
      leaseToken: null,
      leaseExpiresAt: null,
      screenedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(githubFeedbackScreenings.state, 'running'),
        lte(githubFeedbackScreenings.leaseExpiresAt, sql`clock_timestamp()`),
        gte(githubFeedbackScreenings.attempts, SCREEN_MAX_ATTEMPTS)
      )
    )
    .returning({ revisionId: githubFeedbackScreenings.revisionId, squadId: githubFeedbackScreenings.squadId })
  if (abandoned.length)
    await db.insert(integrationAuditEvents).values(
      abandoned.map((row) => ({
        squadId: row.squadId,
        actorKey: SCREEN_AUDIT_ACTOR,
        targetKind: 'github_feedback_revision',
        targetId: row.revisionId,
        action: 'github.feedback.screen',
        outcome: 'held',
        code: 'unavailable',
      }))
    )
  for (const squadId of new Set(abandoned.map((row) => row.squadId)))
    eventEmitter.emit('githubFeedback.updated', { squadId })
  const due = await db
    .select({ revisionId: githubFeedbackScreenings.revisionId })
    .from(githubFeedbackScreenings)
    .where(claimable())
    .orderBy(githubFeedbackScreenings.updatedAt, githubFeedbackScreenings.revisionId)
    .limit(options.limit ?? 10)
  let settled = 0
  for (const { revisionId } of due) {
    try {
      if ((await screenGitHubFeedback(revisionId, deps)).status === 'settled') settled++
    } catch (error) {
      log.warn('GitHub feedback screen failed; it stays held', {
        revisionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return settled
}
