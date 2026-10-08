import {
  workStreamLabel,
  workStreamRef,
  activeWorkflowAttempts,
  effectiveWorkflowStep,
  workflowIncomingAttempts,
  type WorkflowAttempt,
  type WorkflowRun,
} from '@ficus/shared'
import { flowCapabilityInstructions } from './capability-instructions'

type HandoffStream = {
  id: string
  number?: number
  title: string
  description: string
  handoffMessage?: string | null
  metadata: unknown
}

/** Preserve requirements and evidence verbatim; keep shared operating rules out of each assignment. */
export function flowMessage(
  stream: HandoffStream,
  run: { state: WorkflowRun; version: number },
  attempt: WorkflowAttempt
) {
  const step = effectiveWorkflowStep(run.state, attempt)
  const metadata = stream.metadata as { git?: Record<string, unknown>; codeHost?: Record<string, unknown> } | null
  const workspace = [
    ['Worktree', metadata?.git?.worktree],
    ['Branch', metadata?.git?.branch],
    ['Base', metadata?.git?.baseBranch],
    ['Repository', metadata?.codeHost?.repository ?? metadata?.git?.repository],
  ].filter(([, value]) => typeof value === 'string' && value.length)
  // Runtime provenance follows the actual handoff, not every possible graph edge or prior result.
  const results = workflowIncomingAttempts(run.state, attempt)
    .filter((entry) => entry.evidence || entry.feedback)
    .map((entry) => `${entry.stepId} (attempt ${entry.id}): ${entry.evidence ?? entry.feedback}`)
  const returns = run.state.returns.filter(
    (entry) =>
      entry.status === 'open' &&
      entry.branch?.forkId === attempt.branch?.forkId &&
      entry.branch?.branchId === attempt.branch?.branchId
  )
  const example = {
    expectedVersion: run.version,
    attemptId: attempt.id,
    action: 'complete',
    outcome: Object.keys(step.outcomes)[0],
    evidence: 'Describe the result, checks performed, and relevant paths or links.',
  }
  return [
    `Work stream ${workStreamLabel(stream)}: ${stream.title}\nStep: ${step.id} (attempt ${attempt.id}, version ${run.version})`,
    step.kind === 'decision' ? step.instructions : `${step.instructions}\nExpected output: ${step.output}`,
    workspace.length ? workspace.map(([label, value]) => `${label}: ${value}`).join('\n') : '',
    attempt.feedback ? `Rework request:\n${attempt.feedback}` : '',
    results.length ? `Incoming results:\n\n${results.join('\n\n')}` : '',
    attempt.sourceAttemptIds === undefined
      ? 'This older attempt has no recorded handoff sources; consult the run history for its incoming context.'
      : '',
    returns.length
      ? `Open return requests:\n${returns.map((entry) => `${entry.targetStepId} → ${entry.resumeAt}: ${entry.feedback}`).join('\n')}`
      : '',
    stream.description
      ? `Original work brief (initial context; use incoming results for progress):\n${stream.description}`
      : '',
    stream.handoffMessage ? `Owner's handoff:\n${stream.handoffMessage}` : '',
    flowCapabilityInstructions(run.state, attempt, run.version),
    attempt.branch || activeWorkflowAttempts(run.state).length > 1
      ? 'Parallel work is active in this shared workspace.'
      : '',
    `Prefer --content with single-quoted JSON for short commands, or --stdin with a quoted heredoc for longer evidence; no temporary file is needed. Choose the appropriate outcome above and replace the evidence string:\n\`\`\`bash\nficus workstream advance ${workStreamRef(stream)} --stdin <<'FICUS_COMMAND'\n${JSON.stringify(example, null, 2)}\nFICUS_COMMAND\n\`\`\``,
  ]
    .filter(Boolean)
    .join('\n\n')
}
