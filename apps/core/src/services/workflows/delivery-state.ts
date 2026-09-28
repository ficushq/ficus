import {
  readGitHubDeliverySnapshot,
  DELIVERY_SNAPSHOT_MAX_AGE_MS,
  type GitHubDeliverySnapshot,
} from '../integrations/github/delivery-presentation'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  workStreamFlowRuns,
  workStreams,
  squads,
  integrationOutputEvents,
  integrationOutputDeliveries,
  integrationEventPollingCursors,
} from '../../db'
import type { DbHandle } from '../work-streams/waits'
import { codeHostingRegistry } from '../integrations/code-hosting'
import {
  deliveryPullRequests,
  type WorkflowRun,
  type IntegrationOutputFact,
  type WorkStreamDeliveryExplanation,
  type WorkStreamDeliveryGateFacts,
  type WorkStreamDeliveryPresentation,
} from '@ficus/shared'
import { deliveryView } from '../work-streams/delivery-pull-requests'

/** A linked PR with event routing is an external wait, not abandoned delivery setup. */
export function awaitsCodeHostDelivery(state: WorkflowRun, metadata: unknown): boolean {
  return (
    state.status === 'completion-ready' &&
    ['pr-merge', 'pr-auto-merge'].includes(state.definition.completion.mode) &&
    state.definition.completion.followChanges === true &&
    !!codeHostingRegistry.resolve(metadata)?.reference.changeRequest
  )
}

export async function externalDeliveryStreamIds(store: DbHandle, streams: Array<{ id: string; metadata: unknown }>) {
  if (!streams.length) return new Set<string>()
  const runs = await store
    .select()
    .from(workStreamFlowRuns)
    .where(
      and(
        inArray(
          workStreamFlowRuns.workStreamId,
          streams.map((s) => s.id)
        ),
        eq(workStreamFlowRuns.activated, true)
      )
    )
  const metadata = new Map(streams.map((s) => [s.id, s.metadata]))
  return new Set(
    runs
      .filter((run) => awaitsCodeHostDelivery(run.state, metadata.get(run.workStreamId)))
      .map((run) => run.workStreamId)
  )
}

export type DeliveryEvent = IntegrationOutputFact & { integration: string; connectionId?: string; observedAt?: string }

/** Internal classification: the published kind plus the evidence that produced it. */
type ObservedPullRequest = { repository: string; number: number; state: 'open' | 'merged' | 'closed' }
type GateResult = {
  kind: 'approval' | 'review' | 'merge' | 'external' | 'setup' | 'failure' | 'merged'
  explanation?: WorkStreamDeliveryExplanation & {
    /** This gate's own pull request, with its last observed state. */
    pullRequest?: ObservedPullRequest
  }
}

/**
 * Read only event evidence routed to this stream by the integration runtime. A
 * workflow success is NOT aggregate CI success. Only a current PR snapshot can
 * assert merge readiness; unknown evidence remains an external wait.
 */
