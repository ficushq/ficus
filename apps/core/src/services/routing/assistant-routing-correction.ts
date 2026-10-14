import { and, eq, ne, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import {
  assistantRoutingCorrectionRequestSchema,
  assistantRoutingExcerpt,
  assistantRoutingLabel,
  effectiveAssistantRouting,
  type AssistantRoutingHint,
  type AssistantRoutingTarget,
  type MessageMetadata,
} from '@ficus/shared'
import { db, messages } from '../../db'
import { jsonbObjectRecovered } from '../../db/jsonb'
import { Agent } from '../../entities/Agent'
import { mapMessage } from '../../entities/message-mapper'
import { messageEventData } from '../../entities/message-event'
import { User } from '../../entities/User'
import { eventEmitter } from '../../lib/infra/event-emitter'
import { requireAssistantConversation } from '../assistant-task-requests'
import type { Identity } from '../rbac'
import { listRoutableSquads, type RoutingSquad } from './assistant-routing'
import { captureRoutingCorrection } from './routing-eval-capture'

function fail(status: 400 | 404 | 409, message: string) {
  return new HTTPException(status, { message, res: Response.json({ error: message }, { status }) })
}

const sameTarget = (a: AssistantRoutingTarget, b: AssistantRoutingTarget) =>
  (a.scope === 'squad' ? a.squadId : 'none') === (b.scope === 'squad' ? b.squadId : 'none')

/**
 * The user picked a different squad (or no squad) for their latest Assistant message. Saves the
 * pick on the message, so its chip shows it, and tells the Assistant with a short system message
 * that also carries the correction to the model (see `assistantRoutingCorrectionNote`).
 *
 * Only the latest message can be corrected: by then older messages' work has gone somewhere, and
 * nothing ties a message to the tasks it led to, so moving it is a request the user sends instead.
 */
export async function correctAssistantRouting(
  identity: Identity | undefined,
  conversationId: string,
  request: unknown,
  deps: { listSquads?: (identity: Identity) => Promise<RoutingSquad[]> } = {}
): Promise<{ hint: AssistantRoutingHint }> {
  const parsed = assistantRoutingCorrectionRequestSchema.safeParse(request)
  if (!parsed.success) throw fail(400, 'Invalid routing correction')
  const input = parsed.data
  const { user, conversation } = await requireAssistantConversation(identity, conversationId)
  if (!conversation.agentId) throw fail(404, 'Message not found')
  const [row] = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.id, input.messageId), eq(messages.agentId, conversation.agentId), eq(messages.role, 'human'))
    )
  const metadata = (row?.metadata ?? null) as MessageMetadata | null
  if (!row || metadata?.source !== 'user_chat') throw fail(404, 'Message not found')
  const previous = metadata.assistantRouting
  if (!previous) throw fail(409, 'This message has no routing hint')
  const [later] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, conversation.agentId),
        eq(messages.role, 'human'),
        ne(messages.id, row.id),
        sql`${messages.metadata}->>'source' = 'user_chat'`,
        // Compared in SQL: a JS Date drops the microseconds Postgres keeps.
        sql`(${messages.createdAt}, coalesce(${messages.enqueueOrder}, 0)) > (select created_at, coalesce(enqueue_order, 0) from messages where id = ${row.id})`
      )
    )
    .limit(1)
  if (later) throw fail(409, 'Only your latest message can change squad. Ask the Assistant to move older work.')

  let target: AssistantRoutingTarget = { scope: 'none' }
  if (input.scope === 'squad') {
    const squad = (await (deps.listSquads ?? listRoutableSquads)(user)).find((entry) => entry.id === input.squadId)
    if (!squad) throw fail(404, 'Squad not found')
    target = { scope: 'squad', squadId: squad.id, squadName: squad.name }
  }
  if (sameTarget(effectiveAssistantRouting(previous), target)) return { hint: previous }

  const hint: AssistantRoutingHint = { ...previous, correction: { ...target, at: new Date().toISOString() } }
  const [saved] = await db
    .update(messages)
    .set({
      metadata: sql<MessageMetadata>`${jsonbObjectRecovered(messages.metadata)} || jsonb_build_object('assistantRouting', ${JSON.stringify(hint)}::jsonb)`,
    })
    .where(eq(messages.id, row.id))
    .returning()
  if (saved) eventEmitter.emit('message.updated', messageEventData(mapMessage(saved)))
  void captureRoutingCorrection({
    identity: user,
    agentId: conversation.agentId,
    sentAt: row.createdAt,
    text: row.content,
    target,
    source: 'routing-pill',
  })

  const agent = await Agent.find(conversation.agentId)
  if (!agent) throw fail(404, 'Message not found')
  const account = await User.findById(user.userId).catch(() => null)
  await agent.sendMessage(
    target.scope === 'squad'
      ? `[System] You said this is for ${assistantRoutingLabel(target)}.`
      : '[System] You said this is not for a squad.',
    {
      deliveryMode: 'steer',
      metadata: {
        source: 'assistant_routing_correction',
        clientId: input.clientId,
        sender: { userId: user.userId, name: account?.displayName || account?.email || 'a user' },
        assistantRoutingCorrection: { messageId: row.id, excerpt: assistantRoutingExcerpt(row.content), ...target },
      },
    }
  )
  return { hint }
}
