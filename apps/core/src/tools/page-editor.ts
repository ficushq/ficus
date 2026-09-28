import {
  assistantEditorEditParameters,
  assistantEditorProposalSchema,
  assistantEditorReadSchema,
  assistantEditorReadParameters,
  assistantEditorReadResult,
} from '@ficus/shared'
import type { z } from 'zod'
import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readAssistantEditor, proposeAssistantEditor } from '../services/assistant-editors'

/** Bound by the runner, not supplied by the model. Only its own conversation's editor is accessible. */
export function createPageEditorTools(agentId: string, conversationId: string): ToolDefinition[] {
  const run = async (action: () => Promise<unknown>) => {
    try {
      const result = await action()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Editor request failed' }],
        details: { error: true },
        isError: true,
      }
    }
  }
  return [
    {
      name: 'read',
      label: 'Read page draft',
      description:
        'Read the draft and revision in this conversation. Reference catalogs are opt-in via include: contract, agentTypes, integrationOutputs. Use integration to filter integrationOutputs. Brainstorm freely; do not change or publish catalog entries outside this editor.',
      parameters: Type.Unsafe<z.infer<typeof assistantEditorReadSchema>>(assistantEditorReadParameters),
      execute: async (_id, input) =>
        run(async () => assistantEditorReadResult(await readAssistantEditor(conversationId, { agentId }), input)),
    },
    {
      name: 'edit',
      label: 'Edit page draft',
      description:
        'Edit the draft after reading its latest revision. Valid changes apply automatically in the open page and can be undone. Read again to confirm application before another edit. Does not publish changes.',
      parameters: Type.Unsafe<z.infer<typeof assistantEditorProposalSchema>>(assistantEditorEditParameters),
      execute: async (_id, input) =>
        run(async () => {
          const state = await proposeAssistantEditor(conversationId, { agentId }, input)
          return {
            status: 'queued',
            baseRevision: state?.proposal?.baseRevision,
            proposalId: state?.proposal?.id,
            message: 'Read to confirm the page applied this edit before continuing.',
          }
        }),
    },
  ]
}
