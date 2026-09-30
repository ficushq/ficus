import { effectiveWorkflowStep, isEarlierWorkflowStep, type WorkflowAttempt, type WorkflowRun } from '@ficus/shared'

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
      ? 'Live revision: use action=revise, operations, reason, and active=keep. Live outcome changes require flow management permission; workers may revise permitted future work. Preserve existing steps, current attempts and their outcomes, participants, and delivery policy; do not increase limits. Other changes require the manager.'
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
      `Limits: ${limits.join('; ')}.${definition.limits.maxStepAttempts === undefined ? '' : ' Request owner input if the attempt limit is exhausted.'}`
    )
  return lines.join('\n')
}
