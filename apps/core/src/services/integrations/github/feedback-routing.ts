import { and, eq, gt, ne, sql } from 'drizzle-orm'
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
import { readGitHubResource, readGitHubCurrent, reserveGitHubEvent, withGitHubOutputPass } from './feedback-pass'
import { lockGitHubTrustAuthority } from './trust-authority-lock'

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
  const [proof] = await store
    .select()
    .from(githubOutputProofs)
    .where(and(eq(githubOutputProofs.eventId, event.id), gt(githubOutputProofs.expiresAt, new Date())))
  if (!proof || proof.effectHash !== hash(event.fact) || proof.authorityHash !== hash(event.authority)) return false
  const [source] = await store
    .select()
    .from(integrationOutputEvents)
    .where(eq(integrationOutputEvents.id, proof.sourceEventId))
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
  let [source] = proof
    ? await store.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, proof.sourceEventId))
    : []
  if (!proof && event.fact.github?.revisionId && (await isGitHubFeedbackAdmitted(store, event))) {
    const [association] = await store
      .select({ source: integrationOutputEvents })
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
    source = association?.source
    return source ? { ...event, fact: source.fact } : event
  }
  return source && sourceHash(source) === proof?.sourceHash ? { ...event, fact: source.fact } : event
}

/** Original review audiences are immutable. Replanning can only retain or remove them. */
export async function originalGitHubRoutes(store: Store, event: Event) {
  if (event.fact.github?.revisionId) {
    const [revision] = await store
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, event.fact.github.revisionId))
    return revision?.routingProvenance ?? []
  }
  const [proof] = await store.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, event.id))
  return proof?.routes ?? []
}

export async function isOriginalGitHubRoute(
  store: Store,
  event: Event,
  selection?: {
    kind?: string
    id?: string
    workStreamId?: string
    recipientId?: string
    owner?: boolean
    target?: { agentId: string; attemptId?: number; version?: number }
  }
): Promise<boolean> {
  if (event.integration !== 'github') return true
  if (
    event.authority.kind !== 'connection' ||
    !(await authorized(store, 'github', event.authority, event.authority.squadId))
  )
    return false
  return matchesOriginalGitHubRoutes(
    store,
    event,
    await originalGitHubRoutes(store, event),
    await githubMatchingEvent(store, event),
    selection
  )
}

/** Query-only original provenance check for a stored raw source before canonical creation. */
export async function matchesOriginalGitHubRoutes(
  store: Store,
  event: Event,
  originals: import('@ficus/shared').GitHubFeedbackRoute[],
  raw: Event,
  selection?: Parameters<typeof isOriginalGitHubRoute>[2]
): Promise<boolean> {
  if (!originals.length || event.authority.kind !== 'connection') return false
  const matching = raw.fact.github?.status ? { ...raw, fact: raw.fact.github.status } : raw
  const current = await planOutputRouting(
    matching,
    (squadId) => authorized(store, 'github', event.authority, squadId),
    { store, bindingFact: raw.fact, includeSettled: true }
  )
  return originals.some((original) => {
    if (
      !original.fingerprint ||
      original.authorityHash !== hash(event.authority) ||
      (selection?.kind && original.kind !== selection.kind) ||
      (selection?.id && original.id !== selection.id) ||
      (selection?.workStreamId && original.workStreamId !== selection.workStreamId) ||
      (selection?.recipientId && original.recipientId !== selection.recipientId)
    )
      return false
    // A branch route becomes a normal subscription after its authorized binding commits.
    const live = current.routes.find(
      (route) =>
        route.id === original.id &&
        route.workStreamId === original.workStreamId &&
        (route.kind === original.kind || (original.kind === 'delivery-branch' && route.kind === 'subscription')) &&
        route.fingerprint === original.fingerprint &&
        route.runId === original.runId &&
        route.recipientId === original.recipientId
    )
    if (!live) return false
    if (selection?.owner)
      return !!original.ownerId && live.ownerId === original.ownerId && selection.target?.agentId === original.ownerId
    if (!selection?.target)
      return (
        !original.consumers ||
        original.consumers.some((slot) =>
          live.consumers?.some(
            (now) =>
              now.attemptId === slot.attemptId &&
              now.version === slot.version &&
              now.stepHash === slot.stepHash &&
              (!slot.agentId || slot.agentId === now.agentId)
          )
        )
      )
    const target = selection.target
    return (
      original.consumers?.some((slot) => {
        if (slot.agentId && slot.agentId !== target.agentId) return false
        if (slot.attemptId !== target.attemptId || slot.version !== target.version) return false
        return live.consumers?.some(
          (now) =>
            now.agentId === target.agentId &&
            now.attemptId === slot.attemptId &&
            now.version === slot.version &&
            now.stepHash === slot.stepHash
        )
      }) === true
    )
  })
}

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
  return withGitHubOutputPass(() => prepareGitHubOutputInPass(input, options))
}

