import {
  workflowCompletionReviewTargets,
  workflowReturnReviewTargets,
  workflowEarlierHumanDecisions,
  WORKFLOW_DECISION_BRIEF_LIMITS,
  effectiveWorkflowStep,
  isEarlierWorkflowStep,
  type WorkflowAttempt,
  type WorkflowRun,
} from '@ficus/shared'

/** Explain the actual run's capabilities, including the active attempt's pinned handoffs. */
export function flowCapabilityInstructions(state: WorkflowRun, attempt: WorkflowAttempt, version = state.version) {
  const { definition } = state
  const step = effectiveWorkflowStep(state, attempt)
  const remaining = Math.max(0, definition.limits.maxDelegations - (state.delegationCount ?? 0))
  const lines = [
    'Outcomes:\n',
    ...Object.entries(step.outcomes).map(([name, target]) =>
      'next' in target
        ? `- ${name}: ${target.next === 'finish' ? 'delivery policy' : target.next}`
        : 'parallel' in target
          ? `- ${name}: ${target.parallel.join(' + ')} in parallel${target.join ? `, then join at ${target.join}` : ''}`
          : `- ${name}: revise ${target.returnTo}, then ${target.afterRework === 'return-to-requester' ? `return directly to ${step.id}` : 'follow that step’s normal arrows'}`
    ),
  ]
  if (step.kind === 'agent') {
    let humanNext = false
    for (const outcome of Object.keys(step.outcomes)) {
      for (const resume of [false, true]) {
        let targets: string[]
        try {
          targets = workflowCompletionReviewTargets(state, attempt, outcome, resume)
        } catch {
          continue
        }
        if (!targets.length) continue
        humanNext = true
        lines.push(
          `For outcome '${outcome}'${resume ? ' with resume=true' : ''}, a human decides next at ${targets.join(', ')}. The completing producing agent writes decisionBrief; no manager authors it.`
        )
        for (const gate of targets) {
          const previous = workflowEarlierHumanDecisions(state, gate)[0]
          if (previous)
            lines.push(
              `Gate '${gate}' has an earlier decision (attempt ${previous.id}); changesSinceLastReview is required.`
            )
        }
      }
    }
    if (humanNext)
      lines.push(
        'While that gate is open, the reviewer may chat with you from the review screen; refine your result only with action amend, and recommend Changes requested for anything bigger.'
      )
    const returnGates = definition.steps.filter((gate) => {
      if (gate.kind !== 'human-approval') return false
      try {
        return workflowReturnReviewTargets(state, attempt, gate.id).length > 0
      } catch {
        return false
      }
    })
    for (const gate of returnGates) {
      lines.push(
        `For action=return to '${gate.id}', a human decides next. The completing producing agent writes decisionBrief; keep feedback as the separate return explanation.`
      )
      const previous = workflowEarlierHumanDecisions(state, gate.id)[0]
      if (previous)
        lines.push(
          `Gate '${gate.id}' has an earlier decision (attempt ${previous.id}); changesSinceLastReview is required.`
        )
    }
    if (returnGates.length)
      lines.push(
        'For an explicit human-directed return, replace every example field with the actual decision, scope and risks:',
        '```bash',
        "ficus workstream advance STREAM_ID --stdin <<'FICUS_COMMAND'",
        JSON.stringify(
          {
            expectedVersion: version,
            attemptId: attempt.id,
            action: 'return',
            targetStepId: returnGates[0]!.id,
            resumeAt: step.id,
            feedback: 'Review the revised staging scope before work resumes.',
            decisionBrief: {
              decision: 'Approve the revised staging design.',
              recommendation: 'Approve because the documented fallback preserves existing reads.',
              approvalEffect:
                'Approval permits the specified staging work only, not production deployment. Replace this example with exact scope and resource IDs.',
              risks: 'Temporary parallel read paths increase maintenance work.',
              changesSinceLastReview:
                'State the earlier decision, why work returned or stopped, and what changed; omit this field for a first review.',
            },
          },
          null,
          2
        ),
        'FICUS_COMMAND',
        '```'
      )
    lines.push(
      'A decisionBrief is mandatory on agent-produced human-directed completions and explicit returns, and optional otherwise. Keep evidence or return feedback as the separate agent and audit handoff. The fields are decision (one or two history-independent sentences), recommendation (what and why), approvalEffect (what approval permits, exact resource IDs and what remains forbidden), risks (tradeoffs), and changesSinceLastReview (last decision, why work returned or an execution failed, and what changed; required after an earlier gate decision).',
      `Field limits in characters: ${Object.entries(WORKFLOW_DECISION_BRIEF_LIMITS)
        .map(([name, limit]) => `${name}: ${limit}`)
        .join('; ')}.`,
      'Write every text field in normal, readable prose with normal spacing and complete words. Never remove spaces, run words together, invent abbreviations, or use telegraphic shorthand to save tokens or length. When material is long, use headings, bullets, or a linked file instead of compressing it. Preserve exact identifiers, code, URLs, paths, and quoted source material; the rule governs authored prose, not literal data.',
      'Refresh ficus workstream flow immediately before submission to inspect earlier decisions, return reasons and failed or stopped executions, including retries on this same attempt. Do not rewrite gate instructions or infer permission to bypass an outstanding hold.'
    )
  }
  lines.push('')
  if (definition.routing.mode !== 'guided' && definition.routing.returnTo === 'earlier-steps') {
    const declaredReturns = new Set(
      Object.values(step.outcomes).flatMap((target) => ('returnTo' in target ? [target.returnTo] : []))
    )
    const earlier = definition.steps.filter(
      (entry) => !declaredReturns.has(entry.id) && isEarlierWorkflowStep(state, entry.id, step.id)
    )
    if (earlier.length)
      lines.push(
        `Additional return targets: ${earlier.map((step) => step.id).join(', ')}. Use action=return, targetStepId, resumeAt=${step.id}, and feedback.`
      )
  }
  if (definition.routing.delegation === 'allowed' && remaining > 0) {
    lines.push(
      `Delegation: enabled, ${remaining} of ${definition.limits.maxDelegations} specialist assignments remain across the whole flow.`,
      'Use a worker agent type from ficus agent-type list (exclude systemOnly or disabled types). Set agentTypeId to its agent-type ID. A new participant starts on demand; its result returns to this step. Do not manually spawn an untracked helper.',
      'Prefer --content with single-quoted JSON for short commands, or --stdin with a quoted heredoc for longer JSON/YAML; no temporary file is needed. Replace STREAM_ID with this work stream ID, agentTypeId with the chosen worker type, and task with a self-contained request:',
      '```bash',
      "ficus workstream advance STREAM_ID --stdin <<'FICUS_COMMAND'",
      JSON.stringify(
        {
          expectedVersion: version,
          attemptId: attempt.id,
          action: 'delegate',
          participant: { agentTypeId: 'general', session: 'reuse-within-stream' },
          task: 'Investigate the specific question and return findings with evidence.',
        },
        null,
        2
      ),
      'FICUS_COMMAND',
      '```'
    )
  } else
    lines.push(
      definition.routing.delegation === 'disabled'
        ? 'Delegation: disabled.'
        : 'Delegation: budget exhausted. Ask the manager for an authorized revision; do not bypass the limit with a new agent or stream.'
    )
  lines.push(
    definition.routing.mode === 'adaptive'
      ? 'Live revision: use action=revise, operations, reason, and active=keep. Live outcome changes require flow management permission; workers may revise permitted future work. Preserve existing steps, current attempts and their outcomes, participants, and delivery policy; do not increase limits. A new step may be a decision step (kind decision: a decision model routes on typed questions, no participant; see the setup-workflows skill), which cannot be a returnTo target. Other changes require the manager.'
      : 'Other flow changes: flow-management permission is required; ask the manager.'
  )
  const limits = [
    definition.limits.maxStepAttempts === undefined ? '' : `${definition.limits.maxStepAttempts} attempts per step`,
    definition.limits.maxParallelAttempts === undefined
      ? ''
      : `${definition.limits.maxParallelAttempts} concurrent attempts (extra starts queue)`,
  ].filter(Boolean)
  if (limits.length)
    lines.push(
      `Limits: ${limits.join('; ')}.${definition.limits.maxStepAttempts === undefined ? '' : ' When a step uses its last attempt the flow pauses; a reviewer, the stream owner, or the squad manager can raise or remove the limit with ficus workstream raise-limit.'}`
    )
  return lines.join('\n')
}
