import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  deliveryPullRequests,
  PULL_REQUEST_MERGE_COMPLETION_MODES,
  workStreamRef,
  type CodeHostReference,
  type WorkflowRun,
} from '@ficus/shared'
import { db, squads, workStreamFlowRuns, workStreams } from '../../db'
import { InboxMessage } from '../../entities/InboxMessage'
import { createLogger } from '../../lib/infra/logger'
import { codeHostingRegistry } from '../integrations/code-hosting'
import { outputRecipients } from '../integrations/outputs/routing-audience'
import { listOpenWaitsForStreams } from '../work-streams/waits'
import {
  classifyDeliveryPresentation,
  deliveryCurrentHead,
  deliveryEventHead,
  deliveryEventTime,
  deliveryEventsForReference,
  loadDeliveryEvidence,
  type DeliveryEvent,
} from './delivery-state'

/**
 * Delivery readiness wake.
 *
 * A completion-ready `pr-auto-merge` delivery participant ends its turn while it
 * waits for an exact-head approval and green CI, because enabling auto-merge
 * early would let GitHub's retained (stale) approvals merge a later head. When
 * code-host evidence then makes the pull request actionable, this module sends
 * the delivery participant ONE fixed-format wake per flow version and head.
 *
 * It is a hint, never an authority: Ficus does not merge, enable auto-merge or
 * finish anything here. The participant re-verifies the live head, approval
 * and checks before it acts, exactly as its delivery instructions require.
 * Because a pull request this wake reports is usually already mergeable, GitHub
 * may refuse to enable auto-merge; the delivery instructions then let the
 * participant itself perform the equivalent head-constrained normal merge.
 *
 * Missed-merge reconciliation shares the same wake. When the authorized code-host
 * poller observes every designated delivery pull request merged, but no merge event
 * reached the flow (the stream was not following changes when the merge happened,
 * or the event was lost), the delivery participant receives ONE wake per flow version
 * telling it to finish, exactly where a merged event would have gone. Ficus still
 * finishes nothing itself: `finish` verifies the merge live with the code host, and
 * a pull request closed without merging is never reported as merged.
 */

const log = createLogger('delivery-readiness')

export const DELIVERY_READINESS_SOURCE = 'delivery-readiness'

/** One designated delivery pull request that is actionable on its current head. */
export interface ReadyDeliveryPullRequest {
  repository: string
  number: number
  url?: string
  headSha: string
  /** The commit the approving review was submitted on: always equal to `headSha`. */
  approvalCommit: string
  approvedBy?: string
  /** The approving reviewer's write-access association (OWNER, MEMBER or COLLABORATOR). */
  approverAssociation?: string
  checksState?: string
  mergeState?: string
}

export type DeliveryNotReadyReason =
  | 'not-completion-ready'
  | 'not-auto-merge'
  | 'not-merge-ready'
  | 'no-head'
  | 'approval-missing'
  | 'approval-stale'
  | 'approval-without-write-access'
  | 'auto-merge-enabled'

export type DeliveryReadiness =
  { ready: true; pullRequests: ReadyDeliveryPullRequest[] } | { ready: false; reason: DeliveryNotReadyReason }

/** The primary delivery change request plus every other designated delivery pull request. */
function designatedReferences(metadata: unknown): CodeHostReference[] {
  const primary = codeHostingRegistry.resolve(metadata)?.reference
  if (!primary?.changeRequest) return []
  return [
    primary,
    ...deliveryPullRequests(metadata)
      .filter((resource) => resource.source !== 'delivery')
      .map((resource) => ({
        integration: resource.integration,
        repository: resource.repository,
        changeRequest: { number: resource.number },
        ...(resource.connectionId ? { connectionId: resource.connectionId } : {}),
      })),
  ]
}

const REVIEW_VERDICTS = ['approved', 'changes_requested', 'dismissed']
/**
 * Associations whose approval GitHub can count toward a protected merge. Anyone can submit an
 * APPROVED review on a public repository, and GitHub keeps stale approvals, so an approval from
 * anyone else must never make a head look actionable. Missing or unknown associations fail closed.
 */
const WRITE_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

/**
 * Each reviewer's latest verdict (approve, request changes, dismissal); comments are not verdicts,
 * and a verdict without a named reviewer can never be superseded, so it is ignored. An approval
 * counts only when its review commit IS the current head and its reviewer has a write-access
 * association. An approval without a recorded commit cannot be proven current and never counts.
 */