async function prepareGitHubOutputInPass(input: Event, options: { reverifyAdopted?: boolean }): Promise<Event | null> {
  if (input.integration !== 'github') return input
  if (!reserveGitHubEvent(input.id)) return null
  if (
    input.authority.kind !== 'connection' ||
    !input.authority.connectionRevision ||
    !(await authorized(db, 'github', input.authority, input.authority.squadId))
  )
    return null
  let source = input
  const [prior] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, input.id))
  if (prior) {
    const [stored] = await db
      .select()
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.id, prior.sourceEventId))
    if (!stored || sourceHash(stored) !== prior.sourceHash || hash(stored.authority) !== hash(input.authority))
      return null
    source = stored
  } else if (input.fact.github?.revisionId) {
    // Crash recovery uses exact stored source associations and the immutable predicate, never
    // a guessed source, marker, other account's access or provider replacement content.
    if (!(await isGitHubFeedbackAdmitted(db, input))) return null
    const [row] = await db
      .select({ source: integrationOutputEvents })
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
    if (!row) return null
    source = row.source
  } else if (input.sourceKey.startsWith('github-status:')) return null
  const envelope = source.fact.github
  if (!envelope || (!envelope.content && !envelope.status)) return null
  const factual = !!envelope.status
  if (factual && !statusFact(source)) return null
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
  if (!plan.relevant && !prior && !input.fact.github?.revisionId) return null
  if (!factual && !input.fact.github?.revisionId) {
    const [known] = await db
      .select({ decision: githubFeedbackRevisions.decision })
      .from(githubFeedbackSources)
      .innerJoin(githubFeedbackRevisions, eq(githubFeedbackRevisions.id, githubFeedbackSources.revisionId))
      .where(eq(githubFeedbackSources.eventId, source.id))
      .limit(1)
    // Explicit history is released only by the reviewed-source release adapter, never a raw
    // retry or a trust-list change. In particular, pending replays cost no provider requests.
    if (known && known.decision !== 'automatic') return null
  }
  if ((prior || input.fact.github?.revisionId) && !(await isOriginalGitHubRoute(db, input))) return null
  const access = await readGitHubResource(source)
  if (!access?.repositoryAuthorized) return null
  const checkedAt = access.checkedAt,
    expiresAt = new Date(checkedAt.getTime() + TTL)
  const native = access.nativeAuthorized
  if (!(await local(source))) return null
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
        ...(!native ? { holdReason: 'source_unverified' as const } : {}),
      }
      const captured = native
        ? await captureRelevantGitHubFeedback(source, deps)
        : await captureGitHubFeedback(source.id, deps)
      if (!native || !['automatic', 'allow_once', 'allow_trust'].includes(captured.revision.decision)) return null
      effect = await recordCanonicalGitHubFeedback(captured.revision.id, source.id, local)
    }
  } else {
    if (!native) return null
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
      .returning()
    effect =
      inserted ??
      (
        await db
          .select()
          .from(integrationOutputEvents)
          .where(
            and(
              eq(integrationOutputEvents.sourceKey, `github-status:${source.sourceKey}`),
              eq(integrationOutputEvents.eventKey, source.id)
            )
          )
      )[0]!
    if (hash(effect.fact) !== hash(fact)) return null // refinement must be deliberately reconciled, not substitute unseen text
  }
  if (!native) return null
  const [existingProof] = await db.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, effect.id))
  if (
    hash(effect.authority) !== hash(source.authority) ||
    (existingProof && existingProof.sourceEventId !== source.id)
  ) {
    // Dedupe may adopt an earlier canonical event, but this observation's access cannot bless
    // or replace that event's original source. Reverify its OWN retained authority instead.
    // Known-record renewal budgets one native verification per resource. A concurrent source
    // adoption must defer, not recursively exceed that budget; the next pass checks its own proof.
    return options.reverifyAdopted === false ? null : prepareGitHubOutput(effect)
  }
  return db.transaction(async (tx) => {
    await lockGitHubTrustAuthority(tx)
    const [lockedProof] = await tx.select().from(githubOutputProofs).where(eq(githubOutputProofs.eventId, effect.id))
    if (lockedProof && lockedProof.sourceEventId !== source.id) return null
    const [current] = await tx.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, source.id))
    if (
      expiresAt.getTime() <= Date.now() ||
      !current ||
      sourceHash(current) !== sourceHash(source) ||
      effect.authority.kind !== 'connection' ||
      !(await authorized(tx, 'github', effect.authority, effect.authority.squadId)) ||
      (effect.fact.github?.revisionId && !(await isGitHubFeedbackAdmitted(tx, effect)))
    )
      return null
    const proof = {
      eventId: effect.id,
      sourceEventId: source.id,
      sourceHash: sourceHash(source),
      effectHash: hash(effect.fact),
      authorityHash: hash(effect.authority),
      routes:
        lockedProof?.routes ?? (effect.fact.github?.revisionId ? await originalGitHubRoutes(tx, effect) : plan.routes),
      checkedAt,
      expiresAt,
    }
    await tx
      .insert(githubOutputProofs)
      .values(proof)
      .onConflictDoUpdate({ target: githubOutputProofs.eventId, set: proof })
    return effect
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
  if (!(await isGitHubOutputAdmitted(tx, event)) || !(await isOriginalGitHubRoute(tx, event)))
    throw new GitHubOutputNotAdmittedError()
}
