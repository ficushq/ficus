import { expect, test } from 'bun:test'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  applyWorkflowCustomizations,
  createBlankWorkflow,
  workflowPresetSchema,
  type WorkflowSource,
} from '@ficus/shared'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { integrationQueries, queries } from '../../queryOptions'
import { acquireDomHarness } from '../../test/domHarness'
import { WorkflowEditor } from './WorkflowEditor'

test('graph edits share undo/redo and selecting a node opens only its inspector', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.agentTypes.list().queryKey, [
    { id: 'general', name: 'General' },
    { id: 'researcher', name: 'Researcher' },
    { id: 'manager', name: 'Manager', systemOnly: true },
  ])
  queryClient.setQueryData(integrationQueries.outputs().queryKey, [])
  queryClient.setQueryData(queries.workflows.list().queryKey, [])
  let value: WorkflowSource | undefined
  function Editor() {
    const [source, setSource] = useState<WorkflowSource | undefined>({
      kind: 'inline',
      definition: createBlankWorkflow(),
    })
    value = source
    return <WorkflowEditor definitionOnly value={source} onChange={setSource} />
  }
  const click = async (text: string) => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent === text)!
    expect(button).toBeDefined()
    await dom.act(async () => button.click())
  }
  const root = dom.createRoot()
  try {
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={queryClient}>
          <PermissionsProvider
            usePermissions={() => ({ can: () => false, permissions: [], isLoading: false, isError: false })}
          >
            <Editor />
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    const panel = (label: string) =>
      document.querySelector<HTMLButtonElement>(`[aria-label="Workflow panels"] [aria-label="${label}"]`)!
    expect(document.querySelector('[aria-label="Flow controls"]')?.textContent).not.toContain('Participants')
    await dom.act(async () => panel('Participants').click())
    expect(panel('Participants').getAttribute('aria-pressed')).toBe('true')
    await dom.act(async () => panel('Participants').click())
    expect(document.querySelector('[aria-label="Flow inspector"]')).toBeNull()
    await dom.act(async () => panel('Flow settings').click())
    expect(panel('Flow settings').getAttribute('aria-pressed')).toBe('true')
    await click('completed')
    expect(document.querySelector('[role=tablist]')).toBeNull()
    expect(document.body.textContent).toContain('Handoff details')
    expect(panel('Flow settings').getAttribute('aria-pressed')).toBe('false')
    expect(panel('Inspector').getAttribute('aria-pressed')).toBe('true')
    await dom.act(async () => panel('Participants').click())
    await dom.act(async () => panel('Inspector').click())
    expect(document.body.textContent).toContain('Handoff details')

    expect(document.querySelector('[aria-label="Step instructions"]')).toBeNull()
    const outcomeName = document.querySelector<HTMLInputElement>('[aria-label="Rename execute outcome completed"]')!
    await dom.act(async () => {
      outcomeName.value = 'approved'
      outcomeName.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
    })
    expect(document.querySelector('[aria-label="Rename execute outcome approved"]')).not.toBeNull()
    await click('Remove connection')
    expect(value?.kind === 'inline' && value.definition.steps[0]!.outcomes).toEqual({})
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    await click('Undo')
    expect(value?.kind === 'inline' && value.definition.steps[0]!.outcomes).toEqual({ approved: { next: 'finish' } })
    await click('Undo')
    expect(value?.kind === 'inline' && value.definition.steps[0]!.outcomes).toEqual({ completed: { next: 'finish' } })
    await click('Add agent step')
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(2)
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Step instructions"]')?.value).toContain(
      'Complete this step'
    )
    expect(
      [...document.querySelectorAll('select option')].some((option) => option.textContent === 'Human approval')
    ).toBe(false)
    await click('Human approval')
    expect(value?.kind === 'inline' && value.definition.steps[1]!.kind).toBe('human-approval')
    await click('Agent work')
    expect(value?.kind === 'inline' && value.definition.steps[1]!.kind).toBe('agent')
    await click('Edit shared settings')
    expect(document.body.textContent).toContain('Shared by Step 1')
    const typeField = Array.from(document.querySelectorAll('label'))
      .find((label) => label.textContent?.trim().startsWith('Agent type'))!
      .querySelector('select')!
    expect(Array.from(typeField.options).map((option) => option.textContent)).toEqual(['General', 'Researcher'])
    expect(document.body.textContent).not.toContain('Profile')
    expect(document.body.textContent).not.toContain('Earlier')
    expect(document.body.textContent).not.toContain('Later')
    expect(document.body.textContent).not.toContain('Required before delivery')
    expect(document.body.textContent).not.toContain('Independent from participants')
    await dom.act(async () => {
      typeField.value = 'researcher'
      typeField.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    if (value?.kind === 'inline') {
      const step = value.definition.steps[1]!
      expect(step.kind).toBe('agent')
      if (step.kind === 'agent') expect(value.definition.participants[step.participant]!.agentTypeId).toBe('researcher')
      expect(value.definition.participants.worker!.agentTypeId).toBe('general')
      expect(JSON.stringify(value)).not.toContain('"profile"')
    }
    await click('Undo') // Participant settings, kind changes, then the added step.
    await click('Undo')
    await click('Undo')
    await click('Undo')
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    await click('Redo')
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(2)
    await dom.act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Connect step-1 completed"]')!.click()
    )
    await dom.act(async () =>
      (document.querySelector('button[aria-label="Connect to execute"]') as HTMLButtonElement).click()
    )
    if (value?.kind === 'inline')
      expect(value.definition.steps[1]!.outcomes.completed).toEqual({
        returnTo: 'execute',
        afterRework: 'follow-graph',
      })
    expect(document.querySelector('[role="alert"]') !== null).toBe(true) // The only completion path was replaced by a loop.
    await click('Undo')
    if (value?.kind === 'inline') expect(value.definition.steps[1]!.outcomes.completed).toEqual({ next: 'finish' })
    const graph = document.querySelector<HTMLElement>('[aria-label="Edit flow graph"]')!
    const key = async (target: HTMLElement, key: string, modifiers: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
      await dom.act(async () => {
        target.dispatchEvent(event)
      })
      return event.defaultPrevented
    }
    await dom.act(async () => document.querySelector<HTMLButtonElement>('button[aria-label^="Step 1:"]')!.click())
    // Typing, including native undo, must never mutate graph history.
    const instructions = document.querySelector<HTMLTextAreaElement>('[aria-label="Step instructions"]')!
    expect(await key(instructions, 'Delete')).toBe(false)
    expect(await key(instructions, 'z', { ctrlKey: true })).toBe(false)
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(2)
    const trash = [...document.querySelectorAll('button')].find((el) => el.textContent === 'Delete step')!
    expect(trash.closest('[role="toolbar"]')).toBeNull()
    expect(trash.classList.contains('absolute')).toBe(true)
    await click('Delete step')
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    expect(await key(graph, 'z', { metaKey: true })).toBe(true)
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(2)
    expect(await key(graph, 'z', { metaKey: true, shiftKey: true })).toBe(true)
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    await key(graph, 'z', { ctrlKey: true })
    await key(graph, 'y', { ctrlKey: true })
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    // Deleting the final step is allowed in a draft; adding a replacement repairs its entry.
    expect(await key(graph, 'Backspace')).toBe(true)
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(0)
    expect(document.body.textContent).toContain('Add an agent step or approval to start this workflow.')
    await click('Add agent step')
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(1)
    expect(value?.kind === 'inline' && value.definition.entry).toBe('step-2')
    // A new edit after undo discards the abandoned redo branch.
    await key(graph, 'z', { ctrlKey: true })
    await click('Add approval')
    expect(Array.from(document.querySelectorAll('button')).find((el) => el.textContent === 'Redo')!.disabled).toBe(true)
    expect(await key(document.body, 'Delete')).toBe(false)
    expect(await key(graph, 'Delete')).toBe(true)
    expect(value?.kind === 'inline' && value.definition.steps.length).toBe(0)
    await click('Undo')
    await click('Settings')
    expect(document.body.textContent).toContain('Leave blank for unlimited attempts')
    expect(document.body.textContent).toContain('Code hosting')
    const hosting = Array.from(document.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('Code hosting'))!
      .querySelector<HTMLInputElement>('input')!
    await dom.act(async () => hosting.click())
    if (value?.kind === 'inline') expect(value.definition.completion.followChanges).toBe(true)
    expect(document.querySelector('[aria-label="Code hosting: From work stream metadata"]')).not.toBeNull()
    await click('Add agent step')
    if (value?.kind === 'inline') {
      const targetStep = value.definition.steps.find((step) => step.kind === 'agent')!
      const target = targetStep.id
      await dom.act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label="Connect Code hosting"]')!.click()
      )
      await dom.act(async () =>
        document.querySelector<HTMLButtonElement>(`[aria-label="Connect to ${targetStep.name ?? target}"]`)!.click()
      )
      expect(value.definition.completion.changeEventsTo).toEqual({ step: target })
      await click('Settings')
      expect(document.querySelector<HTMLSelectElement>('[aria-label="Code hosting recipient"]')!.value).toBe(
        `step:${target}`
      )
      expect(document.querySelector('[data-flow-edge="code-host:delivery:code hosting events"]')).not.toBeNull()
      await click('Undo')
      expect(value.definition.completion.changeEventsTo).toBeUndefined()
    }
  } finally {
    await dom.cleanup()
    queryClient.clear()
  }
})

