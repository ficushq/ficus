import { z } from 'zod'
import {
  isWorkflowHumanDecisionAttempt,
  workflowAmendEligibility,
  workflowHistoricalStep,
  workflowIncomingAttempts,
  workflowResultRevision,
  workStreamRef,
  type WorkflowReviewConsultation,
} from '@ficus/shared'
import { db } from '../../db'
import { WorkStream } from '../../entities/WorkStream'
import { hasPermission, type Identity } from '../rbac'
import { listOpenWaits } from '../work-streams/waits'
import { getFlow, mayDecideFlowGate } from './execution'
import { isWorkflowReviewer } from './reviewers'
import { flowWaitReference } from './wait-policy'

/** What the review screen sends with a chat message to the producing agent. */
export const reviewConsultationRequestSchema = z.strictObject({
  workStreamId: z.uuid(),
  gateAttemptId: z.int().positive(),
})

export const REVIEW_NOT_OPEN_MESSAGE = 'This review is no longer open, so the message was not sent.'
export const REVIEW_CONSULTATION_FORBIDDEN_MESSAGE =
  'Only a person who can decide this review can consult its agent from the review screen.'

export class ReviewConsultationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
    readonly code: 'REVIEW_NOT_OPEN' | 'REVIEW_CONSULTATION_FORBIDDEN' | 'INVALID_REVIEW_CONSULTATION'
  ) {
    super(message)
    this.name = 'ReviewConsultationError'
  }
}

/**
 * Validate a review-screen message and build the server-owned context it carries: the open gate,
 * this agent's attempts under review at their current revisions, and whether it may amend them.
 * Only a person who may decide the open gate, messaging the agent bound to one of its agent
 * sources, gets the stamp; anything else is refused and no message is sent.
 */
export async function resolveReviewConsultation(
  identity: Identity | undefined,
  agent: { id: string; squadId: string | null },
  request: unknown
): Promise<WorkflowReviewConsultation> {
  const parsed = reviewConsultationRequestSchema.safeParse(request)
  if (!parsed.success)
    throw new ReviewConsultationError('Invalid review consultation', 400, 'INVALID_REVIEW_CONSULTATION')
  const notOpen = () => new ReviewConsultationError(REVIEW_NOT_OPEN_MESSAGE, 409, 'REVIEW_NOT_OPEN')
  const forbidden = () =>
    new ReviewConsultationError(REVIEW_CONSULTATION_FORBIDDEN_MESSAGE, 403, 'REVIEW_CONSULTATION_FORBIDDEN')
  if (identity?.type !== 'user') throw forbidden()
  const stream = await WorkStream.find(parsed.data.workStreamId)
  if (!stream || stream.squadId !== agent.squadId) throw notOpen()
  if (!(await hasPermission(identity, 'workstreams:read', stream.squadId))) throw forbidden()
  const run = await getFlow(stream.id)
  if (!run?.activated || run.state.status !== 'running' || stream.pause || ['done', 'canceled'].includes(stream.status))
    throw notOpen()
  const gate = run.state.attempts.find((attempt) => attempt.id === parsed.data.gateAttemptId)
  const step = gate && workflowHistoricalStep(run.state, gate)
  if (!gate || !step || gate.status !== 'running' || !isWorkflowHumanDecisionAttempt(run.state, gate)) throw notOpen()
  const waitReference = flowWaitReference(stream.id, 'human', gate.id)
  if (!(await listOpenWaits(db, stream.id)).some((wait) => wait.referenceId === waitReference)) throw notOpen()
  if (!mayDecideFlowGate(identity, await isWorkflowReviewer(identity.userId, stream.squadId), stream, step))
    throw forbidden()
  const sources = workflowIncomingAttempts(run.state, gate).filter(
    (source) =>
      workflowHistoricalStep(run.state, source)?.kind === 'agent' && run.attemptAgents[String(source.id)] === agent.id
  )
  if (!sources.length) throw notOpen()
  const refused = sources
    .map((source) => workflowAmendEligibility(run.state, source.id))
    .find((eligibility) => !eligibility.ok)
  return {
    workStreamId: stream.id,
    workStreamRef: workStreamRef(stream),
    gateAttemptId: gate.id,
    gateStepId: gate.stepId,
    gateName: step.name ?? step.id,
    sources: sources.map((source) => ({
      attemptId: source.id,
      stepId: source.stepId,
      revision: workflowResultRevision(source),
    })),
    amend: refused && !refused.ok ? { available: false, reason: refused.reason } : { available: true },
  }
}
