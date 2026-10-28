import { and, eq, inArray } from 'drizzle-orm'
import { db, assistantUpdates, assistantConversations, assistantTasks, inbox } from '../db'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '../lib/zod-validator'
import { markAssistantUpdatesSeen } from '../services/assistant-activity/acknowledge'
import {
  listAssistantActivity,
  readAssistantActivity,
  toAssistantActivityUpdate,
} from '../services/assistant-activity/read'

const uuid = z.uuid()
const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
})
const detailQuerySchema = z.object({ beforeSequence: z.coerce.number().int().min(1).optional() })
const seenSchema = z.object({ messageIds: z.array(uuid).min(1).max(50) })
const seenThroughSchema = z.object({ sequence: z.int().min(0) })

/**
 * Read-only activity discovery plus human acknowledgment. Mounted inside the Assistant router
 * before its `/:id` routes so `/activity` is never captured as a conversation ID. Owner scoping
 * and `chat:send` come from the parent middleware. Nothing here leases a mailbox, seeds an agent,
 * or runs a model.
 */
export const assistantActivityRouter = new Hono<{ Variables: { assistantOwner: string } }>()
  .get('/activity', zValidator('query', activityQuerySchema), async (c) =>
    c.json(await listAssistantActivity(c.get('assistantOwner'), c.req.valid('query')))
  )
  .post('/:id/updates/read', zValidator('json', seenSchema), async (c) => {
    const id = c.req.param('id')
    if (!uuid.safeParse(id).success) return c.json({ error: 'Conversation not found' }, 404)
    const rows = await db
      .select({ update: assistantUpdates, message: inbox, taskLabel: assistantTasks.label })
      .from(assistantUpdates)
      .innerJoin(assistantConversations, eq(assistantConversations.id, assistantUpdates.conversationId))
      .innerJoin(inbox, eq(inbox.id, assistantUpdates.messageId))
      .leftJoin(assistantTasks, eq(assistantTasks.id, assistantUpdates.taskId))
      .where(
        and(
          eq(assistantConversations.id, id),
          eq(assistantConversations.ownerUserId, c.get('assistantOwner')),
          inArray(assistantUpdates.messageId, c.req.valid('json').messageIds)
        )
      )
    if (rows.length !== new Set(c.req.valid('json').messageIds).size) return c.json({ error: 'Update not found' }, 404)
    return c.json(rows.map((row) => ({ ...toAssistantActivityUpdate(row), taskLabel: row.taskLabel ?? null })))
  })
  .get('/:id/activity', zValidator('query', detailQuerySchema), async (c) => {
    const id = c.req.param('id')
    if (!uuid.safeParse(id).success) return c.json({ error: 'Conversation not found' }, 404)
    const detail = await readAssistantActivity(c.get('assistantOwner'), id, c.req.valid('query').beforeSequence)
    return detail ? c.json(detail) : c.json({ error: 'Conversation not found' }, 404)
  })
  .post('/:id/updates/seen', zValidator('json', seenSchema), async (c) => {
    const id = c.req.param('id')
    if (!uuid.safeParse(id).success) return c.json({ error: 'Conversation not found' }, 404)
    const result = await markAssistantUpdatesSeen(c.get('assistantOwner'), id, c.req.valid('json'))
    if (result.ok) return c.json({ success: true })
    return result.reason === 'not-found'
      ? c.json({ error: 'Conversation not found' }, 404)
      : c.json({ error: 'Every update must belong to this conversation' }, 400)
  })
  .post('/:id/updates/seen-through', zValidator('json', seenThroughSchema), async (c) => {
    const id = c.req.param('id')
    if (!uuid.safeParse(id).success) return c.json({ error: 'Conversation not found' }, 404)
    const result = await markAssistantUpdatesSeen(c.get('assistantOwner'), id, {
      throughSequence: c.req.valid('json').sequence,
    })
    return result.ok ? c.json({ success: true }) : c.json({ error: 'Conversation not found' }, 404)
  })
