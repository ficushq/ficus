import { assistantConversations, db } from '../db'
import { eq, sql } from 'drizzle-orm'
import { HTTPException } from 'hono/http-exception'
import { requireConsultantCreationAccess } from '../services/chat/consultant-access'
import { findOrCreateConsultant } from '../services/chat/consultant'
import { resolveActingUser } from '../services/rbac'
import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { chatRequestSchema } from '@ficus/shared'
import { getProxyWorkerSSE } from '../services/streaming/sse-proxy'
import { Agent } from '../entities/Agent'
import { User } from '../entities/User'
import { InvalidAttachmentError } from '../services/attachments/agent-scope'
import { ARTIFACT_BUILDER_RUNNER_TYPE } from '../entities/agent-runners/constants'
import { hasAgentResourcePermission, hasPermission, identityUserId } from '../services/rbac'
import { ChatIdempotencyConflictError, consultantAgentId } from '../services/chat/consultant-idempotency'
import type { Identity } from '../services/rbac'

const IMAGE_UNSUPPORTED_ERROR = 'This model does not support image input. Use a vision-capable model.'

class ImageInputUnsupportedError extends Error {}

function getInitialScopeForAgent(agent: Agent): { type: string; id?: string } {
  if (agent.runnerType === ARTIFACT_BUILDER_RUNNER_TYPE) {
    return { type: ARTIFACT_BUILDER_RUNNER_TYPE }
  }
  return { type: 'system-manager' }
}

async function canSendChat(identity: Identity | undefined, squadId: string | null): Promise<Response | null> {
  if (!identity) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  const allowed = squadId
    ? await hasPermission(identity, 'chat:send', squadId)
    : await hasPermission(identity, 'chat:send')
  return allowed ? null : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
}

