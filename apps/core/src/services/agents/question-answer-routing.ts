import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  formatAgentLabel,
  type AgentMetadata,
  type AgentQuestionAnswerForward,
  type AgentQuestionAnswerForwardRecipient,
  type WorkflowAttempt,
  type WorkflowRun,
} from '@ficus/shared'
import { agentQuestions, agents, executions, workStreamFlowRuns, workStreamWaits, workStreams } from '../../db/schema'
import type { db, DbTx } from '../../db'
import type { DbHandle } from '../work-streams/waits'
import {
  FlowWaitStreamEndedError,
  isCurrentQuestionAttempt,
  type EndedWorkStreamStatus,
} from '../work-streams/wait-scope'
import { completionDeliveryOwner } from '../integrations/outputs/routing-audience'

type QuestionRow = typeof agentQuestions.$inferSelect

export interface QuestionOrigin {
  workStreamId: string
  attemptId: number
}

/**
 * The workflow attempt a question was asked from. New questions record it at creation; older rows
 * fall back to the asking execution's flow context, then to an attempt-scoped wait on the question.
 */
export async function questionOrigin(
  store: DbHandle,
  row: Pick<QuestionRow, 'id' | 'executionId' | 'flowWorkStreamId' | 'flowAttemptId'>
): Promise<QuestionOrigin | null> {
  if (row.flowWorkStreamId && row.flowAttemptId != null)
    return { workStreamId: row.flowWorkStreamId, attemptId: row.flowAttemptId }
  if (row.executionId) {
    const [execution] = await store
      .select({ flowContext: executions.flowContext })
      .from(executions)
      .where(eq(executions.id, row.executionId))
    if (execution?.flowContext)
      return { workStreamId: execution.flowContext.workStreamId, attemptId: execution.flowContext.attemptId }
  }
  const waits = await store
    .select({ workStreamId: workStreamWaits.workStreamId, flowAttemptId: workStreamWaits.flowAttemptId })
    .from(workStreamWaits)
    .where(and(eq(workStreamWaits.type, 'question'), eq(workStreamWaits.referenceId, row.id)))
  const scoped = waits.find((wait) => wait.flowAttemptId != null)
  return scoped ? { workStreamId: scoped.workStreamId, attemptId: scoped.flowAttemptId! } : null
}

/** A planned forward, plus the asker's label for the recipients' note (not stored). */
export type ForwardRoute = Omit<AgentQuestionAnswerForward, 'forwardedAt'> & { askerLabel: string }

export type QuestionAnswerRoute =
  /** The asking attempt is still current (or the question has no flow origin): answer the asker. */
  | { kind: 'asker' }
  /** The asking attempt is no longer running: pass the answer on to these recipients. */
  | { kind: 'forward'; forward: ForwardRoute }
  /** The stream finished or was canceled: nothing may be woken for its work. */
  | { kind: 'refuse'; error: FlowWaitStreamEndedError }

/** Attempts started, directly or through later handoffs, by the origin attempt's result. */
function descendants(state: WorkflowRun, originId: number): Set<number> {
  const found = new Set<number>([originId])
  let grew = true
  while (grew) {
    grew = false
    for (const attempt of state.attempts)
      if (!found.has(attempt.id) && attempt.sourceAttemptIds?.some((id) => found.has(id))) {
        found.add(attempt.id)
        grew = true
      }
  }
  found.delete(originId)
  return found
}

async function liveAgentLabels(store: DbHandle, ids: string[]) {
  const labels = new Map<string, string>()
  for (const id of new Set(ids)) {
    const [agent] = await store
      .select({
        agentTypeId: agents.agentTypeId,
        status: agents.status,
        metadata: agents.metadata,
        pendingDormancyAt: agents.pendingDormancyAt,
      })
      .from(agents)
      .where(eq(agents.id, id))
    if (!agent || agent.status === 'terminated' || agent.pendingDormancyAt) continue
    const metadata = agent.metadata as AgentMetadata | null
    labels.set(
      id,
      formatAgentLabel({ name: metadata?.name, purpose: metadata?.purpose, agentTypeId: agent.agentTypeId })
    )
  }
  return labels
}

