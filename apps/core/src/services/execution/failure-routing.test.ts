import { describe, expect, it } from 'bun:test'
import { routeFailure } from './failure-routing'

describe('routeFailure', () => {
  it('routes rate-limit errors to a waiting-input rate_limit question', () => {
    const route = routeFailure('429 rate limit exceeded')

    expect(route.systemMessage).toBe('[System] Rate limit or plan credit exhaustion. Execution stopped.')
    expect(route.disposition).toEqual({
      status: 'waiting-input',
      questionData: {
        questions: [
          {
            id: 'rate_limit',
            type: 'select',
            question: 'Rate limit or plan credit exhaustion. Execution stopped.',
            optional: false,
            options: [{ value: 'Continue', label: 'Continue' }],
          },
        ],
      },
    })
  })

  it('routes provider-exhausted errors to a waiting-input all_providers_exhausted question', () => {
    const route = routeFailure('ModelSelectionError: all provider exhausted')

    expect(route.systemMessage).toBe('[System] All configured providers are currently exhausted. Try again later.')
    expect(route.disposition).toEqual({
      status: 'waiting-input',
      questionData: {
        questions: [
          {
            id: 'all_providers_exhausted',
            type: 'select',
            question: 'All configured providers are currently exhausted. Try again later.',
            optional: false,
            options: [{ value: 'Continue', label: 'Continue' }],
          },
        ],
      },
    })
  })

  it('keeps canonical provider transport failures idle and actionable', () => {
    expect(routeFailure('Provider transport failure: The socket connection was closed unexpectedly')).toEqual({
      systemMessage:
        '[System] Execution failed: Provider transport failure: The socket connection was closed unexpectedly',
      disposition: { status: 'idle' },
    })
  })

  it('never halts a sandbox provisioning failure as a rate limit, even when its id contains 429', () => {
    const error =
      'Sandbox squad_0b1e2c3d-4f5a-4b6c-8d7e-0a1bc24297ef provision attempt 20535 failed; retry after 2026-11-16T20:01:00.000Z'
    expect(routeFailure(error)).toEqual({
      systemMessage: `[System] Execution failed: ${error}`,
      disposition: { status: 'idle' },
    })
  })

  it('routes by the typed sandbox cause before reading the message', () => {
    const cause = new Error('Failed to prepare sandbox', {
      cause: Object.assign(new Error('429 Too Many Requests'), { name: 'VmPostProvisionSetupError' }),
    })
    expect(routeFailure('429 Too Many Requests', undefined, cause).disposition).toEqual({ status: 'idle' })
    // Without the typed cause the same text is still a provider rate limit.
    expect(routeFailure('429 Too Many Requests').disposition.status).toBe('waiting-input')
  })

  it('routes generic errors to an idle disposition with a generic system message', () => {
    const route = routeFailure('boom: something unexpected broke')

    expect(route.systemMessage).toBe('[System] Execution failed: boom: something unexpected broke')
    expect(route.disposition).toEqual({ status: 'idle' })
  })
})

it('an exactly correlated restart-era failure is explained, not a separate Execution failed event', () => {
  const restart = { restartId: 'restart-1', restartedAt: '2026-10-28T21:32:00.000Z' }
  const route = routeFailure('startup transport unavailable', restart)
  // A chat notice for people: the agent's copy (with the id) is in its prompt.
  expect(route.systemMessage).toBe(
    '[System] Resumed after a restart, but the run could not finish: startup transport unavailable'
  )
  expect(route.systemMessage).not.toContain('restart-1')
  expect(route.systemMessage).not.toContain('Execution failed:')
})
