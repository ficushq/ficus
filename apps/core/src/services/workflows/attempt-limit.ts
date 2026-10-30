import { eq } from 'drizzle-orm'
import { describeWorkflowAttemptLimitPause, workflowAttemptLimitPause, type WorkflowRun } from '@ficus/shared'
import { db, squads, workStreamFlowRuns, workStreams, type DbTx } from '../../db'
import { hasPermission, type Identity } from '../rbac'
import { isWorkflowReviewer } from './reviewers'

type Stream = typeof workStreams.$inferSelect
type Run = typeof workStreamFlowRuns.$inferSelect

/** The paused-flow wait text: what happened and the one action that unblocks it, for people and agents. */
export function attemptLimitWaitMessage(stream: Pick<Stream, 'number'>, state: WorkflowRun): string {
  const pause = workflowAttemptLimitPause(state)
  if (!pause) return 'The workflow is paused and needs an authorized flow revision before work can continue.'
  return (
    `${describeWorkflowAttemptLimitPause(pause)}\n\n` +
    `In the web app, use Raise limit on this card or on the work stream. ` +
    `From the CLI: ficus workstream raise-limit ${stream.number} --max-step-attempts <number> (or --remove).`
  )
}

/**
 * Who may raise or remove the limit at an attempt-limit pause: people with review rights on the
 * stream (an assigned reviewer when reviewers are assigned) or flow management permission, and the
 * stream's owner agent, the squad manager agent, or another agent with flow management permission.
 * The agent that ran the exhausted step can never unblock itself.
 */
export async function canRaiseFlowAttemptLimit(
  identity: Identity,
  stream: Pick<Stream, 'squadId' | 'ownerAgentId' | 'assignedReviewerIds'>,
  run: Pick<Run, 'state' | 'attemptAgents'>,
  store: DbTx | typeof db = db
): Promise<boolean> {
  const pause = workflowAttemptLimitPause(run.state)
  if (!pause) return false
  const canRevise = await hasPermission(identity, 'workstreams:revise-flow', stream.squadId)
  if (identity.type === 'user') {
    if (canRevise) return true
    return (
      (await isWorkflowReviewer(identity.userId, stream.squadId)) &&
      (!stream.assignedReviewerIds.length || stream.assignedReviewerIds.includes(identity.userId))
    )
  }
  if (identity.type !== 'agent') return canRevise
  const ranPausedStep = run.state.attempts
    .slice(run.state.attemptEpoch ?? 0)
    .some((attempt) => attempt.stepId === pause.stepId && run.attemptAgents[String(attempt.id)] === identity.agentId)
  if (ranPausedStep) return false
  if (canRevise || identity.agentId === stream.ownerAgentId) return true
  const [squad] = await store
    .select({ managerAgentId: squads.managerAgentId })
    .from(squads)
    .where(eq(squads.id, stream.squadId))
  return !!squad?.managerAgentId && squad.managerAgentId === identity.agentId
}

/** Where generic unblock or typed input is refused for an attempt-limit pause, point at the action that works. */
export function attemptLimitResolutionHint(stream: number | string): string {
  return `This wait is an attempt-limit pause; unblock it by raising or removing the limit: ficus workstream raise-limit ${stream} --max-step-attempts <number> (or --remove), or Raise limit in the web app.`
}

/**
 * Cheap pre-check before the locked transaction: only identities that could qualify for
 * {@link canRaiseFlowAttemptLimit} may learn anything about the flow. Users need review or flow
 * management permission; agents need to read the stream's squad (owner and manager agents do);
 * other tokens need flow management permission.
 */
export async function mayAttemptRaiseLimit(
  identity: Identity,
  squadId: string,
  canRevise: boolean,
  canReview: boolean
): Promise<boolean> {
  if (canRevise) return true
  if (identity.type === 'user') return canReview
  if (identity.type === 'agent') return hasPermission(identity, 'workstreams:read', squadId)
  return false
}
