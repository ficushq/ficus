import { resolveCodeHostReference } from '@ficus/shared'
import { eq } from 'drizzle-orm'
import { advanceWorkflowState, type Notification } from './ci-notification-state'
export { ciNotificationSchema } from './ci-notification-state'
import { agents, db, workStreams } from '../../db'
import { InboxMessage } from '../../entities/InboxMessage'
import { acquireAgentQueueLock } from '../execution/agent-admission'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export async function settleCiNotification(workStreamId: string, input: Notification) {
  const afterCommit: Array<() => void> = []
  const result = await db.transaction(async (tx) => {
    // Match pause and flow inbox acceptance: stream before agent queue and row.
    const [stream] = await tx.select().from(workStreams).where(eq(workStreams.id, workStreamId)).for('update')
    await acquireAgentQueueLock(tx, input.recipientId)
    const [recipient] = await tx.select().from(agents).where(eq(agents.id, input.recipientId)).for('update')
    if (!recipient || recipient.status === 'terminated' || recipient.pendingDormancyAt)
      return { accepted: false, reason: 'recipient unavailable' }
    if (!stream || stream.status === 'done' || stream.status === 'canceled')
      return { accepted: false, reason: 'work stream is not active' }
    const metadata = record(stream.metadata)
    const github = record(metadata.github)
    const reference = resolveCodeHostReference(metadata)
    if (reference?.integration !== 'github' || reference.repository.toLowerCase() !== input.repository.toLowerCase())
      return { accepted: false, reason: 'repository does not match work stream' }
    const decision = advanceWorkflowState(github.ci, input)
    if (!decision.accepted) return decision
    const message = await InboxMessage.persistSystemAgentOnceInTransaction(
      tx,
      {
        recipientId: input.recipientId,
        subject: input.subject,
        content: input.content,
        metadata: { source: 'workflow-run', workStreamId, workflowId: input.workflowId },
        wakeEligible: false,
        recordOnly: true,
      },
      `ci:${workStreamId}:${input.workflowId}:${input.runId}:${input.runAttempt}`,
      afterCommit
    )
    await tx
      .update(workStreams)
      .set({
        metadata: { ...metadata, github: { ...github, ci: { ...record(github.ci), workflows: decision.workflows } } },
      })
      .where(eq(workStreams.id, workStreamId))
    return { accepted: true, messageId: message.id }
  })
  for (const callback of afterCommit) callback()
  if (result.accepted) {
    // Same best-effort delivery policy as ordinary system inbox messages. The
    // durable row survives a crash between commit and this attempt.
    const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
    await deliverInboxMessagesToAgent(input.recipientId).catch(() => {})
  }
  return result
}