function classifyPrimaryDeliveryPresentation(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): GateResult | undefined {
  if (state.status !== 'completion-ready') return undefined
  const mode = state.definition.completion.mode
  if (mode === 'review-approval') return { kind: 'approval' }
  if (!['pr-merge', 'pr-auto-merge', 'direct-merge'].includes(mode)) return undefined
  const git = (metadata as { git?: { commit?: string; branch?: string; baseBranch?: string } } | null)?.git
  if (mode === 'direct-merge') {
    const factsComplete =
      !!codeHostingRegistry.resolve(metadata) &&
      typeof git?.commit === 'string' &&
      /^[a-f0-9]{40}$/.test(git.commit) &&
      typeof git?.baseBranch === 'string' &&
      !!git.baseBranch.trim()
    return factsComplete ? { kind: 'external' } : { kind: 'setup', explanation: { setupReason: 'direct-merge-facts' } }
  }
  if (!awaitsCodeHostDelivery(state, metadata))
    return {
      kind: 'setup',
      explanation: {
        setupReason: codeHostingRegistry.resolve(metadata)?.reference.changeRequest
          ? 'not-following-changes'
          : 'unbound',
      },
    }
  const reference = codeHostingRegistry.resolve(metadata)!.reference
  const time = (event: DeliveryEvent) => Date.parse(event.occurredAt)
  const snapshotTime = (event: DeliveryEvent) => {
    const updated = typeof event.data.snapshotAt === 'string' ? Date.parse(event.data.snapshotAt) : NaN
    return Number.isFinite(updated) ? Math.max(time(event), updated) : time(event)
  }
  const matching = events
    .filter((event) => {
      const pr = event.data.pullRequest as { number?: number } | undefined
      return (
        event.integration === reference.integration &&
        (!reference.connectionId || event.connectionId === reference.connectionId) &&
        event.data.repository === reference.repository.toLowerCase() &&
        pr?.number === reference.changeRequest!.number &&
        Number.isFinite(Date.parse(event.occurredAt))
      )
    })
    .sort((a, b) => snapshotTime(b) - snapshotTime(a))
  const head = (event: IntegrationOutputFact) => (event.data.pullRequest as { headSha?: string } | undefined)?.headSha
  /**
   * Last-observed provider gate facts for the current snapshot, when it carries any. Live check events that
   * are still pending outrank the snapshot's rollup; `snapshotCurrent: false` drops the snapshot's own
   * merge/check/review facts, which a stale observation can no longer vouch for.
   */
  const gateFacts = (eventsPending = false, snapshotCurrent = true): WorkStreamDeliveryGateFacts | undefined => {
    const facts: WorkStreamDeliveryGateFacts = {}
    if (snapshotCurrent && typeof snapshot?.data.mergeState === 'string') facts.mergeState = snapshot.data.mergeState
    if (eventsPending) facts.checksState = 'pending'
    else if (
      snapshotCurrent &&
      typeof snapshot?.data.checksState === 'string' &&
      ['success', 'failure', 'pending', 'unknown'].includes(snapshot.data.checksState)
    )
      facts.checksState = snapshot.data.checksState as WorkStreamDeliveryGateFacts['checksState']
    if (
      snapshotCurrent &&
      typeof snapshot?.data.reviewDecision === 'string' &&
      ['required', 'approved', 'changes_requested', 'unknown'].includes(snapshot.data.reviewDecision)
    )
      facts.reviewDecision = snapshot.data.reviewDecision as WorkStreamDeliveryGateFacts['reviewDecision']
    if (snapshot?.data.draft === true) facts.draft = true
    if (snapshotCurrent && snapshot?.data.pendingHumanReview === true) facts.pendingHumanReview = true
    return Object.keys(facts).length ? facts : undefined
  }
  /** This pull request's last observed lifecycle state, when any event asserts one. */
  const observedState = (): 'open' | 'merged' | 'closed' | undefined => {
    if (lifecycle?.data.pullRequestState === 'merged' || lifecycle?.output === 'pull_request.merged') return 'merged'
    if (lifecycle?.data.pullRequestState === 'closed' || lifecycle?.output === 'pull_request.closed') return 'closed'
    if (lifecycle?.data.pullRequestState === 'open') return 'open'
    if (
      typeof snapshot?.data.pullRequestState === 'string' &&
      ['open', 'merged', 'closed'].includes(snapshot.data.pullRequestState)
    )
      return snapshot.data.pullRequestState as 'open' | 'merged' | 'closed'
    return undefined
  }
  const observedPullRequest = () => {
    const state = observedState()
    return state
      ? { pullRequest: { repository: reference.repository, number: reference.changeRequest!.number, state } }
      : {}
  }
  // Late CI on an old commit cannot change the PR's head. Reviews may also be
  // delivered out of order, hence the provider occurrence timestamp ordering.
  const snapshot = matching.find((event) => event.output !== 'pull_request.ci_completed' && head(event))
  const currentHead = snapshot && head(snapshot)
  if (!currentHead || !/^[a-f0-9]{40}$/.test(currentHead)) {
    return { kind: matching[0]?.data.state === 'failure' ? 'failure' : 'external' }
  }
  if (
    (git?.branch && snapshot?.data.headBranch && git.branch !== snapshot.data.headBranch) ||
    (git?.baseBranch && snapshot?.data.baseBranch && git.baseBranch !== snapshot.data.baseBranch)
  ) {
    const branchMismatch: WorkStreamDeliveryExplanation['branchMismatch'] = {}
    const headBranch = typeof snapshot?.data.headBranch === 'string' ? snapshot.data.headBranch : undefined
    const baseBranch = typeof snapshot?.data.baseBranch === 'string' ? snapshot.data.baseBranch : undefined
    if (git?.branch && headBranch && git.branch !== headBranch) {
      branchMismatch.streamBranch = git.branch
      branchMismatch.pullRequestBranch = headBranch
    }
    if (git?.baseBranch && baseBranch && git.baseBranch !== baseBranch) {
      branchMismatch.streamBaseBranch = git.baseBranch
      branchMismatch.pullRequestBaseBranch = baseBranch
    }
    const gates = gateFacts()
    return {
      kind: 'setup',
      explanation: { setupReason: 'branch-mismatch', branchMismatch, ...(gates ? { gates } : {}) },
    }
  }
  const current = matching.filter((event) => head(event) === currentHead)
  const fresh = (event: DeliveryEvent | undefined) =>
    !!event &&
    (event.observedAt === undefined ||
      (Date.now() - Date.parse(event.observedAt) <= DELIVERY_SNAPSHOT_MAX_AGE_MS &&
        Date.now() - Date.parse(event.observedAt) >= -60_000))
  // Full native snapshots can arrive on reviews/comments as well as updates,
  // or through the asynchronous presentation-only polling cache.
  // Omitted fields are sparse evidence; explicit unknown fields supersede older
  // readiness. Searching past them would resurrect a gate the provider no longer proves.
  const aggregate = current.find((event) => typeof event.data.mergeState === 'string')
  const checkRollup = current.find(
    (event) => typeof event.data.checksState === 'string' || event.data.mergeState === 'clean'
  )
  const proofTime = (predicate: (event: DeliveryEvent) => boolean) => {
    const proof = current.find((event) => event.data.mergeState === 'clean' || predicate(event))
    return proof ? snapshotTime(proof) : -Infinity
  }
  const ciProof = proofTime((event) => ['success', 'pending', 'failure'].includes(String(event.data.checksState)))
  const reviewProof = proofTime((event) =>
    ['approved', 'required', 'changes_requested'].includes(String(event.data.reviewDecision))
  )
  const conflictProof = proofTime(
    (event) => typeof event.data.mergeState === 'string' && event.data.mergeState !== 'unknown'
  )
  const lifecycle = current.find(
    (event) =>
      event.data.pullRequestState ||
      ['pull_request.updated', 'pull_request.merged', 'pull_request.closed'].includes(event.output)
  )
  // A merged pull request's gates no longer describe anything left to wait on.
  if (lifecycle?.data.pullRequestState === 'merged' || lifecycle?.output === 'pull_request.merged')
    return { kind: 'merged', explanation: observedPullRequest() }
  if (lifecycle?.data.pullRequestState === 'closed' || lifecycle?.output === 'pull_request.closed')
    return { kind: 'failure' }
  const latestChecks = new Map<string, DeliveryEvent>()
  for (const event of current.filter(
    (event) => event.output === 'pull_request.ci_completed' && time(event) >= ciProof
  )) {
    const workflow =
      (event.data.ci as { workflowId?: string } | undefined)?.workflowId || event.ordering?.key || event.eventKey
    if (!latestChecks.has(workflow)) latestChecks.set(workflow, event)
  }
  const checks = [...latestChecks.values()]
  const negative =
    current.some(
      (event) =>
        (snapshotTime(event) >= conflictProof &&
          (event.data.mergeConflict === true || event.data.mergeState === 'dirty')) ||
        (snapshotTime(event) >= ciProof && event.data.checksState === 'failure') ||
        (snapshotTime(event) >= reviewProof && event.data.reviewDecision === 'changes_requested') ||
        (time(event) >= reviewProof &&
          event.data.state === 'changes_requested' &&
          (!event.data.reviewedHeadSha || event.data.reviewedHeadSha === currentHead))
    ) ||
    checks.some((event) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(String(event.data.state)))
  // Draft is a non-readiness fact, never permission to hide a real failure.
  if (negative) return { kind: 'failure' }
  if (snapshot?.data.draft === true || lifecycle?.data.pullRequestState === 'unknown') {
    const gates = gateFacts()
    return { kind: 'external', explanation: { ...observedPullRequest(), ...(gates ? { gates } : {}) } }
  }
  const reviewSnapshot = current.find((event) => typeof event.data.reviewDecision === 'string')
  if (fresh(reviewSnapshot) && reviewSnapshot?.data.reviewDecision === 'required')
    return { kind: 'review', explanation: observedPullRequest() }
  if (
    fresh(snapshot) &&
    (snapshot?.data.pendingHumanReview === true ||
      (snapshot?.data.pendingHumanReview === undefined &&
        snapshot?.output === 'pull_request.review_requested' &&
        ((snapshot.data.requestedReviewerType === 'User' &&
          typeof snapshot.data.requestedReviewer === 'string' &&
          snapshot.data.requestedReviewer.length > 0) ||
          (typeof snapshot.data.requestedTeam === 'string' && snapshot.data.requestedTeam.length > 0))))
  )
    return { kind: 'review', explanation: observedPullRequest() }
  const pending =
    checks.some((event) => ['pending', 'queued', 'in_progress', 'requested'].includes(String(event.data.state))) ||
    checkRollup?.data.checksState === 'pending'
  if (
    aggregate?.data.mergeState === 'clean' &&
    fresh(aggregate) &&
    !pending &&
    (mode === 'pr-merge' || policies?.allowAutoMerge === false)
  )
    return { kind: 'merge', explanation: observedPullRequest() }
  const finalGates = gateFacts(pending, fresh(snapshot))
  return { kind: 'external', explanation: { ...observedPullRequest(), ...(finalGates ? { gates: finalGates } : {}) } }
}

