import { resolveCodeHostReference, workStreamRef, workStreamTitle } from '@ficus/shared'
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../db'
import { agents, executions, inbox, squads, workStreamObservers, workStreams } from '../../db/schema'
import { InboxMessage } from '../../entities/InboxMessage'
import { Agent, AgentTargetUnavailableError } from '../../entities/Agent'
import { acquireAgentQueueLock } from '../execution/agent-admission'
import { deliverInboxMessagesToAgent } from '../inbox/inboxDelivery'
import { createLogger } from '../../lib/infra/logger'
import { hasAgentPermissionWithExecutor } from '../rbac/permissions'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const log = createLogger('work-stream-observers')
export class ObservationError extends Error {
  constructor(
    message: string,
    public readonly status: 403 | 404 | 409
  ) {
    super(message)
  }
}

export async function isObservingWorkStream(workStreamId: string, agentId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(workStreamObservers)
    .where(and(eq(workStreamObservers.workStreamId, workStreamId), eq(workStreamObservers.agentId, agentId)))
    .limit(1)
  return rows.length > 0
}

/** Caller identity must be server-derived. Lock the stream to serialize registration with terminal delivery. */
export async function observeWorkStreamInTransaction(tx: Tx, workStreamId: string, agentId: string): Promise<void> {
  const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId))
  if (!stream) throw new ObservationError('Work stream not found', 404)
  if (!agent || agent.squadId !== stream.squadId || agent.status === 'terminated' || agent.pendingDormancyAt)
    throw new ObservationError('Observation requires an available agent in the same squad', 403)
  if (stream.status === 'done' || stream.status === 'canceled')
    throw new ObservationError('Already terminal: no observer registered. Observe again after reopening.', 409)
  await tx.insert(workStreamObservers).values({ workStreamId, agentId }).onConflictDoNothing()
}
export async function observeWorkStream(workStreamId: string, agentId: string): Promise<void> {
  await db.transaction((tx) => observeWorkStreamInTransaction(tx, workStreamId, agentId))
}
export async function unobserveWorkStream(workStreamId: string, agentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: workStreams.id }).from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    await tx
      .delete(workStreamObservers)
      .where(and(eq(workStreamObservers.workStreamId, workStreamId), eq(workStreamObservers.agentId, agentId)))
  })
}

/** Called under the terminal transition's stream lock. Inbox is the durable outbox;
 * consuming the watch and persisting its receipt are atomic. Delivery is always post-commit. */
export async function persistTerminalObservers(
  tx: Tx,
  stream: typeof workStreams.$inferSelect,
  afterCommit: Array<() => void>
): Promise<void> {
  if (stream.status !== 'done' && stream.status !== 'canceled') return
  const observers = await tx
    .select()
    .from(workStreamObservers)
    .where(eq(workStreamObservers.workStreamId, stream.id))
    .orderBy(asc(workStreamObservers.agentId))
  if (!observers.length) return
  const [squad] = await tx.select().from(squads).where(eq(squads.id, stream.squadId))
  const [owner] = stream.ownerAgentId
    ? await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, stream.ownerAgentId))
    : []
  const ownerId = owner?.id ?? squad?.managerAgentId
  const reference = resolveCodeHostReference(stream.metadata)
  const metadata = stream.metadata as Record<string, unknown> | null
  const nextSteps = typeof metadata?.nextSteps === 'string' ? metadata.nextSteps.trim().slice(0, 800) : ''
  for (const observer of observers) {
    // Owner receives the existing manager notice (or already knows its own action).
    if (observer.agentId === ownerId) continue
    await acquireAgentQueueLock(tx, observer.agentId)
    const [agent] = await tx.select().from(agents).where(eq(agents.id, observer.agentId)).for('update')
    const [latest] = await tx
      .select({ status: executions.status })
      .from(executions)
      .where(eq(executions.agentId, observer.agentId))
      .orderBy(desc(executions.startedAt))
      .limit(1)
    if (
      !agent ||
      agent.squadId !== stream.squadId ||
      agent.pendingDormancyAt ||
      ['terminated', 'dormant', 'waiting-input'].includes(agent.status) ||
      (latest && ['stopped', 'stopping', 'failed'].includes(latest.status))
    )
      continue
    if (
      !(await hasAgentPermissionWithExecutor(
        tx,
        { type: 'agent', agentId: agent.id, squadId: agent.squadId },
        'workstreams:read',
        stream.squadId
      ))
    )
      continue
    await InboxMessage.persistSystemAgentOnceInTransaction(
      tx,
      {
        recipientId: observer.agentId,
        subject: `Observer update: ${workStreamTitle(stream)} — ${stream.status}`,
        content: [
          `Observer update: [${workStreamTitle(stream)}](ficus:ws:${workStreamRef(stream)}) is ${stream.status}.`,
          `Current owner: ${ownerId ? `[agent](ficus:agent:${ownerId})` : 'none'}.`,
          reference?.changeRequest?.url ? `Result: ${reference.changeRequest.url}` : null,
          nextSteps ? `Result notes: ${nextSteps}` : null,
          'No management action required. Context/reporting only; the owner retains execution, blocker handling, reconciliation and delivery. Do not treat this update as an assignment, poll, or start parallel orchestration.',
          'This one-shot observation has expired.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        metadata: {
          source: 'work-stream-observer',
          workStreamId: stream.id,
          workStreamNumber: stream.number,
          squadId: stream.squadId,
          event: stream.status,
          ownerAgentId: ownerId ?? null,
        },
        deliveryMode: 'follow-up',
        // Idle conversations can report back, but observation never revives a dormant conversation.
        wakeEligible: false,
        recordOnly: true,
      },
      `work-stream-observer:${observer.id}`,
      afterCommit
    )
    afterCommit.push(() =>
      deliverInboxMessagesToAgent(observer.agentId).catch((error) => log.error('Observer delivery deferred', error))
    )
  }
  await tx.delete(workStreamObservers).where(eq(workStreamObservers.workStreamId, stream.id))
}

