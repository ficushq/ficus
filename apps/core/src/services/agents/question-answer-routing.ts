import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  formatAgentLabel,
  type AgentMetadata,
  type AgentQuestionAnswerForward,
  type AgentQuestionAnswerForwardRecipient,
  type WorkflowAttempt,
  type WorkflowRun,
} from '@ficus/shared'
import {
  agentQuestions,
  agents,
  executions,
  squads,
  workStreamFlowRuns,
  workStreamWaits,
  workStreams,
} from '../../db/schema'
import type { db, DbTx } from '../../db'
import type { DbHandle } from '../work-streams/waits'
import {
  AnswerNoRecipientError,
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
  /**
   * The stream finished or was canceled, so nothing may be woken for its work; or nobody live was
   * left to receive the answer.
   */
  | { kind: 'refuse'; error: FlowWaitStreamEndedError | AnswerNoRecipientError }

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

/** Display labels for the given agents, and which of them can still receive mail. */
async function agentLabels(store: DbHandle, ids: string[]) {
  const unique = [...new Set(ids)]
  const rows = unique.length
    ? await store
        .select({
          id: agents.id,
          agentTypeId: agents.agentTypeId,
          status: agents.status,
          metadata: agents.metadata,
          pendingDormancyAt: agents.pendingDormancyAt,
        })
        .from(agents)
        .where(inArray(agents.id, unique))
    : []
  const labels = new Map<string, string>()
  const live = new Set<string>()
  for (const agent of rows) {
    const metadata = agent.metadata as AgentMetadata | null
    labels.set(
      agent.id,
      formatAgentLabel({ name: metadata?.name, purpose: metadata?.purpose, agentTypeId: agent.agentTypeId })
    )
    if (agent.status !== 'terminated' && !agent.pendingDormancyAt) live.add(agent.id)
  }
  return { labels, live }
}

/** The squad's designated manager agent, if the squad has one. */
async function squadManagerId(store: DbHandle, squadId: string | null): Promise<string | null> {
  if (!squadId) return null
  const [squad] = await store
    .select({ managerAgentId: squads.managerAgentId })
    .from(squads)
    .where(eq(squads.id, squadId))
  if (!squad?.managerAgentId) return null
  const [manager] = await store
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, squad.managerAgentId), eq(agents.squadId, squadId), eq(agents.agentTypeId, 'manager')))
  return manager?.id ?? null
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
 * Either way, when nobody else can take it the asker receives it as an ordinary message, and when
 * the asker has stopped too, the squad's manager does. Only a finished or canceled stream refuses
 * the answer outright (nothing may wake an agent into ended work), and an answer that no live agent
 * can receive is refused as `no-recipient` rather than recorded as delivered to a stopped agent.
 */
export async function resolveQuestionAnswerRoute(store: DbHandle, row: QuestionRow): Promise<QuestionAnswerRoute> {
  const origin = await questionOrigin(store, row)
  if (!origin) return { kind: 'asker' }
  if (await isCurrentQuestionAttempt(store, origin.workStreamId, origin.attemptId, row.agentId))
    return { kind: 'asker' }
  const [stream] = await store
    .select({ status: workStreams.status, ownerAgentId: workStreams.ownerAgentId, squadId: workStreams.squadId })
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
  const managerId = await squadManagerId(store, stream.squadId ?? row.squadId)
  const { labels, live } = await agentLabels(store, [
    ...candidates.flatMap((attempt) => agentOf(attempt) ?? []),
    ...(owner ? [owner.agentId] : []),
    ...(stream.ownerAgentId ? [stream.ownerAgentId] : []),
    ...(managerId ? [managerId] : []),
    row.agentId,
  ])
  const recipients: AgentQuestionAnswerForwardRecipient[] = []
  for (const attempt of candidates) {
    const agentId = agentOf(attempt)
    if (!agentId || !live.has(agentId) || recipients.some((entry) => entry.agentId === agentId)) continue
    recipients.push({
      role: 'current-work',
      agentId,
      label: labels.get(agentId)!,
      attemptId: attempt.id,
      stepId: attempt.stepId,
    })
  }
  if (!recipients.length && reason === 'attempt-finished') {
    if (owner && live.has(owner.agentId))
      recipients.push({ role: 'delivery', agentId: owner.agentId, label: labels.get(owner.agentId)! })
    else if (stream.ownerAgentId && live.has(stream.ownerAgentId))
      recipients.push({ role: 'owner', agentId: stream.ownerAgentId, label: labels.get(stream.ownerAgentId)! })
  }
  // An inbox message to a stopped agent is never read: only a live asker, then a live manager, can
  // take the answer. With neither, the answer is refused so the person and the operator are told.
  if (!recipients.length && live.has(row.agentId))
    recipients.push({ role: 'asker', agentId: row.agentId, label: labels.get(row.agentId)! })
  if (!recipients.length && managerId && live.has(managerId))
    recipients.push({ role: 'manager', agentId: managerId, label: labels.get(managerId)! })
  if (!recipients.length) return { kind: 'refuse', error: new AnswerNoRecipientError() }
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
          : recipient.role === 'manager'
            ? 'It is passed to you as the squad manager because the asking agent has stopped and no live agent holds that work. Route it to whoever should act on it, if anyone.'
            : 'It is passed to you as the work stream owner because no step is running.'
  const who = recipient.role === 'asker' ? 'You asked this question' : `${asker} asked this question`
  const apply =
    recipient.role === 'asker'
      ? 'Use the answer if it still applies to the work.'
      : 'You did not ask it: first decide whether the answer still applies to your current work, and change course only if it does.'
  return `${who} during ${where}. ${cause} ${why} ${apply}`
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
