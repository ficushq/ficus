import { Type } from '@sinclair/typebox'
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SuggestSquadResponse } from '@ficus/shared'
import { suggestSquadWithRecommendation } from '../services/routing'

const SuggestSquadSchema = Type.Object({
  question: Type.String({ minLength: 3, maxLength: 500, description: 'User request or routing question to classify.' }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10, description: 'Maximum number of suggestions to return.' })
  ),
})

export interface SuggestSquadToolContext {
  squadId: string
}

export async function suggestSquadTool(
  args: { question: string; limit?: number },
  ctx: SuggestSquadToolContext
): Promise<SuggestSquadResponse> {
  return suggestSquadWithRecommendation(ctx.squadId, args.question, { limit: args.limit })
}

export function createSuggestSquadTool(ctx: SuggestSquadToolContext): ToolDefinition {
  return {
    name: 'suggest_squad',
    label: 'Suggest Squad',
    description:
      'Recommend which squad should handle a request. Returns suggestions with evidence plus route/clarify/escalate guidance.',
    parameters: SuggestSquadSchema,
    async execute(
      _toolCallId: string,
      params: { question: string; limit?: number }
    ): Promise<AgentToolResult<SuggestSquadResponse>> {
      const result = await suggestSquadTool(params, ctx)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  }
}
