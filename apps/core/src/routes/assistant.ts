import { listedAssistantConversation } from '../services/assistant-conversation-query'
import { ensureAssistantConversationAgent } from '../services/assistant-conversation-agent'
import {
  assistantMessageSchema,
  sendAssistantTaskRequest,
  assistantTaskCommandSchema,
  changeAssistantTask,
} from '../services/assistant-task-requests'
import {
  syncAssistantEditor,
  readAssistantEditor,
  proposeAssistantEditor,
  closeAssistantEditor,
} from '../services/assistant-editors'
import { assistantEditorSyncSchema, assistantEditorProposalSchema } from '@ficus/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { HTTPException } from 'hono/http-exception'
import { isDeepStrictEqual } from 'node:util'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, ilike, isNull, notInArray, sql } from 'drizzle-orm'
import {
  ASSISTANT_CONVERSATION_KINDS,
  assistantEntrySchema,
  type AssistantEntry,
  type AssistantMailbox,
} from '@ficus/shared'
import { assistantConversations, assistantEntries, assistantTasks, assistantUpdates, db, inbox, agents } from '../db'
import { assistantActivityRouter } from './assistant-activity'
import { markAssistantUpdatesProcessed } from '../services/assistant-activity/acknowledge'
import { resolveActingUser } from '../services/rbac'
import { requirePermission } from '../middleware/require-permission'

