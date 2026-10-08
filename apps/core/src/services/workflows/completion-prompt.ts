import {
  changeRequestBindCommand,
  codeHostBindingCommand,
  describeCodeHostReference,
  trackedResourceLabel,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@ficus/shared'

/** Delivery guidance is shared by every flow participant, independent of squad or agent type. */
export function flowCompletionInstructions(mode: WorkflowDefinition['completion']['mode']): string {
  const guidance = {
    deliverable:
      'Deliver the requested result with verification evidence. No PR, repository mutation, or additional reviewer is required by this completion mode.',
    'review-approval':
      'Present the completed result and evidence to the human for delivery approval. A human must invoke flow finish; a participant cannot approve delivery on their behalf.',
    'pr-merge':
      'Prepare and push the configured branch and create or reuse its PR. Leave merging to the human; do not merge it yourself. Wait until the configured code hosting integration confirms that the PR is merged before finishing the flow.',
    'pr-auto-merge': [
      'Prepare and push the configured branch and create or reuse its PR.',
      'Read the current squad metadata.policies.allowAutoMerge before enabling the provider’s native auto-merge. It must be explicitly true; a missing flag means permission is not granted. Do not enable that policy yourself.',
      'After completing the workflow’s required validation, self-review, and any declared independent review or human-approval gates, verify the live PR base and exact head match the configured base and validated/reviewed deliverable, then enable native auto-merge now. Do not add an independent reviewer to a Solo flow or skip a declared gate; new commits require authorized rework and affected checks/reviews again.',
      'GitHub required CI and external PR approvals may still be pending when you enable auto-merge; the provider must enforce them before the actual merge. This is not authority to approve as a human or change branch protections. Native auto-merge is a code-host feature, not application publication or deployment permission.',
      'If permission is absent or the provider rejects auto-merge, leave the PR open for a human merge and explain the fallback to the owner. Never use --admin or bypass required checks and approvals.',
      'Enabling auto-merge is not completion: wait until the configured code hosting integration confirms the PR is merged before finishing the flow. GitHub autoMergeRequest can be null after an immediate merge; inspect the live merged state rather than treating null as a failed enable.',
    ].join(' '),
    'direct-merge':
      'Read the current squad metadata.policies.allowDirectMerge before merging or pushing to the base branch. It must be explicitly true; a missing flag means permission is not granted. Do not enable that policy yourself. If permission is absent, ask the owner to authorize a revision to pr-merge; do not silently change the flow or merge directly. If allowed, integrate the configured work-stream commit using a clean base checkout or integration worktree, preserving other work, and push the base branch. Record codeHost.integration, codeHost.repository, git.baseBranch, and git.commit (the full deliverable SHA). Flow finish verifies that the commit is included in the remote base branch.',
  } satisfies Record<WorkflowDefinition['completion']['mode'], string>

  const pr = mode === 'pr-merge' || mode === 'pr-auto-merge'
  return [
    `Delivery policy: ${mode}. The workflow determines responsibility for delivery; no agent role intrinsically owns PR creation or completion.`,
    guidance[mode],
    pr
      ? 'Use the work stream’s existing codeHost binding. Open the delivery PR from this stream’s branch (metadata.git.branch) against its base branch: Ficus binds it to codeHost.changeRequest automatically as soon as the code host reports it (fork pull requests never bind), so its comments, reviews, and CI reach this stream during review, and finish resolves it from the branch as a fallback. No manual binding step is required; attach codeHost.changeRequest.number and codeHost.changeRequest.url yourself only when the delivery PR comes from a different branch or to replace a wrong binding (codeHost is strictly validated: changeRequest accepts only number and url, so record merge evidence such as state, verification time, or merge commit under metadata.delivery instead). If the binding is missing, identify the repository and squad-authorized integration first. Check live PR mergeability after creation, CI, and approval. Resolve conflicts through an authorized flow return or revision and re-review the affected changes. Do not use a legacy completing review wait to finish a flow. Additional pull requests that are part of the deliverable must be designated with `ficus workstream track <ws-id> --pr <owner/repo#n> --delivery`; finish verifies every designated delivery PR is merged. `ficus workstream tracked <ws-id>` shows the delivery state.'
      : '',
    'At completion-ready, use ficus workstream finish with the current --version once the delivery condition is met.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The completion-ready self-check for PR delivery: what is bound right now, and the exact repair
 * command when the primary binding is incomplete. Derived from live metadata so it can never
 * contradict what `finish` will verify.
 */
export function deliveryBindingSelfCheck(
  stream: { id: string; metadata?: unknown },
  mode: WorkflowDefinition['completion']['mode']
): string {
  if (mode !== 'pr-merge' && mode !== 'pr-auto-merge') return ''
  const described = describeCodeHostReference(stream.metadata)
  const git = (stream.metadata as { git?: { branch?: unknown } } | null)?.git
  const branch = typeof git?.branch === 'string' && git.branch ? git.branch : undefined
  if (described.status === 'absent')
    return [
      'Delivery binding self-check: codeHost is not configured for this work stream, so flow finish cannot verify delivery.',
      `Set the integration and repository first: ${codeHostBindingCommand(stream.id)}${branch ? ` (this stream's branch is ${branch})` : ''}.`,
    ].join(' ')
  if (described.status === 'invalid')
    return `Delivery binding self-check: codeHost metadata is invalid: ${described.issues.join('; ')}. Fix the metadata before finish; keep verification evidence outside codeHost.`
  const { integration, repository, changeRequest } = described.reference
  if (changeRequest) {
    const label = trackedResourceLabel({ integration, repository, number: changeRequest.number })
    return [
      `Delivery binding self-check: bound to ${label}${changeRequest.url ? ` (${changeRequest.url})` : ''}${branch ? ` on branch ${branch}` : ''}.`,
      `ficus workstream finish ${stream.id} verifies this pull request is merged; replace the binding only with ${changeRequestBindCommand(stream.id, stream.metadata)} if it is wrong.`,
    ].join(' ')
  }
  return [
    `Delivery binding self-check: codeHost is configured (${integration}, ${repository}) but codeHost.changeRequest is absent.`,
    branch
      ? `A pull request opened from this stream's branch ${branch} binds automatically when the code host reports it, and ficus workstream finish otherwise resolves it from the branch (fork pull requests never match); bind manually with ${changeRequestBindCommand(stream.id, stream.metadata)} only when the delivery pull request comes from a different branch, which overrides that resolution. Flow finish then fails until the pull request is merged.`
      : `This stream records no branch (metadata.git.branch), so finish cannot resolve the delivery pull request automatically: bind it manually with ${changeRequestBindCommand(stream.id, stream.metadata)}.`,
  ].join(' ')
}

/** Only current, active delivery work needs the provider/delivery procedure. */
export function deliveryInstructionsForRun(
  stream: { id: string; status: string; pause?: unknown; metadata?: unknown },
  state: WorkflowRun,
  version: number
): string | undefined {
  if (stream.status !== 'active' || stream.pause || state.status !== 'completion-ready') return undefined
  const selfCheck = deliveryBindingSelfCheck(stream, state.definition.completion.mode)
  return [
    flowCompletionInstructions(state.definition.completion.mode) + (selfCheck ? `\n\n${selfCheck}` : ''),
    `When the condition is met: ficus workstream finish ${stream.id} --version ${version}.`,
  ].join('\n\n')
}
