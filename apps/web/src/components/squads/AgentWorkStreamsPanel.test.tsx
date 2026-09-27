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

function renderPanel(workStreams: WorkStream[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.workStreams(squad.id), workStreams)
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
  const { MemoryRouter } = await import('react-router-dom')
  const { acquireDomHarness } = await import('../../test/domHarness')
  const { client } = await import('../../api/clientInstance')
  const dom = await acquireDomHarness({ url: 'http://localhost/agents/agent-1' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  let server = workStream({ agentIds: [agent.id], autoCleanupWorktree: true, worktree: '/workspace/feature' })
  cache.setQueryData(queryKeys.squads.workStreams(squad.id), [server])
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
    if (url.pathname.endsWith('/workstreams')) return Response.json([server])
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
    await dom.cleanup()
    cache.clear()
    save.mockRestore()
    fetch.mockRestore()
  }
})
