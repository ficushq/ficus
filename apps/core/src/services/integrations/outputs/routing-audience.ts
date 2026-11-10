import { activeWorkflowAttempts, type IntegrationSubscription } from '@ficus/shared'
import type { integrationOutputDeliveries, workStreamFlowRuns, workStreams } from '../../../db'
type Run = typeof workStreamFlowRuns.$inferSelect
type Stream = typeof workStreams.$inferSelect
type Target = Omit<(typeof integrationOutputDeliveries.$inferSelect)['targets'][number], 'inboxId'>

/** Only server-inferred CI subscriptions may fall back to observational consumers.
 * Explicit subscriptions retain their literal routing and inactivity policy.
 */
export function isInferredCIObservation(subscription: IntegrationSubscription): boolean {
  return (
    (subscription.id.startsWith('code-host-') || subscription.id.startsWith('tracked-')) &&
    subscription.source.output === 'pull_request.ci_completed'
  )
}

/** The agent that owns delivery of a completion-ready flow. */
export interface DeliveryOwner {
  agentId: string
  attemptId: number
  stepId: string
  participantId: string
}

/**
 * The delivery participant of a completion-ready flow: the last completed agent attempt that has a
 * bound agent. This is the single resolution behind `delivery-owner` routing (merged and closed
 * events always, and change events unless the flow sends them to a named step), so every prompt
 * that names the delivery participant agrees with where code-host and merge events go.
 */
export function completionDeliveryOwner(run: Pick<Run, 'state' | 'attemptAgents'>): DeliveryOwner | undefined {
  if (run.state.status !== 'completion-ready') return undefined
  for (const attempt of [...run.state.attempts].reverse()) {
    if (attempt.status !== 'completed') continue
    const step = attempt.step ?? run.state.definition.steps.find((step) => step.id === attempt.stepId)
    const agentId = run.attemptAgents[String(attempt.id)]
    if (step?.kind === 'agent' && agentId)
      return { agentId, attemptId: attempt.id, stepId: attempt.stepId, participantId: step.participant }
  }
  return undefined
}

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
  const running = activeWorkflowAttempts(run.state)
  const active = running.filter(matches)
  let targets: Target[] = active.flatMap((attempt) =>
    run.attemptAgents[String(attempt.id)]
      ? [{ agentId: run.attemptAgents[String(attempt.id)]!, attemptId: attempt.id }]
      : []
  )
  // A configured change target is also the future rework destination, not an
  // exclusive observer of CI while review is running. Inform existing active
  // agents while that target is inactive (past or future); never activate it.
  // Attempt-bound targets make final acceptance reject mail after a transition.
  if (
    !active.length &&
    run.state.status === 'running' &&
    typeof to === 'object' &&
    isInferredCIObservation(subscription)
  )
    targets = running.flatMap((attempt) => {
      const step = attempt.step ?? run.state.definition.steps.find((step) => step.id === attempt.stepId)
      const agentId = run.attemptAgents[String(attempt.id)]
      return step?.kind === 'agent' && agentId ? [{ agentId, attemptId: attempt.id }] : []
    })
  if (to === 'delivery-owner')
    targets = stream.assigneeAgentId
      ? targets.filter((target) => target.agentId === stream.assigneeAgentId).slice(0, 1)
      : targets.slice(-1)
  if (!targets.length && to === 'delivery-owner') {
    const owner = completionDeliveryOwner(run)
    if (owner) targets = [{ agentId: owner.agentId, version: run.version }]
  }
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