export const chatRouter = new Hono().post('/', zValidator('json', chatRequestSchema), async (c) => {
  const input = c.req.valid('json')

  try {
    let agent: Agent
    let scope: { type: string; id?: string }

    if (input.agentId) {
      const existingAgent = await Agent.find(input.agentId)
      if (!existingAgent) {
        return c.json({ error: 'Agent not found' }, 404)
      }
      if (existingAgent.runnerType === 'system-manager') {
        const actor = await resolveActingUser(c.get('identity'))
        if (!actor || !(await hasAgentResourcePermission(actor, existingAgent, 'chat:send')))
          return c.json({ error: 'Agent not found' }, 404)
      }
      const denial = await canSendChat(c.get('identity'), existingAgent.squadId)
      if (denial) return denial
      c.set('authzChecked', true)
      agent = existingAgent
      const ctx = agent.context as Record<string, any>
      scope =
        agent.runnerType === ARTIFACT_BUILDER_RUNNER_TYPE
          ? getInitialScopeForAgent(agent)
          : (ctx.scope ?? getInitialScopeForAgent(agent))
    } else {
      // Find or create system-manager agent for this scope
      const scopeType = input.scope?.type ?? 'system-manager'
      const scopeId = input.scope?.id

      if (scopeType !== 'system-manager' && !scopeId) {
        return c.json({ error: 'Scope ID is required for non-system-manager scopes' }, 400)
      }

      scope = { type: scopeType, id: scopeId }
      const denial = await canSendChat(c.get('identity'), scopeType === 'system-manager' ? null : (scopeId ?? null))
      if (denial) return denial
      c.set('authzChecked', true)

      const identity = c.get('identity') as Identity | undefined
      // Private system-managers are owned by the creating user (inherits their perms).
      const ownerUserId = (await resolveActingUser(identity))?.userId

      if (scopeType === 'consultant') {
        await requireConsultantCreationAccess(identity, scopeId!)
        const actorUserId = identity ? identityUserId(identity) : null
        if (input.imageIds?.length && (!input.clientId || !actorUserId)) {
          return c.json({ error: 'Image attachments require an authenticated client send ID' }, 400)
        }
        // A client-keyed create is deterministic so lost responses and concurrent
        // requests converge on one consultant; legacy unkeyed text creates stay fresh.
        agent =
          input.clientId && actorUserId
            ? await findOrCreateConsultant(
                consultantAgentId({ actorUserId, squadId: scopeId!, clientId: input.clientId }),
                scopeId!
              )
            : await Agent.create({
                agentTypeId: 'consultant',
                squadId: scopeId,
                context: { scope },
                persist: false,
              })
      } else if (scopeId) {
        // For scoped chats (task, heartbeat), find or create agent for this specific scope
        const existing = await Agent.list(
          {
            agentTypeId: 'system-manager',
            scopeType,
            scopeId,
          },
          'latestMessage'
        )

        if (existing.length > 0) {
          agent = existing[0]
        } else {
          agent = await Agent.create({
            agentTypeId: 'system-manager',
            ownerUserId,
            context: { scope },
          })
        }
      } else {
        // For system-manager chats (no scopeId), always create a new agent
        agent = await Agent.create({
          agentTypeId: 'system-manager',
          ownerUserId,
          context: { scope },
        })
      }
    }

    // Attribute the message to the sending user so the agent knows who it's
    // talking to and the UI can label it — including the first message that
    // starts a brand-new conversation (mirrors the /message route).
    const senderIdentity = c.get('identity') as Identity | undefined
    let sender: { userId: string; name: string } | undefined
    if (senderIdentity?.type === 'user') {
      const user = await User.findById(senderIdentity.userId).catch(() => null)
      sender = { userId: senderIdentity.userId, name: user?.displayName || user?.email || 'a user' }
    }

    // Queue execution
    let execution
    try {
      execution = await agent.queueExecutionIdempotent({
        message: input.message,
        imageIds: input.imageIds,
        attachmentActorUserId: senderIdentity ? (identityUserId(senderIdentity) ?? undefined) : undefined,
        validateNewAcceptance: () => {
          if (input.imageIds?.length && agent.supportsSelectedModelImages() === false) {
            throw new ImageInputUnsupportedError(IMAGE_UNSUPPORTED_ERROR)
          }
        },
        // Export provenance is server-owned and only a resolved human direct chat qualifies.
        metadata: sender
          ? {
              ...(input.pagePath ? { pagePath: input.pagePath } : {}),
              source: 'user_chat',
              sender,
              ...(input.clientId ? { clientId: input.clientId } : {}),
              ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
            }
          : input.clientId || input.deliveryMode || input.pagePath
            ? {
                ...(input.pagePath ? { pagePath: input.pagePath } : {}),
                ...(input.clientId ? { clientId: input.clientId } : {}),
                ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
              }
            : undefined,
      })
    } catch (error) {
      if (error instanceof InvalidAttachmentError) return c.json({ error: 'Invalid attachment' }, 400)
      if (error instanceof ImageInputUnsupportedError) return c.json({ error: error.message }, 400)
      if (error instanceof ChatIdempotencyConflictError) return c.json({ error: error.message }, 409)
      return c.json(
        { error: `Failed to queue execution: ${error instanceof Error ? error.message : String(error)}` },
        500
      )
    }

    if (agent.agentTypeId === 'assistant')
      await db
        .update(assistantConversations)
        .set({
          updatedAt: new Date(),
          title: sql`CASE WHEN ${assistantConversations.title} = 'New conversation' THEN ${input.message.trim().slice(0, 120)} ELSE ${assistantConversations.title} END`,
        })
        .where(eq(assistantConversations.agentId, agent.id))

    // Disable reverse-proxy buffering (nginx & friends) so SSE tokens reach the client
    // in real time instead of arriving in one burst when the stream closes.
    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache, no-transform')
    // Return stream that proxies from worker
    return streamSSE(c, async (stream) =>
      withDeviceStreamRevocation(c.get('authContext'), stream, async (signal) => {
        // Send agent info immediately
        await stream.writeSSE({
          event: 'agent',
          data: JSON.stringify({
            type: 'agent',
            agentId: agent.id,
            scope,
            executionId: execution.id,
            executionStatus: execution.status,
          }),
        })

        if (execution.status === 'waiting-maintenance') {
          await stream.writeSSE({
            event: 'execution_phase',
            data: JSON.stringify({ type: 'execution_phase', phase: 'maintenance_queue' }),
          })
          return
        }

        await getProxyWorkerSSE(c)(stream, {
          workerPath: `/stream/${execution.id}`,
          signal,
        })
      })
    )
  } catch (error) {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    const message = error instanceof Error ? error.message : 'Unknown error'
    return c.json({ error: message }, error instanceof ChatIdempotencyConflictError ? 409 : 400)
  }
})
