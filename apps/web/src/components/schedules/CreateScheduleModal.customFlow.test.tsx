import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { fireEvent, getByLabelText, getByText, queryByText } from '@testing-library/dom'
import { createBlankWorkflow } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { CreateScheduleModal } from './CreateScheduleModal'

describe('CreateScheduleModal custom workflow', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  const realFetch = globalThis.fetch

  afterEach(async () => {
    globalThis.fetch = realFetch
    await cleanup?.()
    cleanup = undefined
  })

  async function render() {
    dom = await acquireDomHarness({ url: 'http://localhost/schedules' })
    globalThis.fetch = (async () => Response.json([])) as typeof fetch
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.workflows.list(), [
      { id: 'solo', revision: 'r1', definition: { ...createBlankWorkflow(), name: 'Solo' } },
    ])
    queryClient.setQueryData(queryKeys.agentTypes.list(), [
      { id: 'general', name: 'General', model: '', systemPrompt: '', includes: [], disabled: false },
    ])
    queryClient.setQueryData(queryKeys.squads.list(), [{ id: 'squad-1', name: 'Ops', managerAgentId: 'm1' }])
    queryClient.setQueryData(queryKeys.agents.list(), [])
    cleanup = async () => {
      await dom.cleanup()
      queryClient.clear()
    }
    await dom.act(async () => {
      rendered.root.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <CreateScheduleModal isOpen onClose={() => {}} defaultScope={{ type: 'squad', id: 'squad-1' }} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    return dom.window.document.body
  }

  test('"Custom workflow…" opens the editor over the form and the saved flow becomes the selected workflow', async () => {
    const body = await render()
    const actionType = [...body.querySelectorAll('select')].find((select) =>
      [...select.options].some((option) => option.value === 'create_work_stream')
    ) as HTMLSelectElement
    await dom.act(async () => {
      fireEvent.change(actionType, { target: { value: 'create_work_stream' } })
    })
    const workflowSelect = getByLabelText(body, 'Workflow') as HTMLSelectElement
    expect(queryByText(body, 'Use this flow')).toBeNull()
    await dom.act(async () => {
      fireEvent.change(workflowSelect, { target: { value: '__custom' } })
    })
    // Both dialogs are on screen: the schedule form underneath, the editor on top.
    expect(body.querySelector('[role="dialog"][aria-label="Create Schedule"]')).toBeTruthy()
    expect(getByText(body, 'Use this flow')).toBeTruthy()
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Use this flow'))
    })
    expect(queryByText(body, 'Use this flow')).toBeNull()
    const reselected = getByLabelText(body, 'Workflow') as HTMLSelectElement
    expect(reselected.value).toBe('__inline')
    const option = [...reselected.options].find((o) => o.value === '__inline')!
    expect(option.textContent).toBe(`${createBlankWorkflow().name} (custom flow)`)
    expect(getByText(body, 'Edit custom flow')).toBeTruthy()
  })
})
