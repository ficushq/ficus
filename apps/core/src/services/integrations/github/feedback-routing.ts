import { and, eq, gt, ne, sql } from 'drizzle-orm'
import { eventEmitter } from '../../../lib/infra/event-emitter'
import {
  db,
  githubOutputProofs,
  githubFeedbackRevisions,
  githubFeedbackSources,
  integrationOutputEvents,
  type DbTx,
  squads,
  settings,
  integrationConnections,
  integrationConnectionAssignments,
} from '../../../db'
import { authorized } from '../outputs/authority'
import { planOutputRouting } from '../outputs/routing-plan'
import { captureRelevantGitHubFeedback, isGitHubFeedbackAdmitted } from './feedback-admission'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import { githubContentHash } from './feedback-envelope'
import { buildGitHubStatus } from './feedback-status'
import {
  readGitHubResource,
  readGitHubCurrent,
  reserveGitHubEvent,
  withGitHubOutputPass,
  inGitHubCandidate,
} from './feedback-pass'
import { readOutputEvent } from './feedback-pass-read'
import { lockGitHubTrustAuthority } from './trust-authority-lock'
import { isGitHubAuthorFilterEnabled, isUnfilteredGitHubEvent } from './author-filter'
import {
  enqueueGitHubFeedbackScreening,
  isGitHubFeedbackScreenWaiting,
  scheduleGitHubFeedbackScreening,
} from './feedback-screening'

type Store = typeof db | DbTx
type Event = typeof integrationOutputEvents.$inferSelect
const TTL = 60_000
const hash = githubContentHash
const sourceHash = (event: Event) => hash([event.fact, event.authority, event.sourceKey, event.eventKey])
const statusFact = (source: Event) => {
  const supplied = source.fact.github?.status
  const safe = supplied ? buildGitHubStatus(supplied) : null
  if (
    !safe ||
    hash(supplied) !== hash(safe) ||
    safe.output !== source.fact.output ||
    safe.data.repository !== source.fact.data.repository
  )
    return null
  const raw = source.fact.data
  if (
    safe.data.action !== raw.action ||
    safe.data.state !==
      (safe.output === 'pull_request.ci_completed' || safe.output === 'dependabot_alert.updated'
        ? raw.state
        : raw.pullRequestState)
  )
    return null
  if (safe.output === 'pull_request.ci_completed' && hash(safe.data.ci) !== hash(raw.ci)) return null
  if (safe.output === 'dependabot_alert.updated' && safe.data.severity !== raw.severity) return null
  return { ...safe, eventKey: source.id, github: { content: null, status: null } }
}

/** Exact stored projection proof plus fresh local authority. No provider I/O inside final locks. */
export async function isGitHubOutputAdmitted(store: Store, event: Event): Promise<boolean> {
  if (event.integration !== 'github') return true
  if (event.authority.kind !== 'connection' || !event.authority.connectionRevision) return false
  // Filter OFF: pre-filter routing. Exact connection authority still applies; no witness/trust.
  if (!(await isGitHubAuthorFilterEnabled(store, event.authority.squadId)))
    return (
      (await authorized(store, 'github', event.authority, event.authority.squadId)) &&
      (await isUnfilteredGitHubEvent(store, event))
    )
  const [proof] = await store
    .select()
    .from(githubOutputProofs)
    .where(and(eq(githubOutputProofs.eventId, event.id), gt(githubOutputProofs.expiresAt, new Date())))
  if (!proof || proof.effectHash !== hash(event.fact) || proof.authorityHash !== hash(event.authority)) return false
  const source = await readOutputEvent(store, proof.sourceEventId)
  if (
    !source ||
    source.integration !== 'github' ||
    sourceHash(source) !== proof.sourceHash ||
    hash(source.authority) !== hash(event.authority) ||
    !(await authorized(store, 'github', event.authority, event.authority.squadId))
  )
    return false
  if (event.fact.github?.revisionId) return isGitHubFeedbackAdmitted(store, event)
  const expected = statusFact(source)
  return (
    !!expected &&
    event.sourceKey === `github-status:${source.sourceKey}` &&
    event.eventKey === source.id &&
    hash(event.fact) === hash(expected)
  )
}

