import { afterEach, describe, expect, it } from 'bun:test'
import { queryKeys, type ContinueHaltedActionsResult } from '@ficus/client-core'
import type { PendingAction } from '@ficus/shared'
import { agentErrorAction, stream } from './fixtures'
import { ContinueAllButton, HaltedAgentAction } from './HaltedAgentAction'
import { PauseControls } from './PauseControls'
import {
  button,
  byLabel,
  cleanup,
  click,
  fakeApi,
  hasButton,
  hasKey,
  render,
  testQueryClient,
  typeInto,
} from './testing'

afterEach(cleanup)

const continued = (ids: string[], stale: string[] = []): Promise<ContinueHaltedActionsResult> =>
  Promise.resolve({ resumed: ids.length, resumedActionIds: ids, staleActionIds: stale })

describe('HaltedAgentAction', () => {
  it('wakes one halted robot', async () => {
    const api = fakeApi({ continueHaltedActions: (ids) => continued(ids) })
    const halted = agentErrorAction('agent-3')
    const queryClient = testQueryClient()
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), [halted])
    const { container, invalidated } = await render(<HaltedAgentAction action={halted} />, api, queryClient)
    expect(container.textContent).toContain('Rate limited by the provider')
    expect(button(container, 'Wake up').textContent).toContain('Continue the halted agent')
    await click(button(container, 'Wake up'))
    expect(api.continueHaltedActions).toHaveBeenCalledWith(['agent-error:agent-3'])
    expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())).toEqual([])
    for (const key of [
      queryKeys.actions.pending(),
      queryKeys.agents.detail('agent-3'),
      queryKeys.agents.activeExecution('agent-3'),
      queryKeys.agents.listPrefix(),
      queryKeys.squads.agents('squad-1'),
    ]) {
      expect(hasKey(invalidated(), key)).toBe(true)
    }
    expect(hasKey(invalidated(), queryKeys.agentQuestions.all)).toBe(false)
  })

  it('announces a failed wake-up', async () => {
    const api = fakeApi({ continueHaltedActions: () => Promise.reject(new Error('Provider still down')) })
    const { container } = await render(<HaltedAgentAction action={agentErrorAction()} />, api)
    await click(button(container, 'Wake up'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Provider still down')
  })
})

describe('ContinueAllButton', () => {
  it('continues exactly the respondable halted robots', async () => {
    const a = agentErrorAction('a')
    const b = agentErrorAction('b')
    const readOnly = agentErrorAction('c', { canRespond: false })
    const api = fakeApi({ continueHaltedActions: (ids) => continued(ids.slice(0, 1), ids.slice(1)) })
    const queryClient = testQueryClient()
    queryClient.setQueryData<PendingAction[]>(queryKeys.actions.pending(), [a, b, readOnly])
    const { container, invalidated } = await render(<ContinueAllButton actions={[a, b, readOnly]} />, api, queryClient)
    await click(button(container, 'Wake them all (2)'))
    expect(api.continueHaltedActions).toHaveBeenCalledWith(['agent-error:a', 'agent-error:b'])
    // Resumed and stale ids both leave the list.
    expect(queryClient.getQueryData<PendingAction[]>(queryKeys.actions.pending())?.map((x) => x.id)).toEqual([
      'agent-error:c',
    ])
    expect(hasKey(invalidated(), queryKeys.actions.pending())).toBe(true)
    expect(hasKey(invalidated(), queryKeys.agents.listPrefix())).toBe(true)
  })

  it('stays hidden with fewer than two respondable robots', async () => {
    const api = fakeApi()
    const { container } = await render(
      <ContinueAllButton actions={[agentErrorAction('a'), agentErrorAction('b', { canRespond: false })]} />,
      api
    )
    expect(container.querySelector('button')).toBeNull()
  })
})

describe('PauseControls', () => {
  it('pauses with a reason and an auto-park delay', async () => {
    const api = fakeApi({ pauseWorkStream: () => Promise.resolve(stream()) })
    const { container, invalidated } = await render(<PauseControls stream={stream()} />, api)
    await click(button(container, 'Pause'))
    await typeInto(byLabel(container, 'Reason (optional)'), 'Frost tonight')
    await typeInto(byLabel(container, 'Park after minutes (optional)'), '30')
    await click(button(container, 'Pause now'))
    expect(api.pauseWorkStream).toHaveBeenCalledWith('ws-1', { reason: 'Frost tonight', parkAfterMinutes: 30 })
    for (const key of [queryKeys.squads.all, queryKeys.workflows.all, queryKeys.agents.all]) {
      expect(hasKey(invalidated(), key)).toBe(true)
    }
  })

  it('pauses without a park delay when none is given', async () => {
    const api = fakeApi({ pauseWorkStream: () => Promise.resolve(stream()) })
    const { container } = await render(<PauseControls stream={stream()} />, api)
    await click(button(container, 'Pause'))
    await click(button(container, 'Pause now'))
    expect(api.pauseWorkStream).toHaveBeenCalledWith('ws-1', { reason: '' })
  })

  const paused = { id: 'p', pausedAt: '2026-09-27T10:00:00.000Z', reason: 'Frost', parkAt: null, agentIds: [] }

  it('resumes and parks a paused stream', async () => {
    const api = fakeApi({
      resumeWorkStream: () => Promise.resolve(stream()),
      parkWorkStream: () => Promise.resolve(stream()),
    })
    const { container } = await render(<PauseControls stream={stream({ pause: paused })} />, api)
    expect(container.textContent).toContain('Paused · Holding its slot · Frost')
    await click(button(container, 'Park'))
    expect(api.parkWorkStream).toHaveBeenCalledWith('ws-1')
    await click(button(container, 'Resume'))
    expect(api.resumeWorkStream).toHaveBeenCalledWith('ws-1')
  })

  it('offers no park once the stream is already parked (queued)', async () => {
    const api = fakeApi()
    const { container } = await render(<PauseControls stream={stream({ pause: paused, status: 'queued' })} />, api)
    expect(hasButton(container, 'Resume')).toBe(true)
    expect(hasButton(container, 'Park')).toBe(false)
  })

  it('needs workstreams:update', async () => {
    const api = fakeApi({
      getMyPermissions: () =>
        Promise.resolve({ permissions: ['workstreams:respond'], identity: { type: 'user', userId: 'u' } }),
    })
    const { container } = await render(<PauseControls stream={stream({ pause: paused })} />, api)
    expect(api.getMyPermissions).toHaveBeenCalledWith('squad-1')
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('Paused')
  })

  it('renders nothing for finished streams', async () => {
    const api = fakeApi()
    const { container } = await render(<PauseControls stream={stream({ status: 'done' })} />, api)
    expect(container.textContent).toBe('')
  })
})
