import { requireAllowedChannelReply } from '../services/channel-policy'
import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getProvider } from '../channels'
import { createLogger } from '../lib/infra/logger'
import type { ChannelConversationContext } from './channel-message-tracking'

const log = createLogger('channel-edit')

const ChannelEditSchema = Type.Object({
  messageId: Type.String({ description: 'Provider message ID/timestamp returned by channel_send/channel_respond.' }),
  content: Type.String({ description: 'Replacement message content. Supports markdown.' }),
})

export function createChannelEditTool(agentId: string): ToolDefinition {
  return {
    name: 'channel_edit',
    label: 'Channel Edit',
    description:
      'Edit a previously Ficus-sent channel message by provider message ID. Only tracked Ficus messages are allowed.',
    parameters: ChannelEditSchema,
    async execute(
      _toolCallId: string,
      params: { messageId: string; content: string }
    ): Promise<AgentToolResult<unknown>> {
      const { Agent } = await import('../entities/Agent')
      const agent = await Agent.find(agentId)
      if (!agent) return failure('Agent not found')

      const agentContext = (agent.context ?? {}) as ChannelConversationContext
      const providerName = agentContext.channelInstance?.provider
      if (!providerName) return failure('No active channel provider found in agent context')

      const knownMessage = (agentContext.channelMessages ?? []).find(
        (message) => message.provider === providerName && message.messageId === params.messageId
      )
      if (!knownMessage) return failure(`Unknown or untracked channel message ID: ${params.messageId}`)

      const provider = getProvider(providerName)
      if (!provider) return failure(`Unknown provider: ${providerName}`)

      try {
        await requireAllowedChannelReply(
          agentContext.channelInstance?.id,
          knownMessage.channelId,
          agentContext.directMessage ? agentId : undefined
        )
        await provider.editMessage({
          channelId: knownMessage.channelId,
          messageId: params.messageId,
          text: params.content,
        })
        return {
          content: [{ type: 'text', text: `Message ${params.messageId} edited via ${providerName}.` }],
          details: { success: true, provider: providerName, messageId: params.messageId },
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        log.error('channel_edit error:', error)
        return failure(errorMsg)
      }
    },
  }
}

function failure(error: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: `Error editing channel message: ${error}` }],
    details: { success: false, error },
  }
}
