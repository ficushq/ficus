import { mapMessage } from '../entities/message-mapper'
import { messageEventData } from '../entities/message-event'
import { eventEmitter } from '../lib/infra/event-emitter'
import { isDeepStrictEqual } from 'node:util'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  assistantEditorContext,
  assistantInboxRecipientId,
  chatPagePathSchema,
  type AssistantEntry,
  type AssistantMessageReceipt,
} from '@ficus/shared'
import {
  assistantConversationAgents,
  assistantConversations,
  assistantEntries,
  assistantTasks,
  db,
  inbox,
  messages,
  users,
} from '../db'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import {
  ASSISTANT_DELEGATION_KEY,
  ASSISTANT_REQUEST_KEY,
  ASSISTANT_TASK_ID_KEY,
  type AssistantTaskMutation,
  assistantDelegationSchema,
} from './assistant-activity/project'
import { resolveOwnedAgent } from './assistant-agents'
import { requireConsultantCreationAccess } from './chat/consultant-access'
import { resolveActingUser, hasAgentResourcePermission, hasPermission, type Identity } from './rbac'

function taskError(status: 400 | 403 | 404 | 409 | 500, options: { message: string }) {
  return new HTTPException(status, {
    message: options.message,
    res: Response.json({ error: options.message }, { status }),
  })
}

const uuid = z.string().uuid()
export const assistantMessageSchema = z
  .object({
    clientId: uuid,
    request: z.string().trim().min(1).max(20_000),
    pagePath: chatPagePathSchema.optional(),
    agentId: uuid.optional(),
    squadId: uuid.optional(),
    label: z.string().trim().min(1).max(80).optional(),
    inReplyTo: uuid.optional(),
    mode: z.enum(['steer', 'follow-up']).default('steer'),
  })
  .refine((input) => !(input.agentId && input.squadId), { message: 'agentId and squadId are mutually exclusive' })

export const assistantTaskCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('continue'),
    clientId: uuid,
    expectedRequestId: uuid,
    request: z.string().trim().min(1).max(20_000),
    mode: z.enum(['steer', 'follow-up']).default('steer'),
  }),
  z.object({
    operation: z.literal('retry'),
    clientId: uuid,
    expectedRequestId: uuid,
    request: z.string().trim().min(1).max(20_000),
    mode: z.enum(['steer', 'follow-up']).default('steer'),
  }),
  z.object({
    operation: z.literal('cancel'),
    clientId: uuid,
    expectedRequestId: uuid,
    reason: z.string().trim().min(1).max(2000).optional(),
  }),
])
type TaskCommand = z.infer<typeof assistantTaskCommandSchema>
type Task = typeof assistantTasks.$inferSelect

/** Continue, retry with an available owned helper, or cancel exactly one request generation. */
export async function changeAssistantTask(
  identity: Identity | undefined,
  conversationId: string,
  taskId: string,
  request: unknown
) {
  const parsed = assistantTaskCommandSchema.safeParse(request)
  if (!parsed.success) throw taskError(400, { message: 'Invalid Assistant task command' })
  const { conversation } = await requireAssistantConversation(identity, conversationId)
  const [task] = uuid.safeParse(taskId).success
    ? await db
        .select()
        .from(assistantTasks)
        .where(and(eq(assistantTasks.id, taskId), eq(assistantTasks.conversationId, conversation.id)))
    : []
  if (!task) throw taskError(404, { message: 'Task not found' })
  const command = parsed.data
  const input = {
    clientId: command.clientId,
    request:
      command.operation === 'cancel'
        ? `Cancel only task ${task.id}. Stop its work and preserve unrelated tasks.${command.reason ? ` Reason: ${command.reason}` : ''}`
        : command.request,
    mode: command.operation === 'cancel' ? ('steer' as const) : command.mode,
  }
  return dispatchAssistantTaskRequest(identity, conversationId, input, { command, task })
}

