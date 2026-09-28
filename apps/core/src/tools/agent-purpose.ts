import { isUserAssistantAgentType } from '@ficus/shared'
import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Agent } from '../entities/Agent'

const SetAgentPurposeSchema = Type.Object({
  purpose: Type.String({
    minLength: 1,
    maxLength: 80,
    description: 'Short human-readable purpose, e.g. "Vercel hello world deployer"',
  }),
})

interface SetAgentPurposeToolContext {
  agentId: string
}

export function createSetAgentPurposeTool(ctx: SetAgentPurposeToolContext): ToolDefinition {
  return {
    name: 'set_agent_purpose',
    label: 'Set Agent Purpose',
    description:
      'Set a concise UI display purpose for yourself. Use when you understand your current assignment, and update only when it meaningfully changes.',
    parameters: SetAgentPurposeSchema,
    async execute(_toolCallId: string, params: { purpose: string }): Promise<AgentToolResult<{ success: boolean }>> {
      const purpose = params.purpose.trim()
      const agent = await Agent.mustFind(ctx.agentId)

      if (!canSetAgentPurpose(agent)) {
        return {
          content: [{ type: 'text' as const, text: 'The set_agent_purpose tool is not available for squad managers.' }],
          details: { success: false },
        }
      }

      await agent.update({ purpose })

      return {
        content: [{ type: 'text' as const, text: `Agent purpose set to: ${purpose}` }],
        details: { success: true },
      }
    },
  }
}

function canSetAgentPurpose(agent: Agent): boolean {
  return isUserAssistantAgentType(agent.agentTypeId) || (!!agent.squadId && agent.agentTypeId !== 'manager')
}
