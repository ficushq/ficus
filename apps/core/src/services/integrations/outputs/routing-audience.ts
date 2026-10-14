import { activeWorkflowAttempts, type IntegrationSubscription } from '@ficus/shared'
import type { integrationOutputDeliveries, workStreamFlowRuns, workStreams } from '../../../db'
type Run = typeof workStreamFlowRuns.$inferSelect
type Stream = typeof workStreams.$inferSelect
type Target = Omit<(typeof integrationOutputDeliveries.$inferSelect)['targets'][number], 'inboxId'>

export function outputRecipients(
  run: Run,
  stream: Stream,
  subscription: IntegrationSubscription,
  managerId?: string | null
): Target[] {
  const to = subscription.deliver.to
  const matches = (attempt: Run['state']['attempts'][number]) => {
    const step = attempt.step ?? run.state.definition.steps.find((step) => step.id === attempt.stepId)
    return (
      step?.kind === 'agent' &&
      (to === 'active' ||
        to === 'delivery-owner' ||
        ('participant' in to ? step.participant === to.participant : step.id === to.step))
    )
  }
  const active = activeWorkflowAttempts(run.state).filter(matches)
  let targets: Target[] = active.flatMap((attempt) =>
    run.attemptAgents[String(attempt.id)]
      ? [{ agentId: run.attemptAgents[String(attempt.id)]!, attemptId: attempt.id }]
      : []
  )
  if (to === 'delivery-owner')
    targets = stream.assigneeAgentId
      ? targets.filter((target) => target.agentId === stream.assigneeAgentId).slice(0, 1)
      : targets.slice(-1)
  if (!targets.length && run.state.status === 'completion-ready' && to !== 'active') {
    const last = [...run.state.attempts]
      .reverse()
      .find((attempt) => attempt.status === 'completed' && matches(attempt) && run.attemptAgents[String(attempt.id)])
    if (last) targets = [{ agentId: run.attemptAgents[String(last.id)]!, version: run.version }]
  }
  if (!targets.length && subscription.deliver.whenInactive === 'manager' && managerId)
    targets = [{ agentId: managerId, version: run.version }]
  return targets
}
