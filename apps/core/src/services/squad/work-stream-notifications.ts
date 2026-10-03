import {
  parseInboxPushPresentation,
  workStreamRef,
  workStreamTitle,
  workStreamWaitActor,
  type AttentionKind,
  type InboxPushPresentation,
  type WorkStreamWaitActor,
} from '@ficus/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, inbox, squads, workStreamWaits } from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { InboxMessage, type SendInboxMessageInput } from '../../entities/InboxMessage'
import { Squad } from '../../entities/Squad'
import { User } from '../../entities/User'
import type { WorkStream } from '../../entities/WorkStream'
import { listWorkStreamNotifyUserIds } from '../attention/resolver'
import { filterUserIdsWithPermission } from '../rbac/permitted-users'
import { listEnabledUserIds } from '../users/enabled'
import { createLogger } from '../../lib/infra/logger'
import { createHash } from 'node:crypto'

const log = createLogger('work-stream-notifications')

type ExactActionTarget = { waitId: string; actionId: string }

type BeforePersistHook = () => Promise<void> | void
let beforePersistHook: BeforePersistHook | undefined

export function setWorkStreamNotificationBeforePersistHookForTests(hook?: BeforePersistHook): void {
  beforePersistHook = hook
}

export type WorkStreamInboxEvent =
  | 'assigned'
  | 'blocked'
  | 'idle'
  | 'review'
  | 'done'
  | 'canceled'
  | 'reopened'
  | 'unblocked'
  | 'reviewed'
  | 'created'
  | 'dependency_canceled'

export async function findExistingWorkStreamInbox(opts: {
  recipientId: string
  subject: string
  workStreamId: string
  squadId?: string
  event: WorkStreamInboxEvent
  transitionAt: string
  waitId?: string
  actionId?: string
}): Promise<boolean> {
  const conditions = [
    eq(inbox.recipientId, opts.recipientId),
    eq(inbox.subject, opts.subject),
    sql`${inbox.metadata}->>'workStreamId' = ${opts.workStreamId}`,
    sql`${inbox.metadata}->>'event' = ${opts.event}`,
    sql`${inbox.metadata}->>'transitionAt' = ${opts.transitionAt}`,
  ]
  if (opts.squadId) conditions.push(sql`${inbox.metadata}->>'squadId' = ${opts.squadId}`)
  if (opts.waitId) conditions.push(sql`${inbox.metadata}->>'waitId' = ${opts.waitId}`)
  if (opts.actionId) conditions.push(sql`${inbox.metadata}->>'actionId' = ${opts.actionId}`)

  const rows = await db
    .select({ id: inbox.id })
    .from(inbox)
    .where(and(...conditions))
    .limit(1)
  return rows.length > 0
}

async function sendDeduped(input: SendInboxMessageInput & { metadata: Record<string, unknown> }): Promise<void> {
  const subject = input.subject ?? null
  const event = input.metadata.event as WorkStreamInboxEvent | undefined
  const workStreamId = input.metadata.workStreamId as string | undefined
  const transitionAt = input.metadata.transitionAt as string | undefined
  if (subject && event && workStreamId && transitionAt) {
    const exists = await findExistingWorkStreamInbox({
      recipientId: input.recipientId,
      subject,
      workStreamId,
      squadId: input.metadata.squadId as string | undefined,
      event,
      transitionAt,
      waitId: input.metadata.waitId as string | undefined,
      actionId: input.metadata.actionId as string | undefined,
    })
    if (exists) return

    await beforePersistHook?.()
    const idempotencyKey = `work-stream:${createHash('sha256')
      .update(
        JSON.stringify({
          v: 1,
          recipientId: input.recipientId,
          subject,
          workStreamId,
          squadId: (input.metadata.squadId as string | undefined) ?? null,
          event,
          transitionAt,
          waitId: (input.metadata.waitId as string | undefined) ?? null,
          actionId: (input.metadata.actionId as string | undefined) ?? null,
        })
      )
      .digest('hex')}`
    await InboxMessage.sendOnce(input, idempotencyKey)
    return
  }
  await InboxMessage.send(input)
}

function transitionAt(workStream: WorkStream): string {
  return workStream.updatedAt.toISOString()
}