function headApproval(
  matching: DeliveryEvent[],
  head: string
):
  | { approved: true; commit: string; by?: string; association: string }
  | { approved: false; reason: 'approval-missing' | 'approval-stale' | 'approval-without-write-access' } {
  const latest = new Map<string, DeliveryEvent>()
  for (const event of matching
    .filter(
      (event) =>
        event.output === 'pull_request.reviewed' &&
        REVIEW_VERDICTS.includes(String(event.data.state)) &&
        typeof event.data.actor === 'string' &&
        event.data.actor !== ''
    )
    .sort((a, b) => deliveryEventTime(b) - deliveryEventTime(a))) {
    const reviewer = String(event.data.actor)
    if (!latest.has(reviewer)) latest.set(reviewer, event)
  }
  const approvals = [...latest.values()].filter((event) => event.data.state === 'approved')
  const writer = (event: DeliveryEvent) => WRITE_ASSOCIATIONS.includes(String(event.data.authorAssociation))
  const current = approvals.find((event) => event.data.reviewedHeadSha === head && writer(event))
  if (current)
    return {
      approved: true,
      commit: head,
      association: String(current.data.authorAssociation),
      // Only a well-formed login (optionally a bot) is quoted; anything else is omitted, never echoed.
      by: GITHUB_LOGIN.test(String(current.data.actor)) ? String(current.data.actor) : undefined,
    }
  // Reasons are diagnostics only; every one of them means "not actionable".
  if (approvals.some((event) => event.data.reviewedHeadSha === head))
    return { approved: false, reason: 'approval-without-write-access' }
  if (approvals.some((event) => typeof event.data.reviewedHeadSha === 'string' && writer(event)))
    return { approved: false, reason: 'approval-stale' }
  return { approved: false, reason: 'approval-missing' }
}

/** Newest current-head evidence carrying a value for `field`. */
function currentFact(current: DeliveryEvent[], field: string): unknown {
  return current.find((event) => event.data[field] !== undefined)?.data[field]
}

/**
 * Whether code-host evidence makes a completion-ready `pr-auto-merge` delivery actionable for its
 * participant: the shared classifier reports every designated pull request merge-ready
 * (`awaiting-merge`: clean, fresh, no pending or failed checks, no requested changes), each open
 * pull request has an approval submitted on its exact current head, and at least one of them does
 * not already show auto-merge enabled on that head. Pure: the caller supplies local evidence.
 */
export function deliveryMergeReadiness(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): DeliveryReadiness {
  if (state.status !== 'completion-ready') return { ready: false, reason: 'not-completion-ready' }
  if (state.definition.completion.mode !== 'pr-auto-merge') return { ready: false, reason: 'not-auto-merge' }
  const presentation = classifyDeliveryPresentation(state, metadata, events, policies)
  if (presentation?.kind !== 'external' || presentation.explanation?.codeHostReason !== 'awaiting-merge')
    return { ready: false, reason: 'not-merge-ready' }
  const pullRequests: ReadyDeliveryPullRequest[] = []
  let autoMergePinned = 0
  for (const reference of designatedReferences(metadata)) {
    const matching = deliveryEventsForReference(reference, events)
    const observed = deliveryCurrentHead(matching)
    if (!observed) return { ready: false, reason: 'no-head' }
    const current = matching.filter((event) => deliveryEventHead(event) === observed.head)
    // A merged extra pull request needs nothing more; the classifier already proved the rest.
    if (current.some((event) => event.output === 'pull_request.merged' || event.data.pullRequestState === 'merged'))
      continue
    const approval = headApproval(matching, observed.head)
    if (!approval.approved) return { ready: false, reason: approval.reason }
    if (currentFact(current, 'autoMerge') === true) autoMergePinned++
    const checksState = currentFact(current, 'checksState')
    const mergeState = currentFact(current, 'mergeState')
    const repository = reference.repository.toLowerCase()
    const number = reference.changeRequest!.number
    pullRequests.push({
      repository,
      number,
      ...(reference.integration === 'github' ? { url: `https://github.com/${repository}/pull/${number}` } : {}),
      headSha: observed.head,
      approvalCommit: approval.commit,
      ...(approval.by ? { approvedBy: approval.by } : {}),
      approverAssociation: approval.association,
      ...(typeof checksState === 'string' ? { checksState } : {}),
      ...(typeof mergeState === 'string' ? { mergeState } : {}),
    })
  }
  if (!pullRequests.length) return { ready: false, reason: 'not-merge-ready' }
  if (autoMergePinned === pullRequests.length) return { ready: false, reason: 'auto-merge-enabled' }
  return { ready: true, pullRequests }
}

