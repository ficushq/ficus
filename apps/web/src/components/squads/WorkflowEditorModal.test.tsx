import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByText } from '@testing-library/dom'
import { createBlankWorkflow, type WorkflowDefinition } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { WorkflowEditorModal } from './WorkflowEditorModal'

describe('WorkflowEditorModal', () => {
  let cleanup: (() => Promise<void>) | undefined
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  const realFetch = globalThis.fetch

  afterEach(async () => {
    globalThis.fetch = realFetch
    await cleanup?.()
    cleanup = undefined
  })

  async function render(props: {
    initialDefinition?: WorkflowDefinition
    onSave: (definition: WorkflowDefinition) => void
    onClose: () => void
    onOuterKeyDown?: () => void
  }) {
    dom = await acquireDomHarness({ url: 'http://localhost/schedules' })
    globalThis.fetch = (async () => Response.json([])) as typeof fetch
    const rendered = dom.createRoot()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.workflows.list(), [])
    queryClient.setQueryData(queryKeys.agentTypes.list(), [
      { id: 'general', name: 'General', model: '', systemPrompt: '', includes: [], disabled: false },
      { id: 'sysops', name: 'SysOps', model: '', systemPrompt: '', includes: [], disabled: false },
    ])
    cleanup = async () => {
      await dom.cleanup()
      queryClient.clear()
    }
    await dom.act(async () => {
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <div onKeyDown={props.onOuterKeyDown}>
            <WorkflowEditorModal
              isOpen
              squadId="squad-1"
              initialDefinition={props.initialDefinition}
              onSave={props.onSave}
              onClose={props.onClose}
            />
          </div>
        </QueryClientProvider>
      )
    })
    return dom.window.document.body
  }

  test('starts from a blank flow and hands back a valid inline definition on "Use this flow"', async () => {
    const saved: WorkflowDefinition[] = []
    let closed = 0
    const body = await render({ onSave: (d) => saved.push(d), onClose: () => closed++ })
    expect(body.textContent).toContain('Custom workflow')
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Use this flow'))
    })
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe(createBlankWorkflow().name)
    expect(saved[0].steps.map((s) => s.id)).toEqual(['execute'])
    expect(closed).toBe(0)
  })

  test('seeds the editor from an initial definition (a detached copy of a preset)', async () => {
    const initial = { ...createBlankWorkflow(), name: 'Solo (copy)' }
    const saved: WorkflowDefinition[] = []
    const body = await render({ initialDefinition: initial, onSave: (d) => saved.push(d), onClose: () => {} })
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Use this flow'))
    })
    expect(saved[0].name).toBe('Solo (copy)')
    expect(saved[0]).not.toBe(initial)
  })

  test('Cancel closes without saving, and Escape closes without reaching the enclosing modal', async () => {
    const saved: WorkflowDefinition[] = []
    let closed = 0
    let outer = 0
    const body = await render({
      onSave: (d) => saved.push(d),
      onClose: () => closed++,
      onOuterKeyDown: () => outer++,
    })
    await dom.act(async () => {
      fireEvent.click(getByText(body, 'Cancel'))
    })
    expect(closed).toBe(1)
    await dom.act(async () => {
      fireEvent.keyDown(getByText(body, 'Use this flow'), { key: 'Escape' })
    })
    expect(closed).toBe(2)
    expect(outer).toBe(0)
    expect(saved).toHaveLength(0)
  })
})