/** Raw matching is internal only, retrieved through an exact stored association, never merged into delivery. */
export async function githubMatchingEvent(store: Store, event: Event): Promise<Event> {
  if (event.integration !== 'github') return event
  const [proof] = await store.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, event.id))
  let source = proof ? await readOutputEvent(store, proof.sourceEventId) : undefined
  if (!proof && event.fact.github?.revisionId && (await isGitHubFeedbackAdmitted(store, event))) {
    const [association] = await store
      .select({ sourceId: integrationOutputEvents.id })
      .from(githubFeedbackSources)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, githubFeedbackSources.eventId))
      .where(
        and(
          eq(githubFeedbackSources.revisionId, event.fact.github.revisionId),
          ne(githubFeedbackSources.eventId, event.id),
          sql`${integrationOutputEvents.authority} = ${JSON.stringify(event.authority)}::jsonb`,
          sql`${integrationOutputEvents.sourceKey} NOT LIKE 'github-feedback:%'`
        )
      )
      .orderBy(githubFeedbackSources.observedAt)
      .limit(1)
    source = association ? await readOutputEvent(store, association.sourceId) : undefined
    return source ? { ...event, fact: source.fact } : event
  }
  return source && sourceHash(source) === proof?.sourceHash ? { ...event, fact: source.fact } : event
}

/**
 * Outcome of preparing a GitHub output event for routing.
 * - `ready`: route `event` now.
 * - `settle`: this raw source event will never route (unauthorized, irrelevant, not routable);
 *   the caller marks it matched with `reason` so the durable unmatched queue stops re-planning it.
 * - `defer`: nothing to route right now (budget exhausted, held for review, transient state);
 *   the event keeps its place in the unmatched queue or is excluded from it by its capture.
 */
export type GitHubOutputPreparation =
  | { kind: 'ready'; event: Event }
  | { kind: 'settle'; reason: string }
  | { kind: 'defer' }

const DEFER: GitHubOutputPreparation = { kind: 'defer' }

/**
 * Entry to every output effect. First query relevance, then capture; held content returns null.
 * Assigned provider I/O finishes before any authority/stream/agent lock. The server-owned witness
 * is short-lived, content/authority bound and rechecked under final locks; a transported status flag
 * or canonical marker has no authority. Existing decisions are never upgraded on retry.
 */
export async function prepareGitHubOutput(
  input: Event,
  options: { reverifyAdopted?: boolean } = {}
): Promise<Event | null> {
  const outcome = await prepareGitHubOutputOutcome(input, options)
  return outcome.kind === 'ready' ? outcome.event : null
}

/** Like {@link prepareGitHubOutput}, but tells the caller whether a null result is final. */
export async function prepareGitHubOutputOutcome(
  input: Event,
  options: { reverifyAdopted?: boolean } = {}
): Promise<GitHubOutputPreparation> {
  return withGitHubOutputPass(() =>
    input.integration === 'github'
      ? inGitHubCandidate(() => prepareGitHubOutputInPass(input, options), DEFER)
      : prepareGitHubOutputInPass(input, options)
  )
}

