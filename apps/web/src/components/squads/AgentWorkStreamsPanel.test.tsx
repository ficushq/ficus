import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'
import type { Agent, Squad, WorkStream } from '@ficus/shared'

const { AgentWorkStreamsPanel } = await import('./AgentWorkStreamsPanel')

const now = new Date('2026-01-01T00:00:00Z')

const squad: Squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
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
}

const agent: Agent = {
  id: 'agent-1',
  squadId: squad.id,
  agentTypeId: 'engineer',
  status: 'idle',
  persist: false,
  metadata: { name: 'Engineer' },
  context: null,
  questionData: null,
  sessionUsage: null,
  createdAt: now,
  updatedAt: now,
  lastMessageAt: null,
  terminatedAt: null,
}

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: squad.id,
    title: 'Relevant work stream',
    description: 'A relevant work stream.',
    status: 'active',
    derivedState: 'in_progress',
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
    ...overrides,
  }
}

const isFinished = (ws: WorkStream) => ws.status === 'done' || ws.status === 'canceled'

/** Seeds the panel's two reads: the squad's open list and this agent's finished history. */
function seedPanel(queryClient: QueryClient, workStreams: WorkStream[], hasMore = false) {
  queryClient.setQueryData(
    queryKeys.squads.activeWorkStreams(squad.id),
    workStreams.filter((ws) => !isFinished(ws))
  )
  const items = workStreams.filter(isFinished)
  queryClient.setQueryData(queryKeys.squads.agentDoneWorkStreamsInfinite(agent.id), {
    pages: [{ items, hasMore, nextCursor: hasMore ? 'next' : null, totalCount: items.length + (hasMore ? 1 : 0) }],
    pageParams: [null],
  })
}

function renderPanel(workStreams: WorkStream[], hasMore = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seedPanel(queryClient, workStreams, hasMore)
  queryClient.setQueryData(queryKeys.squads.list(), [squad])
  queryClient.setQueryData(queryKeys.squads.agents(squad.id), [agent])

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentWorkStreamsPanel agent={agent} squadId={squad.id} />
    </QueryClientProvider>
  )
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