// Rotate bounded pages so paused conversations cannot starve later recipients.
let deliveryCursor: string | null = null

/** Backstop for a process crash after the terminal commit; inbox claims/receipts own retries. */
export async function reconcileObserverDeliveries(): Promise<void> {
  const recipients = await db
    .selectDistinct({ id: inbox.recipientId })
    .from(inbox)
    .where(
      and(
        eq(inbox.recipientType, 'agent'),
        isNull(inbox.readAt),
        isNull(inbox.deliveredAt),
        sql`${inbox.metadata}->>'source' = 'work-stream-observer'`,
        deliveryCursor ? gt(inbox.recipientId, deliveryCursor) : undefined
      )
    )
    .orderBy(asc(inbox.recipientId))
    .limit(100)
  deliveryCursor = recipients.length === 100 ? recipients[recipients.length - 1]!.id : null
  for (const recipient of recipients) {
    try {
      if (!(await Agent.find(recipient.id))) {
        await db
          .update(inbox)
          .set({ readAt: new Date() })
          .where(
            and(
              eq(inbox.recipientType, 'agent'),
              eq(inbox.recipientId, recipient.id),
              isNull(inbox.readAt),
              sql`${inbox.metadata}->>'source' = 'work-stream-observer'`
            )
          )
        continue
      }
      await deliverInboxMessagesToAgent(recipient.id)
    } catch (error) {
      log.error('Observer delivery deferred', error)
    }
  }
}

/** The queue lock is the final stop/wake boundary. A stop can win after inbox
 * filtering but before acceptance; observer-only mail must not undo that stop.
 * Canonical inbox rows (not caller-supplied source metadata) identify this case. */
export async function assertObserverInboxAcceptance(tx: Tx, agentId: string, inboxMessageIds: string[]): Promise<void> {
  if (!inboxMessageIds.length) return
  const rows = await tx
    .select({ metadata: inbox.metadata })
    .from(inbox)
    .where(and(inArray(inbox.id, inboxMessageIds), eq(inbox.recipientType, 'agent'), eq(inbox.recipientId, agentId)))
  if (
    !rows.length ||
    !rows.every((row) => (row.metadata as Record<string, unknown> | null)?.source === 'work-stream-observer')
  )
    return
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId))
  const [latest] = await tx
    .select({ status: executions.status })
    .from(executions)
    .where(eq(executions.agentId, agentId))
    .orderBy(desc(executions.startedAt))
    .limit(1)
  if (
    !agent ||
    agent.pendingDormancyAt ||
    ['terminated', 'dormant', 'waiting-input'].includes(agent.status) ||
    (latest && ['stopping', 'stopped', 'failed'].includes(latest.status))
  )
    throw new AgentTargetUnavailableError(agentId)
  for (const row of rows) {
    const squadId = (row.metadata as Record<string, unknown>).squadId
    if (
      typeof squadId !== 'string' ||
      agent.squadId !== squadId ||
      !(await hasAgentPermissionWithExecutor(
        tx,
        { type: 'agent', agentId, squadId: agent.squadId },
        'workstreams:read',
        squadId
      ))
    )
      throw new AgentTargetUnavailableError(agentId)
  }
}
