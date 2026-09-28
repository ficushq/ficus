import { getActiveExecution, getAgent, getMessage, getMessages, listAgents } from '../../api/agents'
import { agentHandle, resolveAgentByReference } from './agentResolution'
import type { Message } from '@ficus/shared'
import type { VoiceAssistantTool, VoiceToolExecutor } from './types'

function mapMessages(messages: Message[]) {
  return messages.reverse().map((m) => {
    const blocks = m.metadata?.content
    let content: string
    if (blocks?.length) {
      content = blocks
        .map((b) => {
          if (b.type === 'text') return b.content
          if (b.type === 'thinking') return `[thinking] ${b.content}`
          if (b.type === 'tool_use') {
            const tc = b.toolCall
            const parts = [`[tool: ${tc.toolName}]`]
            if (tc.args) parts.push(`input: ${tc.args.slice(0, 200)}${tc.args.length > 200 ? '… (truncated)' : ''}`)
            if (tc.result)
              parts.push(`output: ${tc.result.slice(0, 300)}${tc.result.length > 300 ? '… (truncated)' : ''}`)
            if (tc.isError) parts.push('(error)')
            return parts.join(' ')
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
    } else {
      content = m.content
    }
    return {
      id: m.id,
      role: m.role,
      content: content.length > 1000 ? content.slice(0, 1000) + '… (truncated)' : content,
      blockCount: blocks?.length ?? 0,
      pending: m.pending,
      createdAt: m.createdAt,
    }
  })
}

export function createThreadTools(deps: {
  getAgent: typeof getAgent
  /** Enables handle / mis-copied-id resolution; without it only exact ids resolve. */
  listAgents?: typeof listAgents
  getActiveExecution: typeof getActiveExecution
  getMessages: typeof getMessages
  getMessage: typeof getMessage
}) {
  const resolveAgent = (reference: string) =>
    resolveAgentByReference(reference, { getAgent: deps.getAgent, listAgents: deps.listAgents ?? (async () => []) })
  async function readMessageDetail(input: {
    agentId: string
    messageId: string
    blockIndex?: number
    offset?: number
    limit?: number
  }) {
    const { agentId, messageId, blockIndex, offset: rawOffset, limit: rawPageSize } = input
    const PAGE_SIZE = Math.min(rawPageSize ?? 500, 1500)
    const offset = rawOffset ?? 0

    const msg = await deps.getMessage(agentId, messageId)
    if (!msg) return { error: 'Message not found' }

    const blocks = msg.metadata?.content
    let fullContent: string

    if (blockIndex !== undefined) {
      if (!blocks || blockIndex >= blocks.length) return { error: `Block index ${blockIndex} not found` }
      const block = blocks[blockIndex]
      if (block.type === 'tool_use') {
        const tc = block.toolCall
        fullContent = `[tool: ${tc.toolName}]\ninput: ${tc.args}\noutput: ${tc.result}${tc.isError ? '\n(error)' : ''}`
      } else {
        fullContent = block.content
      }
    } else if (blocks?.length) {
      fullContent = blocks
        .map((b, i) => {
          if (b.type === 'text') return b.content
          if (b.type === 'thinking') return `[thinking] ${b.content}`
          if (b.type === 'tool_use') {
            const tc = b.toolCall
            return `[block ${i}, tool: ${tc.toolName}]\ninput: ${tc.args}\noutput: ${tc.result}${tc.isError ? '\n(error)' : ''}`
          }
          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    } else {
      fullContent = msg.content
    }

    const slice = fullContent.slice(offset, offset + PAGE_SIZE)
    const hasMore = offset + PAGE_SIZE < fullContent.length
    return {
      content: slice,
      offset,
      length: fullContent.length,
      hasMore,
      ...(hasMore ? { nextOffset: offset + PAGE_SIZE } : {}),
    }
  }

  const readThreadTool: VoiceAssistantTool<VoiceToolExecutor> = {
    definition: {
      type: 'function',
      name: 'read_thread',
      description:
        'Read an agent’s conversation. Without messageId: the agent’s status and active execution plus its recent messages. With messageId (from a previous result): that message’s full content, paginated with offset and limit, optionally one content block via blockIndex. Use to check what an agent or task is doing or to answer questions about its work.',
      parameters: {
        type: 'object',
        properties: {
          agentId: { type: 'string', description: 'Agent ID whose thread to read' },
          messageId: { type: 'string', description: 'Message ID to read in full. Omit for the recent thread.' },
          blockIndex: {
            type: 'number',
            description: 'With messageId: content block index (0-based). Omit for all blocks.',
          },
          offset: { type: 'number', description: 'With messageId: character offset to start from (default 0).' },
          limit: {
            type: 'number',
            description:
              'Recent messages to fetch (default 5, max 20); with messageId, max characters (default 500, max 1500).',
          },
        },
        required: ['agentId'],
      },
    },
    async execute(args) {
      const input = args as {
        agentId: string
        messageId?: string
        blockIndex?: number
        offset?: number
        limit?: number
      }
      if (input.messageId) {
        // Message ids come from a previous read of the same agent, so only a bare handle needs resolving.
        const agentId =
          agentHandle(input.agentId) === input.agentId.trim().toLowerCase()
            ? (await resolveAgent(input.agentId)).id
            : input.agentId
        return readMessageDetail({ ...input, agentId } as typeof input & { messageId: string })
      }
      const agent = await resolveAgent(input.agentId)
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 20)
      const [execution, { messages }] = await Promise.all([
        deps.getActiveExecution(agent.id),
        deps.getMessages(agent.id, { limit }),
      ])
      return {
        agent: {
          id: agent.id,
          type: agent.agentTypeId,
          status: agent.status,
          execution: execution.active ? { status: execution.status } : null,
        },
        messages: mapMessages(messages),
      }
    },
  }

  return { readThreadTool, threadTools: [readThreadTool] }
}

export const { readThreadTool, threadTools } = createThreadTools({
  getAgent,
  listAgents,
  getActiveExecution,
  getMessages,
  getMessage,
})