const uuid = z.string().uuid()
const createSchema = z.object({
  id: uuid,
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(ASSISTANT_CONVERSATION_KINDS).default('assistant'),
})
const appendSchema = z.object({ entries: z.array(assistantEntrySchema).min(1).max(50) })
// Every lookup includes the current human owner, including when called by their system manager.
async function owned(id: string, userId: string) {
  if (!uuid.safeParse(id).success) return null
  const [conversation] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.id, id), eq(assistantConversations.ownerUserId, userId)))
  return conversation ?? null
}
export const assistantRouter = new Hono<{ Variables: { assistantOwner: string } }>()
  .use('*', requirePermission('chat:send'))
  .use('*', async (c, next) => {
    const user = await resolveActingUser(c.get('identity'))
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    c.set('assistantOwner', user.userId)
    await next()
  })
  .get(
    '/',
    zValidator(
      'query',
      z.object({
        q: z.string().max(120).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
      })
    ),
    async (c) => {
      const { q: query, limit, offset } = c.req.valid('query')
      const rows = await db
        .select()
        .from(assistantConversations)
        .where(
          and(
            eq(assistantConversations.ownerUserId, c.get('assistantOwner')),
            query ? ilike(assistantConversations.title, `%${query.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
            // Page-editor conversations belong to their page, not the app-wide Assistant, and empty
            // shells (unused drafts) are not conversations yet.
            listedAssistantConversation()
          )
        )
        .orderBy(desc(assistantConversations.updatedAt), desc(assistantConversations.id))
        .limit(limit + 1)
        .offset(offset)
      return c.json({ conversations: rows.slice(0, limit), hasMore: rows.length > limit })
    }
  )
  .post('/', zValidator('json', createSchema), async (c) => {
    const input = c.req.valid('json')
    await db
      .insert(assistantConversations)
      .values({ ...input, ownerUserId: c.get('assistantOwner') })
      .onConflictDoNothing()
    const row = await owned(input.id, c.get('assistantOwner'))
    if (!row) return c.json({ error: 'Conversation not found' }, 404)
    return c.json(row)
  })
  // Activity discovery registers before `/:id` so `/activity` is never read as a conversation ID.
  .route('/', assistantActivityRouter)
  .get('/:id', zValidator('query', z.object({ before: z.coerce.number().int().positive().optional() })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const before = c.req.valid('query').before
    const rows = await db
      .select()
      .from(assistantEntries)
      .where(
        and(
          eq(assistantEntries.conversationId, conversation.id),
          before !== undefined ? sql`${assistantEntries.position} < ${before}` : undefined
        )
      )
      .orderBy(desc(assistantEntries.position))
      .limit(101)
    const history = rows.slice(0, 100).reverse()
    return c.json({
      conversation,
      entries: history.map((row) => row.entry),
      hasMore: rows.length > 100,
      before: history[0]?.position,
    })
  })
  .put('/:id/editor', zValidator('json', assistantEditorSyncSchema), async (c) =>
    c.json(
      await syncAssistantEditor(
        c.req.param('id'),
        { userId: c.get('assistantOwner'), identity: c.get('identity') },
        c.req.valid('json')
      )
    )
  )
  .get('/:id/editor', async (c) =>
    c.json(
      await readAssistantEditor(c.req.param('id'), { userId: c.get('assistantOwner'), identity: c.get('identity') })
    )
  )
  .post('/:id/editor/propose', zValidator('json', assistantEditorProposalSchema), async (c) =>
    c.json(
      await proposeAssistantEditor(
        c.req.param('id'),
        { userId: c.get('assistantOwner'), identity: c.get('identity') },
        c.req.valid('json')
      )
    )
  )
  .delete('/:id/editor', async (c) =>
    c.json(
      await closeAssistantEditor(c.req.param('id'), { userId: c.get('assistantOwner'), identity: c.get('identity') })
    )
  )
  .post('/:id/entries', zValidator('json', appendSchema), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const input = c.req.valid('json')
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(assistantConversations)
        .where(eq(assistantConversations.id, conversation.id))
        .for('update')
      const [last] = await tx
        .select({ position: assistantEntries.position })
        .from(assistantEntries)
        .where(eq(assistantEntries.conversationId, conversation.id))
        .orderBy(desc(assistantEntries.position))
        .limit(1)
      let position = last?.position ?? 0
      let changed = false
      for (const entry of input.entries) {
        const [previous] = await tx
          .select()
          .from(assistantEntries)
          .where(and(eq(assistantEntries.conversationId, conversation.id), eq(assistantEntries.clientId, entry.id)))
        if (previous) {
          const prior = previous.entry as AssistantEntry
          if (isDeepStrictEqual(prior, entry)) continue
          // Partial entries reserve their place. Completing them cannot rewrite a saved turn's identity.
          if (
            prior.final ||
            !entry.final ||
            prior.role !== entry.role ||
            prior.toolCallId !== entry.toolCallId ||
            prior.toolName !== entry.toolName
          ) {
            throw new HTTPException(409, { message: 'Saved entry conflicts with this request' })
          }
          await tx.update(assistantEntries).set({ entry }).where(eq(assistantEntries.id, previous.id))
        } else {
          await tx
            .insert(assistantEntries)
            .values({ conversationId: conversation.id, clientId: entry.id, position: ++position, entry })
        }
        changed = true
      }
      if (changed) {
        const firstUser = input.entries.find((entry) => entry.role === 'user' && entry.final && entry.text.trim())
        await tx
          .update(assistantConversations)
          .set({
            updatedAt: new Date(),
            ...(locked.title === 'New conversation' && firstUser ? { title: firstUser.text.trim().slice(0, 120) } : {}),
          })
          .where(eq(assistantConversations.id, conversation.id))
      }
    })
    return c.json({ success: true })
  })
  .post('/:id/agent', async (c) => c.json(await ensureAssistantConversationAgent(c.get('identity'), c.req.param('id'))))
  .post('/:id/messages', zValidator('json', assistantMessageSchema), async (c) =>
    c.json(await sendAssistantTaskRequest(c.get('identity'), c.req.param('id'), c.req.valid('json')))
  )
  .post('/:id/tasks/:taskId/commands', zValidator('json', assistantTaskCommandSchema), async (c) => {
    try {
      return c.json(
        await changeAssistantTask(c.get('identity'), c.req.param('id'), c.req.param('taskId'), c.req.valid('json'))
      )
    } catch (error) {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
      throw error
    }
  })
  .post('/:id/inbox', zValidator('json', z.object({ consumerId: uuid })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    const { consumerId } = c.req.valid('json')
    // One active receiver across devices. DB time owns both lease creation and expiry.
    const [lease] = await db
      .update(assistantConversations)
      .set({
        inboxConsumerId: consumerId,
        inboxConsumerExpiresAt: sql`now() + interval '30 seconds'`,
      })
      .where(
        and(
          eq(assistantConversations.id, conversation.id),
          sql`(
      ${assistantConversations.inboxConsumerId} = ${consumerId} OR
      ${assistantConversations.inboxConsumerExpiresAt} IS NULL OR
      ${assistantConversations.inboxConsumerExpiresAt} <= now()
    )`
        )
      )
      .returning({ id: assistantConversations.id })
    if (!lease) return c.json({ acquired: false, messages: [], pending: 0, unavailable: false })
    // Unprocessed means Realtime has not presented it; it says nothing about whether the human saw it.
    const incoming = await db
      .select({ update: assistantUpdates, inbox })
      .from(assistantUpdates)
      .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
      .where(and(eq(assistantUpdates.conversationId, conversation.id), isNull(assistantUpdates.processedAt)))
      .orderBy(asc(assistantUpdates.sequence))
      .limit(50)
    // A task stays pending until its delegate explicitly finishes it; progress replies do not end it.
    const pending = await db
      .select({ id: assistantTasks.id, status: agents.status })
      .from(assistantTasks)
      .leftJoin(agents, eq(agents.id, assistantTasks.agentId))
      .where(
        and(
          eq(assistantTasks.conversationId, conversation.id),
          notInArray(assistantTasks.status, ['completed', 'failed', 'cancelled'])
        )
      )
    const mailbox: AssistantMailbox = {
      acquired: true,
      messages: incoming.map(({ update, inbox: message }) => ({
        messageId: message.id,
        taskId: update.taskId,
        requestId: update.requestId,
        sequence: update.sequence,
        reportedStatus: update.reportedStatus,
        content: message.content,
        subject: message.subject,
        senderId: message.senderId,
        senderName:
          (message.metadata.sender as { name?: string; agentTypeName?: string })?.name ||
          (message.metadata.sender as { agentTypeName?: string })?.agentTypeName ||
          'Agent',
        processedAt: null,
        seenAt: update.seenAt?.toISOString() ?? null,
        createdAt: message.createdAt.toISOString(),
      })),
      pending: pending.length,
      unavailable: pending.some((row) => !row.status || row.status === 'terminated'),
    }
    return c.json(mailbox)
  })
  .post(
    '/:id/inbox/ack',
    zValidator(
      'json',
      z.object({
        consumerId: uuid,
        messageIds: z.array(uuid).min(1).max(10),
        responseEntryId: z.string().min(1).max(160),
      })
    ),
    async (c) => {
      const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
      if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
      const result = await markAssistantUpdatesProcessed(conversation.id, c.req.valid('json'))
      return result.ok ? c.json({ success: true }) : c.json({ error: result.message, reason: result.reason }, 409)
    }
  )
  .post('/:id/inbox/release', zValidator('json', z.object({ consumerId: uuid })), async (c) => {
    const conversation = await owned(c.req.param('id'), c.get('assistantOwner'))
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    await db
      .update(assistantConversations)
      .set({ inboxConsumerId: null, inboxConsumerExpiresAt: null })
      .where(
        and(
          eq(assistantConversations.id, conversation.id),
          eq(assistantConversations.inboxConsumerId, c.req.valid('json').consumerId)
        )
      )
    return c.json({ success: true })
  })
