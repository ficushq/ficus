import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { fireEvent } from '@testing-library/dom'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import type { AgentPrivateStatus } from '../../api/agentPrivate'
import { WorkspaceTab } from './WorkspaceTab'
import { newFilePathError, privateAreaAgents } from './agentPrivateTargets'
import { agentVisiblePath } from './workspaceSource'

const SQUAD = 'squad-1'
const agent = (id: string, overrides: Partial<Agent> = {}) =>
  ({
    id,
    agentTypeId: 'engineer',
    squadId: SQUAD,
    parentAgentId: null,
    status: 'idle',
    metadata: { name: id },
    ...overrides,
  }) as unknown as Agent

const AGENTS = [
  agent('zed-dormant', { status: 'dormant' }),
  agent('amy'),
  agent('sub', { parentAgentId: 'amy' }),
  agent('chat', { agentTypeId: 'consultant' }),
  agent('bob', { status: 'active', metadata: { name: 'bob', purpose: 'Billing integration' } }),
]

function status(overrides: Partial<AgentPrivateStatus> = {}): AgentPrivateStatus {
  return {
    agentId: 'amy',
    agentStatus: 'idle',
    live: true,
    sandboxId: 'agent_amy',
    privateRoot: '/home/box_amy/.private',
    sandbox: { status: 'not_found' },
    filesAvailable: false,
    canStart: true,
    canUseTerminal: true,
    ...overrides,
  }
}