test('assistant edits apply directly, share undo history, and cannot overwrite newer manual edits', async () => {
  const { spyOn } = await import('bun:test')
  const { MemoryRouter } = await import('react-router-dom')
  const { fireEvent, waitFor } = await import('@testing-library/dom')
  const { assistantApi } = await import('../../api/assistant')
  const { assistantQueries } = await import('../../queryOptions')
  const { useAssistantConversationBridge } = await import('../../voice/AssistantConversationContext')
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(element: HTMLElement) {
      Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 600 },
      })
      this.callback()
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.workflows.list().queryKey, [])
  cache.setQueryData(queries.agentTypes.list().queryKey, [{ id: 'general', name: 'General' }])
  cache.setQueryData(integrationQueries.outputs().queryKey, [])
  cache.setQueryData(queries.voice.status().queryKey, { enabled: false })
  let id = ''
  let stored: import('@ficus/shared').AssistantEditorState
  let bridge: ReturnType<typeof useAssistantConversationBridge>
  let value: WorkflowSource | undefined
  let graphPositions: Record<string, { x: number; y: number }> = {}
  let moveGraph!: (positions: typeof graphPositions) => void
  const create = spyOn(assistantApi, 'create').mockImplementation(async (next) => {
    id = next
    return { id } as any
  })
  const sync = spyOn(assistantApi, 'syncEditor').mockImplementation(async (_id, draft) => {
    stored = structuredClone(draft)
    return stored
  })
  const read = spyOn(assistantApi, 'editor').mockImplementation(async () => ({ ...stored!, contract: '' }))
  const close = spyOn(assistantApi, 'closeEditor').mockResolvedValue({})
  const propose = spyOn(assistantApi, 'proposeEditor').mockImplementation(async (_id, args: any) => ({
    ...stored!,
    proposal: {
      id: crypto.randomUUID(),
      baseRevision: args.baseRevision,
      summary: args.summary,
      document: args.historyAction
        ? stored!.document
        : args.operations
          ? applyWorkflowCustomizations(stored!.document as any, args.operations)
          : args.documentJson
            ? JSON.parse(args.documentJson)
            : stored!.document,
      preset: args.preset ? { ...stored!.preset!, ...args.preset } : stored!.preset,
      historyAction: args.historyAction,
    },
  }))
  const dependencies = {
    api: {
      ...assistantApi,
      history: async () => ({ entries: [], hasMore: false }),
      inbox: async () => ({ acquired: true, messages: [], pending: 0 }),
      release: async () => ({}),
    } as any,
    useAssistant: (() => {
      bridge = useAssistantConversationBridge()
      return {
        history: [],
        status: 'idle',
        error: null,
        isLiveAudio: false,
        isConnected: false,
        disconnect() {},
        setLiveAudio: async () => {},
      }
    }) as any,
  }
  function Editor() {
    const [source, setSource] = useState<WorkflowSource | undefined>({
      kind: 'inline',
      definition: createBlankWorkflow(),
    })
    const [preset, setPreset] = useState({ id: 'research', description: 'Original description' })
    const [positions, setPositions] = useState<typeof graphPositions>({})
    graphPositions = positions
    moveGraph = setPositions
    value = source
    return (
      <WorkflowEditor
        definitionOnly
        value={source}
        onChange={setSource}
        preset={preset}
        onPresetChange={setPreset}
        assistantDependencies={dependencies}
        graphPositions={positions}
        onGraphPositionsChange={setPositions}
      />
    )
  }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.textContent === label)!
    await dom.act(async () => button.click())
  }
  const name = () => (value?.kind === 'inline' ? value.definition.name : undefined)
  try {
    const root = dom.createRoot()
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter>
            <PermissionsProvider
              usePermissions={() => ({ can: () => true, permissions: ['*'], isLoading: false, isError: false })}
            >
              <Editor />
            </PermissionsProvider>
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await dom.act(async () => waitFor(() => expect(bridge?.pageEditor).toBeDefined()))
    expect(document.body.textContent).not.toContain('Advanced editor')
    const preview = document.querySelector('[aria-label="Live flow preview"]')!
    expect(preview.closest('details')).toBeNull()
    expect([...preview.querySelectorAll('button')].filter((button) => button.textContent === 'Undo')).toHaveLength(1)
    expect(document.body.textContent).not.toContain('Undo assistant edit')
    expect(document.body.textContent).toContain('What flow do you want?')
    const completion = () => (value?.kind === 'inline' ? value.definition.completion.mode : undefined)
    // Realtime tool delivery updates the document and acknowledges the revision before returning.
    let response: any
    await dom.act(async () => {
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: stored!.revision,
        summary: 'Made a research flow',
        operations: [
          { op: 'set-name', name: 'Research flow' },
          { op: 'update-step', id: 'execute', changes: { instructions: 'Research the question carefully.' } },
          { op: 'set-completion', completion: { mode: 'review-approval' } },
        ],
      })
    })
    expect(response.result.status).toBe('applied')
    expect(name()).toBe('Research flow')
    expect(stored!.revision).toBe(1)
    expect(document.body.textContent).not.toContain('Apply to draft')
    expect(document.querySelectorAll('[aria-label="Changed by assistant"]')).toHaveLength(1)
    await dom.act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-flow-target="execute"]')!.click()
    })
    expect(document.querySelector('[aria-label="Changed by assistant"]')).toBeNull()
    const escapeSelection = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await dom.act(async () =>
      document.querySelector('[aria-label="Step instructions"]')!.dispatchEvent(escapeSelection)
    )
    expect(escapeSelection.defaultPrevented).toBe(true)
    expect(document.querySelectorAll('[data-flow-kind][aria-pressed="true"]')).toHaveLength(0)
    expect(document.querySelector('[aria-label="Flow inspector"]') === null).toBe(true)
    await click('Undo')
    expect(name()).toBe('Research flow')
    expect(completion()).toBe('deliverable')
    expect(stored!.history).toEqual({ canUndo: false, canRedo: true })
    await dom.act(async () => {
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: stored!.revision,
        summary: 'Restore research',
        historyAction: 'redo',
      })
    })
    expect(response.result.status).toBe('applied')
    expect(name()).toBe('Research flow')
    await dom.act(async () => {
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: stored!.revision,
        summary: 'Undo research',
        historyAction: 'undo',
      })
    })
    expect(response.result.status).toBe('applied')
    expect(name()).toBe('Research flow')
    expect(completion()).toBe('deliverable')
    await click('Redo')
    expect(name()).toBe('Research flow')
    // Text fallback edits arrive through the query, using the same application path.
    const proposal = {
      id: crypto.randomUUID(),
      baseRevision: stored!.revision,
      summary: 'Added a clearer name',
      document: { ...(stored!.document as object), name: 'Reviewed research' },
    }
    await dom.act(async () => cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored!, proposal }))
    await waitFor(() => expect(name()).toBe('Reviewed research'))
    const revision = stored!.revision
    await dom.act(async () => cache.setQueryData(assistantQueries.editor(id).queryKey, { ...stored!, proposal }))
    expect(stored!.revision).toBe(revision) // duplicate delivery does not add history
    await click('Undo')
    expect(name()).toBe('Reviewed research')
    expect(completion()).toBe('deliverable')
    await click('Redo')
    expect(name()).toBe('Reviewed research')
    expect(completion()).toBe('review-approval')
    // A manual edit advances the revision; a delayed agent result must not overwrite it.
    const baseRevision = stored!.revision
    await click('Settings')
    const input = document.querySelector<HTMLInputElement>('[aria-label="Name"]')!
    await dom.act(async () => fireEvent.change(input, { target: { value: 'My manual name' } }))
    await dom.act(async () =>
      cache.setQueryData(assistantQueries.editor(id).queryKey, {
        ...stored!,
        proposal: { ...proposal, id: crypto.randomUUID(), baseRevision },
      })
    )
    expect(name()).toBe('My manual name')
    expect(bridge!.pageEditor!.getContext!()).toContain('My manual name')
    expect(document.body.textContent).not.toContain('Preparing the conversation')
    await waitFor(() => expect(document.body.textContent).toContain('The draft changed before this edit arrived'))
    await dom.act(async () => {
      await bridge!.pageEditor!.execute('edit', {
        baseRevision: stored.revision,
        summary: 'Describe this preset',
        preset: { id: 'research-team', description: 'Research with citations' },
      })
    })
    expect(stored.preset).toEqual({ id: 'research-team', description: 'Research with citations' })
    await click('Undo')
    expect(stored.preset).toEqual({ id: 'research-team', description: 'Research with citations' })
    expect(completion()).toBe('deliverable')
    expect(name()).toBe('My manual name')
    await click('Redo')
    expect(stored.preset?.description).toBe('Research with citations')
    expect(completion()).toBe('review-approval')
    // Manual positions stay put, but an assistant-created step must not inherit an overlap.
    await dom.act(async () =>
      moveGraph({
        ...graphPositions,
        execute: { x: 32, y: 32 },
        research: { x: 32, y: 32 },
      })
    )
    expect(graphPositions.execute).toEqual(graphPositions.research)
    await dom.act(async () => {
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: stored.revision,
        summary: 'Add a research step',
        operations: [
          {
            op: 'put-step',
            step: {
              id: 'research',
              kind: 'agent',
              participant: 'worker',
              instructions: 'Research the question.',
              output: 'Research notes.',
              outcomes: { completed: { next: 'finish' } },
            },
          },
          { op: 'set-outcome', id: 'execute', outcome: 'completed', transition: { next: 'research' } },
        ],
      })
    })
    expect(response.result.status).toBe('applied')
    expect(graphPositions.execute).not.toEqual(graphPositions.research)
    expect(graphPositions.research).toBeDefined()
    // Consecutive undo calls use returned revisions, even before React commits between them.
    const readsBeforeUndo = read.mock.calls.length
    const beforeUndo = stored.revision
    await dom.act(async () => {
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: response.result.revision,
        summary: 'Undo addition',
        historyAction: 'undo',
      })
      expect(response.result).toMatchObject({
        status: 'applied',
        revision: beforeUndo + 1,
        history: { canUndo: true, canRedo: true },
      })
      response = await bridge!.pageEditor!.execute('edit', {
        baseRevision: response.result.revision,
        summary: 'Undo prior change',
        historyAction: 'undo',
      })
      expect(response.result.status).toBe('applied')
      expect(response.result.revision).toBe(beforeUndo + 2)
    })
    expect(read.mock.calls.length).toBe(readsBeforeUndo)
    expect(stored.revision).toBe(beforeUndo + 2)
  } finally {
    await dom.cleanup()
    cache.clear()
    for (const spy of [create, sync, read, close, propose]) spy.mockRestore()
    globalThis.ResizeObserver = originalObserver
  }
})