async function prepareGitHubOutputInPass(
  input: Event,
  options: { reverifyAdopted?: boolean }
): Promise<GitHubOutputPreparation> {
  const ready = (event: Event): GitHubOutputPreparation => ({ kind: 'ready', event })
  // Only a raw provider source is ever settled. Canonical (`github-feedback:`) and status
  // (`github-status:`) effects keep `matchedAt` as their own routing record, which the release
  // worker reads; a dead end for one of those is a deferral.
  const raw = !input.fact.github?.revisionId && !input.sourceKey.startsWith('github-status:')
  const settle = (reason: string): GitHubOutputPreparation => (raw ? { kind: 'settle', reason } : DEFER)
  if (input.integration !== 'github') return ready(input)
  if (!reserveGitHubEvent(input.id)) return DEFER
  if (
    input.authority.kind !== 'connection' ||
    !input.authority.connectionRevision ||
    !(await authorized(db, 'github', input.authority, input.authority.squadId))
  )
    return settle('github_unauthorized')
  // Filter OFF: no capture, hold, provider witness or projection; the event routes as before.
  if (!(await isGitHubAuthorFilterEnabled(db, input.authority.squadId)))
    return (await isUnfilteredGitHubEvent(db, input)) ? ready(input) : settle('github_not_routable')
  let source = input
  const [prior] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, input.id))
  if (prior) {
    const stored = await readOutputEvent(db, prior.sourceEventId)
    if (!stored || sourceHash(stored) !== prior.sourceHash || hash(stored.authority) !== hash(input.authority))
      return DEFER
    source = stored
  } else if (input.fact.github?.revisionId) {
    // Crash recovery uses exact stored source associations and the immutable predicate, never
    // a guessed source, marker, other account's access or provider replacement content.
    if (!(await isGitHubFeedbackAdmitted(db, input))) return DEFER
    const [row] = await db
      .select({ sourceId: integrationOutputEvents.id })
      .from(githubFeedbackSources)
      .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, githubFeedbackSources.eventId))
      .where(
        and(
          eq(githubFeedbackSources.revisionId, input.fact.github.revisionId),
          ne(githubFeedbackSources.eventId, input.id),
          sql`${integrationOutputEvents.authority} = ${JSON.stringify(input.authority)}::jsonb`,
          sql`${integrationOutputEvents.sourceKey} NOT LIKE 'github-feedback:%'`
        )
      )
      .orderBy(githubFeedbackSources.observedAt)
      .limit(1)
    if (!row) return DEFER
    const stored = await readOutputEvent(db, row.sourceId)
    if (!stored) return DEFER
    source = stored
  } else if (input.sourceKey.startsWith('github-status:')) return DEFER
  // A raw event already routed (before rollout, or while the filter was OFF) is never re-delivered
  // as a new capture; only a refinement that resets matchedAt is evaluated again.
  else if (input.matchedAt) return DEFER
  const envelope = source.fact.github
  if (!envelope || (!envelope.content && !envelope.status)) return settle('github_no_content')
  const factual = !!envelope.status
  if (factual && !statusFact(source)) return settle('github_status_invalid')
  const relevanceEvent = factual ? { ...source, fact: envelope.status! } : source
  const local = (event: Event) =>
    event.authority.kind === 'connection' && sourceHash(event) === sourceHash(source)
      ? authorized(db, 'github', event.authority, event.authority.squadId)
      : Promise.resolve(false)
  // Raw branch equality is internal factual discovery, not a content binding or title source.
  const plan = await planOutputRouting(
    relevanceEvent,
    async (squadId) =>
      squadId === (source.authority.kind === 'connection' ? source.authority.squadId : null) && (await local(source)),
    { bindingFact: source.fact }
  )
  // Nobody tracks this resource and no rule selects it. Before the filter this event was routed
  // nowhere and marked matched; settling it keeps the unmatched queue from re-planning it for ever.
  if (!plan.relevant && !prior && !input.fact.github?.revisionId) return settle('github_irrelevant')
  if (!factual && !input.fact.github?.revisionId) {
    const [known] = await db
      .select({ decision: githubFeedbackRevisions.decision })
      .from(githubFeedbackSources)
      .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
      .where(eq(githubFeedbackSources.eventId, source.id))
      .limit(1)
    // Explicit history is released only by the reviewed-source release adapter, never a raw
    // retry or a trust-list change. In particular, pending replays cost no provider requests.
    if (known && known.decision !== 'automatic') return DEFER
  }
  const access = await readGitHubResource(source)
  if (!access) return DEFER
  if (!access.repositoryAuthorized) return settle('github_repository_unauthorized')
  const checkedAt = access.checkedAt,
    expiresAt = new Date(checkedAt.getTime() + TTL)
  const native = access.nativeAuthorized
  if (!(await local(source))) return settle('github_unauthorized')
  let effect: Event
  if (!factual) {
    if (prior || input.fact.github?.revisionId) effect = input
    else {
      // Unresolvable native objects/IDs are quarantined, never silently dropped or automatically
      // trusted. This path is STORAGE ONLY; no native witness means no materialization/effects.
      const deps = {
        authorizeSource: local,
        readCurrent: readGitHubCurrent,
        routingProvenance: plan.routes,
        ...(!native
          ? { holdReason: 'source_unverified' as const }
          : {
              queueScreening: (tx: DbTx, revision: Parameters<typeof enqueueGitHubFeedbackScreening>[0]) =>
                enqueueGitHubFeedbackScreening(revision, tx),
            }),
      }
      let captured
      try {
        captured = native
          ? await captureRelevantGitHubFeedback(source, deps)
          : await captureGitHubFeedback(source.id, deps)
      } catch (error) {
        // The filter was turned OFF between the relevance read and the capture transaction:
        // route the raw event as the filter-OFF path would, instead of holding it.
        if (error instanceof Error && error.message === 'feedback_filter_disabled')
          return (await isUnfilteredGitHubEvent(db, input)) ? ready(input) : settle('github_not_routable')
        throw error
      }
      // Content-free, after the capture transaction committed: the human queue count changed.
      if (captured.revision.decision === 'pending' && captured.disposition !== 'replay')
        eventEmitter.emit('githubFeedback.updated', { squadId: captured.revision.squadId })
      // Squads that screen untrusted feedback: the capture transaction queued a decision-model
      // screen for a new held revision. Run it off this path; the revision stays held meanwhile.
      if (native && captured.disposition !== 'replay' && (await isGitHubFeedbackScreenWaiting(captured.revision.id)))
        scheduleGitHubFeedbackScreening(captured.revision.id)
      if (!native || !['automatic', 'allow_once', 'allow_trust', 'screened'].includes(captured.revision.decision))
        return DEFER
      effect = await recordCanonicalGitHubFeedback(captured.revision.id, source.id, local)
    }
  } else {
    if (!native) return settle('github_source_unverified')
    const fact = statusFact(source)!
    const [inserted] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: `github-status:${source.sourceKey}`,
        eventKey: source.id,
        authority: source.authority,
        fact,
        createdAt: source.createdAt,
      })
      .onConflictDoNothing()
      .returning({ id: integrationOutputEvents.id })
    const identity =
      inserted ??
      (
        await db
          .select({ id: integrationOutputEvents.id })
          .from(integrationOutputEvents)
          .where(
            and(
              eq(integrationOutputEvents.sourceKey, `github-status:${source.sourceKey}`),
              eq(integrationOutputEvents.eventKey, source.id)
            )
          )
      )[0]!
    const storedEffect = await readOutputEvent(db, identity.id)
    if (!storedEffect) return DEFER
    effect = storedEffect
    if (hash(effect.fact) !== hash(fact)) return DEFER // refinement must be deliberately reconciled, not substitute unseen text
  }
  if (!native) return DEFER
  const [existingProof] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, effect.id))
  if (
    hash(effect.authority) !== hash(source.authority) ||
    (existingProof && existingProof.sourceEventId !== source.id)
  ) {
    // Dedupe may adopt an earlier canonical event, but this observation's access cannot bless
    // or replace that event's original source. Reverify its OWN retained authority instead.
    // Known-record renewal budgets one native verification per resource. A concurrent source
    // adoption must defer, not recursively exceed that budget; the next pass checks its own proof.
    return options.reverifyAdopted === false ? DEFER : prepareGitHubOutputOutcome(effect)
  }
  return db.transaction(async (tx): Promise<GitHubOutputPreparation> => {
    await lockGitHubTrustAuthority(tx)
    const [lockedProof] = await tx.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, effect.id))
    if (lockedProof && lockedProof.sourceEventId !== source.id) return DEFER
    const current = await readOutputEvent(tx, source.id)
    if (
      expiresAt.getTime() <= Date.now() ||
      !current ||
      sourceHash(current) !== sourceHash(source) ||
      effect.authority.kind !== 'connection' ||
      !(await authorized(tx, 'github', effect.authority, effect.authority.squadId)) ||
      (effect.fact.github?.revisionId && !(await isGitHubFeedbackAdmitted(tx, effect)))
    )
      return DEFER
    const proof = {
      eventId: effect.id,
      sourceEventId: source.id,
      sourceHash: sourceHash(source),
      effectHash: hash(effect.fact),
      authorityHash: hash(effect.authority),
      checkedAt,
      expiresAt,
    }
    await tx
      .insert(githubOutputProofs)
      .values(proof)
      .onConflictDoUpdate({ target: githubOutputProofs.eventId, set: proof })
    return ready(effect)
  })
}

