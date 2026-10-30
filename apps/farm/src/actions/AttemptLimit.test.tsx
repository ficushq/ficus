import { afterEach, describe, expect, it } from 'bun:test'
import type { WorkflowRunDetail } from '@ficus/client-core'
import { stream, wait, workflowRun } from './fixtures'
import { UnblockForm } from './UnblockForm'
import { button, byLabel, cleanup, click, fakeApi, hasButton, render, typeInto } from './testing'

afterEach(cleanup)

/** The gate fixture, paused because step build used its one allowed attempt. */
function pausedRun(): WorkflowRunDetail {
  const run = workflowRun('gate', { version: 9 })
  const state = run.state as unknown as Record<string, unknown>
  state.status = 'paused'
  state.activeAttemptId = null
  state.pauseReason = { type: 'attempt-limit', stepId: 'build' }
  state.attempts = [{ id: 1, stepId: 'build', status: 'completed', outcome: 'done', evidence: 'Planted' }]
  ;(state.definition as Record<string, unknown>).limits = { maxStepAttempts: 1 }
  return run
}

describe('Farm attempt-limit pause', () => {
  const limitWait = () =>
    wait({ type: 'manual', resolutionHandler: 'workflow', flowAttemptId: null, workflowAttemptLimit: true })
  const setup = (extra: Parameters<typeof fakeApi>[0] = {}) =>
    fakeApi({
      workflowRun: () => Promise.resolve(pausedRun()),
      getWorkStream: () => Promise.resolve(stream()),
      advanceWorkflow: () => Promise.resolve({ version: 10, stateStatus: 'running' as const, activeAttemptId: 2 }),
      ...extra,
    })

  it('explains the pause and raises the limit with the run version', async () => {
    const api = setup()
    const { container } = await render(
      <UnblockForm workStreamId="ws-1" squadId="squad-1" wait={limitWait()} message="Old raw message" />,
      api
    )
    expect(container.textContent).toContain('The step "Build" has used all 1 of its allowed attempts')
    expect(container.textContent).not.toContain('Old raw message')
    await typeInto(byLabel(container, 'New attempt limit'), '4')
    await click(button(container, 'Raise limit'))
    expect(api.advanceWorkflow).toHaveBeenCalledWith(
      'ws-1',
      { action: 'raise-limit', expectedVersion: 9, maxStepAttempts: 4 },
      'request-1'
    )
    expect(api.resolveWorkStreamWait).not.toHaveBeenCalled()
  })

  it('removes the limit with null', async () => {
    const api = setup()
    const { container } = await render(<UnblockForm workStreamId="ws-1" squadId="squad-1" wait={limitWait()} />, api)
    await click(button(container, 'Remove limit'))
    expect(api.advanceWorkflow).toHaveBeenCalledWith(
      'ws-1',
      { action: 'raise-limit', expectedVersion: 9, maxStepAttempts: null },
      'request-1'
    )
  })

  it('shows who can act instead of controls without review or flow permission', async () => {
    const api = setup({
      getMyPermissions: () =>
        Promise.resolve({ permissions: ['workstreams:respond'], identity: { type: 'user', userId: 'u' } }),
    })
    const { container } = await render(<UnblockForm workStreamId="ws-1" squadId="squad-1" wait={limitWait()} />, api)
    expect(hasButton(container, 'Raise limit')).toBe(false)
    expect(container.textContent).toContain('the squad manager can raise the limit')
  })
})
