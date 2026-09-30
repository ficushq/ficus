import { describe, expect, test } from 'bun:test'
import { deliveryBindingSelfCheck, deliveryInstructionsForRun, flowCompletionInstructions } from './completion-prompt'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'

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