/** One designated delivery pull request the code host reports merged. */
export interface MergedDeliveryPullRequest {
  repository: string
  number: number
  url?: string
}

/**
 * The designated delivery pull requests of a completion-ready merge-completed flow, when local
 * evidence shows every one of them merged but at least one merge never arrived as a merged event
 * (it is known only from the poller's snapshot, or from lifecycle facts on other events). Pure:
 * the caller supplies local evidence; the classifier already refuses closed-unmerged requests.
 */
export function deliveryMissedMerge(
  state: WorkflowRun,
  metadata: unknown,
  events: DeliveryEvent[],
  policies?: { allowAutoMerge?: boolean }
): MergedDeliveryPullRequest[] | undefined {
  if (state.status !== 'completion-ready') return undefined
  if (!PULL_REQUEST_MERGE_COMPLETION_MODES.includes(state.definition.completion.mode)) return undefined
  const presentation = classifyDeliveryPresentation(state, metadata, events, policies)
  if (presentation?.kind !== 'external' || presentation.explanation?.codeHostReason !== 'merged') return undefined
  const references = designatedReferences(metadata)
  const delivered = (reference: CodeHostReference) =>
    deliveryEventsForReference(reference, events).some((event) => event.output === 'pull_request.merged')
  if (!references.length || references.every(delivered)) return undefined
  return references.map((reference) => {
    const repository = reference.repository.toLowerCase()
    const number = reference.changeRequest!.number
    return {
      repository,
      number,
      ...(reference.integration === 'github' ? { url: `https://github.com/${repository}/pull/${number}` } : {}),
    }
  })
}

/** One missed-merge wake per flow version and set of pull requests. */
export function deliveryMergedKey(workStreamId: string, version: number, pullRequests: MergedDeliveryPullRequest[]) {
  const merged = pullRequests
    .map((pr) => `${pr.repository}/${pr.number}`)
    .sort()
    .join(',')
  return `delivery-merged:${workStreamId}:${version}:${createHash('sha256').update(merged).digest('hex').slice(0, 24)}`
}

export function deliveryMergedContent(
  stream: { id: string; number?: number | null },
  version: number,
  merged: MergedDeliveryPullRequest[]
) {
  const ref = workStreamRef(stream)
  const plural = merged.length > 1
  return [
    `The code host reports ${plural ? 'every delivery pull request' : 'the delivery pull request'} for work stream ${ref} merged, but no merge event reached this flow, so it is still waiting at completion-ready.`,
    ...merged.map((pr) => `- Pull request: ${pr.repository} PR ${pr.number}${pr.url ? ` (${pr.url})` : ''}: merged`),
    `Ficus has not finished the stream. Finish delivery now: \`ficus workstream finish ${ref} --version ${version}\` (read the current version with \`ficus workstream flow ${ref}\` if it changed). Finish verifies the merge live with the code host and refuses if it does not hold. This notice is sent once per flow version.`,
  ].join('\n')
}

/** One wake per flow version and set of heads: repeated events for the same state are no-ops. */
export function deliveryReadinessKey(workStreamId: string, version: number, pullRequests: ReadyDeliveryPullRequest[]) {
  const heads = pullRequests
    .map((pr) => `${pr.repository}/${pr.number}@${pr.headSha}`)
    .sort()
    .join(',')
  return `delivery-ready:${workStreamId}:${version}:${createHash('sha256').update(heads).digest('hex').slice(0, 24)}`
}

export function deliveryReadinessContent(
  stream: { id: string; number?: number | null },
  ready: ReadyDeliveryPullRequest[]
) {
  const ref = workStreamRef(stream)
  const lines = ready.flatMap((pr) => [
    `- Pull request: ${pr.repository} PR ${pr.number}${pr.url ? ` (${pr.url})` : ''}`,
    `  Head: ${pr.headSha}`,
    `  Approval commit: ${pr.approvalCommit} (approved by ${pr.approvedBy ? `@${pr.approvedBy}, ` : ''}a reviewer with write access${pr.approverAssociation ? `: ${pr.approverAssociation}` : ''})`,
    `  Checks: ${pr.checksState ?? 'no pending or failed check observed'}; mergeability: ${pr.mergeState ?? 'unknown'}`,
  ])
  return [
    `The delivery pull request for work stream ${ref} looks actionable: the code host reports it merge-ready, a reviewer with write access approved the current head, and auto-merge is not enabled on that head.`,
    ...lines,
    `Ficus has not merged or enabled anything. Before acting, re-verify live that the head is unchanged, that the effective required approval is on that exact head, and that all applicable checks passed (skipped checks are not passes), then follow the delivery instructions from \`ficus workstream flow ${ref}\`. If GitHub refuses to enable native auto-merge because the pull request is already mergeable, those instructions let you perform a normal merge constrained to that head, with the merge method auto-merge would have used, as its equivalent; never use administrator powers or bypass reviews, checks or branch protections. This notice is sent once per head.`,
  ].join('\n')
}

