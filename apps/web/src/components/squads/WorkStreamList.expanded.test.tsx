import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { Squad, WorkStream } from '@ficus/shared'
import { queries } from '../../queryOptions'
import { acquireDomHarness } from '../../test/domHarness'
import { SquadHomeTab } from './SquadHomeTab'
import { WorkStreamList } from './WorkStreamList'

const now = new Date('2026-08-17T12:00:00Z')
function LocationProbe() {
  return <output data-router-search={useLocation().search} />
}
const squad = {
  id: 'squad-expanded',
  name: 'Expanded explorer squad',
  purpose: '',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  createdAt: now,
  updatedAt: now,
} as Squad

function stream(id: string): WorkStream {
  return {
    id,
    squadId: squad.id,
    title: `Stream ${id}`,
    description: '',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    effectivePriority: 'normal',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
  }
}

test('opens the dependency graph in a content-sized dialog with no view toggle and closes from its visible control', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  queryClient.setQueryData(queries.agentTypes.list().queryKey, [])
  const rendered = dom.createRoot()

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SquadHomeTab squad={squad} workStreams={[stream('a')]} dependencies={{ SquadAgentThreads: () => null }} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    const expand = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Show work stream graph"]')
    expect(expand).toBeTruthy()
    await dom.act(async () => expand!.click())

    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Work Stream Graph"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.querySelector('svg[aria-label^="Dependency graph"]')).toBeTruthy()
    expect(dialog.querySelector('[role="button"][aria-label^="Open Stream a,"]')).toBeTruthy()
    expect(dialog.querySelector('[data-modal-size="default"]')).toBeTruthy()
    expect(dialog.querySelector('[aria-label="Work stream view"]')).toBeNull()
    expect(dialog.querySelector('[aria-label="Close"]')).toBeTruthy()
    expect([...dialog.querySelectorAll('button')].some((button) => button.textContent?.includes('Active'))).toBe(false)
    expect(dom.window.document.querySelectorAll('button[aria-label="Show work stream graph"]')).toHaveLength(1)
    // The graph is a canvas, not rows: the inline list stays the only list on the page.
    expect(dialog.querySelectorAll('li')).toHaveLength(0)
    expect(dom.window.document.querySelectorAll('li')).toHaveLength(1)

    await dom.act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(dom.window.document.querySelector('[role="dialog"][aria-label="Work Stream Graph"]')).toBeNull()
    expect(dom.window.document.querySelector('svg[aria-label^="Dependency graph"]')).toBeNull()
    expect(dom.window.document.body.textContent).toContain('Stream a')
    expect(dom.window.document.querySelectorAll('li')).toHaveLength(1)
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('expandable Home stays list-only inline and shows the graph skeleton in its dialog during initial load', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SquadHomeTab
              squad={squad}
              workStreams={[]}
              workStreamsLoading
              dependencies={{ SquadAgentThreads: () => null }}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    expect(dom.window.document.querySelector('[role="status"][aria-label="Loading active work streams"]')).toBeTruthy()
    expect(dom.window.document.querySelector('[aria-label="Work stream view"]')).toBeNull()
    const expand = dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Show work stream graph"]')!
    expect(expand).toBeTruthy()
    await dom.act(async () => expand.click())
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Work Stream Graph"]')!
    expect(dialog.querySelector('[role="status"][aria-label="Loading work stream graph"]')).toBeTruthy()
    expect(dialog.querySelector('[role="status"][aria-label="Loading active work streams"]')).toBeNull()
    expect(dialog.querySelector('[aria-label="Work stream view"]')).toBeNull()
    expect(dialog.querySelector('button[aria-label="Show work stream graph"]')).toBeNull()
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('kanban preserves review, human wait, dependency wait, and blocked columns', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  dom.window.localStorage.setItem(`ficus.wsView.${squad.id}`, 'kanban')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  const rendered = dom.createRoot()
  const states = [
    ['review', 'in_review'],
    ['answer', 'waiting_on_answer'],
    ['dependency', 'waiting_on_dependency'],
    ['blocked', 'blocked'],
  ] as const
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <WorkStreamList
              squadId={squad.id}
              workStreams={states.map(([id, derivedState]) => ({ ...stream(id), derivedState }))}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    const text = dom.window.document.body.textContent ?? ''
    expect(text).toContain('In Review (1)')
    expect(text).toContain('Waiting on Answer (1)')
    expect(text).toContain('Waiting on Dependency (1)')
    expect(text).toContain('Blocked (1)')
    expect(text).toContain('Needs review — click to open')
    expect(text).toContain('Waiting on answer — click to respond')
    expect(text).toContain('Waiting on dependency — click to inspect')

    const cards = Array.from(dom.window.document.querySelectorAll<HTMLElement>('[role="button"][tabindex="0"]'))
    const reviewCard = cards.find((card) => card.textContent?.includes('Stream review'))!
    const dependencyCard = cards.find((card) => card.textContent?.includes('Stream dependency'))!
    expect(reviewCard).toBeTruthy()
    expect(dependencyCard).toBeTruthy()

    await dom.act(async () => {
      const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      expect(reviewCard.dispatchEvent(event)).toBe(false)
    })
    expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Stream review')

    await dom.act(async () => {
      const event = new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
      expect(dependencyCard.dispatchEvent(event)).toBe(false)
    })
    expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Stream dependency')
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('non-expandable work keeps its real categories and controls during initial load', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  const rendered = dom.createRoot()
  const render = (workStreams: WorkStream[]) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkStreamList squadId={squad.id} workStreams={workStreams} isLoading />
      </MemoryRouter>
    </QueryClientProvider>
  )
  try {
    await dom.act(async () => rendered.root.render(render([])))
    expect(dom.window.document.querySelector('[role="status"][aria-label="Loading active work streams"]')).toBeTruthy()
    expect(dom.window.document.body.textContent).toContain('Active')
    expect(dom.window.document.body.textContent).toContain('Done')
    expect(dom.window.document.querySelector('[aria-label="Work stream view"]')).toBeTruthy()
    expect(dom.window.document.querySelector('button[aria-label="Show work stream graph"]')).toBeNull()
    await dom.act(async () => rendered.root.render(render([stream('a')])))
    expect(dom.window.document.body.textContent).toContain('Stream a')
    expect(dom.window.document.querySelector('[aria-label="Work stream view"]')).toBeTruthy()
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('the graph dialog ignores the embedded Active collapse without changing it', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  queryClient.setQueryData(queries.agentTypes.list().queryKey, [])
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <LocationProbe />
            <SquadHomeTab squad={squad} workStreams={[stream('a')]} dependencies={{ SquadAgentThreads: () => null }} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    const activeButton = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Active')
    )!
    await dom.act(async () => activeButton.click())
    expect(dom.window.document.body.textContent).not.toContain('Stream a')
    expect(dom.window.document.querySelector('output')?.dataset.routerSearch).toContain('activeCollapsed=1')
    await dom.act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Show work stream graph"]')!.click()
    )
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Work Stream Graph"]')!
    expect(dialog.querySelector('[role="button"][aria-label^="Open Stream a,"]')).toBeTruthy()
    expect([...dialog.querySelectorAll('button')].some((button) => button.textContent?.includes('Active'))).toBe(false)
    expect(dom.window.document.querySelector('output')?.dataset.routerSearch).toContain('activeCollapsed=1')
    await dom.act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click())
    expect(dom.window.document.body.textContent).not.toContain('Stream a')
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('Escape closes detail before fullscreen', async () => {
  const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  queryClient.setQueryData(queries.agentTypes.list().queryKey, [])
  const rendered = dom.createRoot()

  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <SquadHomeTab squad={squad} workStreams={[stream('a')]} dependencies={{ SquadAgentThreads: () => null }} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )

    await dom.act(async () =>
      dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Show work stream graph"]')!.click()
    )
    const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Work Stream Graph"]')!
    expect(dialog.querySelector('[aria-label="Work stream view"]')).toBeNull()
    expect(dialog.querySelector('[data-modal-size="default"]')).toBeTruthy()
    expect(dialog.querySelector('[data-modal-size="viewport"]')).toBeNull()
    expect(dialog.querySelector('svg[aria-label^="Dependency graph"]')).toBeTruthy()
    // A stale Home view preference from older builds must not leak into the dialog or the inline list.
    expect(dom.window.localStorage.getItem(`ficus.wsView.home.${squad.id}`)).toBeNull()

    const graphNode = dialog.querySelector<HTMLElement>('[role="button"][aria-label^="Open Stream a,"]')!
    graphNode.focus()
    await dom.act(async () =>
      graphNode.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    expect(dom.window.document.querySelector('[role="dialog"][aria-label="Stream a"]')).toBeTruthy()

    await dom.act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent
      )
    )
    expect(dom.window.document.querySelector('[role="dialog"][aria-label="Stream a"]')).toBeNull()
    const survivingDialog = dom.window.document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Work Stream Graph"]'
    )!
    expect(survivingDialog).toBeTruthy()
    expect(survivingDialog.contains(dom.window.document.activeElement)).toBe(true)

    await dom.act(async () =>
      dom.window.document.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as KeyboardEvent
      )
    )
    expect(dom.window.document.querySelector('[role="dialog"][aria-label="Work Stream Graph"]')).toBeNull()
    expect(dom.window.document.querySelector('svg[aria-label^="Dependency graph"]')).toBeNull()
    expect(dom.window.document.body.textContent).toContain('Stream a')
    expect(dom.window.document.activeElement?.getAttribute('aria-label')).toBe('Show work stream graph')
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})

