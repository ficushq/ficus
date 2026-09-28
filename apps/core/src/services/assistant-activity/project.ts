import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import {
  applyAssistantTaskStatus,
  assistantTaskStatusSchema,
  parseAssistantInboxConversationId,
  type AssistantMessageTargetKind,
} from '@ficus/shared'
import type { db } from '../../db'
import type { AssistantNotificationDecision } from './notification'
import { assistantConversations, assistantTasks, assistantUpdates, inbox } from '../../db/schema'

export type AssistantActivityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Server-controlled metadata. Generic inbox callers cannot supply these keys. */
export const ASSISTANT_TASK_ID_KEY = 'assistantTaskId'
export const ASSISTANT_TASK_STATUS_KEY = 'assistantTaskStatus'
export const ASSISTANT_REQUEST_KEY = 'assistantRequest'
export const ASSISTANT_TASK_MUTATION_KEY = 'assistantTaskMutation'
export const assistantTaskMutationSchema = z.object({
  operation: z.enum(['continue', 'retry', 'cancel']),
  taskId: z.string().uuid(),
  expectedRequestId: z.string().uuid(),
})
export type AssistantTaskMutation = z.infer<typeof assistantTaskMutationSchema>
/** Route-supplied delegation facts recorded on an outgoing Assistant request. */
export const ASSISTANT_DELEGATION_KEY = 'assistantDelegation'

export const TASK_LABEL_MAX_LENGTH = 80

export const assistantDelegationSchema = z.object({
  kind: z.enum(['background', 'squad', 'agent']),
  squadId: z.string().uuid().nullable().optional(),
  label: z.string().trim().min(1).max(TASK_LABEL_MAX_LENGTH).optional(),
})
export type AssistantDelegation = z.infer<typeof assistantDelegationSchema>

export interface AssistantActivityInvalidation {
  conversationId: string
  recipientId: string
  /** Present only for incoming updates; outgoing requests never push. */
  update?: AssistantNotificationDecision
}

type InboxRow = typeof inbox.$inferSelect
const uuid = z.string().uuid()

/** Bounded first line of a request when the delegation carried no label. */
export function fallbackTaskLabel(content: string): string {
  const line = content.split('\n').find((candidate) => candidate.trim()) ?? ''
  const trimmed = line.trim()
  if (!trimmed) return 'Assistant task'
  return trimmed.length > TASK_LABEL_MAX_LENGTH ? `${trimmed.slice(0, TASK_LABEL_MAX_LENGTH - 1)}…` : trimmed
}

async function lockConversation(tx: AssistantActivityTransaction, conversationId: string) {
  const [conversation] = await tx
    .select()
    .from(assistantConversations)
    .where(eq(assistantConversations.id, conversationId))
    .for('update')
  if (!conversation) throw new Error('Assistant conversation not found')
  return conversation
}

