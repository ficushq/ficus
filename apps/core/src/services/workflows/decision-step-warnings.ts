import { workflowCompletionWarnings, type WorkflowDefinition, type WorkflowSource } from '@ficus/shared'
import { decisionChain } from '../decisions/service'
import { createLogger } from '../../lib/infra/logger'
import { resolveStoredWorkflow } from './catalog'

const log = createLogger('workflow-decision-warnings')

/**
 * What whoever saves a flow should know about its decision steps: that no decision model is set up
 * to answer them (Settings → Decision Providers → Workflow decisions), so they take `unavailable`,
 * or wait for a reviewer. Empty when there are none, or a provider is set up.
 */
export function decisionStepWarnings(
  definition: Pick<WorkflowDefinition, 'steps'>,
  chain: () => unknown[] = () => decisionChain('workflow-steps')
): string[] {
  const steps = definition.steps.filter((step) => step.kind === 'decision').map((step) => `'${step.id}'`)
  if (!steps.length || chain().length) return []
  return [
    `No decision model is set up for Workflow decisions (Settings → Decision Providers), so decision step${steps.length === 1 ? '' : 's'} ${steps.join(', ')} will not be asked: ${steps.length === 1 ? 'it takes its' : 'each takes its'} unavailable outcome, or waits for a reviewer when that is omitted.`,
  ]
}

/**
 * Everything whoever saves or resolves a flow should know: unanswerable decision steps, and a
 * merge-completed flow that explicitly opts out of following its delivery pull request.
 */
export function workflowWarnings(
  definition: Pick<WorkflowDefinition, 'steps'> & Partial<Pick<WorkflowDefinition, 'completion'>>,
  chain?: () => unknown[]
): string[] {
  return [
    ...decisionStepWarnings(definition, chain),
    ...(definition.completion ? workflowCompletionWarnings({ completion: definition.completion }) : []),
  ]
}

/** The same for a creation source (inline or preset); never fails a save over it. */
export async function workflowSourceWarnings(source: WorkflowSource): Promise<string[]> {
  try {
    return workflowWarnings((await resolveStoredWorkflow(source)).definition)
  } catch (error) {
    log.warn('Could not check the workflow for warnings', error)
    return []
  }
}

/** `{ warnings }` when there are any, for spreading into a response. */
export const withWarnings = (warnings: string[]) => (warnings.length ? { warnings } : {})