test('arrows select and delete individual connections, preserve positions, and use a contextual inspector', async () => {
  const definition = workflowPresetSchema.parse(
    Bun.YAML.parse(await Bun.file(new URL('../../test/fixtures/parallel-flow.yaml', import.meta.url)).text())
  ).definition
  const dom = await acquireDomHarness({ url: 'http://localhost/settings/workflows' })
  const originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private callback: () => void) {}
    observe(element: HTMLElement) {
      Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 600 },
      })
      this.callback()
    }
    disconnect() {}
  } as any
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queries.workflows.list().queryKey, [])
  cache.setQueryData(queries.agentTypes.list().queryKey, [])
  cache.setQueryData(integrationQueries.outputs().queryKey, [])
  let current = definition
  function Editor() {
    const [source, setSource] = useState<WorkflowSource | undefined>({ kind: 'inline', definition })
    if (source?.kind === 'inline') current = source.definition
    return <WorkflowEditor definitionOnly value={source} onChange={setSource} />
  }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find((button) => button.textContent === label)!
    expect(button).toBeDefined()
    await dom.act(async () => button.click())
  }
  const selectArrow = async (id: string) => {
    const arrow = document.querySelector(`[data-flow-edge="${id}"] path[stroke="transparent"]`)!
    expect(arrow).not.toBeNull()
    await dom.act(async () => arrow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    expect(document.querySelectorAll('[data-flow-edge][data-selected="true"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-flow-kind][aria-pressed="true"]')).toHaveLength(0)
  }
  const remove = async () => {
    const graph = document.querySelector<HTMLElement>('[aria-label="Edit flow graph"]')!
    await dom.act(async () =>
      graph.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    )
  }
  const positions = () =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-flow-kind]')].map((card) => [
        card.dataset.flowTarget,
        [card.style.left, card.style.top],
      ])
    )
  try {
    const root = dom.createRoot()
    await dom.act(async () =>
      root.root.render(
        <QueryClientProvider client={cache}>
          <PermissionsProvider
            usePermissions={() => ({ can: () => false, permissions: [], isLoading: false, isError: false })}
          >
            <Editor />
          </PermissionsProvider>
        </QueryClientProvider>
      )
    )
    const before = positions()
    const zoom = document.querySelector<HTMLElement>('[style*="scale("]')!.style.transform
    await selectArrow('build:completed · branch 1')
    const escape = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await dom.act(async () => document.querySelector('[aria-label="Edit flow graph"]')!.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(document.querySelector('[aria-label="Flow inspector"]')).toBeNull()
    expect(document.querySelector('[data-flow-edge][data-selected="true"]')).toBeNull()
    await selectArrow('build:completed · branch 1')
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect(document.body.textContent).toContain('Handoff details')
    expect(document.querySelector('[aria-label="Step instructions"]')).toBeNull()
    for (const [previous, next] of [
      ['completed', 'ready'],
      ['ready', 'completed'],
    ]) {
      const input = document.querySelector<HTMLInputElement>(`[aria-label="Rename build outcome ${previous}"]`)!
      await dom.act(async () => {
        input.value = next!
        input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
      })
      expect(document.querySelector('[data-flow-edge][data-selected="true"]')?.getAttribute('data-flow-edge')).toBe(
        `build:${next} · branch 1`
      )
    }
    await remove()
    expect(current.steps).toHaveLength(4)
    expect(current.steps[0]!.outcomes.completed).toEqual({ next: 'audience' })
    expect(positions()).toEqual(before)
    expect(document.querySelector<HTMLElement>('[style*="scale("]')!.style.transform).toBe(zoom)
    const warning = document.querySelector('[role="alert"]')!
    expect(warning.textContent).toContain('unreachable')
    expect(warning.closest('[data-workflow-notice]')!.classList.contains('absolute')).toBe(true)
    await dom.act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Dismiss workflow warning"]')!.click()
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toBeUndefined()
    await click('Undo')
    expect(current).toEqual(definition)
    await selectArrow('audience:approved')
    await remove()
    expect(current.steps.find((step) => step.id === 'audience')!.outcomes.approved).toBeUndefined()
    expect(current.steps.find((step) => step.id === 'correctness')!.outcomes.approved).toEqual({ next: 'consolidate' })
    expect(current.steps[0]!.outcomes.completed).toEqual(definition.steps[0]!.outcomes.completed)
    expect(positions()).toEqual(before)
    await click('Undo')
    await selectArrow('consolidate:completed')
    await remove()
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('“consolidate” has no outgoing connection')
    await click('Undo')
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[data-flow-target="audience"]')!.click())
    expect(document.body.textContent).toContain('Step details')
    expect(document.querySelector('[aria-label="Flow inspector"]')!.textContent).not.toContain('Completion policy')
    await click('Delete step')
    for (const [id, point] of Object.entries(positions())) expect(point).toEqual(before[id])
    await click('Settings')
    expect(document.body.textContent).toContain('Workflow settings')
    expect(document.querySelector('[aria-label="Step instructions"]')).toBeNull()
    expect(document.querySelector('[aria-label="Completion policy"]')).toBeNull()
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[data-flow-kind="completion"]')!.click())
    const inspector = document.querySelector('[aria-label="Flow inspector"]')!
    expect(inspector.querySelector('h4')!.textContent).toBe('Finish')
    expect(inspector.textContent).not.toContain('Routing')
    expect(inspector.textContent).not.toContain('Integration events')
    const policy = inspector.querySelector<HTMLSelectElement>('[aria-label="Completion policy"]')!
    await dom.act(async () => {
      policy.value = 'review-approval'
      policy.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    })
    expect(current.completion.mode).toBe('review-approval')
    expect(document.querySelector('[data-flow-kind="completion"]')!.textContent).toContain('Human approval')
    await click('Undo')
    expect(current.completion.mode).toBe(definition.completion.mode)
    expect(document.querySelector('[data-flow-kind="completion"]')!.textContent).toContain('Deliverable')
    const beforeRename = positions()
    await dom.act(async () => document.querySelector<HTMLButtonElement>('[data-flow-target="correctness"]')!.click())
    const nameInput = [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Step name'))!
      .querySelector('input')!
    await dom.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        nameInput,
        'Quality review'
      )
      nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    expect(current.steps.find((step) => step.id === 'correctness')?.name).toBe('Quality review')
    expect(document.querySelector('[data-flow-target="correctness"]')?.textContent).toContain('Quality review')
    expect(positions()).toEqual(beforeRename)
    const references = JSON.stringify(current.steps.map((step) => step.outcomes))
    await click('Undo')
    expect(current.steps.find((step) => step.id === 'correctness')?.name).toBeUndefined()
    expect(JSON.stringify(current.steps.map((step) => step.outcomes))).toBe(references)
    const stepId = [...document.querySelectorAll('label')]
      .find((label) => label.textContent?.startsWith('Step ID'))!
      .querySelector('input')!
    await dom.act(async () => {
      stepId.value = 'quality'
      stepId.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
    })
    expect(positions().quality).toEqual(beforeRename.correctness)
    expect(current.steps.some((step) => step.id === 'quality')).toBe(true)
    await click('Undo')
    expect(positions()).toEqual(beforeRename)
    await click('Redo')
    expect(positions().quality).toEqual(beforeRename.correctness)
  } finally {
    globalThis.ResizeObserver = originalObserver
    await dom.cleanup()
    cache.clear()
  }
})
