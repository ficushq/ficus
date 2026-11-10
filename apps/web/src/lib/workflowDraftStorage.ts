import { z } from 'zod'
import {
  decisionQuestionSchema,
  workflowDefinitionShapeSchema,
  normalizeWorkflowStep,
  workflowLimitsSchema,
  workflowStepSchema,
  workflowTransitionSchema,
} from '@ficus/shared'
import type { AuthIdentity } from '@ficus/client-core'
import { getApiUrl } from '../api/client'
import { WORKFLOW_DRAFT_STORAGE_PREFIX } from '@ficus/shared/browser-keys'

// Drafts may have incomplete names, limits, or connections while being edited.
// Check their structure without requiring a runnable workflow.
const draftTransition = z.union([
  workflowTransitionSchema.options[0],
  workflowTransitionSchema.options[1].extend({ parallel: z.array(z.string()).max(16) }),
  workflowTransitionSchema.options[2],
])
// A decision step's questions may be half-written too (an empty prompt, a choice with one option).
const draftQuestions = z.record(
  z.string(),
  z.discriminatedUnion('type', [
    decisionQuestionSchema.options[0].extend({ instructions: z.string() }),
    decisionQuestionSchema.options[1].extend({ instructions: z.string(), options: z.record(z.string(), z.string()) }),
    decisionQuestionSchema.options[2].extend({
      instructions: z.string(),
      levels: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    }),
  ])
)
const definition = workflowDefinitionShapeSchema.extend({
  name: z.string(),
  steps: z.array(
    z.preprocess(
      normalizeWorkflowStep,
      z.union([
        workflowStepSchema.options[0].extend({
          instructions: z.string(),
          output: z.string(),
          outcomes: z.record(z.string(), draftTransition),
        }),
        workflowStepSchema.options[1].extend({
          instructions: z.string(),
          output: z.string(),
          outcomes: z.record(z.string(), draftTransition),
        }),
        workflowStepSchema.options[2].extend({
          instructions: z.string(),
          questions: draftQuestions,
          outcomes: z.record(z.string(), draftTransition),
        }),
      ])
    )
  ),
  limits: workflowLimitsSchema.extend({
    maxStepAttempts: z.number().optional(),
    maxDelegations: z.number(),
    maxParallelAttempts: z.number().optional(),
  }),
})
const draftSchema = z.object({
  version: z.literal(1),
  positions: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })).default({}),
  id: z.string(),
  idEdited: z.boolean(),
  description: z.string(),
  source: z.object({ kind: z.literal('inline'), definition }),
})
export type WorkflowDraft = z.infer<typeof draftSchema>

export function workflowDraftKey(identity: AuthIdentity | undefined, draftId: string): string | undefined {
  if (!identity) return undefined
  const owner =
    identity.type === 'user'
      ? identity.userId
      : identity.type === 'agent'
        ? identity.agentId
        : identity.type === 'system'
          ? identity.systemTokenId
          : 'legacy'
  return `${WORKFLOW_DRAFT_STORAGE_PREFIX}${JSON.stringify([getApiUrl(), identity.type, owner, draftId])}`
}

export function readWorkflowDraft(key: string | undefined): WorkflowDraft | undefined {
  if (!key) return undefined
  try {
    const raw = localStorage.getItem(key)
    return raw ? draftSchema.parse(JSON.parse(raw)) : undefined
  } catch {
    return undefined
  }
}

// Whether the last write of each draft key failed. Writes happen in an effect; render reads the
// result as an external store (useSyncExternalStore), so a failure needs no state set from the effect.
const draftWriteFailures = new Map<string, boolean>()
const draftWriteListeners = new Set<() => void>()

/** Save a draft under its key and record whether the browser accepted it. */
export function writeWorkflowDraft(key: string, draft: WorkflowDraft) {
  let failed = false
  try {
    localStorage.setItem(key, JSON.stringify(draft))
  } catch {
    failed = true
  }
  recordDraftWrite(key, failed)
}

/** Remove a saved draft; false (recorded as a failed write) when the browser refused. */
export function discardWorkflowDraft(key: string): boolean {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    recordDraftWrite(key, true)
    return false
  }
}

function recordDraftWrite(key: string, failed: boolean) {
  if ((draftWriteFailures.get(key) ?? false) === failed) return
  draftWriteFailures.set(key, failed)
  for (const listener of draftWriteListeners) listener()
}

export function subscribeWorkflowDraftWrites(listener: () => void): () => void {
  draftWriteListeners.add(listener)
  return () => {
    draftWriteListeners.delete(listener)
  }
}

/** Whether the last write of this draft key failed. */
export function workflowDraftWriteFailed(key: string | undefined): boolean {
  return key !== undefined && draftWriteFailures.get(key) === true
}
