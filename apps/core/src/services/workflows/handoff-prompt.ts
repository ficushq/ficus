import {
  workStreamLabel,
  workStreamRef,
  activeWorkflowAttempts,
  effectiveWorkflowStep,
  workflowIncomingAttempts,
  workflowCompletionReviewTargets,
  workflowDecisionRevisionNote,
  type WorkflowAttempt,
  type WorkflowRun,
  type WorkflowProducerReviewContext,
} from '@ficus/shared'
import { createHash } from 'node:crypto'
import { flowCompletionInstructions } from './completion-prompt'
import { flowCapabilityInstructions } from './capability-instructions'

type HandoffStream = {
  id: string
  number?: number
  title: string
  description: string
  handoffMessage?: string | null
  metadata: unknown
}

/** Reviewers read handoff files inline, so deliverables are attached rather than pasted or only named. */
const ATTACH_GUIDANCE =
  'Attach the documents your result refers to (design docs, reports, plans, screenshots) by adding --attach <path> to the advance command, once per file (at most 10, 10 MB each); reviewers read them alongside your handoff. Keep evidence a concise summary that names each attached file; do not paste their contents.'

/** Identifies the work brief an assignment carries, so an agent that already has it is not sent it again. */
export function workStreamBriefDigest(stream: Pick<HandoffStream, 'description' | 'handoffMessage'>): string {
  return createHash('sha256')
    .update(JSON.stringify([stream.description ?? '', stream.handoffMessage ?? '']))
    .digest('hex')
}

/**
 * Preserve requirements and evidence verbatim; keep shared operating rules out of each assignment.
 * `briefSeenInAttempt` names an earlier attempt in which this same agent session received the unchanged
 * work brief: the brief, owner's handoff and standing guidance are then not restated.
 */
export function flowMessage(
  stream: HandoffStream,
  run: { state: WorkflowRun; version: number },
  attempt: WorkflowAttempt,
  /** Present when the stream was built on a dependency's unmerged branch. */
  stackNotice?: string,
  reviewContexts?: WorkflowProducerReviewContext[],
  briefSeenInAttempt?: number
) {
  const seen = briefSeenInAttempt !== undefined
  const step = effectiveWorkflowStep(run.state, attempt)
  const metadata = stream.metadata as { git?: Record<string, unknown>; codeHost?: Record<string, unknown> } | null
  const workspace = [
    ['Worktree', metadata?.git?.worktree],
    ['Branch', metadata?.git?.branch],
    ['Base', metadata?.git?.baseBranch],
    ['Repository', metadata?.codeHost?.repository ?? metadata?.git?.repository],
  ].filter(([, value]) => typeof value === 'string' && value.length)
  // Runtime provenance follows the actual handoff, not every possible graph edge or prior result.
  // A human decision always names the revision it was made on, even without notes. The rework request
  // is shown once on its own, so a result whose text is that request is not repeated here.
  const results = workflowIncomingAttempts(run.state, attempt).flatMap((entry) => {
    const text = entry.evidence || entry.feedback
    const repeatsRequest = !!attempt.feedback && text === attempt.feedback
    const decided = workflowDecisionRevisionNote(run.state, entry)
    if (decided)
      return [
        `${entry.stepId} (attempt ${entry.id}): ${decided}. ${
          !text ? 'No decision notes.' : repeatsRequest ? 'The notes are the rework request above.' : `Notes: ${text}`
        }`,
      ]
    return text && !repeatsRequest ? [`${entry.stepId} (attempt ${entry.id}): ${text}`] : []
  })
  const returns = run.state.returns.filter(
    (entry) =>
      entry.status === 'open' &&
      entry.branch?.forkId === attempt.branch?.forkId &&
      entry.branch?.branchId === attempt.branch?.branchId
  )
  const outcome = Object.keys(step.outcomes)[0]!
  let humanNext = false
  try {
    humanNext = step.kind === 'agent' && workflowCompletionReviewTargets(run.state, attempt, outcome).length > 0
  } catch {
    /* The current return may require explicit resume. */
  }
  const example = {
    expectedVersion: run.version,
    attemptId: attempt.id,
    action: 'complete',
    outcome,
    ...(humanNext
      ? {
          decisionBrief: {
            decision: 'Approve the proposed staging design.',
            recommendation: 'Approve because the documented fallback preserves existing reads.',
            approvalEffect:
              'Approval permits the described staging implementation, not production deployment. Replace this example with exact scope and resource IDs.',
            risks: 'Temporary parallel read paths increase maintenance work.',
            changesSinceLastReview:
              'State the earlier decision, why work returned or stopped, and what changed; omit this field for a first review.',
          },
        }
      : {}),
    evidence: 'Describe the result, checks performed, and relevant paths or links.',
  }
  return [
    `Work stream ${workStreamLabel(stream)}: ${stream.title}\nStep: ${step.id} (attempt ${attempt.id}, version ${run.version})`,
    step.kind === 'decision' ? step.instructions : `${step.instructions}\nExpected output: ${step.output}`,
    workspace.length ? workspace.map(([label, value]) => `${label}: ${value}`).join('\n') : '',
    stackNotice ?? '',
    attempt.feedback ? `Rework request:\n${attempt.feedback}` : '',
    results.length ? `Incoming results:\n\n${results.join('\n\n')}` : '',
    attempt.sourceAttemptIds === undefined
      ? 'This older attempt has no recorded handoff sources; consult the run history for its incoming context.'
      : '',
    returns.length
      ? `Open return requests:\n${returns.map((entry) => `${entry.targetStepId} → ${entry.resumeAt}: ${entry.feedback}`).join('\n')}`
      : '',
    seen
      ? `You already have this work stream's brief from your attempt ${briefSeenInAttempt} assignment in this session, and it has not changed, so it is not repeated. If your context no longer has it, run \`ficus workstream get ${workStreamRef(stream)}\`.`
      : stream.description
        ? `Original work brief (initial context; use incoming results for progress):\n${stream.description}`
        : '',
    !seen && stream.handoffMessage ? `Owner's handoff:\n${stream.handoffMessage}` : '',
    reviewContexts?.length ? `Context for the next human review:\n${JSON.stringify(reviewContexts, null, 2)}` : '',
    flowCapabilityInstructions(run.state, attempt, run.version),
    !seen && run.state.definition.completion.mode === 'pr-review' ? flowCompletionInstructions('pr-review') : '',
    attempt.branch || activeWorkflowAttempts(run.state).length > 1
      ? 'Parallel work is active in this shared workspace.'
      : '',
    `${seen ? '' : 'Prefer --content with single-quoted JSON for short commands, or --stdin with a quoted heredoc for longer evidence; no temporary file is needed. '}Choose the appropriate outcome above and replace the evidence string:\n\`\`\`bash\nficus workstream advance ${workStreamRef(stream)} --stdin <<'FICUS_COMMAND'\n${JSON.stringify(example, null, 2)}\nFICUS_COMMAND\n\`\`\``,
    step.kind === 'decision' || seen ? '' : ATTACH_GUIDANCE,
  ]
    .filter(Boolean)
    .join('\n\n')
}