/**
 * Where an accepted answer goes.
 *
 * An answer must not be dropped while it can still matter. When the attempt the question was asked
 * from is no longer running, the answer goes to whoever now holds that work:
 *
 * - Finished normally (completed, or returned work to an earlier step): the agents running the
 *   attempts that the asker's result started, or if none of those is running, every running attempt;
 *   at completion-ready, the delivery participant; with nothing running, the stream's owner agent.
 *   The successor, not the idle asker, receives it: the asker's step is closed and cannot be reopened,
 *   while the running step is where the answer can still change the work. When the asker itself runs
 *   one of those attempts, it is one of the recipients.
 * - Replaced (a rework, restart or revision canceled it): a running attempt of the same step or the
 *   same agent took the work over, so its agent receives it.
 *
 * Either way, when nobody else can take it the asker receives it as an ordinary message. Only a
 * finished or canceled stream refuses the answer: nothing may wake an agent into ended work.
 */
export async function resolveQuestionAnswerRoute(store: DbHandle, row: QuestionRow): Promise<QuestionAnswerRoute> {
  const origin = await questionOrigin(store, row)
  if (!origin) return { kind: 'asker' }
  if (await isCurrentQuestionAttempt(store, origin.workStreamId, origin.attemptId, row.agentId))
    return { kind: 'asker' }
  const [stream] = await store
    .select({ status: workStreams.status, ownerAgentId: workStreams.ownerAgentId })
    .from(workStreams)
    .where(eq(workStreams.id, origin.workStreamId))
  if (!stream) return { kind: 'asker' }
  if (stream.status === 'done' || stream.status === 'canceled')
    return { kind: 'refuse', error: new FlowWaitStreamEndedError(stream.status as EndedWorkStreamStatus) }
  const [run] = await store
    .select()
    .from(workStreamFlowRuns)
    .where(eq(workStreamFlowRuns.workStreamId, origin.workStreamId))
  const state = run?.activated ? run.state : undefined
  const originAttempt = state?.attempts.find((attempt) => attempt.id === origin.attemptId)
  const reason: AgentQuestionAnswerForward['reason'] =
    originAttempt && (originAttempt.status === 'completed' || originAttempt.status === 'returned')
      ? 'attempt-finished'
      : 'attempt-replaced'
  const active = state ? activeWorkflowAttempts(state) : []
  const agentOf = (attempt: WorkflowAttempt) => run!.attemptAgents[String(attempt.id)]
  let candidates: WorkflowAttempt[]
  if (reason === 'attempt-finished') {
    const successors = descendants(state!, origin.attemptId)
    const following = active.filter((attempt) => successors.has(attempt.id))
    candidates = following.length ? following : active
  } else
    candidates = active.filter(
      (attempt) => (originAttempt && attempt.stepId === originAttempt.stepId) || agentOf(attempt) === row.agentId
    )
  const owner = run?.activated && reason === 'attempt-finished' ? completionDeliveryOwner(run) : undefined
  const labels = await liveAgentLabels(store, [
    ...candidates.flatMap((attempt) => agentOf(attempt) ?? []),
    ...(owner ? [owner.agentId] : []),
    ...(stream.ownerAgentId ? [stream.ownerAgentId] : []),
    row.agentId,
  ])
  const recipients: AgentQuestionAnswerForwardRecipient[] = []
  for (const attempt of candidates) {
    const agentId = agentOf(attempt)
    const label = agentId && labels.get(agentId)
    if (!label || recipients.some((entry) => entry.agentId === agentId)) continue
    recipients.push({ role: 'current-work', agentId, label, attemptId: attempt.id, stepId: attempt.stepId })
  }
  if (!recipients.length && reason === 'attempt-finished') {
    if (owner && labels.has(owner.agentId))
      recipients.push({ role: 'delivery', agentId: owner.agentId, label: labels.get(owner.agentId)! })
    else if (stream.ownerAgentId && labels.has(stream.ownerAgentId))
      recipients.push({ role: 'owner', agentId: stream.ownerAgentId, label: labels.get(stream.ownerAgentId)! })
  }
  if (!recipients.length)
    recipients.push({ role: 'asker', agentId: row.agentId, label: labels.get(row.agentId) ?? row.agentId })
  return {
    kind: 'forward',
    forward: {
      reason,
      workStreamId: origin.workStreamId,
      originAttemptId: origin.attemptId,
      ...(originAttempt ? { originStepId: originAttempt.stepId } : {}),
      recipients,
      askerLabel: labels.get(row.agentId) ?? `Agent ${row.agentId}`,
    },
  }
}

