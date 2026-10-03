import { describe, expect, test } from 'bun:test'
import { deliveryBindingSelfCheck, deliveryInstructionsForRun, flowCompletionInstructions } from './completion-prompt'
import { advanceWorkflowRun, createBlankWorkflow, createWorkflowRun, type WorkflowRun } from '@ficus/shared'

const stream = (id: string, metadata?: unknown) => ({ id, metadata })
const run = (mode: 'pr-merge' | 'pr-auto-merge' | 'deliverable') => {
  const definition = createBlankWorkflow()
  definition.completion.mode = mode
  const state = createWorkflowRun(definition)
  state.status = 'completion-ready'
  return state
}

describe('delivery binding self-check', () => {
  test('absent binding names the exact integration/repository repair', () => {
    const check = deliveryBindingSelfCheck(stream('11111111-1111-4111-8111-111111111111'), 'pr-merge')
    expect(check).toContain('codeHost is not configured for this work stream')
    expect(check).toContain(
      `ficus workstream set-meta 11111111-1111-4111-8111-111111111111 codeHost '{"integration":"github","repository":"<owner/repo>"}'`
    )
  })

  test('missing change request names the exact bind command and the finish-time resolution', () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const check = deliveryBindingSelfCheck(
      stream(id, { codeHost: { integration: 'github', repository: 'owner/repo' }, git: { branch: 'work/x' } }),
      'pr-auto-merge'
    )
    expect(check).toContain('codeHost.changeRequest is absent')
    expect(check).toContain(
      `ficus workstream set-meta ${id} codeHost.changeRequest '{"number":<pr-number>,"url":"<pr-url>"}'`
    )
    expect(check).toContain("stream's branch work/x")
    expect(check).toContain('binds automatically when the code host reports it')
    expect(check).toContain('fork pull requests never match')
    expect(check).toContain('only when the delivery pull request comes from a different branch')
  })

  test('a branchless stream is told the manual bind is required; legacy shapes get github.pr', () => {
    const id = '44444444-4444-4444-8444-444444444444'
    const branchless = deliveryBindingSelfCheck(
      stream(id, { codeHost: { integration: 'github', repository: 'owner/repo' } }),
      'pr-merge'
    )
    expect(branchless).toContain('records no branch (metadata.git.branch)')
    expect(branchless).toContain('bind it manually')
    const legacy = deliveryBindingSelfCheck(
      stream(id, { github: { repo: 'owner/repo' }, git: { branch: 'work/x' } }),
      'pr-merge'
    )
    expect(legacy).toContain(`ficus workstream set-meta ${id} github.pr '{"number":<pr-number>,"url":"<pr-url>"}'`)
  })

  test('bound pull request is reported with its identity, and invalid metadata is named', () => {
    expect(
      deliveryBindingSelfCheck(
        stream('id-1', {
          codeHost: { integration: 'github', repository: 'owner/repo', changeRequest: { number: 7 } },
        }),
        'pr-merge'
      )
    ).toContain('bound to owner/repo#7')
    expect(
      deliveryBindingSelfCheck(
        stream('id-2', { codeHost: { integration: 'github', repository: 'owner/repo', changeRequest: { extra: 1 } } }),
        'pr-merge'
      )
    ).toContain('codeHost metadata is invalid')
  })

  test('non-PR completion modes need no binding self-check', () => {
    expect(deliveryBindingSelfCheck(stream('id-3'), 'deliverable')).toBe('')
    expect(deliveryBindingSelfCheck(stream('id-4'), 'direct-merge')).toBe('')
    expect(flowCompletionInstructions('deliverable')).not.toContain('Delivery binding self-check')
  })
})

describe('delivery instructions composition', () => {
  test('completion-ready PR flows append the self-check; other statuses stay silent', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const instructions = deliveryInstructionsForRun(
      { id, status: 'active', metadata: { codeHost: { integration: 'github', repository: 'owner/repo' } } },
      run('pr-merge'),
      4
    )
    expect(instructions).toContain('Delivery policy: pr-merge')
    expect(instructions).toContain('codeHost.changeRequest is absent')
    expect(instructions).toContain(`When the condition is met: ficus workstream finish ${id} --version 4.`)
    expect(deliveryInstructionsForRun({ id, status: 'active', metadata: {} }, run('deliverable'), 4)).not.toContain(
      'Delivery binding self-check'
    )
    expect(deliveryInstructionsForRun({ id, status: 'done' }, run('pr-merge'), 4)).toBeUndefined()
    expect(
      deliveryInstructionsForRun({ id, status: 'active', pause: { reason: 'hold' } }, run('pr-merge'), 4)
    ).toBeUndefined()
  })
})