let location = ''
function LocationProbe() {
  const current = useLocation()
  location = current.search
  return null
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Workspace to browse"]')!
const optionLabels = () =>
  [...document.querySelectorAll<HTMLElement>('[role="listbox"][aria-label="Workspaces"] [role="option"]')].map(
    (option) => option.textContent ?? ''
  )

/**
 * Renders the tab with seeded queries (and optionally a stubbed fetch) and
 * returns a `cleanup` that undoes everything in reverse order: the fetch stub
 * first (so the harness restores the real global afterwards), then the DOM
 * harness (unmounting every query observer and timer), then the cache. If the
 * render itself throws, the same cleanup runs before rethrowing.
 */
async function renderTab(url: string, seed: (cache: QueryClient) => void, stubFetch?: typeof fetch) {
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1' })
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const harnessFetch = globalThis.fetch
  /**
   * Let every pending query, mutation and React update finish inside act, so nothing this file
   * started is still running (or still updating React) when the next test file takes the DOM.
   */
  const settle = () =>
    dom.act(async () => {
      for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    })
  const cleanup = async () => {
    try {
      await settle()
    } catch {
      // Teardown continues; the harness cleanup below reports real failures.
    }
    globalThis.fetch = harnessFetch
    try {
      await dom.cleanup()
    } finally {
      cache.clear()
    }
  }
  try {
    // After the harness installs its window: it provides its own fetch.
    if (stubFetch) globalThis.fetch = stubFetch
    const { root } = dom.createRoot()
    cache.setQueryData(queryKeys.auth.permissions(SQUAD), { permissions: ['agents:private-access', 'terminal:access'] })
    cache.setQueryData(queryKeys.squads.agents(SQUAD), AGENTS)
    seed(cache)
    await dom.act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <MemoryRouter initialEntries={[url]}>
            <LocationProbe />
            <WorkspaceTab squadId={SQUAD} />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    await settle()
  } catch (error) {
    await cleanup()
    throw error
  }
  return { dom, cleanup, settle }
}

describe('agent target helpers', () => {
  test('lists agents with a private box of their own, live first', () => {
    expect(privateAreaAgents(AGENTS).map((a) => a.id)).toEqual(['amy', 'bob', 'zed-dormant'])
  })

  test('validates new file paths like the server', () => {
    expect(newFilePathError('creds/token.txt')).toBeNull()
    expect(newFilePathError('')).toBe('Enter a file name')
    expect(newFilePathError('../x')).not.toBeNull()
    expect(newFilePathError('.ficus/identity.pem')).not.toBeNull()
    expect(newFilePathError('identity.pem')).not.toBeNull()
    expect(newFilePathError('chat-attachments/x')).not.toBeNull()
  })

  test('builds the path the agent sees', () => {
    expect(agentVisiblePath('/private', 'creds/token.txt')).toBe('/private/creds/token.txt')
    expect(agentVisiblePath('/home/box_a/.private/', '/a.txt')).toBe('/home/box_a/.private/a.txt')
    expect(agentVisiblePath('/private', '')).toBe('/private')
  })
})

describe('WorkspaceTab agent target', () => {
  test('a stopped box shows its state and a start button instead of opening a terminal', async () => {
    const requests: string[] = []
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
      const body = String(input).endsWith('/private/status') ? status({ sandbox: { status: 'running' } }) : { ok: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const { dom, cleanup, settle } = await renderTab(
      '/squads/squad-1?workspaceAgent=amy',
      (c) => c.setQueryData(queryKeys.agentPrivate.status('amy'), status()),
      stub
    )
    try {
      const text = document.body.textContent ?? ''
      expect(text).toContain('/home/box_amy/.private')
      expect(text).toContain('Sandbox stopped')
      expect(text).toContain('Start the agent’s sandbox to open a terminal in it.')
      expect(text).toContain('Start it to browse its private files.')
      // Nothing reached for the terminal or files while the box is stopped.
      expect(requests.filter((request) => request.includes('/terminal') || request.includes('/tree'))).toEqual([])

      expect(trigger().getAttribute('aria-label')).toBe('Workspace to browse: amy')

      const start = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Start sandbox'))!
      await dom.act(async () => start.click())
      await settle()
      expect(
        requests.some((request) => request.startsWith('POST') && request.includes('/agents/amy/private/start'))
      ).toBe(true)
      // After starting, the status is refetched and shows the running box.
      expect(document.body.textContent).toContain('Sandbox running')

      // The picker lists the squad workspace, then agents with a box of their own, live first.
      await dom.act(async () => trigger().click())
      expect(optionLabels()).toEqual([
        expect.stringContaining('Squad workspace'),
        'amy',
        'Billing integrationbob',
        'zed-dormant (dormant)',
      ])
      // Search matches purpose as well as name.
      const search = document.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!
      await dom.act(async () => {
        fireEvent.change(search, { target: { value: 'billing' } })
      })
      expect(optionLabels()).toEqual(['Billing integrationbob'])
      await dom.act(async () => {
        fireEvent.change(search, { target: { value: 'nobody' } })
      })
      expect(optionLabels()).toEqual([])
      expect(document.body.textContent).toContain('No agents match “nobody”.')
      await dom.act(async () => {
        fireEvent.change(search, { target: { value: 'bob' } })
      })
      await dom.act(async () => {
        fireEvent.keyDown(search, { key: 'Enter' })
      })
      await settle()
      expect(trigger().getAttribute('aria-expanded')).toBe('false')
      expect(location).toContain('workspaceAgent=bob')
      expect(location).not.toMatch(/[?&]agent=/)
    } finally {
      await cleanup()
    }
  })

  test('a dormant agent on local storage: files browsable with copy-path, no start, no terminal', async () => {
    const { cleanup } = await renderTab('/squads/squad-1?workspaceAgent=zed-dormant&file=notes.md', (c) => {
      c.setQueryData(
        queryKeys.agentPrivate.status('zed-dormant'),
        status({
          agentId: 'zed-dormant',
          live: false,
          sandboxId: 'agent_zed-dormant',
          privateRoot: '/private',
          filesAvailable: true,
          canStart: false,
          canUseTerminal: false,
        })
      )
      c.setQueryData(queryKeys.agentPrivate.tree('zed-dormant', ''), {
        name: 'private',
        type: 'directory',
        children: [{ name: 'notes.md', type: 'file', size: 7 }],
      })
      c.setQueryData(queryKeys.agentPrivate.file('zed-dormant', 'notes.md'), {
        path: 'notes.md',
        agentPath: '/private/notes.md',
        content: '# notes',
        size: 7,
        binary: false,
      })
    })
    try {
      const text = document.body.textContent ?? ''
      expect(text).toContain('Agent dormant · sandbox stopped')
      expect(text).toContain('A terminal opens in its own sandbox while the agent is awake.')
      expect(text).not.toContain('Start sandbox')
      expect(text).toContain('notes.md')
      expect(document.querySelector('[title="Copy path the agent can open: /private/notes.md"]')).not.toBeNull()
    } finally {
      await cleanup()
    }
  })

  test('a shared link to an agent the viewer may not open explains why and offers the way back', async () => {
    const forbidden = (async () =>
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    const { dom, cleanup, settle } = await renderTab(
      '/squads/squad-1?workspaceAgent=amy',
      (c) => {
        c.setQueryData(queryKeys.auth.permissions(SQUAD), { permissions: ['workspace:read'] })
        c.removeQueries({ queryKey: queryKeys.squads.agents(SQUAD) })
      },
      forbidden
    )
    try {
      await settle()
      expect(document.body.textContent).toContain('needs the agents:private-access permission')
      // No agent list is offered; only the way back to the squad workspace.
      expect(trigger().getAttribute('aria-label')).toBe('Workspace to browse: Unknown agent')
      await dom.act(async () => trigger().click())
      expect(optionLabels()).toEqual([expect.stringContaining('Squad workspace')])
      // Close it again (Escape) so no popover, and no position watcher, is open at teardown.
      await dom.act(async () => {
        fireEvent.keyDown(document.querySelector('input[aria-label="Search agents"]')!, { key: 'Escape' })
      })
      await settle()
      expect(trigger().getAttribute('aria-expanded')).toBe('false')
    } finally {
      await cleanup()
    }
  })

  test('cleanup leaves the global fetch exactly as it found it', async () => {
    const before = globalThis.fetch
    const stub = (async () => new Response('{}')) as unknown as typeof fetch
    const { cleanup } = await renderTab(
      '/squads/squad-1?workspaceAgent=amy',
      (c) => c.setQueryData(queryKeys.agentPrivate.status('amy'), status()),
      stub
    )
    expect(globalThis.fetch).toBe(stub)
    await cleanup()
    expect(globalThis.fetch).toBe(before)
  })
})