/** The note that tells a recipient why it, not the asker's attempt, received the answer. */
export function forwardedAnswerNote(
  forward: Pick<AgentQuestionAnswerForward, 'reason' | 'workStreamId' | 'originAttemptId' | 'originStepId'>,
  asker: string,
  recipient: AgentQuestionAnswerForwardRecipient
): string {
  const step = forward.originStepId
    ? `step ${forward.originStepId} (attempt ${forward.originAttemptId})`
    : `attempt ${forward.originAttemptId}`
  const where = `${step} of work stream ${forward.workStreamId}`
  const cause =
    forward.reason === 'attempt-finished'
      ? `That step had already finished when the answer arrived, so it was not sent back to the step.`
      : `That attempt had been replaced when the answer arrived, so it was not sent back to it.`
  const why =
    recipient.role === 'asker'
      ? 'It comes to you as an ordinary message because nobody else is working on that step. No flow step is assigned to you by it.'
      : recipient.role === 'current-work'
        ? `It is passed to you because you are running step ${recipient.stepId} (attempt ${recipient.attemptId}), which now holds that work.`
        : recipient.role === 'delivery'
          ? 'It is passed to you because you are delivering the work stream.'
          : 'It is passed to you as the work stream owner because no step is running.'
  const who = recipient.role === 'asker' ? 'You asked this question' : `${asker} asked this question`
  return `${who} during ${where}. ${cause} ${why} Use the answer if it still applies to the work.`
}

/**
 * Answers the agent asked from earlier attempts of this stream that were passed to someone else, and
 * that it has not been shown yet. Called while assigning the agent a new attempt in the stream, in
 * the assignment transaction: the agent sees them in its assignment, and each is marked shown so a
 * later assignment does not repeat it.
 */
export async function lateAnswersNotice(
  tx: DbTx | typeof db,
  workStreamId: string,
  agentId: string,
  attemptId: number
): Promise<string | undefined> {
  const rows = await tx
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.agentId, agentId),
        eq(agentQuestions.status, 'answered'),
        eq(agentQuestions.answerDeliveryStatus, 'delivered'),
        sql`${agentQuestions.answerDeliveryForward}->>'workStreamId' = ${workStreamId}`,
        isNull(sql`${agentQuestions.answerDeliveryForward}->'askerShownInAttemptId'`)
      )
    )
  const unseen = rows.filter((row) => {
    const forward = row.answerDeliveryForward
    return (
      forward?.workStreamId === workStreamId &&
      forward.askerShownInAttemptId === undefined &&
      forward.originAttemptId !== attemptId &&
      !forward.recipients.some((recipient) => recipient.agentId === agentId)
    )
  })
  if (!unseen.length) return undefined
  const { answerContent } = await import('./question-answer-delivery')
  const sections: string[] = []
  for (const row of unseen.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const forward = row.answerDeliveryForward!
    const passedTo = forward.recipients.map((recipient) => recipient.label).join(', ')
    sections.push(
      `From your attempt ${forward.originAttemptId}${forward.originStepId ? ` (step ${forward.originStepId})` : ''}, passed to ${passedTo}:\n${answerContent(row)}`
    )
    await tx
      .update(agentQuestions)
      .set({ answerDeliveryForward: { ...forward, askerShownInAttemptId: attemptId } })
      .where(eq(agentQuestions.id, row.id))
  }
  return `Answers to your earlier questions that arrived after your step in this work stream had ended (they were passed to whoever held the work; use them if they still apply):\n\n${sections.join('\n\n')}`
}
