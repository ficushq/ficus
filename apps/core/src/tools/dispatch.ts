import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'
import { toolCallIdempotencyKey } from '@ficus/shared/node'
import { Subagent, type SubagentParentExecutionContext } from '../entities/Subagent'

const DispatchSchema = Type.Object({
  subagents: Type.Array(
    Type.Object({
      agentType: Type.Optional(Type.String({ description: "Only 'subagent' is supported in Phase A" })),
      model: Type.Optional(
        Type.String({
          description: 'Provides an explicit child model override; cannot be combined with inheritModel=true',
        })
      ),
      inheritModel: Type.Optional(
        Type.Boolean({
          description: "Copy the parent's full resolved model fallback chain; cannot be true when model is provided",
        })
      ),
      systemPrompt: Type.Optional(Type.String({ description: 'Additional role/expertise context' })),
      instructions: Type.String({ description: 'Required scoped task instructions' }),
      label: Type.Optional(Type.String({ description: 'Human-readable label' })),
    }),
    { minItems: 1 }
  ),
})

export function createDispatchTool(ctx: {
  agentId: string
  parentExecutionContext: SubagentParentExecutionContext
}): ToolDefinition {
  return {
    name: 'dispatch',
    label: 'Dispatch Subagents',
    description:
      "Dispatch one or more fresh ephemeral subagents to perform scoped tasks asynchronously. Without a model option, each child defaults through the subagent's Standard tier; model provides an explicit child override; inheritModel=true copies the parent's full resolved model fallback chain. model and inheritModel=true cannot be combined. Returns immediately with subagent IDs; results arrive later by inbox/steer.",
    parameters: DispatchSchema,
    async execute(
      toolCallId: string,
      params: Parameters<typeof Subagent.dispatch>[0]
    ): Promise<AgentToolResult<unknown>> {
      const executionId = ctx.parentExecutionContext.executionId
      const result = await Subagent.dispatch({
        parentAgentId: ctx.agentId,
        parentExecutionContext: ctx.parentExecutionContext,
        subagents: params.subagents,
        // The same tool call executed again returns the children it created instead of new ones.
        ...(executionId && toolCallId
          ? { idempotencyKey: toolCallIdempotencyKey(ctx.agentId, executionId, toolCallId) }
          : {}),
      })
      const describe = (children: typeof result.subagents) =>
        children.map((s) => `${s.label} (${s.subagentId})`).join(', ')
      const list = describe(result.subagents)
      const earlier = new Set(result.previouslyStartedSubagentIds ?? [])
      const started = result.subagents.filter((s) => !earlier.has(s.subagentId))
      const text =
        result.reused === 'tool-call'
          ? `This tool call was already dispatched, so no new subagents were started: ${list}. They may have finished already; check_subagents shows their status, and their results arrive by inbox.`
          : result.reused === 'identical-running-dispatch'
            ? `You already dispatched exactly these subagents in this run and they are still running, so no new ones were started: ${list}. Their results arrive by inbox.`
            : earlier.size > 0
              ? `This tool call had already started ${earlier.size} of these subagents: ${describe(result.subagents.filter((s) => earlier.has(s.subagentId)))}. They may have finished already; check_subagents shows their status. Dispatched ${started.length} new subagent(s): ${describe(started)}`
              : `Dispatched ${result.subagents.length} subagent(s): ${list}`
      return {
        content: [{ type: 'text' as const, text }],
        details: result,
      }
    },
  }
}
