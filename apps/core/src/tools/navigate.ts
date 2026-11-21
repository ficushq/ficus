import { Type } from '@sinclair/typebox'
import type { ToolDefinition, AgentToolResult } from '@earendil-works/pi-coding-agent'

// --- TypeBox Schema ---

const NavigateSchema = Type.Object({
  path: Type.String({
    description: 'The frontend route path to navigate to (e.g. /squads/abc123/work, /settings?section=providers).',
  }),
  prompt: Type.Boolean({
    description:
      'If false, navigate the user immediately (use when the user explicitly asked to go somewhere). ' +
      'If true, show a clickable link instead of auto-navigating (use when you are proactively suggesting a page).',
  }),
})

// --- Factory ---

export function createNavigateTool(): ToolDefinition {
  return {
    name: 'navigate',
    label: 'Navigate',
    description:
      'Navigate the user to a page in the frontend UI. ' +
      "Use prompt=false when the user explicitly asked to be taken somewhere (e.g. 'show me task X', 'go to settings'). " +
      'Use prompt=true when you are proactively suggesting a page the user might want to visit — ' +
      "this shows a clickable link instead of auto-navigating, so the user isn't unexpectedly redirected.",
    parameters: NavigateSchema,
    async execute(_toolCallId: string, params: { path: string; prompt: boolean }): Promise<AgentToolResult<unknown>> {
      // Navigation is handled entirely by the frontend.
      // The backend just acknowledges the tool call.
      return {
        content: [
          {
            type: 'text' as const,
            text: params.prompt ? `Link to ${params.path} shown to user.` : `Navigating user to ${params.path}.`,
          },
        ],
        details: { path: params.path, prompt: params.prompt },
      }
    },
  }
}