/** The agent merged/closed events reach: the delivery participant of this flow version. */
function deliveryParticipant(
  run: typeof workStreamFlowRuns.$inferSelect,
  stream: typeof workStreams.$inferSelect,
  managerId: string | null
): string | undefined {
  const subscription = codeHostingRegistry
    .subscriptions(run.state.definition, stream.metadata)
    .find((item) => codeHostingRegistry.isDeliveryEvent(item))
  if (!subscription) return undefined
  // `retain` subscriptions never fall back to the manager; the target is version-bound.
  const target = outputRecipients(run, stream, subscription, managerId).find(
    (recipient) => recipient.version === run.version
  )
  return target?.agentId
}

async function loadFlowState(workStreamId: string) {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, workStreamId))
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, workStreamId))
  if (!stream || !run) return undefined
  const [squad] = await db
    .select({ managerId: squads.managerAgentId })
    .from(squads)
    .where(eq(squads.id, stream.squadId))
  return { stream, run, managerId: squad?.managerId ?? null }
}

/**
 * A stream that could act now: admitted, unpaused, completion-ready, no open wait of any kind.
 * A missed merge must reach someone, so without a delivery participant it falls back to the
 * squad manager; a readiness hint does not.
 */
async function mayWake(
  flow: NonNullable<Awaited<ReturnType<typeof loadFlowState>>>,
  version: number,
  fallbackToManager = false
): Promise<string | undefined> {
  const { stream, run, managerId } = flow
  if (stream.status !== 'active' || stream.pause || !run.activated) return undefined
  if (run.state.status !== 'completion-ready' || run.version !== version) return undefined
  if ((await listOpenWaitsForStreams([stream.id])).get(stream.id)?.length) return undefined
  return deliveryParticipant(run, stream, managerId) ?? (fallbackToManager ? (managerId ?? undefined) : undefined)
}

type Evidence = Awaited<ReturnType<typeof loadDeliveryEvidence>>[number] | undefined

/** Current readiness of one stream from local evidence only, bound to the flow version it was read at. */
function currentReadiness(evidence: Evidence) {
  if (!evidence) return undefined
  const readiness = deliveryMergeReadiness(evidence.state, evidence.metadata, evidence.events, evidence.policies)
  return readiness.ready ? { version: evidence.version, pullRequests: readiness.pullRequests } : undefined
}

/** A merge the flow never received, from local evidence only, bound to the flow version it was read at. */
function currentMissedMerge(evidence: Evidence) {
  if (!evidence) return undefined
  const merged = deliveryMissedMerge(evidence.state, evidence.metadata, evidence.events, evidence.policies)
  return merged ? { version: evidence.version, pullRequests: merged } : undefined
}

const loadEvidence = async (workStreamId: string): Promise<Evidence> =>
  (await loadDeliveryEvidence(db, [workStreamId]))[0]

/** Wake the delivery participant (or the manager) once per flow version to finish a missed merge. */
async function wakeForMissedMerge(
  workStreamId: string,
  evidence: Evidence
): Promise<'woken' | 'duplicate' | 'not-ready' | 'not-eligible'> {
  const merged = currentMissedMerge(evidence)
  if (!merged) return 'not-ready'
  const flow = await loadFlowState(workStreamId)
  const recipientId = flow && (await mayWake(flow, merged.version, true))
  if (!flow || !recipientId) return 'not-eligible'
  const { created } = await InboxMessage.sendOnce(
    {
      recipientId,
      senderType: 'system',
      subject: `Delivery pull request merged: ${merged.pullRequests.map((pr) => `${pr.repository} PR ${pr.number}`).join(', ')}`,
      content: deliveryMergedContent(flow.stream, merged.version, merged.pullRequests),
      metadata: {
        source: DELIVERY_READINESS_SOURCE,
        reason: 'merged',
        workStreamId,
        flowVersion: merged.version,
        pullRequests: merged.pullRequests.map(({ repository, number }) => ({ repository, number })),
      },
      wakeEligible: true,
    },
    deliveryMergedKey(workStreamId, merged.version, merged.pullRequests)
  )
  return created ? 'woken' : 'duplicate'
}

