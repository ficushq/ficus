import type { WorkflowAttempt, WorkflowRun } from './workflow-runtime'
import type { WorkflowDecisionBrief } from './workflow-decision-brief'

export interface WorkflowBriefInterruption {
  executionId: string
  attemptId: number
  status: 'failed' | 'stopped'
  failureClass?: string | null
  endedAt: string
}
export interface WorkflowBriefContext {
  gateStepId: string
  previousDecisionAttemptId?: number
  returnIds: number[]
  revisionVersions: number[]
  interruptedExecutions: WorkflowBriefInterruption[]
}
export interface WorkflowBriefSubmission {
  value: WorkflowDecisionBrief
  submittedVersion: number
  contexts: WorkflowBriefContext[]
}
export type WorkflowReviewBriefBinding =
  | { kind: 'authored'; sourceAttemptIds: number[]; carriedSourceAttemptIds?: number[] }
  | { kind: 'carried-forward'; sourceAttemptId: number }
  | { kind: 'none' }
  | { kind: 'legacy' }

/** Resolve historical kind without letting today's definition rewrite a recorded round. */
export function workflowHistoricalStep(run: WorkflowRun, attempt: WorkflowAttempt) {
  return (
    attempt.step ??
    run.revisions?.[attempt.revision ?? 0]?.definition.steps.find((s) => s.id === attempt.stepId) ??
    run.definition.steps.find((s) => s.id === attempt.stepId)
  )
}
export function workflowEarlierHumanDecisions(
  run: WorkflowRun,
  gateStepId: string,
  versions: Record<number, number> = {}
) {
  return run.attempts
    .filter(
      (a) =>
        a.stepId === gateStepId &&
        workflowHistoricalStep(run, a)?.kind === 'human-approval' &&
        (a.status === 'completed' || a.status === 'returned') &&
        (a.outcome !== undefined || (a.status === 'returned' && !!a.feedback))
    )
    .sort((a, b) => (b.settledVersion ?? versions[b.id] ?? b.id) - (a.settledVersion ?? versions[a.id] ?? a.id))
}
/** Causal sources only. An agent is a boundary, not a bridge to an older producer's brief. */
export function workflowCausalAttempts(run: WorkflowRun, attempt: WorkflowAttempt): WorkflowAttempt[] {
  const found = new Map<number, WorkflowAttempt>()
  const pending = [...(attempt.sourceAttemptIds ?? [])]
  while (pending.length) {
    const id = pending.pop()!
    const source = run.attempts.find((a) => a.id === id)
    if (!source || found.has(id)) continue
    found.set(id, source)
    pending.push(...(source.sourceAttemptIds ?? []))
  }
  return [...found.values()].sort((a, b) => a.id - b.id)
}
export function workflowCarryForwardSources(run: WorkflowRun, sourceIds: number[]): WorkflowAttempt[] {
  const found = new Map<number, WorkflowAttempt>()
  const pending = [...sourceIds]
  const visited = new Set<number>()
  while (pending.length) {
    const id = pending.pop()!
    if (visited.has(id) || id <= (run.attemptEpoch ?? 0)) continue
    visited.add(id)
    const source = run.attempts.find((a) => a.id === id)
    if (!source || !['completed', 'returned'].includes(source.status)) continue
    if (workflowHistoricalStep(run, source)?.kind === 'agent') {
      if (source.status === 'completed' && source.decisionBrief) found.set(id, source)
      continue
    }
    if (source.freshSession) continue
    // A fresh, explicitly bound return-to-human submission may be carried, never traversed.
    const bound = source.reviewBrief
    if (bound?.kind === 'authored')
      for (const sourceId of bound.sourceAttemptIds) {
        const producer = run.attempts.find((a) => a.id === sourceId)
        if (producer?.status === 'returned' && producer.id > (run.attemptEpoch ?? 0) && producer.decisionBrief)
          found.set(producer.id, producer)
      }
    pending.push(...(source.sourceAttemptIds ?? []))
  }
  return [...found.values()].sort(
    (a, b) => b.decisionBrief!.submittedVersion - a.decisionBrief!.submittedVersion || b.id - a.id
  )
}
export function workflowReviewBriefForAttempt(
  run: WorkflowRun,
  attempt: WorkflowAttempt
): {
  kind: 'authored' | 'carried-forward' | 'none' | 'legacy'
  sources: WorkflowAttempt[]
  carriedSources?: WorkflowAttempt[]
} {
  if (attempt.reviewBrief?.kind === 'legacy') return { kind: 'legacy', sources: [] }
  if (attempt.freshSession && workflowHistoricalStep(run, attempt)?.kind === 'human-approval')
    return { kind: 'none', sources: [] }
  const binding = attempt.reviewBrief
  if (binding?.kind === 'authored')
    return {
      kind: 'authored',
      sources: run.attempts.filter((a) => binding.sourceAttemptIds.includes(a.id) && !!a.decisionBrief),
      ...(binding.carriedSourceAttemptIds?.length
        ? {
            carriedSources: run.attempts.filter(
              (a) => binding.carriedSourceAttemptIds!.includes(a.id) && !!a.decisionBrief
            ),
          }
        : {}),
    }
  if (binding?.kind === 'none') return { kind: 'none', sources: [] }
  // Historical bound rounds retain their original provenance after reopen; they do not donate to the new epoch.
  const scope = binding && attempt.id <= (run.attemptEpoch ?? 0) ? { ...run, attemptEpoch: 0 } : run
  const eligible = workflowCarryForwardSources(scope, attempt.sourceAttemptIds ?? [])
  if (binding?.kind === 'carried-forward') {
    const source = eligible.find((a) => a.id === binding.sourceAttemptId)
    return source ? { kind: 'carried-forward', sources: [source] } : { kind: 'none', sources: [] }
  }
  if (workflowHistoricalStep(run, attempt)?.kind === 'decision')
    return eligible[0] ? { kind: 'carried-forward', sources: [eligible[0]] } : { kind: 'none', sources: [] }
  const direct = run.attempts.filter((a) => attempt.sourceAttemptIds?.includes(a.id))
  if (!direct.length || direct.some((a) => workflowHistoricalStep(run, a)?.kind === 'agent'))
    return { kind: 'legacy', sources: [] }
  return eligible[0] ? { kind: 'carried-forward', sources: [eligible[0]] } : { kind: 'none', sources: [] }
}
export interface WorkflowProducerReviewContext {
  gateStepId: string
  outcomes: string[]
  viaResume: boolean
  viaReturn?: boolean
  previousDecisions: Array<{
    attemptId: number
    version?: number
    kind: 'outcome' | 'return'
    outcome?: string
    notes?: string
  }>
  returns: Array<{
    id: number
    requestedByAttemptId: number
    targetStepId: string
    resumeAt: string
    feedback: string
    status: 'open' | 'resolved' | 'superseded'
  }>
  revisions: Array<{ version: number; reason: string }>
  interruptedExecutions: WorkflowBriefInterruption[]
}