// This boundary is also called by in-process Assistant tools, without HTTP middleware.
export async function requireAssistantConversation(identity: Identity | undefined, conversationId: string) {
  const user = await resolveActingUser(identity)
  if (!user) throw taskError(403, { message: 'Forbidden' })
  const [active] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, user.userId), isNull(users.disabledAt)))
  if (!active || !(await hasPermission(user, 'chat:send'))) throw taskError(403, { message: 'Forbidden' })
  const [conversation] = uuid.safeParse(conversationId).success
    ? await db
        .select()
        .from(assistantConversations)
        .where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.ownerUserId, user.userId)))
    : []
  if (!conversation) throw taskError(404, { message: 'Conversation not found' })
  return { user, conversation }
}

function receiptFor(message: InboxMessage): AssistantMessageReceipt {
  const taskId = message.metadata[ASSISTANT_TASK_ID_KEY]
  const delegation = assistantDelegationSchema.safeParse(message.metadata[ASSISTANT_DELEGATION_KEY])
  if (typeof taskId !== 'string' || !delegation.success) throw taskError(500, { message: 'Task receipt unavailable' })
  return {
    id: message.id,
    taskId,
    agentId: message.recipientId,
    delivered: Boolean(message.deliveredAt),
    kind: delegation.data.kind,
    ...(delegation.data.kind === 'squad' && delegation.data.squadId ? { squadId: delegation.data.squadId } : {}),
  }
}

/** Start independent work, or answer one task update. Steer remains the default for shared delegates. */
export async function sendAssistantTaskRequest(
  identity: Identity | undefined,
  conversationId: string,
  request: unknown
): Promise<AssistantMessageReceipt> {
  const receipt = await dispatchAssistantTaskRequest(identity, conversationId, request)
  const input = assistantMessageSchema.parse(request)
  if (input.inReplyTo) {
    const { conversation } = await requireAssistantConversation(identity, conversationId)
    if (conversation.agentId) {
      const [saved] = await db
        .insert(messages)
        .values({
          id: receipt.id,
          agentId: conversation.agentId,
          role: 'human',
          content: input.request,
          metadata: {
            clientId: `assistant-answer:${receipt.id}`,
            source: 'assistant_task_answer',
            assistantTaskIds: [receipt.taskId],
          },
        })
        .onConflictDoNothing()
        .returning()
      if (saved) eventEmitter.emit('message.created', messageEventData(mapMessage(saved)))
    }
  }
  return receipt
}

