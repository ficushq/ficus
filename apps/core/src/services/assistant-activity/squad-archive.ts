import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm'
import { assistantInboxRecipientId, type AssistantTaskStatus } from '@ficus/shared'
import { assistantConversations, assistantTasks, assistantUpdates, db, inbox, squads } from '../../db'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { createLogger } from '../../lib/infra/logger'
import { ASSISTANT_TASK_ID_KEY, ASSISTANT_TASK_STATUS_KEY, type AssistantActivityTransaction } from './project'

const log = createLogger('assistant-squad-archive')

/** Why a task closed when its squad was archived; shown in the conversation and to its Assistant. */
export const SQUAD_ARCHIVED_TASK_REASON = 'The squad was archived'
export const SQUAD_ARCHIVED_TASK_SOURCE = 'assistant_task_squad_archived'

const TERMINAL: AssistantTaskStatus[] = ['completed', 'failed', 'cancelled']

/**
 * Cancel every unfinished Assistant task delegated to one squad. Each owner's conversation gets a
 * `cancelled` task update on the task's current request, exactly like a delegate-reported
 * cancellation: it is listed in the conversation's activity and forwarded to its Assistant, and the
 * task's needs-input pending action disappears with the status. Runs inside the squad archive
 * transaction, and in the sweep for squads archived before this existed.
 *
 * Idempotent: finished tasks are skipped, and the update's inbox row is keyed by task and request
 * generation, so a repeat never records a second update. Locks each conversation before its tasks,
 * the same order inbox projection uses. Events are queued on `afterCommit`.
 */
export async function closeSquadAssistantTasksInTransaction(
  tx: AssistantActivityTransaction,
  squad: { id: string; name: string },
  afterCommit: Array<() => void>
): Promise<string[]> {
  const open = await tx
    .select({ id: assistantTasks.id, conversationId: assistantTasks.conversationId })
    .from(assistantTasks)
    .where(and(eq(assistantTasks.squadId, squad.id), notInArray(assistantTasks.status, TERMINAL)))
    .orderBy(asc(assistantTasks.conversationId), asc(assistantTasks.id))
  const closed: string[] = []
  let lockedConversationId: string | null = null
  for (const candidate of open) {
    if (candidate.conversationId !== lockedConversationId) {
      await tx
        .select({ id: assistantConversations.id })
        .from(assistantConversations)
        .where(eq(assistantConversations.id, candidate.conversationId))
        .for('update')
      lockedConversationId = candidate.conversationId
    }
    // Recheck under the lock: a concurrent command may already have finished this task.
    const [task] = await tx
      .select()
      .from(assistantTasks)
      .where(and(eq(assistantTasks.id, candidate.id), notInArray(assistantTasks.status, TERMINAL)))
      .for('update')
    if (!task) continue
    await tx
      .update(assistantTasks)
      .set({ status: 'cancelled', updatedAt: sql`now()` })
      .where(eq(assistantTasks.id, task.id))
    closed.push(task.id)
    const recipientId = assistantInboxRecipientId(task.conversationId)
    const [message] = await tx
      .insert(inbox)
      .values({
        recipientType: 'voice_assistant',
        recipientId,
        senderType: 'system',
        senderId: null,
        subject: 'Task cancelled',
        content: `${SQUAD_ARCHIVED_TASK_REASON}, so the task "${task.label}" was cancelled. Squad: ${squad.name}. Its work cannot continue; start a new task in another squad if it is still needed.`,
        metadata: {
          inReplyTo: task.currentRequestId,
          source: SQUAD_ARCHIVED_TASK_SOURCE,
          squadId: squad.id,
          sender: { name: 'Ficus' },
          wakeEligible: false,
          [ASSISTANT_TASK_ID_KEY]: task.id,
          [ASSISTANT_TASK_STATUS_KEY]: 'cancelled',
        },
        deliveryMode: 'steer',
        idempotencyKey: `assistant-squad-archived:${task.id}:${task.currentRequestId}`,
      })
      .onConflictDoNothing({ target: inbox.idempotencyKey })
      .returning()
    if (!message) continue
    const [conversation] = await tx
      .update(assistantConversations)
      .set({ nextUpdateSequence: sql`${assistantConversations.nextUpdateSequence} + 1`, updatedAt: sql`now()` })
      .where(eq(assistantConversations.id, task.conversationId))
      .returning({ sequence: assistantConversations.nextUpdateSequence })
    await tx.insert(assistantUpdates).values({
      messageId: message.id,
      conversationId: task.conversationId,
      taskId: task.id,
      requestId: task.currentRequestId,
      sequence: conversation.sequence,
      reportedStatus: 'cancelled',
      createdAt: message.createdAt,
    })
    afterCommit.push(() => {
      eventEmitter.emit('inbox.messageReceived', {
        messageId: message.id,
        recipientType: 'voice_assistant',
        recipientId,
        senderAgentId: null,
      })
      eventEmitter.emit('assistant.activityChanged', { conversationId: task.conversationId, recipientId })
    })
  }
  return closed
}

/**
 * Close Assistant tasks still open in squads that are already archived: squads archived before
 * archiving closed them, and a delegation that committed while its squad was being archived.
 * Bounded per run; quiescent once no such task remains.
 */
export async function closeArchivedSquadAssistantTasks(options: { limit?: number } = {}): Promise<number> {
  const stuck = await db
    .selectDistinct({ id: squads.id, name: squads.name })
    .from(assistantTasks)
    .innerJoin(squads, eq(squads.id, assistantTasks.squadId))
    .where(and(isNotNull(squads.archivedAt), notInArray(assistantTasks.status, TERMINAL)))
    .limit(options.limit ?? 50)
  let closed = 0
  for (const squad of stuck) {
    const afterCommit: Array<() => void> = []
    try {
      closed += (await db.transaction((tx) => closeSquadAssistantTasksInTransaction(tx, squad, afterCommit))).length
    } catch (error) {
      log.warn(`Could not close Assistant tasks of archived squad ${squad.id}:`, error)
      continue
    }
    for (const emit of afterCommit) emit()
  }
  return closed
}