/**
 * Evaluate local delivery evidence after new code-host evidence was recorded for a stream, and
 * wake its delivery participant when the pull request just became actionable, or when it merged
 * without the flow receiving the merge event. Idempotent and best-effort: failures are logged,
 * and the next event or poll re-evaluates the same deduplicated wake.
 */
export async function wakeDeliveryParticipantIfReady(
  workStreamId: string
): Promise<'woken' | 'duplicate' | 'not-ready' | 'not-eligible' | 'failed'> {
  try {
    const evidence = await loadEvidence(workStreamId)
    const readiness = currentReadiness(evidence)
    if (!readiness) return await wakeForMissedMerge(workStreamId, evidence)
    const flow = await loadFlowState(workStreamId)
    const recipientId = flow && (await mayWake(flow, readiness.version))
    if (!flow || !recipientId) return 'not-eligible'
    const { created } = await InboxMessage.sendOnce(
      {
        recipientId,
        senderType: 'system',
        subject: `Delivery pull request ready: ${readiness.pullRequests.map((pr) => `${pr.repository} PR ${pr.number}`).join(', ')}`,
        content: deliveryReadinessContent(flow.stream, readiness.pullRequests),
        metadata: {
          source: DELIVERY_READINESS_SOURCE,
          workStreamId,
          flowVersion: readiness.version,
          pullRequests: readiness.pullRequests.map(({ repository, number, headSha }) => ({
            repository,
            number,
            headSha,
          })),
        },
        wakeEligible: true,
      },
      deliveryReadinessKey(workStreamId, readiness.version, readiness.pullRequests)
    )
    return created ? 'woken' : 'duplicate'
  } catch (error) {
    log.warn('Delivery readiness evaluation failed', { workStreamId, error })
    return 'failed'
  }
}

/** Rechecked when the inbox delivers the wake: still the same flow version, recipient and an actionable state. */
export async function isCurrentDeliveryReadinessMessage(message: {
  metadata: unknown
  recipientId: string | null
}): Promise<boolean> {
  const metadata = message.metadata as { workStreamId?: unknown; flowVersion?: unknown; reason?: unknown } | null
  if (typeof metadata?.workStreamId !== 'string' || typeof metadata.flowVersion !== 'number' || !message.recipientId)
    return false
  try {
    const flow = await loadFlowState(metadata.workStreamId)
    if (metadata.reason === 'merged') {
      // Superseded once the flow moved on (finished, reworked) or the merge evidence changed.
      if (!flow || (await mayWake(flow, metadata.flowVersion, true)) !== message.recipientId) return false
      const merged = currentMissedMerge(await loadEvidence(metadata.workStreamId))
      return (
        !!merged &&
        merged.version === metadata.flowVersion &&
        deliveryMergedKey(metadata.workStreamId, merged.version, merged.pullRequests) ===
          deliveryMergedKey(metadata.workStreamId, metadata.flowVersion, mergedPullRequests(message.metadata))
      )
    }
    if (!flow || (await mayWake(flow, metadata.flowVersion)) !== message.recipientId) return false
    // A newer head (or lost readiness) supersedes the queued notice; its own wake, if any, follows.
    const readiness = currentReadiness(await loadEvidence(metadata.workStreamId))
    return (
      !!readiness &&
      readiness.version === metadata.flowVersion &&
      deliveryReadinessKey(metadata.workStreamId, readiness.version, readiness.pullRequests) ===
        deliveryReadinessKey(metadata.workStreamId, metadata.flowVersion, readyHeads(message.metadata))
    )
  } catch {
    return false
  }
}

/** The pull requests a stored missed-merge wake was sent for. */
function mergedPullRequests(metadata: unknown): MergedDeliveryPullRequest[] {
  const stored = (metadata as { pullRequests?: unknown } | null)?.pullRequests
  if (!Array.isArray(stored)) return []
  return stored.flatMap((pr) =>
    pr && typeof pr.repository === 'string' && typeof pr.number === 'number'
      ? [{ repository: pr.repository, number: pr.number }]
      : []
  )
}

/** The pull request heads a stored wake was sent for. */
function readyHeads(metadata: unknown): ReadyDeliveryPullRequest[] {
  const stored = (metadata as { pullRequests?: unknown } | null)?.pullRequests
  if (!Array.isArray(stored)) return []
  return stored.flatMap((pr) =>
    pr && typeof pr.repository === 'string' && typeof pr.number === 'number' && typeof pr.headSha === 'string'
      ? [{ repository: pr.repository, number: pr.number, headSha: pr.headSha, approvalCommit: pr.headSha }]
      : []
  )
}
