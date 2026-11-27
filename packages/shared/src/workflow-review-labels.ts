import { agentTypeNoun, typeFirstAgentLabel } from './agentLabel'
import type { Agent } from './types'
import { workflowHistoricalStep, workflowReviewBriefForAttempt } from './workflow-review-history'
import {
  effectiveWorkflowStep,
  workflowCompletionTargets,
  type WorkflowAttempt,
  type WorkflowRun,
} from './workflow-runtime'
import type { WorkflowTransition } from './workflows'

/**
 * The review screen's plain words for people and effects, shared so web and Farm say the same thing:
 * who prepared an attempt, what an outcome does, what approval allows, and how long a review has waited.
 */

/** The squad's own name for an agent type (`AgentType.name`), when it is known. */
export type WorkflowAgentTypeName = (agentTypeId: string) => string | undefined
const noTypeNames: WorkflowAgentTypeName = () => undefined

export function workflowStepName(run: WorkflowRun, stepId: string): string {
  return run.definition.steps.find((entry) => entry.id === stepId)?.name ?? stepId
}

/** "changes-requested" as "Changes requested". */
export function workflowOutcomeLabel(outcome: string): string {
  const words = outcome.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "design-assessment · Attempt 16 · Proposal ready": the attempt whose handoff is under review. */
export function workflowAttemptSummary(run: WorkflowRun, attempt: WorkflowAttempt): string {
  const outcome = attempt.outcome ? ` · ${workflowOutcomeLabel(attempt.outcome)}` : ''
  return `${workflowStepName(run, attempt.stepId)} · Attempt ${attempt.id}${outcome}`
}

/** "Engineer", or "General Purpose agent" for the built-in general type (see `agentTypeNoun`). */
function agentNoun(type: string, typeName: WorkflowAgentTypeName): string {
  return agentTypeNoun({ agentTypeId: type, typeName: typeName(type) })
}

/** The agent type a step's participant runs as, when the step is an agent step. */
function stepAgentType(run: WorkflowRun, stepId: string): string | undefined {
  const step = run.definition.steps.find((entry) => entry.id === stepId)
  return step?.kind === 'agent' ? run.definition.participants[step.participant]?.agentTypeId : undefined
}

function joinWords(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/**
 * What an outcome does, in plain words, so a reviewer knows the effect before deciding: who gets the work
 * next ("Returns to the Engineer with your notes", "Next: Release (Engineer)"), or that the work stream
 * completes. It never restates the brief: what approval allows is shown whole beside the buttons.
 */
export function workflowOutcomeEffect(
  run: WorkflowRun,
  transition: WorkflowTransition,
  attempt?: WorkflowAttempt,
  outcome?: string,
  { typeName = noTypeNames }: { typeName?: WorkflowAgentTypeName } = {}
): string {
  if ('returnTo' in transition) {
    const type = stepAgentType(run, transition.returnTo)
    return type
      ? `Returns to the ${agentNoun(type, typeName)} with your notes`
      : `Returns to ${workflowStepName(run, transition.returnTo)} with your notes`
  }
  const targets =
    attempt && outcome
      ? workflowCompletionTargets(run, attempt, outcome)
      : 'parallel' in transition
        ? transition.parallel
        : [transition.next]
  if (targets.every((target) => target === 'finish')) return 'Completes the work stream'
  const described = targets.map((target) => {
    if (target === 'finish') return 'completion'
    const type = stepAgentType(run, target)
    return type ? `${workflowStepName(run, target)} (${agentNoun(type, typeName)})` : workflowStepName(run, target)
  })
  return `Next: ${joinWords(described)}`
}

/**
 * What approval allows, word for word, from a brief authored for this gate, when the gate has exactly one
 * forward outcome for it to describe. It is never shortened: a first sentence, a list's first step or a
 * statement without its code block can read as the whole promise. A carried-forward brief is not fresh
 * authorization for this gate, and join briefs that disagree are not merged, so neither gives one.
 */
export function workflowApprovalStatement(run: WorkflowRun, gateAttempt: WorkflowAttempt): string | undefined {
  const step = effectiveWorkflowStep(run, gateAttempt)
  if (!step || step.kind === 'agent') return undefined
  const forward = Object.values(step.outcomes).filter((transition) => !('returnTo' in transition))
  if (forward.length !== 1) return undefined
  const brief = workflowReviewBriefForAttempt(run, gateAttempt)
  if (brief.kind !== 'authored') return undefined
  const statements = [
    ...new Set(brief.sources.map((source) => source.decisionBrief?.value.approvalEffect?.trim() ?? '').filter(Boolean)),
  ]
  return statements.length === 1 ? statements[0] : undefined
}

/**
 * Who prepared an attempt's handoff: its agent's type, with the agent's purpose when it has one
 * ("Engineer (Payments)"), as the shared type-first label every surface uses. The type comes from the
 * agent when it is listed, else the participant the attempt ran as. Undefined for an attempt no agent ran.
 */
export function workflowAttemptAuthor(
  run: { state: WorkflowRun; attemptAgents: Record<string, string> },
  attempt: WorkflowAttempt,
  {
    agents,
    typeName = noTypeNames,
  }: {
    agents?: ReadonlyMap<string, Pick<Agent, 'agentTypeId' | 'metadata'>>
    typeName?: WorkflowAgentTypeName
  } = {}
): string | undefined {
  const agentId = run.attemptAgents[String(attempt.id)]
  const agent = agentId ? agents?.get(agentId) : undefined
  const step = workflowHistoricalStep(run.state, attempt)
  const participantType =
    attempt.participant?.agentTypeId ??
    (step?.kind === 'agent' ? run.state.definition.participants[step.participant]?.agentTypeId : undefined)
  const type = agent?.agentTypeId ?? participantType
  if (!type) return undefined
  const purpose = agent?.metadata?.purpose
  return typeFirstAgentLabel({
    agentTypeId: type,
    typeName: typeName(type),
    purpose: typeof purpose === 'string' ? purpose : undefined,
  })
}

/** "Waiting 7 days": how long a review has waited, in the largest whole unit. */
export function workflowWaitingLabel(openedAt: string, now: number): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(openedAt)) / 60_000)
  const unit = (count: number, word: string) => `Waiting ${count} ${word}${count === 1 ? '' : 's'}`
  if (minutes < 1) return 'Waiting less than a minute'
  if (minutes < 60) return unit(minutes, 'minute')
  if (minutes < 24 * 60) return unit(Math.floor(minutes / 60), 'hour')
  return unit(Math.floor(minutes / (24 * 60)), 'day')
}
