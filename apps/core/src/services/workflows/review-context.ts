import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  activeWorkflowAttempts,
  effectiveWorkflowStep,
  workflowCausalAttempts,
  workflowCompletionReviewTargets,
  workflowReturnReviewTargets,
  workflowEarlierHumanDecisions,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowBriefInterruption,
  type WorkflowProducerReviewContext,
} from '@ficus/shared'
import { executions, workStreamFlowTransitions } from '../../db/schema'
import type { DbHandle } from '../work-streams/waits'

/** Full causal history is review context, not a replacement for the ordinary immediate handoff. */
export function producerReviewContexts(
  run: WorkflowRun,
  attempt: WorkflowAttempt,
  interruptions: WorkflowBriefInterruption[] = [],
  versions: Record<number, number> = {},
  settledAt: Record<number, string> = {}
): WorkflowProducerReviewContext[] {
  const step = effectiveWorkflowStep(run, attempt)
  if (step.kind !== 'agent') return []
  const targets = new Map<string, { outcomes: string[]; viaResume: boolean; viaReturn?: boolean }>()
  for (const outcome of Object.keys(step.outcomes))
    for (const resume of [false, true]) {
      let gates: string[]
      try {
        gates = workflowCompletionReviewTargets(run, attempt, outcome, resume)
      } catch {
        continue
      }
      for (const gate of gates) {
        const value = targets.get(gate) ?? { outcomes: [], viaResume: false }
        if (!value.outcomes.includes(outcome)) value.outcomes.push(outcome)
        value.viaResume ||= resume
        targets.set(gate, value)
      }
    }
  for (const gate of run.definition.steps.filter((s) => s.kind === 'human-approval')) {
    try {
      if (!workflowReturnReviewTargets(run, attempt, gate.id).length) continue
      const value = targets.get(gate.id) ?? { outcomes: [], viaResume: false }
      targets.set(gate.id, { ...value, viaReturn: true })
    } catch {
      // Not an authorized explicit return from this producer.
    }
  }
  const causal = new Set([attempt.id, ...workflowCausalAttempts(run, attempt).map((a) => a.id)])
  return [...targets].map(([gateStepId, routing]) => {
    const previous = workflowEarlierHumanDecisions(run, gateStepId, versions)
    const previousVersion = previous[0] && (previous[0].settledVersion ?? versions[previous[0].id])
    const previousTime = previous[0] && settledAt[previous[0].id]
    const afterPrevious = (id: number) => {
      if (!previous[0]) return true
      const source = run.attempts.find((a) => a.id === id)
      const version = source?.settledVersion ?? versions[id]
      return version !== undefined && previousVersion !== undefined ? version > previousVersion : id > previous[0].id
    }
    return {
      gateStepId,
      ...routing,
      previousDecisions: previous.map((a) => ({
        attemptId: a.id,
        version: a.settledVersion ?? versions[a.id],
        kind: a.outcome === undefined ? ('return' as const) : ('outcome' as const),
        outcome: a.outcome,
        notes: a.evidence ?? a.feedback,
      })),
      returns: run.returns
        .filter(
          (r) =>
            causal.has(r.requestedByAttemptId) &&
            (afterPrevious(r.requestedByAttemptId) || r.requestedByAttemptId === previous[0]?.id)
        )
        .map((r) => ({
          id: r.id,
          requestedByAttemptId: r.requestedByAttemptId,
          targetStepId: r.targetStepId,
          resumeAt: r.resumeAt,
          feedback: r.feedback,
          status: r.status,
        })),
      revisions: (run.revisions ?? [])
        .filter((r) => r.version > (previousVersion ?? 0))
        .map((r) => ({ version: r.version, reason: r.reason })),
      interruptedExecutions: interruptions.filter(
        (e) =>
          causal.has(e.attemptId) &&
          (previousTime ? Date.parse(e.endedAt) >= Date.parse(previousTime) : afterPrevious(e.attemptId))
      ),
    }
  })
}

/** Select exact flow attribution and bounded machine codes only, never transcripts or raw errors. */
export async function loadReviewContexts(
  store: DbHandle,
  workStreamId: string,
  run: WorkflowRun,
  scope: { attemptAgents: Record<string, string>; createdAt: Date }
): Promise<Record<string, WorkflowProducerReviewContext[]>> {
  const producers = activeWorkflowAttempts(run).filter((a) => producerReviewContexts(run, a).length > 0)
  if (!producers.length) return {}
  const causal = new Set(producers.flatMap((a) => [a.id, ...workflowCausalAttempts(run, a).map((s) => s.id)]))
  const agentIds = [
    ...new Set(
      [...causal].flatMap((id) => (scope.attemptAgents[String(id)] ? [scope.attemptAgents[String(id)]!] : []))
    ),
  ]
  const [rows, receipts] = await Promise.all([
    agentIds.length
      ? store
          .select({
            executionId: executions.id,
            flowContext: executions.flowContext,
            status: executions.status,
            failureClass: executions.failureClass,
            endedAt: executions.endedAt,
          })
          .from(executions)
          .where(
            and(
              inArray(executions.agentId, agentIds),
              gte(executions.startedAt, scope.createdAt),
              sql`${executions.flowContext}->>'workStreamId' = ${workStreamId}`,
              inArray(executions.status, ['failed', 'stopped']),
              isNotNull(executions.endedAt)
            )
          )
          .orderBy(desc(executions.startedAt), desc(executions.id))
          .limit(200)
      : Promise.resolve([]),
    store
      .select({
        command: workStreamFlowTransitions.command,
        version: workStreamFlowTransitions.version,
        createdAt: workStreamFlowTransitions.createdAt,
      })
      .from(workStreamFlowTransitions)
      .where(eq(workStreamFlowTransitions.workStreamId, workStreamId)),
  ])
  const versions: Record<number, number> = {}
  const settledAt: Record<number, string> = {}
  for (const receipt of receipts)
    if (receipt.command.attemptId != null && ['complete', 'return'].includes(receipt.command.action)) {
      versions[receipt.command.attemptId] = receipt.version
      settledAt[receipt.command.attemptId] = receipt.createdAt.toISOString()
    }
  const interruptions: WorkflowBriefInterruption[] = rows.flatMap((row) =>
    row.flowContext && row.endedAt
      ? [
          {
            executionId: row.executionId,
            attemptId: row.flowContext.attemptId,
            status: row.status as 'failed' | 'stopped',
            failureClass: row.failureClass?.slice(0, 100),
            endedAt: row.endedAt.toISOString(),
          },
        ]
      : []
  )
  return Object.fromEntries(
    producers.map((attempt) => [
      String(attempt.id),
      producerReviewContexts(run, attempt, interruptions, versions, settledAt),
    ])
  )
}
