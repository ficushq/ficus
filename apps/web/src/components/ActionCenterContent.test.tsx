import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { PendingAction } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ActionCenterContent } from './ActionCenterContent'
import { queryKeys } from '../queryKeys'

const continueHaltedAgents = mock(async (_actionIds: string[]) => ({
  resumed: 0,
  resumedActionIds: [],
  staleActionIds: [],
}))

function haltedAction(id: string, canRespond: boolean): PendingAction {
  return {
    id,
    type: 'agent-error',
    priority: 0,
    createdAt: new Date().toISOString(),
    canRespond,
    data: {
      agentId: id.replace('agent-error:', ''),
      agentName: null,
      agentTypeId: 'worker',
      squadId: 'squad-1',
      squadName: 'Squad',
      ownerUserId: null,
      reason: 'Provider unavailable',
    },
  }
}

describe('ActionCenterContent bulk continuation', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: ReturnType<typeof dom.createRoot>['root']

  beforeEach(async () => {
    continueHaltedAgents.mockClear()
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    ;({ root } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  test('submits exactly the respondable rendered action IDs', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const actions = [
      haltedAction('agent-error:one', true),
      haltedAction('agent-error:two', false),
      haltedAction('agent-error:three', true),
    ]

    await dom.act(async () => {
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionCenterContent actions={actions} isLoading={false} continueHaltedActions={continueHaltedAgents} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    const button = document.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toContain('Continue all (2)')

    await dom.act(async () => button.click())

    expect(continueHaltedAgents).toHaveBeenCalledWith(['agent-error:one', 'agent-error:three'])
  })

  test('removes only returned resumed and stale bulk action IDs', async () => {
    const actions = [
      haltedAction('agent-error:one', true),
      haltedAction('agent-error:two', true),
      haltedAction('agent-error:three', true),
    ]
    const continueSome = mock(async () => ({
      resumed: 1,
      resumedActionIds: ['agent-error:one'],
      staleActionIds: ['agent-error:three'],
    }))
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.actions.pending(), actions)
    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionCenterContent actions={actions} isLoading={false} continueHaltedActions={continueSome} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Continue all')
    )
    await dom.act(async () => button?.click())
    expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual([actions[1]])
  })

  test('retains every bulk card and sanitizes a rejected request', async () => {
    const actions = [haltedAction('agent-error:one', true), haltedAction('agent-error:two', true)]
    const rejectBulk = mock(async () => Promise.reject({ secret: 'unsafe' }))
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.actions.pending(), actions)
    await dom.act(async () =>
      root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ActionCenterContent actions={actions} isLoading={false} continueHaltedActions={rejectBulk} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Continue all')
    )
    await dom.act(async () => {
      button?.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(queryClient.getQueryData(queryKeys.actions.pending())).toEqual(actions)
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Action failed. Try again.')
    expect(document.body.textContent).not.toContain('unsafe')
  })

  describe('ActionCenterContent exact action focus', () => {
    test('keeps concurrent waits distinct and focuses only the full action ID', async () => {
      const manualAction = (waitId: string, message: string): PendingAction => ({
        id: `workstream-blocked:ws-1:${waitId}`,
        type: 'workstream-blocked',
        priority: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
        canRespond: true,
        squadId: 'squad-1',
        squadName: 'Ficus',
        data: {
          workStreamId: 'ws-1',
          workStreamTitle: 'Choose an option',
          squadId: 'squad-1',
          squadName: 'Ficus',
          waitId: `legacy-${waitId}`,
          wait: {
            id: waitId,
            workStreamId: 'ws-1',
            type: 'manual',
            referenceId: null,
            message,
            createdBy: 'agent',
            createdByAgentId: null,
            createdByUserId: null,
            completesOnApproval: false,
            openedAt: '2026-01-01T00:00:00.000Z',
            closedAt: null,
            resolution: null,
            resolutionNote: null,
          },
          focus: { kind: 'workstream-wait', workStreamId: 'ws-1', waitId },
          assigneeAgentId: null,
          assigneeName: null,
          completionMode: 'review-approval',
          prompt: { type: 'text', message },
        },
      })
      const actions = [manualAction('manual-full-1', 'Use option A'), manualAction('manual-full-2', 'Use option B')]
      const queryClient = new QueryClient()
      await dom.act(async () => {
        root.render(
          <MemoryRouter>
            <QueryClientProvider client={queryClient}>
              <ActionCenterContent
                actions={actions}
                isLoading={false}
                focusActionId="workstream-blocked:ws-1:manual-full-2"
              />
            </QueryClientProvider>
          </MemoryRouter>
        )
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      expect(document.body.textContent).toContain('Use option B')
      const expandButtons = [...document.querySelectorAll('button[aria-label="Expand"]')]
      expect(expandButtons).toHaveLength(1)
      await dom.act(async () => (expandButtons[0] as HTMLButtonElement).click())
      expect(document.body.textContent).toContain('Use option A')
      const focused = document.querySelectorAll('[aria-current="true"]')
      expect(focused).toHaveLength(1)
      expect(focused[0]?.textContent).toContain('Use option B')
    })
  })
})