/** All designated PRs participate; an unknown extra PR cannot advertise a ready merge. */
export function classifyDeliveryPresentation(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): WorkStreamDeliveryPresentation | undefined {
  const primary = classifyPrimaryDeliveryPresentation(state, metadata, events, policies)
  if (!primary) return undefined
  const aggregate = ['pr-merge', 'pr-auto-merge'].includes(state.definition.completion.mode) && primary.kind !== 'setup'
  const gates = aggregate
    ? [
        primary,
        ...deliveryPullRequests(metadata)
          .filter((resource) => resource.source !== 'delivery')
          .map(
            (resource) =>
              classifyPrimaryDeliveryPresentation(
                state,
                {
                  codeHost: {
                    integration: resource.integration,
                    repository: resource.repository,
                    changeRequest: { number: resource.number },
                    ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
                  },
                },
                events,
                policies
              )!
          ),
      ]
    : [primary]
  const winner =
    (['setup', 'failure', 'review', 'external', 'merge'] as const)
      .map((kind) => gates.find((gate) => gate.kind === kind))
      .find(Boolean) ?? primary
  return explainPresentation(winner.kind === 'merged' ? 'external' : winner.kind, winner, gates, metadata)
}

/**
 * Publish the kind with only the explanation fields its consumers render:
 * setup reasons for `setup`, gate facts and pull requests for `setup`/`external`.
 * Pull request states prefer the classifier's observed evidence over the
 * metadata delivery view, which is open until a merge or close is observed.
 */
