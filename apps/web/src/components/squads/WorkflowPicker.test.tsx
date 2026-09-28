import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByLabelText, getByText, queryByText } from '@testing-library/dom'
import { createBlankWorkflow, type WorkflowDefinition, type WorkflowSource } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { WorkflowPicker } from './WorkflowPicker'

describe('WorkflowPicker custom flows', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>

  afterEach(async () => {
    await cleanup?.()
    cleanup = undefined
  })

  async function render(props: {
    value?: WorkflowSource
    onChange?: (source: WorkflowSource) => void
    onCustomize?: (definition: WorkflowDefinition | undefined) => void
  }) {
    dom = await acquireDomHarness({ url: 'http://localhost/schedules' })
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.workflows.list(), [
      { id: 'solo', revision: 'r1', definition: { ...createBlankWorkflow(), name: 'Solo' } },
    ])
    cleanup = async () => {
      await dom.cleanup()
      queryClient.clear()
    }
    await dom.act(async () => {
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <WorkflowPicker
            squadId="squad-1"
            value={props.value}
            onChange={props.onChange ?? (() => {})}
            onUseSquadDefault={() => {}}
            onCustomize={props.onCustomize}
            preview={false}
          />
        </QueryClientProvider>
      )
    })
    return dom.window.document.body
  }

  test('offers "Custom workflow…" and opens a blank editor when chosen', async () => {
    const calls: Array<WorkflowDefinition | undefined> = []
    const body = await render({ onCustomize: (d) => calls.push(d) })
    const select = getByLabelText(body, 'Workflow') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toContain('Custom workflow…')
    await dom.act(async () => {
      fireEvent.change(select, { target: { value: '__custom' } })
    })
    expect(calls).toEqual([undefined])
  })

  test('a selected preset gets a "Customize" button that hands over a detached copy of its definition', async () => {
    const calls: Array<WorkflowDefinition | undefined> = []
    const body = await render({
      value: { kind: 'preset', id: 'solo', customizations: [] },
      onCustomize: (d) => calls.push(d),
    })
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Customize'))
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe('Solo')
  })

  test('an inline flow is a selectable option with an "Edit custom flow" button', async () => {
    const definition = { ...createBlankWorkflow(), name: 'Nightly disk check' }
    const calls: Array<WorkflowDefinition | undefined> = []
    const body = await render({ value: { kind: 'inline', definition }, onCustomize: (d) => calls.push(d) })
    const select = getByLabelText(body, 'Workflow') as HTMLSelectElement
    const option = [...select.options].find((o) => o.value === '__inline')!
    expect(option.textContent).toBe('Nightly disk check (custom flow)')
    expect(option.disabled).toBe(false)
    expect(select.value).toBe('__inline')
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Edit custom flow'))
    })
    expect(calls[0]?.name).toBe('Nightly disk check')
  })

  test('without onCustomize the picker keeps its read-only behaviour', async () => {
    const definition = { ...createBlankWorkflow(), name: 'Saved flow' }
    const body = await render({ value: { kind: 'inline', definition } })
    const select = getByLabelText(body, 'Workflow') as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).not.toContain('Custom workflow…')
    expect([...select.options].find((o) => o.value === '__inline')!.disabled).toBe(true)
    expect(queryByText(body, 'Edit custom flow')).toBeNull()
    expect(queryByText(body, 'Customize')).toBeNull()
  })
})