export async function resolveWorkStreamRecipient(workStream: WorkStream): Promise<Agent | null> {
  if (workStream.ownerAgentId) {
    const owner = await Agent.find(workStream.ownerAgentId)
    if (owner) return owner
  }
  const squad = await Squad.find(workStream.squadId)
  return squad ? squad.getManagerAgent() : null
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

type PersistentIdleStream = { number?: number } & Pick<
  WorkStream,
  'id' | 'title' | 'squadId' | 'assigneeAgentId' | 'ownerAgentId'
>

export async function persistWorkStreamPersistentIdleInTransaction(
  tx: DbTransaction,
  workStream: PersistentIdleStream,
  input: { generation: number; normalExecutionId: string; endedAt: Date },
  afterCommit: Array<() => void>
): Promise<boolean> {
  const [squad] = await tx
    .select({ managerAgentId: squads.managerAgentId })
    .from(squads)
    .where(eq(squads.id, workStream.squadId))
    .limit(1)
  const preferredRecipientIds = [workStream.ownerAgentId, squad?.managerAgentId].filter(
    (id, index, ids): id is string => Boolean(id) && ids.indexOf(id) === index
  )
  if (preferredRecipientIds.length === 0) return false
  const recipients = await tx
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(inArray(agents.id, preferredRecipientIds))
  const recipient = preferredRecipientIds
    .map((id) => recipients.find((candidate) => candidate.id === id))
    .find((candidate) => candidate && candidate.status !== 'terminated')
  if (!recipient) return false

  await InboxMessage.persistSystemAgentOnceInTransaction(
    tx,
    {
      recipientId: recipient.id,
      subject: `Work stream still idle: ${workStreamTitle(workStream)}`,
      content: `Work stream "${workStreamTitle(workStream)}" remains active and idle 60 seconds after its one automatic continuation. No wait was opened; no action is required if the agent is intentionally waiting for an event.`,
      metadata: {
        workStreamNumber: workStream.number,
        workStreamId: workStream.id,
        squadId: workStream.squadId,
        event: 'idle',
        generation: input.generation,
        normalExecutionId: input.normalExecutionId,
        normalExecutionEndedAt: input.endedAt.toISOString(),
        source: 'work-stream-continuation',
        assigneeAgentId: workStream.assigneeAgentId,
        ownerAgentId: workStream.ownerAgentId,
      },
      wakeEligible: false,
      recordOnly: true,
    },
    `work-stream-continuation-idle:v1:${workStream.id}:${input.generation}`,
    afterCommit
  )
  return true
}

export async function notifyWorkStreamPersistentIdle(
  workStream: WorkStream,
  input: { generation: number; normalExecutionId: string; endedAt: Date }
): Promise<boolean> {
  const afterCommit: Array<() => void> = []
  const persisted = await db.transaction((tx) =>
    persistWorkStreamPersistentIdleInTransaction(tx, workStream, input, afterCommit)
  )
  afterCommit.forEach((callback) => callback())
  return persisted
}

// State the work stream OWNER (the agent to hand back to / report progress to) — resolved from
// ownerAgentId, falling back to the squad manager. Surfaced on handoff so an assignee knows who
// owns the stream rather than assuming "the squad manager".
export async function formatWorkStreamOwner(workStream: WorkStream, recipientAgentId: string): Promise<string | null> {
  const owner = await resolveWorkStreamRecipient(workStream)
  if (!owner || owner.id === recipientAgentId) return null
  const agentType = await owner.getAgentType()
  const typeName = agentType?.name ?? owner.agentTypeId
  const displayName = owner.metadata?.name ?? 'Unnamed agent'
  return `Work stream owner (hand back to / report progress to): ${typeName}: ${displayName} [${owner.id}]`
}

/** Human-readable attribution of the user who requested this work stream (name + short id), if any. */
export async function formatRequestingUser(workStream: WorkStream): Promise<string | null> {
  if (!workStream.requestingUserId) return null
  const user = await User.findById(workStream.requestingUserId).catch(() => null)
  const name = user?.displayName || user?.email || 'a user'
  return `Requested by: ${name} [${workStream.requestingUserId.slice(0, 8)}]`
}

export async function formatOtherWorkStreamAgents(
  workStream: WorkStream,
  recipientAgentId: string
): Promise<string | null> {
  const otherAgentIds = (workStream.agentIds ?? []).filter((agentId) => agentId !== recipientAgentId)
  if (otherAgentIds.length === 0) return null

  const lines: string[] = []
  for (const agentId of otherAgentIds) {
    const agent = await Agent.find(agentId)
    if (!agent) continue
    const agentType = await agent.getAgentType()
    const typeName = agentType?.name ?? agent.agentTypeId
    const displayName = agent.metadata?.name ?? 'Unnamed agent'
    lines.push(`- ${typeName}: ${displayName} [${agent.id}]`)
  }

  return lines.length ? ['Other agents assigned to this work stream:', ...lines].join('\n') : null
}

function getWorkStreamNextSteps(workStream: WorkStream): string | undefined {
  const value = workStream.metadata?.nextSteps
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

// Human-facing lifecycle events. `blocked` is here because a human-actor manual wait is a DECISION
// waiting on a person — the same class of interruption as a review — and a stream can sit blocked
// for hours while everyone assumes an agent is working. Owner-actor manual waits
// never reach human watchers (see notifyWorkStreamBlocked).
const HUMAN_SUBSCRIBER_EVENTS: ReadonlySet<WorkStreamInboxEvent> = new Set(['review', 'blocked', 'done'])

/** Which attention kind decides who hears about an event. */
const EVENT_ATTENTION_KIND: Record<'review' | 'blocked' | 'done', AttentionKind> = {
  review: 'decisions',
  blocked: 'decisions',
  done: 'progress',
}

const TERMINAL_REQUESTER_CONTEXT_EVENTS: ReadonlySet<WorkStreamInboxEvent> = new Set(['done', 'canceled'])

// Notify human watchers only about decisions and completions. Each persisted user inbox message
// flows through the per-user push pipeline (respecting their notification preferences).
/**
 * The agent whose action produced a lifecycle event, when one is known.
 *
 * An agent is never told about its own action. The notice is a system inbox
 * message — often a STEER, which interrupts the recipient mid-turn — carrying
 * news that agent already has, so a manager cancelling five streams interrupted
 * itself five times for nothing.
 *
 * `undefined`/`null` means a user, the system, or an unknown caller triggered
 * it, and everyone is notified. That is the pre-existing behavior, so any path
 * that has not been taught to pass an actor keeps working exactly as before —
 * the failure mode of forgetting one is a redundant message, never a missing one.
 *
 * This generalizes the rule notifyWorkStreamOwnerOfNewStream already applied at
 * creation (skip when creatorAgentId === ownerAgentId, so a manager opening its
 * own stream is not announced to itself) to every lifecycle transition.
 */
export type WorkStreamActorAgentId = string | null | undefined

/** True when the recipient IS the actor — they already know, so say nothing. */
function isSelfNotification(recipientAgentId: string, actorAgentId: WorkStreamActorAgentId): boolean {
  return Boolean(actorAgentId) && actorAgentId === recipientAgentId
}

const PUSH_COPY: Record<
  'review' | 'blocked' | 'done',
  { label: string; fallbackBody: string; interruptionLevel: InboxPushPresentation['interruptionLevel'] }
> = {
  review: { label: 'Ready for review', fallbackBody: 'Awaiting your review.', interruptionLevel: 'active' },
  blocked: { label: 'Blocked', fallbackBody: 'Needs your input to continue.', interruptionLevel: 'active' },
  done: { label: 'Completed', fallbackBody: 'Completed without notes.', interruptionLevel: 'passive' },
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/**
 * The phone-facing form of a watcher notice. The inbox subject/content are written for the
 * owning agent and read as "Work stream "#N · title" has been completed." twice over on a
 * lock screen; this carries the state once, the detail a human acts on, and the metadata iOS
 * uses to group per squad (threadKey) and replace an earlier "ready for review" with
 * "completed" (collapseKey). The squad name is deliberately not shown: the group already
 * carries it, and a third text line makes the card cramped.
 */
function buildWatcherPush(
  workStream: WorkStream,
  event: 'review' | 'blocked' | 'done',
  detail: string | undefined
): InboxPushPresentation | undefined {
  const copy = PUSH_COPY[event]
  const title = `${copy.label}: ${workStreamTitle(workStream)}`
  const body = detail?.trim() || copy.fallbackBody
  return parseInboxPushPresentation({
    title: clip(title, 120),
    body: clip(body, 300),
    ...(title.length > 120 || body.length > 300 ? { source: { title, body } } : {}),
    collapseKey: `ws:${workStream.id}`,
    threadKey: `squad:${workStream.squadId}`,
    interruptionLevel: copy.interruptionLevel,
  })
}

async function notifyWorkStreamSubscribers(
  workStream: WorkStream,
  event: WorkStreamInboxEvent,
  message: string,
  target?: ExactActionTarget,
  pushDetail?: string
): Promise<void> {
  if (!HUMAN_SUBSCRIBER_EVENTS.has(event)) return

  try {
    const nextSteps = event === 'done' ? getWorkStreamNextSteps(workStream) : undefined
    const kind = EVENT_ATTENTION_KIND[event as 'review' | 'blocked' | 'done']
    // One bounded query per event: the stream's rows ∪ its squad's rows, precedence resolved per
    // candidate. Users with no row anywhere default to `show`, which never notifies.
    const notifyIds = await listWorkStreamNotifyUserIds(workStream.id, workStream.squadId, kind)
    if (notifyIds.length === 0) return
    // A notify row outlives the account: a disabled user cannot read the inbox it would land in.
    const candidateIds = await listEnabledUserIds(notifyIds)
    if (candidateIds.length === 0) return
    // Permission first, attention second: a notify row is a preference, never an entitlement. A
    // subscription that outlived the user's role on the squad must not deliver stream content.
    // Failure isolation and the fail-closed rule live in the shared helper.
    const subscriberIds = await filterUserIdsWithPermission(
      candidateIds,
      'workstreams:read',
      workStream.squadId,
      ({ failed, total, reason }) =>
        log.error(
          `Failed to resolve ${failed} of ${total} watcher permission checks for work stream ${workStream.id} (${event}); treating them as not permitted:`,
          reason
        )
    )
    if (subscriberIds.length === 0) return
    const description = workStream.description?.trim() ? workStream.description : undefined
    const detail = event === 'done' ? pushDetail || nextSteps || description : workStream.handoffMessage || description
    const push = buildWatcherPush(workStream, event as 'review' | 'blocked' | 'done', detail ?? undefined)
    for (const userId of subscriberIds) {
      // Per recipient, not per batch: a send that throws (a unique-key race, a transient write
      // failure) used to abandon every watcher after it in the list, silently and by list order.
      try {
        await sendDeduped({
          recipientType: 'user',
          recipientId: userId,
          senderType: 'system',
          wakeEligible: false,
          subject: `Work Stream ${event}: ${workStreamTitle(workStream)}`,
          content: message,
          metadata: {
            workStreamNumber: workStream.number,
            workStreamId: workStream.id,
            squadId: workStream.squadId,
            event,
            transitionAt: transitionAt(workStream),
            ...(target ?? {}),
            ...(nextSteps ? { nextSteps } : {}),
            ...(push ? { push } : {}),
          },
        })
      } catch (error) {
        log.error(`Failed to notify work stream subscriber ${userId} of ${event}:`, error)
      }
    }
  } catch (error) {
    log.error(`Failed to notify work stream subscribers of ${event}:`, error)
  }
}

async function notifyWorkStreamOwner(
  workStream: WorkStream,
  event: WorkStreamInboxEvent,
  message: string,
  target?: ExactActionTarget,
  actorAgentId?: WorkStreamActorAgentId,
  /** Human-facing detail for the push body (for example a reviewer's approval note). */
  pushDetail?: string
): Promise<void> {
  // Eligible human watchers are notified regardless of whether an agent owner
  // exists — and regardless of the actor. A human watching a stream still wants
  // to see that the manager cancelled it; only the ACTING AGENT's own copy is
  // redundant, so the self-notification guard sits in the owner-agent notice.
  await notifyWorkStreamSubscribers(workStream, event, message, target, pushDetail)
  await notifyWorkStreamOwnerAgent(workStream, event, message, target, actorAgentId)
}

/** The owning agent's (owner, else squad manager) copy of a lifecycle event. It wakes the agent. */
async function notifyWorkStreamOwnerAgent(
  workStream: WorkStream,
  event: WorkStreamInboxEvent,
  message: string,
  target?: ExactActionTarget,
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  try {
    const nextSteps = event === 'done' ? getWorkStreamNextSteps(workStream) : undefined
    const recipient = await resolveWorkStreamRecipient(workStream)
    if (!recipient) return
    if (isSelfNotification(recipient.id, actorAgentId)) return
    const subject = `Work Stream ${event}: ${workStreamTitle(workStream)}`
    const requesterContext = TERMINAL_REQUESTER_CONTEXT_EVENTS.has(event)
      ? await formatRequestingUser(workStream)
      : null
    const agentMessage = requesterContext ? `${message}\n\n${requesterContext}` : message
    await sendDeduped({
      recipientType: 'agent',
      recipientId: recipient.id,
      senderType: 'system',
      wakeEligible: true,
      subject,
      content: agentMessage,
      metadata: {
        workStreamNumber: workStream.number,
        workStreamId: workStream.id,
        squadId: workStream.squadId,
        event,
        transitionAt: transitionAt(workStream),
        assigneeAgentId: workStream.assigneeAgentId,
        ownerAgentId: workStream.ownerAgentId,
        ...(target ?? {}),
        ...(nextSteps ? { nextSteps } : {}),
      },
    })
  } catch (error) {
    log.error(`Failed to notify work stream owner of ${event}:`, error)
  }
}

export async function notifyWorkStreamAssigned(
  workStreamOrInput: WorkStream | { workStreamId: string; squadId: string; agentId: string },
  agentId?: string,
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  try {
    const workStream =
      'workStreamId' in workStreamOrInput
        ? await import('../../entities/WorkStream').then(({ WorkStream }) =>
            WorkStream.find(workStreamOrInput.workStreamId)
          )
        : workStreamOrInput
    const targetAgentId = agentId ?? ('agentId' in workStreamOrInput ? workStreamOrInput.agentId : undefined)
    if (!workStream || !targetAgentId) return

    const assignee = await Agent.find(targetAgentId)
    if (!assignee) return
    // An agent that assigned the stream to itself already knows it owns the work.
    if (isSelfNotification(assignee.id, actorAgentId)) return
    const squad = await Squad.find(workStream.squadId)
    if (squad?.managerAgentId === assignee.id) return
    const ownerContext = await formatWorkStreamOwner(workStream, assignee.id)
    const otherAgentsContext = await formatOtherWorkStreamAgents(workStream, assignee.id)
    const parts = [
      ...(ownerContext ? [ownerContext] : []),
      ...(workStream.handoffMessage ? [`Handoff message: ${workStream.handoffMessage}`] : []),
      ...(otherAgentsContext ? [otherAgentsContext] : []),
      `Query the work stream with \`ficus workstream get ${workStreamRef(workStream)}\` to see the full details.`,
    ]
    await sendDeduped({
      recipientType: 'agent',
      recipientId: assignee.id,
      senderType: 'system',
      wakeEligible: true,
      subject: `Work stream handed off to you: ${workStreamTitle(workStream)}`,
      content: parts.join('\n\n'),
      metadata: {
        workStreamNumber: workStream.number,
        workStreamId: workStream.id,
        squadId: workStream.squadId,
        event: 'assigned',
        transitionAt: transitionAt(workStream),
        handoffMessage: workStream.handoffMessage ?? null,
      },
    })
  } catch (error) {
    log.error('Failed to notify work stream assignee:', error)
  }
}

type BlockedWaitFacts = { actor?: WorkStreamWaitActor | string | null; message?: string | null }

/** Read the opened wait's actor/message when the caller (an event fallback) only knows its id. */
async function loadBlockedWait(waitId: string): Promise<BlockedWaitFacts | undefined> {
  try {
    const [row] = await db
      .select({ actor: workStreamWaits.actor, message: workStreamWaits.message })
      .from(workStreamWaits)
      .where(eq(workStreamWaits.id, waitId))
      .limit(1)
    return row
  } catch (error) {
    log.error(`Failed to load wait ${waitId} for blocked notification:`, error)
    return undefined
  }
}

/**
 * A manual wait opened. Who hears about it follows the wait's actor:
 * - human (also missing/unknown): human watchers (inbox + push) and the owning agent, as before;
 * - owner: only the owning agent (owner, else squad manager) is woken — no human watcher is told.
 */
export async function notifyWorkStreamBlocked(
  workStream: WorkStream,
  target?: ExactActionTarget,
  actorAgentId?: WorkStreamActorAgentId,
  wait?: BlockedWaitFacts
): Promise<void> {
  const facts = wait ?? (target ? await loadBlockedWait(target.waitId) : undefined)
  const actor = workStreamWaitActor(facts ?? {})
  const title = workStreamTitle(workStream)
  if (actor === 'human') {
    await notifyWorkStreamOwner(
      workStream,
      'blocked',
      `Work stream "${title}" is blocked and needs attention.`,
      target,
      actorAgentId
    )
    return
  }
  const summary = `Work stream "${title}" is waiting on owner action (manual wait, actor: owner). No human action was requested; clear it with \`ficus workstream unblock ${workStreamRef(workStream)}${target ? ` --wait ${target.waitId}` : ''}\` once the condition is met.`
  const reason = facts?.message?.trim()
  await notifyWorkStreamOwnerAgent(
    workStream,
    'blocked',
    reason ? `${summary}\n\nWait: ${reason}` : summary,
    target,
    actorAgentId
  )
}

export async function notifyWorkStreamReview(
  workStream: WorkStream,
  target?: ExactActionTarget,
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  const msg = workStream.handoffMessage
    ? `Work stream "${workStreamTitle(workStream)}" is ready for review.\n\nHandoff message: ${workStream.handoffMessage}`
    : `Work stream "${workStreamTitle(workStream)}" is ready for review.`
  await notifyWorkStreamOwner(workStream, 'review', msg, target, actorAgentId)
}

export async function notifyWorkStreamDone(
  workStream: WorkStream,
  opts: {
    /** Reviewer's approval note (spec §4b) — delivered with the completion notice. */
    approvalNote?: string
    actorAgentId?: WorkStreamActorAgentId
  } = {}
): Promise<void> {
  const nextSteps = getWorkStreamNextSteps(workStream)
  const parts = [`Work stream "${workStreamTitle(workStream)}" has been completed.`]
  if (opts.approvalNote) parts.push(`Approval note: ${opts.approvalNote}`)
  if (nextSteps) parts.push(`Next steps: ${nextSteps}`)
  await notifyWorkStreamOwner(workStream, 'done', parts.join('\n\n'), undefined, opts.actorAgentId, opts.approvalNote)
}

export async function notifyWorkStreamCanceled(
  workStream: WorkStream,
  agentIds: string[],
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  await notifyWorkStreamOwner(
    workStream,
    'canceled',
    `Work stream "${workStreamTitle(workStream)}" has been canceled. Active assigned agent executions were asked to stop where possible.`,
    undefined,
    actorAgentId
  )
  const requesterContext = await formatRequestingUser(workStream)
  const crewMessage = [
    `Work stream "${workStreamTitle(workStream)}" has been canceled. Stop working on it. Do not hand it off, continue implementation, or open additional follow-up work unless a manager creates a new work stream.`,
    requesterContext,
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n')
  // The crew broadcast is a STEER — it interrupts. An agent that cancelled a
  // stream it was itself bound to does not need to be interrupted and told to
  // stop working on it.
  await Promise.all(
    agentIds
      .filter((agentId) => !isSelfNotification(agentId, actorAgentId))
      .map(async (agentId) => {
        try {
          await sendDeduped({
            recipientType: 'agent',
            recipientId: agentId,
            senderType: 'system',
            wakeEligible: false,
            subject: `Work stream canceled: ${workStreamTitle(workStream)}`,
            content: crewMessage,
            metadata: {
              workStreamNumber: workStream.number,
              workStreamId: workStream.id,
              squadId: workStream.squadId,
              event: 'canceled',
              transitionAt: transitionAt(workStream),
            },
            deliveryMode: 'steer',
          })
        } catch (error) {
          log.error('Failed to notify agent of work stream cancellation:', error)
        }
      })
  )
}

/**
 * A queued stream depends on a stream that was CANCELED (not done): it can
 * never be admitted as-is and needs a decision (re-point the dependency or
 * cancel the stream). Sent once per stream by the admission controller.
 */
/**
 * A terminal stream re-entered admission via reopen (spec §6): notify the
 * owner (or manager fallback) + watchers, and the assignee when one is still
 * bound and distinct from that recipient.
 */
export async function notifyWorkStreamReopened(
  workStream: WorkStream,
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  const message = `Work stream "${workStreamTitle(workStream)}" has been reopened and re-entered admission (status: queued; it activates when a slot is free).`
  await notifyWorkStreamOwner(workStream, 'reopened', message, undefined, actorAgentId)
  try {
    const recipient = await resolveWorkStreamRecipient(workStream)
    if (
      workStream.assigneeAgentId &&
      workStream.assigneeAgentId !== recipient?.id &&
      !isSelfNotification(workStream.assigneeAgentId, actorAgentId)
    ) {
      await sendDeduped({
        recipientType: 'agent',
        recipientId: workStream.assigneeAgentId,
        senderType: 'system',
        wakeEligible: true,
        subject: `Work stream reopened: ${workStreamTitle(workStream)}`,
        content: `${message} You are still its assignee; resume work once it is admitted.`,
        metadata: {
          workStreamNumber: workStream.number,
          workStreamId: workStream.id,
          squadId: workStream.squadId,
          event: 'reopened',
          transitionAt: transitionAt(workStream),
        },
      })
    }
  } catch (error) {
    log.error('Failed to notify assignee of reopened work stream:', error)
  }
}

export async function notifyWorkStreamDependencyCanceled(
  workStream: WorkStream,
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  await notifyWorkStreamOwner(
    workStream,
    'dependency_canceled',
    `Queued work stream "${workStreamTitle(workStream)}" depends on a work stream that was canceled, so it will never become eligible for admission. Re-point its dependencies (ws update --depends-on) or cancel it.`,
    undefined,
    actorAgentId
  )
}

async function formatWorkStreamCreatorForOwnerNotice(workStream: WorkStream): Promise<string | null> {
  if (workStream.creatorAgentId) {
    const creator = await Agent.find(workStream.creatorAgentId)
    if (!creator) return `the agent (${workStream.creatorAgentId})`

    const agentType = await creator.getAgentType()
    const typeName = (agentType?.name ?? creator.agentTypeId).toLowerCase()
    const displayName = creator.metadata?.name ?? 'Unnamed agent'
    return `the ${typeName} agent ${displayName} (${creator.id})`
  }

  if (workStream.requestingUserId) {
    const user = await User.findById(workStream.requestingUserId).catch(() => null)
    if (!user) return `the user (${workStream.requestingUserId})`

    const displayName = user.displayName || user.email
    return `the user ${displayName} (${user.email})`
  }

  const source = workStream.metadata?.integrationSource as { integration?: unknown } | undefined
  if (typeof source?.integration === 'string') return `an integration event (${source.integration})`

  return null
}

export async function notifyWorkStreamOwnerOfNewStream(
  workStream: WorkStream,
  options: { retryOnFailure?: boolean } = {}
): Promise<void> {
  try {
    const { creatorAgentId, ownerAgentId } = workStream
    // Same rule as every other lifecycle event, with the creator as the actor:
    // a manager opening a stream it owns is not announced to itself.
    if (!ownerAgentId || isSelfNotification(ownerAgentId, creatorAgentId)) return

    // Avoid double-notify: if the owner is also the assignee and the assignee was
    // already notified by notifyWorkStreamAssigned, skip. That assignee notification
    // is skipped for manager assignees, so only skip here for non-manager assignees.
    if (workStream.assigneeAgentId && workStream.assigneeAgentId === ownerAgentId) {
      const squad = await Squad.find(workStream.squadId)
      if (squad?.managerAgentId !== ownerAgentId) return
    }

    const owner = await Agent.find(ownerAgentId)
    if (!owner) return
    const creatorDescription = await formatWorkStreamCreatorForOwnerNotice(workStream)
    if (!creatorDescription) return
    const requesterContext = await formatRequestingUser(workStream)
    const content = [
      `A new work stream you now own was ${workStream.metadata?.integrationSource ? 'created' : 'started'} by ${creatorDescription}.`,
      requesterContext,
      `Query it with \`ficus workstream get ${workStreamRef(workStream)}\` to see the full details.`,
      workStream.pause && workStream.metadata?.integrationSource && !workStream.agentIds?.length
        ? `The workflow is paused before any workers start. Review the event and workflow, prepare its workspace if needed with \`ficus workstream update ${workStreamRef(workStream)} --repository <checkout-path>\`, then start it with \`ficus workstream resume ${workStreamRef(workStream)}\`. If no Git workspace is needed, resume after reviewing the task. Do not manually bypass repository setup guards.`
        : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')

    await sendDeduped({
      recipientType: 'agent',
      recipientId: owner.id,
      senderType: 'system',
      wakeEligible: true,
      subject: `New work stream you own: ${workStreamTitle(workStream)}`,
      content,
      metadata: {
        workStreamNumber: workStream.number,
        workStreamId: workStream.id,
        squadId: workStream.squadId,
        event: 'created',
        transitionAt: workStream.createdAt.toISOString(),
        ownerAgentId,
        creatorAgentId,
        requestingUserId: workStream.requestingUserId,
      },
    })
  } catch (error) {
    log.error('Failed to notify work stream owner of new stream:', error)
    if (options.retryOnFailure) throw error
  }
}

export async function notifyWorkStreamResponded(
  workStream: WorkStream,
  resolvedWaitType: 'manual' | 'review',
  // The resolution note recorded on the just-closed wait — the source of truth
  // in the open-waits model. Prefer it over the legacy `workStreams.response`
  // column so an operator `unblock -m <note>` actually reaches the assignee
  // (the note lives on the wait row, never in `response`).
  resolutionNote?: string,
  // For review waits: whether this was an approval (a checkpoint gate approving
  // without completing) or a send-back. Wording must not tell an approved
  // assignee their work "needs further work".
  reviewResolution: 'approved' | 'sent_back' = 'sent_back',
  actorAgentId?: WorkStreamActorAgentId
): Promise<void> {
  try {
    if (workStream.status === 'done' || workStream.status === 'canceled') return
    // The resolution note recorded on the just-closed wait is the sole source
    // (the legacy workStreams.response column has been retired).
    const responseText = resolutionNote?.trim() ?? ''
    const isUnblocked = resolvedWaitType === 'manual'
    const event: WorkStreamInboxEvent = isUnblocked ? 'unblocked' : 'reviewed'
    const isApprovedCheckpoint = !isUnblocked && reviewResolution === 'approved'
    const subject = isUnblocked
      ? `Work stream unblocked: ${workStreamTitle(workStream)}`
      : isApprovedCheckpoint
        ? `Checkpoint approved: ${workStreamTitle(workStream)}`
        : `Review feedback: ${workStreamTitle(workStream)}`
    const content = isUnblocked
      ? `Your work stream "${workStreamTitle(workStream)}" has been unblocked.\n\nResponse: ${responseText}`
      : isApprovedCheckpoint
        ? `Your checkpoint review on "${workStreamTitle(workStream)}" was APPROVED — continue the work.\n\nApproval note: ${responseText}`
        : `Your work stream "${workStreamTitle(workStream)}" received review feedback and needs further work.\n\nFeedback: ${responseText}`

    // An assignee that resolved its OWN wait (an agent unblocking itself, or
    // approving its own checkpoint) does not need the resolution steered back
    // at it. A wait resolved by anyone else still reaches the assignee.
    if (workStream.assigneeAgentId && isSelfNotification(workStream.assigneeAgentId, actorAgentId)) return

    if (workStream.assigneeAgentId) {
      await sendDeduped({
        recipientType: 'agent',
        recipientId: workStream.assigneeAgentId,
        senderType: 'system',
        wakeEligible: true,
        subject,
        content,
        metadata: {
          workStreamNumber: workStream.number,
          workStreamId: workStream.id,
          squadId: workStream.squadId,
          event,
          transitionAt: transitionAt(workStream),
        },
        deliveryMode: isUnblocked ? 'steer' : undefined,
      })
    } else {
      await notifyWorkStreamOwner(
        workStream,
        event,
        isUnblocked
          ? `Work stream "${workStreamTitle(workStream)}" was unblocked with this response:\n\n${responseText}`
          : `Work stream "${workStreamTitle(workStream)}" received review feedback:\n\n${responseText}`,
        undefined,
        actorAgentId
      )
    }
  } catch (error) {
    log.error('Failed to notify work stream response:', error)
  }
}
