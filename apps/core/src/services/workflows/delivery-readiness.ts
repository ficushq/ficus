import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { deliveryPullRequests, workStreamRef, type CodeHostReference, type WorkflowRun } from '@ficus/shared'
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
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/

/**
 * Each reviewer's latest verdict (approve, request changes, dismissal); comments are not verdicts.
 * An approval counts only when its review commit IS the current head. An approval without a
 * recorded commit cannot be proven current and never counts.
 */
function headApproval(matching: DeliveryEvent[], head: string) {
  const latest = new Map<string, DeliveryEvent>()
  for (const event of matching
    .filter((event) => event.output === 'pull_request.reviewed' && REVIEW_VERDICTS.includes(String(event.data.state)))
    .sort((a, b) => deliveryEventTime(b) - deliveryEventTime(a))) {
    const reviewer = typeof event.data.actor === 'string' && event.data.actor ? event.data.actor : event.eventKey
    if (!latest.has(reviewer)) latest.set(reviewer, event)
  }
  const approvals = [...latest.values()].filter((event) => event.data.state === 'approved')
  const current = approvals.find((event) => event.data.reviewedHeadSha === head)
  return current
    ? {
        approved: true as const,
        commit: head,
        // Only a well-formed login (optionally a bot) is quoted; anything else is omitted, never echoed.
        by: GITHUB_LOGIN.test(String(current.data.actor ?? '')) ? String(current.data.actor) : undefined,
      }
    : {
        approved: false as const,
        // Stale: approved, but provably on another commit. An unrecorded commit proves nothing.
        stale: approvals.some((event) => typeof event.data.reviewedHeadSha === 'string'),
      }
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
    if (!approval.approved) return { ready: false, reason: approval.stale ? 'approval-stale' : 'approval-missing' }
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
      ...(typeof checksState === 'string' ? { checksState } : {}),
      ...(typeof mergeState === 'string' ? { mergeState } : {}),
    })
  }
  if (!pullRequests.length) return { ready: false, reason: 'not-merge-ready' }
  if (autoMergePinned === pullRequests.length) return { ready: false, reason: 'auto-merge-enabled' }
  return { ready: true, pullRequests }
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
    `  Approval commit: ${pr.approvalCommit}${pr.approvedBy ? ` (approved by @${pr.approvedBy})` : ''}`,
    `  Checks: ${pr.checksState ?? 'no pending or failed check observed'}; mergeability: ${pr.mergeState ?? 'unknown'}`,
  ])
  return [
    `The delivery pull request for work stream ${ref} looks actionable: the code host reports it merge-ready, an approval was submitted on the current head, and auto-merge is not enabled on that head.`,
    ...lines,
    `Ficus has not merged or enabled anything. Before acting, re-verify live that the head is unchanged, that the effective required approval is on that exact head, and that all applicable checks passed, then follow the delivery instructions from \`ficus workstream flow ${ref}\`. This notice is sent once per head.`,
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

/** A stream that could act now: admitted, unpaused, completion-ready, no open wait of any kind. */
async function mayWake(
  flow: NonNullable<Awaited<ReturnType<typeof loadFlowState>>>,
  version: number
): Promise<string | undefined> {
  const { stream, run, managerId } = flow
  if (stream.status !== 'active' || stream.pause || !run.activated) return undefined
  if (run.state.status !== 'completion-ready' || run.version !== version) return undefined
  if ((await listOpenWaitsForStreams([stream.id])).get(stream.id)?.length) return undefined
  return deliveryParticipant(run, stream, managerId)
}

/** Current readiness of one stream from local evidence only, bound to the flow version it was read at. */
async function currentReadiness(workStreamId: string) {
  const [evidence] = await loadDeliveryEvidence(db, [workStreamId])
  if (!evidence) return undefined
  const readiness = deliveryMergeReadiness(evidence.state, evidence.metadata, evidence.events, evidence.policies)
  return readiness.ready ? { version: evidence.version, pullRequests: readiness.pullRequests } : undefined
}

/**
 * Evaluate local delivery evidence after new code-host evidence was recorded for a stream, and
 * wake its delivery participant when the pull request just became actionable. Idempotent and
 * best-effort: failures are logged, and the next event re-evaluates the same deduplicated wake.
 */
export async function wakeDeliveryParticipantIfReady(
  workStreamId: string
): Promise<'woken' | 'duplicate' | 'not-ready' | 'not-eligible' | 'failed'> {
  try {
    const readiness = await currentReadiness(workStreamId)
    if (!readiness) return 'not-ready'
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
  const metadata = message.metadata as { workStreamId?: unknown; flowVersion?: unknown } | null
  if (typeof metadata?.workStreamId !== 'string' || typeof metadata.flowVersion !== 'number' || !message.recipientId)
    return false
  try {
    const flow = await loadFlowState(metadata.workStreamId)
    if (!flow || (await mayWake(flow, metadata.flowVersion)) !== message.recipientId) return false
    // A newer head (or lost readiness) supersedes the queued notice; its own wake, if any, follows.
    const readiness = await currentReadiness(metadata.workStreamId)
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