export class GitHubOutputNotAdmittedError extends Error {
  constructor() {
    super('github_output_not_admitted')
  }
}

/**
 * Fence DB-owned authority/material and source snapshots until the actual effect commits.
 * Order: trust -> squad -> provider settings -> connection -> assignment -> event/source.
 * This agrees with assignment's squad-before-connection order; no provider I/O is permitted.
 * Resource authority is the bounded server witness, never a caller status/approval flag.
 */
export async function lockGitHubOutputAuthority(tx: DbTx, event: Event): Promise<void> {
  if (event.integration !== 'github') return
  // Exclusive on purpose: effect transactions take the squad row FOR SHARE below and some later
  // upgrade it (consultant creation, trigger runs). Two of them running concurrently under a shared
  // advisory lock deadlock on that upgrade, so the advisory lock also serializes effects.
  await lockGitHubTrustAuthority(tx)
  if (event.authority.kind !== 'connection') return
  await tx.select({ id: squads.id }).from(squads).where(eq(squads.id, event.authority.squadId)).for('share')
  await tx
    .select({ key: settings.key })
    .from(settings)
    .where(eq(settings.key, '__integration-enabled:github'))
    .for('share')
  await tx
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, event.authority.connectionId))
    .for('share')
  await tx
    .select({ id: integrationConnectionAssignments.connectionId })
    .from(integrationConnectionAssignments)
    .where(
      and(
        eq(integrationConnectionAssignments.squadId, event.authority.squadId),
        eq(integrationConnectionAssignments.connectionId, event.authority.connectionId),
        eq(integrationConnectionAssignments.providerKey, 'github')
      )
    )
    .for('share')
  const [proof] = await tx
    .select()
    .from(githubOutputProofs)
    .where(eq(githubOutputProofs.eventId, event.id))
    .for('share')
  const ids = [...new Set([event.id, ...(proof ? [proof.sourceEventId] : [])])].sort()
  for (const id of ids)
    await tx
      .select({ id: integrationOutputEvents.id })
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.id, id))
      .for('share')
}

/** Local final effect guard; always acquired before stream/agent locks, never does provider I/O. */
export async function lockAdmittedGitHubOutput(tx: DbTx, event: Event): Promise<void> {
  await lockGitHubOutputAuthority(tx, event)
  if (!(await isGitHubOutputAdmitted(tx, event))) throw new GitHubOutputNotAdmittedError()
}