function explainPresentation(
  kind: WorkStreamDeliveryPresentation['kind'],
  winner: GateResult,
  gates: GateResult[],
  metadata: unknown
): WorkStreamDeliveryPresentation {
  if (kind !== 'setup' && kind !== 'external') return { kind }
  const explanation: WorkStreamDeliveryExplanation = {}
  if (kind === 'setup') {
    if (winner.explanation?.setupReason) explanation.setupReason = winner.explanation.setupReason
    if (winner.explanation?.branchMismatch) explanation.branchMismatch = winner.explanation.branchMismatch
  }
  if (winner.explanation?.gates) explanation.gates = winner.explanation.gates
  const observed = new Map(
    gates
      .map((gate) => gate.explanation?.pullRequest)
      .filter((pullRequest): pullRequest is ObservedPullRequest => !!pullRequest)
      // Designated PRs can span repositories, so a number alone is not an identity.
      .map((pullRequest) => [`${pullRequest.repository.toLowerCase()}#${pullRequest.number}`, pullRequest.state])
  )
  const pullRequests = deliveryView(metadata).pullRequests.map(({ repository, number, state }) => ({
    number,
    state: observed.get(`${repository.toLowerCase()}#${number}`) ?? state,
  }))
  if (pullRequests.length) explanation.pullRequests = pullRequests
  return Object.keys(explanation).length ? { kind, explanation } : { kind }
}