describe('AgentWorkStreamsPanel', () => {
  test('renders attached work streams in the server canonical order without re-sorting', () => {
    // Pre-sorted to mirror the server contract (GET /workstreams); the panel
    // must render that order as-is after filtering to the agent's streams.
    const attached = (overrides: Partial<WorkStream>) => workStream({ agentIds: [agent.id], ...overrides })
    const html = renderPanel([
      attached({ id: 'review', title: 'Panel Review', derivedState: 'in_review' }),
      attached({ id: 'wait', title: 'Panel Wait', derivedState: 'blocked' }),
      attached({ id: 'progress', title: 'Panel Progress', derivedState: 'in_progress' }),
      attached({ id: 'idle', title: 'Panel Idle', derivedState: 'idle' }),
      attached({ id: 'queue-1', title: 'Panel Queue One', status: 'queued', queuePosition: 1 }),
      attached({ id: 'queue-2', title: 'Panel Queue Two', status: 'queued', queuePosition: 2 }),
    ])
    const indices = [
      'Panel Review',
      'Panel Wait',
      'Panel Progress',
      'Panel Idle',
      'Panel Queue One',
      'Panel Queue Two',
    ].map((title) => html.indexOf(title))
    expect(indices.every((index) => index >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test("lists open work first, then the agent's finished history with a way to page further", () => {
    const html = renderPanel(
      [
        workStream({ id: 'open', title: 'Open panel work', agentIds: [agent.id] }),
        workStream({
          id: 'shipped',
          title: 'Shipped panel work',
          status: 'done',
          derivedState: 'done',
          ownerAgentId: agent.id,
        }),
        // A server that ignored agentId: another agent's history stays out.
        workStream({ id: 'theirs', title: 'Their shipped work', status: 'done', assigneeAgentId: 'agent-2' }),
      ],
      true
    )
    expect(html.indexOf('Open panel work')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('Open panel work')).toBeLessThan(html.indexOf('Shipped panel work'))
    expect(html).not.toContain('Their shipped work')
    expect(html).toContain('Show older work streams')
    expect(renderPanel([workStream({ agentIds: [agent.id] })])).not.toContain('Show older work streams')
  })

  test('includes work streams created by the agent with a Creator badge', () => {
    const html = renderPanel([
      workStream({ id: 'created', title: 'Creator only work', creatorAgentId: agent.id }),
      workStream({ id: 'unrelated', title: 'Unrelated work' }),
    ])

    expect(html).toContain('Creator only work')
    expect(html).toContain('Creator')
    expect(html).not.toContain('Unrelated work')
  })

  test('shows the tracked delivery pull request number on the row', () => {
    const html = renderPanel([
      workStream({
        id: 'tracked-pr',
        title: 'Tracked PR work',
        agentIds: [agent.id],
        metadata: {
          tracked: [
            {
              integration: 'github',
              repository: 'example/product',
              kind: 'pull_request',
              number: 123,
              delivery: true,
            },
          ],
        },
      }),
    ])

    expect(html).toContain('#123')
  })

  test('shows every delivery pull request number, codeHost-bound first', () => {
    const html = renderPanel([
      workStream({
        id: 'multi-pr',
        title: 'Multi PR work',
        agentIds: [agent.id],
        metadata: {
          codeHost: { integration: 'github', repository: 'example/product', changeRequest: { number: 5 } },
          tracked: [
            {
              integration: 'github',
              repository: 'example/product',
              kind: 'pull_request',
              number: 6,
              delivery: true,
            },
          ],
        },
      }),
    ])

    expect(html.indexOf('#5')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('#6')).toBeGreaterThanOrEqual(0)
    expect(html.indexOf('#5')).toBeLessThan(html.indexOf('#6'))
  })

  test('shows no pull request number for legacy metadata.github alone', () => {
    const html = renderPanel([
      workStream({
        id: 'legacy',
        title: 'Legacy work',
        agentIds: [agent.id],
        metadata: { github: { repo: 'example/product', pr: { number: 123 } } },
      }),
    ])

    expect(html).not.toContain('#123')
  })

  test('shows creator badge once alongside assigned and owner badges when roles overlap', () => {
    const html = renderPanel([
      workStream({
        id: 'overlap',
        title: 'Overlap work',
        assigneeAgentId: agent.id,
        ownerAgentId: agent.id,
        creatorAgentId: agent.id,
        agentIds: [agent.id],
      }),
    ])

    expect(countOccurrences(html, 'Overlap work')).toBe(1)
    expect(countOccurrences(html, 'Assigned')).toBe(1)
    expect(countOccurrences(html, 'Owner')).toBe(1)
    expect(countOccurrences(html, 'Creator')).toBe(1)
  })
})

test('open agent-panel details stay live across off/on saves and cleanup state changes', async () => {
  const { spyOn } = await import('bun:test')
  const { MemoryRouter } = await import('react-router')
  const { acquireDomHarness } = await import('../../test/domHarness')
  const { client } = await import('../../api/clientInstance')
  const dom = await acquireDomHarness({ url: 'http://localhost/agents/agent-1' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  let server = workStream({ agentIds: [agent.id], autoCleanupWorktree: true, worktree: '/workspace/feature' })
  seedPanel(cache, [server])
  cache.setQueryData(queryKeys.squads.workStreamDetail(server.id), server)
  cache.setQueryData(queryKeys.squads.list(), [squad])
  cache.setQueryData(queryKeys.squads.agents(squad.id), [agent])
  cache.setQueryData(queryKeys.auth.permissions(squad.id), { permissions: ['workstreams:update'] })
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost'
    )
    if (url.pathname.endsWith('/subscription')) return Response.json({ subscribed: false, count: 0 })
    if (url.pathname.endsWith(`/workstreams/${server.id}`)) return Response.json({ ...server, metrics: null })
    if (url.pathname.endsWith('/workstreams'))
      return Response.json(
        url.searchParams.has('limit') ? { items: [], hasMore: false, nextCursor: null, totalCount: 0 } : [server]
      )
    if (url.pathname.endsWith('/agents')) return Response.json({ agents: [agent] })
    if (url.pathname.endsWith('/squads')) return Response.json([squad])
    if (url.pathname.includes('/workflows/runs/')) return Response.json(null)
    return Response.json({})
  })
  const save = spyOn(client.workStreams, 'setAutoCleanupWorktree').mockImplementation(async (_id, enabled) => {
    server = { ...server, autoCleanupWorktree: enabled }
    return server
  })
  const root = dom.createRoot()
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const checkbox = () =>
    dom.window.document.querySelector('section[aria-label="Worktree cleanup"] input') as HTMLInputElement
  try {
    await dom.act(async () =>
      root.root.render(
        <MemoryRouter>
          <QueryClientProvider client={cache}>
            <AgentWorkStreamsPanel agent={agent} squadId={squad.id} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    await dom.act(async () => {
      const open = [...dom.window.document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(server.title)
      )!
      open.click()
      await settle()
    })
    expect(checkbox().checked).toBe(true)
    for (const enabled of [false, true]) {
      await dom.act(async () => {
        checkbox().click()
        await settle()
      })
      expect(save).toHaveBeenLastCalledWith(server.id, enabled)
      expect(cache.getQueryData<WorkStream>(queryKeys.squads.workStreamDetail(server.id))!.autoCleanupWorktree).toBe(
        enabled
      )
      expect(checkbox().checked).toBe(enabled)
    }
    for (const status of ['removing', 'succeeded'] as const) {
      server = {
        ...server,
        worktreeCleanup: {
          status,
          reason: `Live ${status}`,
          operationId: 'operation',
        } as WorkStream['worktreeCleanup'],
      }
      await dom.act(async () => {
        await cache.invalidateQueries({ queryKey: queryKeys.squads.workStreamDetail(server.id) })
        await settle()
      })
      expect(checkbox().disabled).toBe(true)
      expect(dom.window.document.body.textContent).toContain(`Live ${status}`)
    }
  } finally {
    await cache.cancelQueries()
    fetch.mockRestore()
    await dom.cleanup()
    cache.clear()
    save.mockRestore()
  }
})

test("reads the open list and pages the agent history, never the squad's unfiltered list", async () => {
  const { MemoryRouter } = await import('react-router')
  const { acquireDomHarness } = await import('../../test/domHarness')
  const reads: URL[] = []
  const agentId = '7d1c1c39-5f4b-4e0f-9a51-0b2a1c9d8e01'
  const uuidAgent = { ...agent, id: agentId }
  const dom = await acquireDomHarness({
    url: 'http://localhost/',
    api: {
      '/api/workstreams': ({ url }) => {
        reads.push(url)
        if (!url.searchParams.has('limit'))
          return [workStream({ id: 'open', title: 'Open history work', agentIds: [agentId] })]
        const second = url.searchParams.get('cursor') === 'page-2'
        return {
          items: [
            workStream({
              id: second ? 'older' : 'newer',
              title: second ? 'Older history work' : 'Newer history work',
              status: 'done',
              derivedState: 'done',
              assigneeAgentId: agentId,
            }),
          ],
          hasMore: !second,
          nextCursor: second ? null : 'page-2',
          totalCount: 2,
        }
      },
    },
  })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queryKeys.squads.list(), [squad])
  cache.setQueryData(queryKeys.squads.agents(squad.id), [uuidAgent])
  const root = dom.createRoot()
  const text = () => dom.window.document.body.textContent ?? ''
  const settle = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt++)
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  try {
    await dom.act(async () =>
      root.root.render(
        <MemoryRouter>
          <QueryClientProvider client={cache}>
            <AgentWorkStreamsPanel agent={uuidAgent} squadId={squad.id} />
          </QueryClientProvider>
        </MemoryRouter>
      )
    )
    await settle(() => text().includes('Newer history work'))
    expect(text().indexOf('Open history work')).toBeLessThan(text().indexOf('Newer history work'))
    expect(text()).not.toContain('Older history work')
    await dom.act(async () => {
      ;[...dom.window.document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Show older work streams')!
        .click()
    })
    await settle(() => text().includes('Older history work'))
    expect(text()).not.toContain('Show older work streams')
    expect(reads.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { statuses: 'queued,active', squadId: squad.id },
      { statuses: 'done,canceled', limit: '25', squadId: squad.id, agentId },
      { statuses: 'done,canceled', limit: '25', squadId: squad.id, agentId, cursor: 'page-2' },
    ])
  } finally {
    await dom.cleanup()
  }
})

/** Renders the panel against an API route table in a DOM harness; returns helpers to drive it. */
async function mountPanel(api: Record<string, (request: { url: URL }) => unknown>) {
  const { MemoryRouter } = await import('react-router')
  const { acquireDomHarness } = await import('../../test/domHarness')
  const dom = await acquireDomHarness({ url: 'http://localhost/', api })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  cache.setQueryData(queryKeys.squads.list(), [squad])
  cache.setQueryData(queryKeys.squads.agents(squad.id), [agent])
  const root = dom.createRoot()
  const text = () => dom.window.document.body.textContent ?? ''
  const settle = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt++)
      await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  await dom.act(async () =>
    root.root.render(
      <MemoryRouter>
        <QueryClientProvider client={cache}>
          <AgentWorkStreamsPanel agent={agent} squadId={squad.id} />
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  const button = (label: string) =>
    [...dom.window.document.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
  return { dom, cache, text, settle, button }
}

const emptyPage = { items: [], hasMore: false, nextCursor: null, totalCount: 0 }

test('a failed first load shows an error with Retry instead of an empty panel, and Retry recovers', async () => {
  let historyFails = true
  const historyReads: URL[] = []
  const panel = await mountPanel({
    '/api/workstreams': ({ url }) => {
      if (!url.searchParams.has('limit'))
        return [workStream({ id: 'open', title: 'Open retry work', agentIds: [agent.id] })]
      historyReads.push(url)
      if (historyFails) return Response.json({ error: 'Internal error' }, { status: 500 })
      return emptyPage
    },
  })
  try {
    await panel.settle(() => panel.text().includes('Could not load work streams'))
    expect(panel.text()).toContain('Could not load work streams')
    expect(panel.text()).not.toContain('No work streams')
    // The open list loaded, but showing it alone would hide that the history is missing.
    expect(panel.text()).not.toContain('Open retry work')
    expect(panel.dom.window.document.querySelector('[role="alert"]')?.textContent).toBe('Could not load work streams')

    historyFails = false
    await panel.dom.act(async () => panel.button('Retry')!.click())
    await panel.settle(() => panel.text().includes('Open retry work'))
    expect(panel.text()).toContain('Open retry work')
    expect(panel.text()).not.toContain('Could not load work streams')
    expect(historyReads).toHaveLength(2)
  } finally {
    await panel.cache.cancelQueries()
    await panel.dom.cleanup()
  }
})

test('a failed open list with no history also shows the error, not "No work streams"', async () => {
  const panel = await mountPanel({
    '/api/workstreams': ({ url }) =>
      url.searchParams.has('limit') ? emptyPage : Response.json({ error: 'busy' }, { status: 500 }),
  })
  try {
    await panel.settle(() => panel.text().includes('Could not load work streams'))
    expect(panel.text()).toContain('Could not load work streams')
    expect(panel.text()).not.toContain('No work streams')
    expect(panel.button('Retry')).toBeDefined()
  } finally {
    await panel.cache.cancelQueries()
    await panel.dom.cleanup()
  }
})

test('an open stream that leaves the polled open list refreshes the history, so it shows as finished', async () => {
  let finished = false
  const historyReads: URL[] = []
  const shipped = workStream({ id: 'shipping', title: 'Quietly shipped work', agentIds: [agent.id] })
  const unrelated = workStream({ id: 'other', title: 'Another agent work', assigneeAgentId: 'agent-2' })
  const panel = await mountPanel({
    '/api/workstreams': ({ url }) => {
      if (!url.searchParams.has('limit')) return finished ? [] : [shipped, unrelated]
      historyReads.push(url)
      const items = finished ? [{ ...shipped, status: 'done', derivedState: 'done' }] : []
      return { items, hasMore: false, nextCursor: null, totalCount: items.length }
    },
  })
  const refetchActive = async () => {
    await panel.dom.act(async () => {
      await panel.cache.invalidateQueries({ queryKey: queryKeys.squads.activeWorkStreams(squad.id), exact: true })
    })
  }
  try {
    await panel.settle(() => panel.text().includes('Quietly shipped work'))
    expect(historyReads).toHaveLength(1)

    // A poll that still lists the stream (or only drops another agent's) reads no history.
    await refetchActive()
    expect(historyReads).toHaveLength(1)

    // The stream finished and no live event arrived: the next poll no longer lists it.
    finished = true
    await refetchActive()
    await panel.settle(() => historyReads.length === 2 && panel.text().includes('Quietly shipped work'))
    expect(historyReads).toHaveLength(2)
    expect(historyReads[1]!.searchParams.get('cursor')).toBeNull()
    expect(panel.text()).toContain('Quietly shipped work')
    expect(panel.text()).not.toContain('No work streams')

    // Once it is in the history, later polls read no more history.
    await refetchActive()
    expect(historyReads).toHaveLength(2)
  } finally {
    await panel.cache.cancelQueries()
    await panel.dom.cleanup()
  }
})

test('a first history page that filters to nothing still offers older work streams', async () => {
  const panel = await mountPanel({
    '/api/workstreams': ({ url }) => {
      if (!url.searchParams.has('limit')) return []
      const older = url.searchParams.get('cursor') === 'page-2'
      // An older Core that ignores agentId: the first page holds only another agent's work.
      const items = older
        ? [workStream({ id: 'mine', title: 'My older work', status: 'done', assigneeAgentId: agent.id })]
        : [workStream({ id: 'theirs', title: 'Their work', status: 'done', assigneeAgentId: 'agent-2' })]
      return { items, hasMore: !older, nextCursor: older ? null : 'page-2', totalCount: 2 }
    },
  })
  try {
    await panel.settle(() => panel.button('Show older work streams') !== undefined)
    expect(panel.text()).not.toContain('No work streams')
    expect(panel.text()).not.toContain('Their work')
    await panel.dom.act(async () => panel.button('Show older work streams')!.click())
    await panel.settle(() => panel.text().includes('My older work'))
    expect(panel.text()).toContain('My older work')
  } finally {
    await panel.cache.cancelQueries()
    await panel.dom.cleanup()
  }
})