describe('auto-merge enabling versus delivery', () => {
  test('generated enabling instructions stay unavailable until all declared internal gates complete', () => {
    const definition = createBlankWorkflow()
    definition.completion.mode = 'pr-auto-merge'
    definition.participants.reviewer = { agentTypeId: 'reviewer', session: 'fresh-per-attempt' }
    definition.steps[0]!.outcomes.completed = { next: 'review' }
    definition.steps.push(
      {
        id: 'review',
        kind: 'agent',
        participant: 'reviewer',
        instructions: 'Independently review the change.',
        output: 'Review evidence.',
        outcomes: { approved: { next: 'human' } },
      },
      {
        id: 'human',
        kind: 'human-approval',
        approver: 'assigned-reviewers',
        instructions: 'Approve the reviewed change.',
        output: 'Human approval.',
        outcomes: { approved: { next: 'finish' } },
      }
    )
    const activeStream = { id: 'internal-gates', status: 'active' }
    let state = createWorkflowRun(definition)
    const complete = (current: WorkflowRun, outcome: string) =>
      advanceWorkflowRun(current, {
        action: 'complete',
        expectedVersion: current.version,
        attemptId: current.activeAttemptId,
        outcome,
        evidence: 'Verified internal step.',
      })
    expect(deliveryInstructionsForRun(activeStream, state, state.version)).toBeUndefined()
    state = complete(state, 'completed')
    expect(state.attempts.at(-1)!.stepId).toBe('review')
    expect(deliveryInstructionsForRun(activeStream, state, state.version)).toBeUndefined()
    state = complete(state, 'approved')
    expect(state.attempts.at(-1)!.stepId).toBe('human')
    expect(deliveryInstructionsForRun(activeStream, state, state.version)).toBeUndefined()
    // The pure runtime routes gates; the server separately authorizes the human actor.
    state = complete(state, 'approved')
    expect(deliveryInstructionsForRun(activeStream, state, state.version)).toContain('enable native auto-merge now')
  })

  test('Solo reaches delivery through its own evidence without inserting an independent review', () => {
    const definition = createBlankWorkflow()
    definition.completion.mode = 'pr-auto-merge'
    const initial = createWorkflowRun(definition)
    const ready = advanceWorkflowRun(initial, {
      action: 'complete',
      expectedVersion: initial.version,
      attemptId: initial.activeAttemptId,
      outcome: 'completed',
      evidence: 'Implementation, validation, and self-review verified.',
    })
    expect(ready.attempts).toHaveLength(1)
    expect(deliveryInstructionsForRun({ id: 'solo', status: 'active' }, ready, ready.version)).toContain(
      'Do not add an independent reviewer to a Solo flow or skip a declared gate'
    )
  })

  test('internal workflow prerequisites precede enabling, not external GitHub gates', () => {
    const instructions = flowCompletionInstructions('pr-auto-merge')
    expect(instructions).toContain(
      'required validation, self-review, and any declared independent review or human-approval gates'
    )
    expect(instructions).toContain('Do not add an independent reviewer to a Solo flow or skip a declared gate')
    expect(instructions).toContain(
      'GitHub required CI and external PR approvals may still be pending when you enable auto-merge'
    )
    expect(instructions).toContain('the provider must enforce them before the actual merge')
    expect(instructions.indexOf('After completing')).toBeLessThan(instructions.indexOf('enable native auto-merge now'))
    expect(instructions.indexOf('enable native auto-merge now')).toBeLessThan(
      instructions.indexOf('Enabling auto-merge is not completion')
    )
  })

  test('explicit current policy and exact reviewed head do not grant human or bypass authority', () => {
    const instructions = flowCompletionInstructions('pr-auto-merge')
    for (const text of [
      'current squad metadata.policies.allowAutoMerge',
      'explicitly true',
      'a missing flag means permission is not granted',
      'Do not enable that policy yourself',
      'live PR base and exact head match the configured base and validated/reviewed deliverable',
      'new commits require authorized rework and affected checks/reviews again',
      'not authority to approve as a human or change branch protections',
      'leave the PR open for a human merge',
      'Never use --admin or bypass required checks and approvals',
      'integration confirms the PR is merged',
      'finish verifies every designated delivery PR is merged',
    ])
      expect(instructions).toContain(text)
  })

  test('provider state, not a historical autoMergeRequest, proves delivery', () => {
    const instructions = flowCompletionInstructions('pr-auto-merge')
    expect(instructions).toContain('autoMergeRequest can be null after an immediate merge')
    expect(instructions).toContain('inspect the live merged state rather than treating null as a failed enable')
  })

  test('explicit other modes retain their distinct authority and delivery conditions', () => {
    expect(flowCompletionInstructions('pr-merge')).toContain('Leave merging to the human; do not merge it yourself')
    expect(flowCompletionInstructions('direct-merge')).toContain('metadata.policies.allowDirectMerge')
    expect(flowCompletionInstructions('direct-merge')).toContain('commit is included in the remote base branch')
    expect(flowCompletionInstructions('review-approval')).toContain('A human must invoke flow finish')
    expect(flowCompletionInstructions('deliverable')).toContain('No PR, repository mutation, or additional reviewer')
    for (const mode of ['pr-merge', 'direct-merge', 'review-approval', 'deliverable'] as const)
      expect(flowCompletionInstructions(mode)).not.toContain('enable native auto-merge now')
  })
})