async function setMetadata(tx: AssistantActivityTransaction, messageId: string, patch: Record<string, unknown>) {
  const [row] = await tx
    .update(inbox)
    .set({ metadata: sql`${inbox.metadata} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(inbox.id, messageId))
    .returning()
  if (!row) throw new Error('Inbox message disappeared during Assistant projection')
  return row
}

/**
 * Project one newly inserted inbox row into durable task/update state. Must run inside the inbox
 * insertion transaction after the recipient-agent admission lock (when any) and before commit, so
 * a fast agent reply can never arrive before its task exists. Emits nothing; the caller emits
 * after commit. Returns the updated inbox row (server metadata added) and an invalidation
 * descriptor, or `null` for traffic unrelated to saved Assistant conversations.
 */
export async function projectAssistantInboxMessage(
  tx: AssistantActivityTransaction,
  message: InboxRow
): Promise<{ row: InboxRow; invalidation: AssistantActivityInvalidation } | null> {
  const outgoingConversation =
    message.senderType === 'voice_assistant' && message.recipientType === 'agent'
      ? parseAssistantInboxConversationId(message.senderId)
      : null
  if (outgoingConversation) return projectOutgoingRequest(tx, message, outgoingConversation)
  const incomingConversation =
    message.recipientType === 'voice_assistant' ? parseAssistantInboxConversationId(message.recipientId) : null
  if (incomingConversation) return projectIncomingUpdate(tx, message, incomingConversation)
  return null
}

async function projectOutgoingRequest(tx: AssistantActivityTransaction, message: InboxRow, conversationId: string) {
  await lockConversation(tx, conversationId)
  const mutation = assistantTaskMutationSchema.safeParse(message.metadata[ASSISTANT_TASK_MUTATION_KEY])
  if (mutation.success) {
    const command = mutation.data
    const [task] = await tx
      .select()
      .from(assistantTasks)
      .where(and(eq(assistantTasks.id, command.taskId), eq(assistantTasks.conversationId, conversationId)))
      .for('update')
    if (!task || task.currentRequestId !== command.expectedRequestId)
      throw new HTTPException(409, { message: 'This task has a newer request. Refresh before continuing.' })
    const [request] = await tx.select().from(inbox).where(eq(inbox.id, command.expectedRequestId))
    if (!request || (command.operation !== 'retry' && request.recipientId !== message.recipientId))
      throw new HTTPException(409, { message: 'Task delegate changed. Refresh before continuing.' })
    await tx
      .update(assistantTasks)
      .set({
        currentRequestId: message.id,
        ...(command.operation === 'cancel' ? {} : { agentId: message.recipientId }),
        status: command.operation === 'cancel' ? 'cancelled' : 'working',
        updatedAt: sql`now()`,
      })
      .where(eq(assistantTasks.id, task.id))
    const row = await setMetadata(tx, message.id, { [ASSISTANT_TASK_ID_KEY]: task.id })
    await tx
      .update(assistantConversations)
      .set({ updatedAt: sql`now()` })
      .where(eq(assistantConversations.id, conversationId))
    return { row, invalidation: { conversationId, recipientId: message.senderId! } }
  }
  const agentId = uuid.safeParse(message.recipientId).success ? message.recipientId : null
  const delegation = assistantDelegationSchema.safeParse(message.metadata[ASSISTANT_DELEGATION_KEY])
  const kind: AssistantMessageTargetKind = delegation.success ? delegation.data.kind : 'background'
  const inReplyTo = uuid.safeParse(message.metadata.inReplyTo)
  let taskId: string | null = null
  let expectedRequestId: string | null = null
  if (inReplyTo.success) {
    // A user answer stays on the task whose update it answers; only same-conversation updates count.
    const [referenced] = await tx
      .select({ taskId: assistantUpdates.taskId, requestId: assistantUpdates.requestId })
      .from(assistantUpdates)
      .where(and(eq(assistantUpdates.messageId, inReplyTo.data), eq(assistantUpdates.conversationId, conversationId)))
    taskId = referenced?.taskId ?? null
    expectedRequestId = referenced?.requestId ?? null
  }
  if (taskId) {
    const [advanced] = await tx
      .update(assistantTasks)
      .set({ currentRequestId: message.id, agentId, status: 'working', updatedAt: sql`now()` })
      .where(
        and(
          eq(assistantTasks.id, taskId),
          eq(assistantTasks.conversationId, conversationId),
          expectedRequestId ? eq(assistantTasks.currentRequestId, expectedRequestId) : sql`false`
        )
      )
      .returning({ id: assistantTasks.id })
    if (!advanced)
      throw new HTTPException(409, { message: 'This task has a newer request. Refresh before continuing.' })
  }
  if (!taskId) {
    taskId = message.id
    await tx.insert(assistantTasks).values({
      id: taskId,
      conversationId,
      currentRequestId: message.id,
      agentId,
      kind,
      squadId: delegation.success ? (delegation.data.squadId ?? null) : null,
      label: (delegation.success && delegation.data.label) || fallbackTaskLabel(message.content),
      status: 'working',
    })
  }
  await tx
    .update(assistantConversations)
    .set({ updatedAt: sql`now()` })
    .where(eq(assistantConversations.id, conversationId))
  const row = await setMetadata(tx, message.id, { [ASSISTANT_TASK_ID_KEY]: taskId })
  return { row, invalidation: { conversationId, recipientId: message.senderId! } }
}

async function projectIncomingUpdate(tx: AssistantActivityTransaction, message: InboxRow, conversationId: string) {
  const conversation = await lockConversation(tx, conversationId)
  const reported = assistantTaskStatusSchema.safeParse(message.metadata[ASSISTANT_TASK_STATUS_KEY])
  const reportedStatus = reported.success ? reported.data : null
  const inReplyTo = uuid.safeParse(message.metadata.inReplyTo)
  let requestId: string | null = null
  let taskId: string | null = null
  let decision: AssistantNotificationDecision = { isCurrentRequest: false, changedStatus: false, reportedStatus }
  if (inReplyTo.success && message.senderType === 'agent') {
    const [request] = await tx
      .select({ id: inbox.id, taskId: sql<string | null>`${inbox.metadata}->>${ASSISTANT_TASK_ID_KEY}` })
      .from(inbox)
      .where(
        and(
          eq(inbox.id, inReplyTo.data),
          eq(inbox.senderType, 'voice_assistant'),
          eq(inbox.senderId, message.recipientId),
          eq(inbox.recipientType, 'agent')
        )
      )
    if (request) {
      requestId = request.id
      const [task] = uuid.safeParse(request.taskId).success
        ? await tx
            .select()
            .from(assistantTasks)
            .where(and(eq(assistantTasks.id, request.taskId!), eq(assistantTasks.conversationId, conversationId)))
            .for('update')
        : []
      if (task) {
        taskId = task.id
        const isCurrentRequest = task.currentRequestId === request.id
        const next = applyAssistantTaskStatus(task.status, reportedStatus ?? undefined, isCurrentRequest)
        const changedStatus = next !== task.status
        decision = { isCurrentRequest, changedStatus, reportedStatus }
        if (changedStatus)
          await tx
            .update(assistantTasks)
            .set({ status: next, updatedAt: sql`now()` })
            .where(eq(assistantTasks.id, task.id))
      }
    }
  }
  const sequence = conversation.nextUpdateSequence + 1
  await tx
    .update(assistantConversations)
    .set({ nextUpdateSequence: sequence, updatedAt: sql`now()` })
    .where(eq(assistantConversations.id, conversationId))
  await tx.insert(assistantUpdates).values({
    messageId: message.id,
    conversationId,
    taskId,
    requestId,
    sequence,
    reportedStatus,
    createdAt: message.createdAt,
  })
  return { row: message, invalidation: { conversationId, recipientId: message.recipientId, update: decision } }
}