/** Batched local reads only: serialization never performs provider requests. */
export async function loadDeliveryPresentations(store: DbHandle, ids: string[]) {
  const result = new Map<string, WorkStreamDeliveryPresentation>()
  if (!ids.length) return result
  const runs = await store
    .select({
      id: workStreamFlowRuns.workStreamId,
      state: workStreamFlowRuns.state,
      metadata: workStreams.metadata,
      squadMetadata: squads.metadata,
      squadId: workStreams.squadId,
    })
    .from(workStreamFlowRuns)
    .innerJoin(workStreams, eq(workStreams.id, workStreamFlowRuns.workStreamId))
    .innerJoin(squads, eq(squads.id, workStreams.squadId))
    .where(and(inArray(workStreamFlowRuns.workStreamId, ids), eq(workStreamFlowRuns.activated, true)))
  const candidates = runs.filter((run) => run.state.status === 'completion-ready')
  if (!candidates.length) return result
  const rows = await store
    .select({
      id: integrationOutputDeliveries.workStreamId,
      fact: integrationOutputEvents.fact,
      integration: integrationOutputEvents.integration,
      authority: integrationOutputEvents.authority,
      observedAt: integrationOutputEvents.createdAt,
    })
    .from(integrationOutputDeliveries)
    .innerJoin(integrationOutputEvents, eq(integrationOutputEvents.id, integrationOutputDeliveries.eventId))
    .where(
      inArray(
        integrationOutputDeliveries.workStreamId,
        candidates.map((run) => run.id)
      )
    )
  const byStream = new Map<string, DeliveryEvent[]>()
  for (const row of rows) {
    const facts = byStream.get(row.id) ?? []
    facts.push({
      ...row.fact,
      integration: row.integration,
      observedAt: row.observedAt.toISOString(),
      ...(row.authority.kind === 'connection' ? { connectionId: row.authority.connectionId } : {}),
    })
    byStream.set(row.id, facts)
  }
  const cached = await store
    .select({ cursor: integrationEventPollingCursors.cursor })
    .from(integrationEventPollingCursors)
    .where(
      and(
        eq(integrationEventPollingCursors.providerKey, 'github'),
        inArray(sql`${integrationEventPollingCursors.cursor}->'deliveryPresentation'->>'squadId'`, [
          ...new Set(candidates.map((run) => run.squadId)),
        ])
      )
    )
  const snapshots = cached.flatMap(({ cursor }) => {
    const snapshot = readGitHubDeliverySnapshot(cursor)
    return snapshot ? [snapshot] : []
  })
  for (const run of candidates) {
    const evidence = [
      ...(byStream.get(run.id) ?? []),
      ...snapshots.filter((snapshot) => snapshot.squadId === run.squadId).map(deliverySnapshotEvent),
    ]
    const presentation = classifyDeliveryPresentation(run.state, run.metadata, evidence, {
      allowAutoMerge:
        (run.squadMetadata as { policies?: { allowAutoMerge?: boolean } } | null)?.policies?.allowAutoMerge === true,
    })
    if (presentation) result.set(run.id, presentation)
  }
  return result
}

/** In-memory evidence only: never published as activity or delivered to an agent. */
function deliverySnapshotEvent(snapshot: GitHubDeliverySnapshot): DeliveryEvent {
  return {
    integration: 'github',
    connectionId: snapshot.connectionId,
    observedAt: snapshot.observedAt,
    output: 'pull_request.snapshot',
    version: 1,
    eventKey: '',
    resourceKey: '',
    subject: '',
    body: '',
    occurredAt: snapshot.observedAt,
    data: {
      repository: snapshot.repository,
      pullRequest: { number: snapshot.number, headSha: snapshot.headSha },
      headBranch: snapshot.headBranch,
      baseBranch: snapshot.baseBranch,
      pullRequestState: snapshot.state,
      draft: snapshot.draft,
      mergeState: snapshot.mergeState,
      reviewDecision: snapshot.reviewDecision,
      checksState: snapshot.checksState,
      pendingHumanReview: snapshot.pendingHumanReview,
    },
  }
}