test('preserves filter controls as active and done queries resolve independently', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(queries.squads.agents(squad.id).queryKey, [])
  queryClient.setQueryData(queries.agentTypes.list().queryKey, [])
  const { root } = dom.createRoot()
  const render = (loading: boolean, loadingDone: boolean, doneStreams: WorkStream[] = []) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <WorkStreamList
            squadId={squad.id}
            workStreams={[]}
            isLoading={loading}
            isLoadingDone={loadingDone}
            doneStreams={doneStreams}
          />
        </MemoryRouter>
      </QueryClientProvider>
    )
  try {
    await dom.act(async () => render(true, true))
    const filters = document.querySelector('[aria-label="Work stream filters"]')
    expect(filters).not.toBeNull()
    await dom.act(async () => render(false, true))
    expect(document.querySelector('[aria-label="Work stream filters"]')).toBe(filters)
    expect(document.body.textContent).not.toContain('No work streams yet')
    expect(document.body.textContent).toContain('Done')
    await dom.act(async () => render(false, false, [{ ...stream('done'), status: 'done', derivedState: 'done' }]))
    expect(document.querySelector('[aria-label="Work stream filters"]')).toBe(filters)
    expect(document.body.textContent).not.toContain('No work streams yet')
    await dom.act(async () => render(false, false))
    expect(document.body.textContent).toContain('No work streams yet')
    expect(document.querySelector('[aria-label="Work stream filters"]')).toBe(filters)
  } finally {
    queryClient.clear()
    await dom.cleanup()
  }
})
