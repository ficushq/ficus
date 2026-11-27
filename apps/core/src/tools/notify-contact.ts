/**
 * notify_contact Tool
 *
 * Allows agents to send important status updates to the right contact point.
 * For agents assigned to owner-managed work streams, the work stream owner is
 * the contact point; otherwise messages go to the human user's inbox.
 *
 * Use for important events that require attention:
 * - PR ready for review
 * - Work stream complete and ready for verification
 * - Blocked on external dependency
 */

import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { toolCallIdempotencyKey } from '@ficus/shared/node'
import { Agent } from '../entities/Agent'
import { InboxMessage, type SendInboxMessageInput } from '../entities/InboxMessage'
import { WorkStream } from '../entities/WorkStream'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('tools')

type NotifyTarget =
  | { kind: 'agent'; agentId: string; routedTo: 'work_stream_owner' | 'squad_manager'; workStreamId?: string }
  | { kind: 'system' }

const NotifyContactSchema = Type.Object({
  title: Type.String({ description: 'Short notification title (e.g., "PR Ready for Review")' }),
  message: Type.String({ description: 'Notification message body with details' }),
  url: Type.Optional(Type.String({ description: 'Optional URL to link to (e.g., PR URL, work stream)' })),
})

interface NotifyContactToolContext {
  agentId: string
  /** The running execution; with the tool call ID it makes each notification exactly-once. */
  executionId?: string
}

// Decide where an agent's notify_contact message should go. notify_contact is agent→agent
// coordination — it never targets a human directly (humans hear about work via work-stream status
// changes they're subscribed to). Routing:
// 1. the OWNER agent of an active owner-managed work stream (who relays to the human/channel), else
// 2. the agent's squad manager, else
// 3. the shared system inbox (don't silently drop the signal).
async function resolveNotifyTarget(agentId: string): Promise<NotifyTarget> {
  const workStreams = await WorkStream.findByAgent(agentId)
  const active = workStreams.filter((ws) => ws.status !== 'done' && ws.status !== 'canceled')

  const owned = active.find((ws) => ws.ownerAgentId && ws.ownerAgentId !== agentId)
  if (owned?.ownerAgentId)
    return { kind: 'agent', agentId: owned.ownerAgentId, routedTo: 'work_stream_owner', workStreamId: owned.id }

  const agent = await Agent.find(agentId)
  if (agent?.squadId) {
    const { Squad } = await import('../entities/Squad')
    const squad = await Squad.find(agent.squadId)
    const manager = squad ? await squad.getManagerAgent() : null
    if (manager && manager.id !== agentId) return { kind: 'agent', agentId: manager.id, routedTo: 'squad_manager' }
  }

  return { kind: 'system' }
}

/**
 * Create a notify_contact tool instance for an agent.
 */
export function createNotifyContactTool(ctx: NotifyContactToolContext): ToolDefinition {
  return {
    name: 'notify_contact',
    label: 'Notify Contact',
    description:
      'Send an inbox message to the right contact point. Use sparingly for important events.\n' +
      'If you are working on an owner-managed work stream, this notifies the work stream owner, ' +
      'who is responsible for updating the human or external channel when needed. Otherwise it notifies ' +
      'your squad manager. It never messages a human directly — humans follow work via work-stream status ' +
      'changes they subscribe to. Prefer status transitions (handoff/block/review/done) for normal updates.\n' +
      '- A PR has been opened and needs review\n' +
      '- A work stream is complete and ready for verification\n' +
      '- You are blocked and need intervention\n' +
      'Do NOT use for routine status updates.',
    parameters: NotifyContactSchema,
    async execute(
      toolCallId: string,
      params: { title: string; message: string; url?: string }
    ): Promise<AgentToolResult<unknown>> {
      // The same tool call executed again returns its first notification instead of sending another.
      const idempotencyKey =
        ctx.executionId && toolCallId
          ? `notify-contact:${toolCallIdempotencyKey(ctx.agentId, ctx.executionId, toolCallId)}`
          : undefined
      // Build message content with optional URL
      let content = params.message
      if (params.url) {
        content += `\n\n[Link](${params.url})`
      }

      const previous = idempotencyKey ? await InboxMessage.findByIdempotencyKey(idempotencyKey) : null
      if (previous && (previous.subject !== params.title || previous.content !== content)) {
        const error = 'This tool call already sent a different notification; nothing was sent.'
        return { content: [{ type: 'text' as const, text: `Error: ${error}` }], details: { error } }
      }
      if (previous) {
        const where =
          previous.recipientType === 'system'
            ? 'system inbox'
            : previous.metadata.routedTo === 'work_stream_owner'
              ? 'work stream owner'
              : 'squad manager'
        return {
          content: [
            {
              type: 'text' as const,
              text: `This tool call already sent its notification to the ${where}; nothing was sent again: "${previous.subject ?? params.title}"`,
            },
          ],
          details: {
            success: true,
            routedTo: previous.metadata.routedTo,
            workStreamId: previous.metadata.workStreamId,
            messageId: previous.id,
            reused: true,
          },
        }
      }

      const target = await resolveNotifyTarget(ctx.agentId)
      const recipientType = target.kind === 'agent' ? 'agent' : 'system'
      const recipientId = target.kind === 'agent' ? target.agentId : SYSTEM_RECIPIENT_ID
      const routedTo = target.kind === 'agent' ? target.routedTo : 'system'
      const workStreamId = target.kind === 'agent' ? target.workStreamId : undefined

      const input: SendInboxMessageInput = {
        recipientType,
        recipientId,
        senderType: 'agent',
        senderId: ctx.agentId,
        subject: params.title,
        content,
        metadata: { url: params.url, routedTo, workStreamId },
      }
      const message = idempotencyKey
        ? (await InboxMessage.sendOnce(input, idempotencyKey)).message
        : await InboxMessage.send(input)

      log.info(`notify_contact:${ctx.agentId}: Sent to ${routedTo}: ${params.title}`)

      const where =
        target.kind === 'agent'
          ? routedTo === 'work_stream_owner'
            ? 'work stream owner'
            : 'squad manager'
          : 'system inbox'
      return {
        content: [{ type: 'text' as const, text: `Notification sent to ${where}: "${params.title}"` }],
        details: { success: true, routedTo, workStreamId, messageId: message.id },
      }
    },
  }
}