async function dispatchAssistantTaskRequest(
  identity: Identity | undefined,
  conversationId: string,
  request: unknown,
  action?: { command: TaskCommand; task: Task }
): Promise<AssistantMessageReceipt> {
  const parsed = assistantMessageSchema.safeParse(request)
  if (!parsed.success) throw taskError(400, { message: 'Invalid Assistant request' })
  const input: z.infer<typeof assistantMessageSchema> = JSON.parse(JSON.stringify(parsed.data))
  const { user, conversation } = await requireAssistantConversation(identity, conversationId)
  const snapshot = action ? JSON.parse(JSON.stringify({ taskId: action.task.id, ...action.command })) : input
  const mutation: AssistantTaskMutation | undefined = action
    ? {
        operation: action.command.operation,
        taskId: action.task.id,
        expectedRequestId: action.command.expectedRequestId,
      }
    : undefined
  const idempotencyKey = `${assistantInboxRecipientId(conversation.id)}:${input.clientId}`
  // Adopt a committed request before inspecting mutable editor content or replacing a helper.
  // Authorization is still current: knowing an old client ID never restores revoked access.
  const accepted = await InboxMessage.findByIdempotencyKey(idempotencyKey)
  if (accepted && accepted.metadata[ASSISTANT_REQUEST_KEY] !== undefined) {
    if (!isDeepStrictEqual(accepted.metadata[ASSISTANT_REQUEST_KEY], snapshot))
      throw taskError(409, { message: 'Message receipt conflicts with this request' })
    const receipt = receiptFor(accepted)
    if (receipt.kind === 'squad') await requireConsultantCreationAccess(user, receipt.squadId!)
    if (receipt.kind === 'agent') {
      const target = await Agent.find(receipt.agentId)
      if (
        (!target && action?.command.operation !== 'cancel') ||
        (target && !(await hasAgentResourcePermission(user, target, 'chat:send')))
      )
        throw taskError(404, { message: 'Agent not found' })
    }
    return receipt
  }
  if (action && action.task.currentRequestId !== action.command.expectedRequestId)
    throw taskError(409, { message: 'This task has a newer request. Refresh before continuing.' })
  const address = assistantInboxRecipientId(conversation.id)
  const requestContent =
    conversation.editor && !conversation.editor.closed
      ? `${input.request}\n\n${assistantEditorContext(conversation.editor)}\n\n[Page editor conversation: brainstorm or edit the draft using read and edit. Read the latest draft before edits. Do not modify or publish saved presets via CLI or other tools; valid edits apply automatically and can be undone; the user saves to publish.]`
      : input.request
  // Validate replies before resolving or creating a helper. A reply always addresses its actual
  // sender, even if that helper has since become dormant or its scope has been replaced.
  const [reply] = input.inReplyTo
    ? await db
        .select({ senderId: inbox.senderId })
        .from(inbox)
        .where(
          and(
            eq(inbox.id, input.inReplyTo),
            eq(inbox.recipientType, 'voice_assistant'),
            eq(inbox.recipientId, address),
            eq(inbox.senderType, 'agent')
          )
        )
    : []
  const replyAgentId = reply?.senderId
  if (input.inReplyTo && (!replyAgentId || (input.agentId && replyAgentId !== input.agentId)))
    throw taskError(404, { message: 'Reply not found in this conversation' })
  let agent: Agent | null
  let kind: AssistantMessageReceipt['kind']
  let targetSquadId: string | null = null
  let cancelledRecipientId: string | undefined
  if (action) {
    const { task, command } = action
    kind = task.kind
    targetSquadId = task.squadId
    if (task.kind === 'squad') {
      if (!task.squadId) throw taskError(409, { message: 'Task squad is unavailable' })
      await requireConsultantCreationAccess(user, task.squadId)
    }
    agent = task.agentId ? await Agent.find(task.agentId) : null
    if (task.kind === 'agent' && agent && !(await hasAgentResourcePermission(user, agent, 'chat:send')))
      throw taskError(404, { message: 'Agent not found' })
    if (command.operation === 'cancel') {
      const [original] = await db
        .select({ recipientId: inbox.recipientId })
        .from(inbox)
        .where(eq(inbox.id, command.expectedRequestId))
      if (!original) throw taskError(409, { message: 'Task request is unavailable' })
      cancelledRecipientId = original.recipientId
    } else if (command.operation === 'retry' && task.kind !== 'agent') {
      const afterCommit: Array<() => void> = []
      agent = await db.transaction(async (tx) => {
        await tx
          .select({ id: assistantConversations.id })
          .from(assistantConversations)
          .where(eq(assistantConversations.id, conversation.id))
          .for('update')
        return resolveOwnedAgent(tx, conversation, { squadId: task.squadId }, afterCommit)
      })
      for (const emit of afterCommit) emit()
    } else if (!agent || agent.status === 'terminated') {
      throw taskError(409, {
        message:
          task.kind === 'agent'
            ? 'Task agent is unavailable. Start a new task with another agent.'
            : 'Task helper is unavailable. Retry this task to recover it.',
      })
    }
  } else if (input.agentId) {
    agent = await Agent.find(input.agentId)
    if (!agent || !(await hasAgentResourcePermission(user, agent, 'chat:send')))
      throw taskError(404, { message: 'Agent not found' })
    kind = 'agent'
  } else {
    let squadId = input.squadId ?? null
    if (replyAgentId) {
      const [ownedAgent] = await db
        .select({ squadId: assistantConversationAgents.squadId })
        .from(assistantConversationAgents)
        .where(
          and(
            eq(assistantConversationAgents.conversationId, conversation.id),
            eq(assistantConversationAgents.agentId, replyAgentId)
          )
        )
      if (!ownedAgent)
        throw taskError(409, {
          message: 'This task helper is no longer attached. Start a new task without inReplyTo.',
        })
      if (input.squadId && input.squadId !== ownedAgent.squadId)
        throw taskError(404, { message: 'Reply not found in this conversation' })
      squadId = ownedAgent.squadId
    }
    // Explicit scopes and reply-inferred scopes pass through the same current authorization check.
    if (squadId) {
      await requireConsultantCreationAccess(user, squadId)
    }
    targetSquadId = squadId
    const afterCommit: Array<() => void> = []
    agent = replyAgentId
      ? await Agent.find(replyAgentId)
      : await db.transaction(async (tx) => {
          await tx
            .select({ id: assistantConversations.id })
            .from(assistantConversations)
            .where(eq(assistantConversations.id, conversation.id))
            .for('update')
          return resolveOwnedAgent(tx, conversation, { squadId }, afterCommit)
        })
    for (const emit of afterCommit) emit()
    kind = squadId ? 'squad' : 'background'
  }
  if (!agent && !cancelledRecipientId) throw taskError(404, { message: 'Agent not found' })
  if (replyAgentId && agent?.status === 'terminated')
    throw taskError(409, { message: 'This task helper was terminated. Start a new task without inReplyTo.' })
  const agentId = cancelledRecipientId ?? agent!.id
  const history = await db
    .select()
    .from(assistantEntries)
    .where(eq(assistantEntries.conversationId, conversation.id))
    .orderBy(desc(assistantEntries.position))
    .limit(24)
  const [previous] = await db
    .select({ pagePath: sql<string>`${inbox.metadata}->>'pagePath'` })
    .from(inbox)
    .where(
      and(
        eq(inbox.senderType, 'voice_assistant'),
        eq(inbox.senderId, address),
        eq(inbox.recipientId, agentId),
        sql`${inbox.metadata}->>'pagePath' IS NOT NULL`
      )
    )
    .orderBy(desc(inbox.createdAt))
    .limit(1)
  const { message } = await InboxMessage.sendOnce(
    {
      recipientType: 'agent',
      recipientId: agentId,
      senderType: 'voice_assistant',
      senderId: address,
      content: requestContent,
      deliveryMode: input.mode,
      assistantRequest: snapshot,
      assistantTaskMutation: mutation,
      metadata: {
        source: 'assistant_inbox',
        inReplyTo: input.inReplyTo,
        [ASSISTANT_DELEGATION_KEY]: { kind, squadId: targetSquadId, ...(input.label ? { label: input.label } : {}) },
        ...(input.pagePath && previous?.pagePath !== input.pagePath ? { pagePath: input.pagePath } : {}),
        assistantContext: history.reverse().map(({ entry }) => ({
          role: (entry as AssistantEntry).role,
          text: (entry as AssistantEntry).text.slice(-3000),
        })),
      },
    },
    idempotencyKey
  )
  if (
    message.metadata[ASSISTANT_REQUEST_KEY] !== undefined
      ? !isDeepStrictEqual(message.metadata[ASSISTANT_REQUEST_KEY], snapshot)
      : message.content !== requestContent ||
        message.recipientId !== agentId ||
        message.deliveryMode !== input.mode ||
        (message.metadata?.inReplyTo ?? undefined) !== input.inReplyTo
  )
    throw taskError(409, { message: 'Message receipt conflicts with this request' })
  return receiptFor(message)
}
