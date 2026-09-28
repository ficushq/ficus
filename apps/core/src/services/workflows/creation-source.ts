import type { WorkflowSource } from '@ficus/shared'
import type { Squad } from '../../entities/Squad'

/** Explicit choice, squad default, then the standard Solo preset. */
export function creationWorkflow(
  explicit: WorkflowSource | undefined,
  configured: WorkflowSource | undefined
): WorkflowSource {
  return explicit ?? configured ?? { kind: 'preset', id: 'solo', customizations: [] }
}

export async function resolveCreationWorkflow(explicit: WorkflowSource | undefined, squad: Squad) {
  return creationWorkflow(explicit, squad.metadata?.workflow as WorkflowSource | undefined)
}
