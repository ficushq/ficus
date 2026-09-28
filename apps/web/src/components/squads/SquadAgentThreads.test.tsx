import { PermissionsProvider } from '../../hooks/usePermissions'
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom'
import { useContext, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { ChatFullscreenContext } from '../ChatFullscreenContext'
import type { Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { Window } from 'happy-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { SquadAgentThreadsApiProvider } from './squadAgentThreadsApi'
import type { Agent } from '@ficus/shared'

// Seeds the initial URL search params for the next mount — lets tests simulate a
// page load / refresh at a given URL (e.g. ?newConsultant=1). Reset in afterEach.
let initialSearchParams = ''
// Most tests use the default all-agents view; filter regressions explicitly enable the toggle.
let includeIdleAgents = true
let deniedPermissions = new Set<string>()
const apiFetchCalls: Array<[string, RequestInit | undefined]> = []
const singleArchiveCalls: Array<[string, string]> = []
const threadsApi = {
  terminateSquadAgent: async (squadId: string, agentId: string) => {
    singleArchiveCalls.push([squadId, agentId])
  },
  terminateSquadAgentsBulk: async (squadId: string, agentTypeId: string) => {
    apiFetchCalls.push([
      `/squads/${squadId}/agents/terminate-bulk`,
      { method: 'POST', body: JSON.stringify({ agentTypeId }) },
    ])
    return { terminated: [], deferred: [], skipped: [] }
  },
}

const threadsDependencies = {
  Chat: ({ headerLayout, onAgentCreated }: { headerLayout?: string; onAgentCreated?: (agentId: string) => void }) => (
    <div data-testid="consultant-chat-composer" data-header-layout={headerLayout ?? 'default'}>
      <button type="button" onClick={() => onAgentCreated?.('consultant-1')}>
        Mock create consultant
      </button>
    </div>
  ),
  AgentConversation: () => <div data-agent-conversation>Agent chat body</div>,
  SubagentsInlinePanel: ({ parentAgentId }: { parentAgentId: string }) => <div>Subagents panel {parentAgentId}</div>,
  AgentWorkStreamsPanel: () => <div>Agent work streams</div>,
  AgentInboxPanel: () => <div>Agent inbox</div>,
  AgentContextPanel: () => <div>Agent context</div>,
}

const usePermissionsMock = () => ({
  can: (permission: string) => !deniedPermissions.has(permission),
  isLoading: false,
  isError: false,
  permissions: [],
})

afterEach(() => {
  initialSearchParams = ''
  includeIdleAgents = true
  deniedPermissions = new Set<string>()
  apiFetchCalls.length = 0
  singleArchiveCalls.length = 0
})

const { SquadAgentThreads } = await import('./SquadAgentThreads')
const { getAgentHeaderTitleParts } = await import('./AgentViewModal')

function fixtureLocation() {
  const params = new URLSearchParams(initialSearchParams)
  if (!includeIdleAgents) params.set('activeAgentsOnly', '1')
  return `/squads/squad-1?${params}`
}

const now = new Date('2026-01-01T00:00:00Z')

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    agentTypeId: 'manager',
    status: 'idle',
    metadata: { name: 'Pearl' },
    createdAt: now,
    ...overrides,
  } as Agent
}

function makeQueryClient(childrenByAgentId: Record<string, Agent[]> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  for (const [agentId, children] of Object.entries(childrenByAgentId)) {
    queryClient.setQueryData(['agents', 'children', agentId], children)
  }
  return queryClient
}

function renderThreads(
  agents: Agent[],
  recentlyTerminatedAgents: Agent[] = [],
  isLoading = false,
  recentlyTerminatedTotalCount?: number,
  childrenByAgentId: Record<string, Agent[]> = {},
  extraProps: Partial<ComponentProps<typeof SquadAgentThreads>> = {}
) {
  const queryClient = makeQueryClient(childrenByAgentId)

  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[fixtureLocation()]}>
      <SquadAgentThreadsApiProvider api={threadsApi}>
        <PermissionsProvider usePermissions={usePermissionsMock}>
          <QueryClientProvider client={queryClient}>
            <SquadAgentThreads
              agents={agents}
              recentlyTerminatedAgents={recentlyTerminatedAgents}
              recentlyTerminatedTotalCount={recentlyTerminatedTotalCount}
              squadId="squad-1"
              isLoading={isLoading}
              dependencies={threadsDependencies}
              {...extraProps}
            />
          </QueryClientProvider>
        </PermissionsProvider>
      </SquadAgentThreadsApiProvider>
    </MemoryRouter>
  )
}

async function installDom() {
  return acquireDomHarness({
    url: 'http://localhost/squads/squad-1',
    configureWindow(window) {
      Object.assign(window, { SyntaxError })
    },
  })
}

function renderThreadsDom(
  root: Root,
  queryClient: QueryClient,
  agents: Agent[],
  recentlyTerminatedAgents: Agent[] = [],
  extraProps: Partial<ComponentProps<typeof SquadAgentThreads>> = {}
) {
  root.render(
    <MemoryRouter initialEntries={[fixtureLocation()]}>
      <SquadAgentThreadsApiProvider api={threadsApi}>
        <PermissionsProvider usePermissions={usePermissionsMock}>
          <QueryClientProvider client={queryClient}>
            <SquadAgentThreads
              agents={agents}
              recentlyTerminatedAgents={recentlyTerminatedAgents}
              squadId="squad-1"
              dependencies={threadsDependencies}
              {...extraProps}
            />
          </QueryClientProvider>
        </PermissionsProvider>
      </SquadAgentThreadsApiProvider>
    </MemoryRouter>
  )
}

function changeSearchInput(_window: Window, input: HTMLInputElement, value: string) {
  fireEvent.input(input, { target: { value } })
}

describe('SquadAgentThreads layout', () => {
  test('fills the available horizontal space in flex parents', () => {
    const html = renderThreads([agent()])

    expect(html).toContain('flex flex-col md:flex-row gap-3 md:gap-4 h-full w-full min-w-0')
  })

  test('the loading skeleton fills the available width and announces itself', () => {
    // #1413 replaced the centred spinner with a two-pane skeleton (roster +
    // conversation). The layout contract this test guards is unchanged --
    // the loading state must still occupy the full available width -- but it
    // is now carried by the skeleton's own root rather than a spinner div.
    const html = renderThreads([], [], true)

    expect(html).toContain('flex h-full w-full min-w-0')
    // Announced, not merely drawn: a purely visual skeleton would leave a
    // screen reader with silence where the spinner's text used to be.
    expect(html).toContain('aria-label="Loading agent conversations"')
    expect(html).toContain('aria-busy="true"')
  })

  test('idle consultants retain a status dot in the chat picker', () => {
    const html = renderThreads([
      agent({ id: 'manager-1', agentTypeId: 'manager', status: 'active' }),
      agent({ id: 'consultant-1', agentTypeId: 'consultant', status: 'idle' }),
    ])
    expect(html.match(/aria-label="Agent activity: Idle"/g)).toHaveLength(1)
  })

  test('labels roster and selected-header activity with working/idle semantics', () => {
    const html = renderThreads([
      agent({ id: 'manager-1', agentTypeId: 'manager', status: 'active' }),
      agent({ id: 'engineer-1', agentTypeId: 'engineer', status: 'idle' }),
    ])

    expect(html.match(/aria-label="Agent activity: Working"/g)).toHaveLength(2)
    expect(html.match(/aria-label="Agent activity: Idle"/g)).toHaveLength(1)
  })
})

describe('SquadAgentThreads mobile agent picker layout', () => {
  test('groups same-type agents inside a single collapsible section', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
      agent({ id: 'e2', agentTypeId: 'engineer', metadata: { name: 'Fix API' } }),
    ])

    const engineerSectionStart = html.indexOf('data-agent-type-section="engineer"')
    const firstEngineer = html.indexOf('Build UI', engineerSectionStart)
    const secondEngineer = html.indexOf('Fix API', engineerSectionStart)

    expect(engineerSectionStart).toBeGreaterThan(-1)
    expect(firstEngineer).toBeGreaterThan(engineerSectionStart)
    expect(secondEngineer).toBeGreaterThan(firstEngineer)
    expect(html).toContain('rounded-xl overflow-hidden flex-col min-h-0')
    expect(html).toContain('overflow-y-auto overflow-x-hidden')
  })

  test('keeps same-type active agents ordered by latest human message instead of latest agent-authored message', () => {
    const html = renderThreads([
      agent({
        id: 'older-prompted-active',
        agentTypeId: 'engineer',
        status: 'active',
        metadata: { name: 'Older Prompted Active' },
        updatedAt: new Date('2026-01-01T10:30:00Z'),
        lastMessageAt: new Date('2026-01-01T10:30:00Z'),
        lastHumanMessageAt: new Date('2026-01-01T10:00:00Z'),
      } as Partial<Agent>),
      agent({
        id: 'newer-prompted-active',
        agentTypeId: 'engineer',
        status: 'active',
        metadata: { name: 'Newer Prompted Active' },
        updatedAt: new Date('2026-01-01T10:10:00Z'),
        lastMessageAt: new Date('2026-01-01T10:10:00Z'),
        lastHumanMessageAt: new Date('2026-01-01T10:05:00Z'),
      } as Partial<Agent>),
    ])

    const newerActive = html.indexOf('Newer Prompted Active')
    const olderActive = html.indexOf('Older Prompted Active')

    expect(newerActive).toBeGreaterThan(-1)
    expect(olderActive).toBeGreaterThan(newerActive)
  })

  test('orders same-type agents deterministically when activity timestamps tie', () => {
    const html = renderThreads([
      agent({ id: 'z-agent', agentTypeId: 'engineer', metadata: { name: 'Zeta' }, updatedAt: now }),
      agent({ id: 'a-agent', agentTypeId: 'engineer', metadata: { name: 'Alpha' }, updatedAt: now }),
    ])

    const alpha = html.indexOf('Alpha')
    const zeta = html.indexOf('Zeta')

    expect(alpha).toBeGreaterThan(-1)
    expect(zeta).toBeGreaterThan(alpha)
  })
})

describe('SquadAgentThreads completed agents', () => {
  test('files dormant agents under Recently Completed instead of a separate section', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager' }),
      agent({ id: 'sleeping', agentTypeId: 'engineer', status: 'dormant', metadata: { name: 'Sleeping Agent' } }),
    ])

    expect(html).toContain('data-agent-type-section="recently-completed"')
    expect(html).toContain('Recently Completed (1)')
    expect(html).not.toContain('data-agent-type-section="dormant"')
    // The dormant/terminated distinction is never surfaced to the reader.
    expect(html).not.toContain('Dormant')
    expect(html).not.toContain('Terminated')
  })

  test('counts dormant and terminated agents together, using the server total for terminated', () => {
    const html = renderThreads(
      [
        agent({ id: 'm1', agentTypeId: 'manager' }),
        agent({ id: 'd1', agentTypeId: 'engineer', status: 'dormant', metadata: { name: 'Dozing One' } }),
        agent({ id: 'd2', agentTypeId: 'engineer', status: 'dormant', metadata: { name: 'Dozing Two' } }),
      ],
      [agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Old Engineer' }, terminatedAt: now })],
      false,
      57
    )

    expect(html).toContain('Recently Completed (59)')
  })

  test('orders the merged list by completion time, newest first', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const older = new Date(Date.now() - 60 * 60_000).toISOString()
      const newer = new Date(Date.now() - 60_000).toISOString()
      await dom.act(async () => {
        renderThreadsDom(
          root,
          makeQueryClient(),
          [
            agent({ id: 'm1', agentTypeId: 'manager' }),
            agent({
              id: 'sleeping',
              agentTypeId: 'engineer',
              status: 'dormant',
              metadata: { name: 'Recent Dormant' },
              dormantAt: newer,
            }),
          ],
          [agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Older Done' }, terminatedAt: older })]
        )
      })

      const sectionToggle = Array.from(window.document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Recently Completed')
      ) as HTMLButtonElement
      await dom.act(async () => sectionToggle.click())

      const rows = Array.from(
        window.document.querySelectorAll('[data-agent-type-section="recently-completed"] button[title]')
      ).map((node) => node.getAttribute('title'))
      expect(rows[0]).toContain('sleeping')
      expect(rows[1]).toContain('old1')

      await dom.act(async () => root.unmount())
    } finally {
      await dom.cleanup()
    }
  })

  test('expands the section and selects a dormant conversation', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => {
        renderThreadsDom(root, makeQueryClient(), [
          agent({ id: 'm1', agentTypeId: 'manager' }),
          agent({ id: 'sleeping', agentTypeId: 'engineer', status: 'dormant', metadata: { name: 'Sleeping Agent' } }),
        ])
      })

      const sectionToggle = Array.from(window.document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Recently Completed (1)')
      ) as HTMLButtonElement
      expect(sectionToggle.getAttribute('aria-expanded')).toBe('false')
      await dom.act(async () => sectionToggle.click())
      expect(sectionToggle.getAttribute('aria-expanded')).toBe('true')

      const dormantButton = window.document.querySelector(
        'button[title="Sleeping Agent · engineer · sleeping"]'
      ) as HTMLButtonElement
      expect(dormantButton).toBeTruthy()
      expect(dormantButton.tagName).toBe('BUTTON')
      await dom.act(async () => dormantButton.click())
      expect(dormantButton.className).toContain('is-selected')

      await dom.act(async () => root.unmount())
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads terminated agent collapse', () => {
  test('uses total count for recently completed agents when only the first page is loaded', () => {
    const loadedAgents = Array.from({ length: 20 }, (_, index) =>
      agent({
        id: `old${index}`,
        agentTypeId: 'engineer',
        metadata: { name: `Old Engineer ${index}` },
        terminatedAt: now,
      })
    )

    const html = renderThreads([agent({ id: 'm1', agentTypeId: 'manager' })], loadedAgents, false, 57)

    expect(html).toContain('Recently Completed (57)')
    expect(html).not.toContain('Recently Completed (20)')
  })

  test('collapses recently completed agents by default', () => {
    const html = renderThreads(
      [agent({ id: 'm1', agentTypeId: 'manager' })],
      [agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Old Engineer' }, terminatedAt: now })]
    )

    expect(html).toContain('Recently Completed (1)')
    expect(html).not.toContain('Old Engineer · engineer · old1')
    expect(html).toContain('data-agent-type-section="recently-completed"')
  })
})

describe('SquadAgentThreads header', () => {
  test('uses Manager (name), including when the manager has a purpose', () => {
    for (const purpose of [undefined, 'Review PRs']) {
      expect(getAgentHeaderTitleParts(agent({ metadata: { name: 'Pearl', purpose } }))).toEqual({
        title: 'Manager',
        suffix: '(Pearl)',
      })
    }
    expect(renderThreads([agent()])).toContain('Manager <span class="font-normal text-secondary">(Pearl)</span>')
  })

  test('shows purpose with title-cased type before the generated name', () => {
    expect(
      getAgentHeaderTitleParts(
        agent({ agentTypeId: 'code-reviewer', metadata: { name: 'Pearl', purpose: 'Review PRs' } })
      )
    ).toEqual({
      title: 'Review PRs',
      suffix: '(Code Reviewer • Pearl)',
    })
  })

  test('shows title-cased type followed by name when purpose is absent or blank', () => {
    for (const purpose of [undefined, '  ']) {
      expect(
        getAgentHeaderTitleParts(agent({ agentTypeId: 'engineer', metadata: { name: 'Pearl', purpose } }))
      ).toEqual({
        title: 'Engineer',
        suffix: '(Pearl)',
      })
    }
  })
})

describe('SquadAgentThreads mobile agent picker modal', () => {
  test('hides the sidebar on mobile and shows a header dropdown trigger', () => {
    const html = renderThreads([agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })])

    expect(html).toContain('hidden md:flex md:w-64')
    expect(html).toContain('aria-label="Choose agent"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('hidden md:flex items-baseline')
  })

  test('shows the selected agent purpose with name and type metadata in the mobile header trigger', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [
          agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Pearl', purpose: 'Review PRs' } }),
        ])
      })

      const trigger = window.document.querySelector('[aria-label="Choose agent"]') as HTMLButtonElement
      expect(trigger).toBeTruthy()
      expect(trigger.textContent).toContain('Review PRs')
      expect(trigger.textContent).toContain('(Engineer • Pearl)')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('does not render the picker modal before the trigger is tapped', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [agent({ id: 'm1', agentTypeId: 'manager' })])
      })

      expect(window.document.querySelector('[role="dialog"]')).toBeNull()

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('opens the picker modal on tapping the mobile trigger and closes on selection', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const agents = [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
      ]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, agents)
      })

      const trigger = window.document.querySelector('[aria-label="Choose agent"]') as HTMLButtonElement
      expect(trigger).toBeTruthy()

      await dom.act(async () => {
        trigger.click()
      })

      expect(window.document.querySelector('[role="dialog"]')).toBeTruthy()
      expect(window.document.body.textContent).toContain('Chats')
      expect(window.document.body.textContent).toContain('Pearl')
      expect(window.document.body.textContent).toContain('Build UI')

      const engineerRow = window.document.querySelector('[title*="Build UI"]') as HTMLElement
      expect(engineerRow).toBeTruthy()

      await dom.act(async () => {
        engineerRow.click()
      })

      expect(window.document.querySelector('[role="dialog"]')).toBeNull()

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('search filters the mobile picker list', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const agents = [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
        agent({ id: 'e2', agentTypeId: 'engineer', metadata: { name: 'Fix API' } }),
      ]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, agents)
      })

      const trigger = window.document.querySelector('[aria-label="Choose agent"]') as HTMLButtonElement
      await dom.act(async () => {
        trigger.click()
      })

      const search = window.document.querySelector('[role="dialog"] input[type="search"]') as HTMLInputElement
      await dom.act(async () => {
        const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        valueSetter?.call(search, 'Build')
        search.dispatchEvent(new window.InputEvent('input', { bubbles: true, data: 'Build', inputType: 'insertText' }))
        search.dispatchEvent(new window.Event('change', { bubbles: true }))
      })

      expect(window.document.body.textContent).toContain('Build UI')
      expect(window.document.body.textContent).not.toContain('Fix API')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('themes the mobile picker search text and placeholder for dark mode', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [agent({ id: 'm1', agentTypeId: 'manager' })])
      })

      const trigger = window.document.querySelector('[aria-label="Choose agent"]') as HTMLButtonElement
      await dom.act(async () => {
        trigger.click()
      })

      const search = window.document.querySelector('[role="dialog"] input[type="search"]') as HTMLInputElement
      expect(search).toBeTruthy()
      expect(search.className).toContain('text-primary')
      expect(search.className).toContain('placeholder:text-placeholder')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads recent consultant chats', () => {
  test('shows recent consultant chats expanded by default', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager' }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius', purpose: 'Plan auth' } }),
      agent({ id: 'k2', agentTypeId: 'consultant', metadata: { name: 'Vera' } }),
    ])
    expect(html).toContain('Recent chats')
    expect(html).toContain('Cassius')
    expect(html).toContain('m1')
  })

  test('keeps all recent consultant rows visible alongside the selected chat', () => {
    initialSearchParams = 'agent=k1'
    // Consultant chats stay expanded even alongside another category.
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius', purpose: 'Plan auth' } }),
      agent({ id: 'k2', agentTypeId: 'consultant', metadata: { name: 'Vera' } }),
    ])

    // Recent conversations stay visible by default.
    expect(html).toContain('Recent chats')
    // The selected conversation is included.
    expect(html).toContain('Cassius')
    // Other recent conversations remain available.
    expect(html).toContain('Vera')
  })
})

async function toggleManagingChats(dom: Awaited<ReturnType<typeof installDom>>) {
  const options = dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Chat options"]')!
  await dom.act(async () => options.click())
  const manage = Array.from(dom.window.document.querySelectorAll('button')).find((button) =>
    /^(Manage chats|Done managing chats)$/.test(button.textContent?.trim() ?? '')
  )!
  await dom.act(async () => manage.click())
}

describe('SquadAgentThreads consultant terminate-all', () => {
  test('does not render the terminate-all control for non-consultant sections', () => {
    const html = renderThreads([
      agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
      agent({ id: 'e2', agentTypeId: 'engineer', metadata: { name: 'Fix API' } }),
    ])

    expect(html).not.toContain('data-testid="terminate-all-consultant"')
  })

  test('keeps archive controls hidden until managing chats even when consultants are terminatable', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius' }, status: 'idle' }),
    ])

    expect(html).not.toContain('data-testid="terminate-all-consultant"')
    expect(html).not.toContain('aria-label="Archive conversation"')
    expect(html.toLowerCase()).not.toContain('make dormant')
  })

  test('hides terminate-all when no consultant is terminatable', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius' }, status: 'active' }),
    ])

    expect(html).not.toContain('data-testid="terminate-all-consultant"')
  })

  test('hides terminate-all without agent termination permission', () => {
    deniedPermissions = new Set(['agents:terminate'])

    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius' }, status: 'idle' }),
    ])

    expect(html).not.toContain('data-testid="terminate-all-consultant"')
  })

  test('requires a second click before bulk terminating consultants', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [
          agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
          agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius' }, status: 'idle' }),
        ])
      })

      await toggleManagingChats(dom)
      const terminateAllButton = window.document.querySelector(
        '[data-testid="terminate-all-consultant"]'
      ) as HTMLButtonElement
      expect(terminateAllButton).toBeTruthy()
      // Icon-only: the affordance is the tooltip, not a text label.
      expect(terminateAllButton.getAttribute('title')).toBe('Archive all')
      expect(terminateAllButton.textContent?.trim()).toBe('')
      expect(terminateAllButton.querySelector('svg')).toBeTruthy()

      await dom.act(async () => {
        terminateAllButton.click()
      })

      expect(apiFetchCalls.filter(([path]) => path.endsWith('/agents/terminate-bulk'))).toEqual([])
      expect(terminateAllButton.getAttribute('title')).toBe('Click again to confirm')

      await dom.act(async () => {
        terminateAllButton.click()
      })

      expect(apiFetchCalls.filter(([path]) => path.endsWith('/agents/terminate-bulk'))).toEqual([
        [
          '/squads/squad-1/agents/terminate-bulk',
          { method: 'POST', body: JSON.stringify({ agentTypeId: 'consultant' }) },
        ],
      ])

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads search behavior', () => {
  test('searches consultant chats by name while showing their purpose', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const agents = [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius', purpose: 'Plan auth' } }),
        agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
      ]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, agents)
      })

      expect(window.document.body.textContent).toContain('Plan auth')

      const searchInput = window.document.querySelector('input[type="search"]') as HTMLInputElement
      expect(searchInput).toBeTruthy()
      await dom.act(async () => {
        changeSearchInput(window, searchInput, 'Cassius')
      })

      expect(window.document.body.textContent).toContain('Plan auth')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('auto-expands recently completed section and shows matching terminated agents on search', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const agents = [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })]
      const terminated = [
        agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Old Engineer' }, terminatedAt: now }),
      ]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, agents, terminated)
      })

      expect(window.document.body.textContent).not.toContain('Old Engineer')

      const searchInput = window.document.querySelector('input[type="search"]') as HTMLInputElement
      expect(searchInput).toBeTruthy()
      await dom.act(async () => {
        changeSearchInput(window, searchInput, 'Old')
      })

      expect(window.document.body.textContent).toContain('Old Engineer')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('hides terminated agents that do not match the search query', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const agents = [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })]
      const terminated = [
        agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Alpha Agent' }, terminatedAt: now }),
        agent({ id: 'old2', agentTypeId: 'engineer', metadata: { name: 'Beta Agent' }, terminatedAt: now }),
      ]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, agents, terminated)
      })

      const searchInput = window.document.querySelector('input[type="search"]') as HTMLInputElement
      expect(searchInput).toBeTruthy()
      await dom.act(async () => {
        changeSearchInput(window, searchInput, 'Alpha')
      })

      expect(window.document.body.textContent).toContain('Alpha Agent')
      expect(window.document.body.textContent).not.toContain('Beta Agent')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads new consultant chat', () => {
  test('places one primary New chat action in the header before search and the pinned manager', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Build UI' } }),
    ])

    const manager = html.indexOf('Pearl')
    const newConsultant = html.indexOf('New consultant chat')
    const search = html.indexOf('Search conversations')

    expect(manager).toBeGreaterThan(-1)
    expect(newConsultant).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(newConsultant)
    expect(manager).toBeGreaterThan(search)
    expect(html).toContain('hidden md:flex')
    expect(html).toContain('bg-accent px-2 text-xs font-medium text-on-accent')
  })

  test('shows a clean composing header and keeps it visible until the created consultant is loaded', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const initialAgents = [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })]

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, initialAgents)
      })

      const startButton = Array.from(window.document.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'New consultant chat'
      ) as HTMLButtonElement
      expect(startButton).toBeTruthy()

      await dom.act(async () => {
        startButton.click()
      })

      expect(window.document.body.textContent).toContain('New consultant')
      expect(window.document.body.textContent).not.toContain('(manager)')
      expect(window.document.querySelector('[aria-label="Agent view"]')).toBeNull()
      expect(window.document.querySelector('[data-header-layout="controls"]')).toBeTruthy()

      const createButton = window.document.querySelector(
        '[data-testid="consultant-chat-composer"] button'
      ) as HTMLButtonElement
      await dom.act(async () => {
        createButton.click()
      })

      expect(window.document.body.textContent).toContain('New consultant')
      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeTruthy()

      // The consultant now appears in the list, but until its messages are cached the composer must
      // stay mounted (so the just-sent message doesn't disappear/reappear).
      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [
          ...initialAgents,
          agent({ id: 'consultant-1', agentTypeId: 'consultant', metadata: { name: 'Cassius' } }),
        ])
      })
      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeTruthy()

      // Once the new consultant's message history is cached, swap to the real conversation.
      await dom.act(async () => {
        queryClient.setQueryData(queryKeys.agents.messagesInfinite('consultant-1'), {
          pages: [{ messages: [], pagination: { hasMore: false } }],
          pageParams: [undefined],
        })
      })

      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeNull()
      expect(window.document.body.textContent).toContain('Cassius')
      expect(window.document.body.textContent).toContain('(Cassius)')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('deselects the previously viewed agent row when composing a new consultant chat', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })])
      })

      const row = () =>
        window.document.querySelector(
          '[data-agent-type-section="manager"] [title="Pearl · manager · m1"]'
        ) as HTMLElement | null

      // The auto-selected manager row is highlighted.
      expect(row()?.getAttribute('aria-pressed')).toBe('true')

      const startButton = Array.from(window.document.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'New consultant chat'
      ) as HTMLButtonElement
      await dom.act(async () => {
        startButton.click()
      })

      // Composing a new consultant chat deselects the last-viewed row.
      expect(row()?.getAttribute('aria-pressed')).toBe('false')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })

  test('stays in the new consultant chat view on refresh via the ?newConsultant=1 deep link', async () => {
    // Simulate landing/refreshing on the deep link.
    initialSearchParams = 'newConsultant=1'
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })])
      })

      // The composer is shown on initial mount — no click needed — and no agent row is selected.
      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeTruthy()
      expect(window.document.body.textContent).toContain('New consultant')
      const row = window.document.querySelector(
        '[data-agent-type-section="manager"] [title="Pearl · manager · m1"]'
      ) as HTMLElement | null
      expect(row?.getAttribute('aria-pressed')).toBe('false')

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads subagent visibility', () => {
  test('renders a Subagents tab for agents with children', () => {
    const parent = agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })
    const child = agent({ id: 'sa1', agentTypeId: 'subagent', metadata: { name: 'Child agent' } })

    const html = renderThreads([parent], [], false, undefined, { m1: [child] })

    expect(html).toContain('Subagents')
  })

  test('shows the active subagent count in the Subagents tab', () => {
    const parent = agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })
    const activeChild = agent({
      id: 'sa1',
      agentTypeId: 'subagent',
      status: 'active',
      metadata: { name: 'Child agent' },
    })
    const idleChild = agent({ id: 'sa2', agentTypeId: 'subagent', status: 'idle', metadata: { name: 'Idle child' } })

    const html = renderThreads([parent], [], false, undefined, { m1: [activeChild, idleChild] })

    expect(html).toContain('aria-label="Subagents, 1 active subagent"')
  })

  test('does not render a Subagents tab for agents without children', () => {
    const html = renderThreads([agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })])

    expect(html).not.toContain('Subagents')
  })

  test('renders exactly the backend-provided agents without client-side subagent filtering', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
      agent({
        id: 'sa1',
        agentTypeId: 'subagent',
        metadata: { name: 'Child agent' },
        parentAgentId: 'm1',
      } as Partial<Agent>),
    ])

    expect(html).toContain('Pearl')
    expect(html).toContain('Child agent')
    expect(html).toContain('sa1')
  })
})

describe('SquadAgentThreads section ordering', () => {
  test('orders the sidebar: New chat, search, manager, recent chats, workers, completed', () => {
    const html = renderThreads(
      [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius', purpose: 'Plan auth' } }),
        agent({ id: 'a1', agentTypeId: 'architect', metadata: { name: 'Avi' } }),
      ],
      [agent({ id: 'old1', agentTypeId: 'engineer', metadata: { name: 'Old' }, terminatedAt: now })]
    )

    const managerSection = html.indexOf('data-agent-type-section="manager"')
    const consultantChat = html.indexOf('New consultant chat')
    const search = html.indexOf('Search conversations')
    const consultantSection = html.indexOf('Recent chats')
    const architectSection = html.indexOf('data-agent-type-section="architect"')
    const recentlyCompleted = html.indexOf('Recently Completed')

    expect(managerSection).toBeGreaterThan(-1)
    expect(consultantChat).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(consultantChat)
    expect(managerSection).toBeGreaterThan(search)
    expect(consultantSection).toBeGreaterThan(managerSection)
    expect(architectSection).toBeGreaterThan(consultantSection)
    expect(recentlyCompleted).toBeGreaterThan(architectSection)
  })

  test('keeps non-consultant, non-manager sections in alphabetical order after the consultant section', () => {
    const html = renderThreads([
      agent({ id: 'm1', agentTypeId: 'manager' }),
      agent({ id: 'k1', agentTypeId: 'consultant', metadata: { name: 'Cassius' } }),
      agent({ id: 'r1', agentTypeId: 'reviewer', metadata: { name: 'Rae' } }),
      agent({ id: 'a1', agentTypeId: 'architect', metadata: { name: 'Avi' } }),
    ])

    const consultantSection = html.indexOf('Recent chats')
    const architect = html.indexOf('data-agent-type-section="architect"')
    const reviewer = html.indexOf('data-agent-type-section="reviewer"')

    expect(architect).toBeGreaterThan(consultantSection)
    expect(reviewer).toBeGreaterThan(architect)
  })
})

describe('SquadAgentThreads agent-specific modes', () => {
  test('agentTypeFilter restricts the view to that agent type', () => {
    const html = renderThreads(
      [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } }),
      ],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'consultant' }
    )
    expect(html).toContain('Sage')
    expect(html).not.toContain('Pearl')
  })

  test('lockedAgentId selects that agent regardless of the URL', () => {
    initialSearchParams = 'agent=c1'
    const html = renderThreads(
      [
        agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } }),
        agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } }),
      ],
      [],
      false,
      undefined,
      {},
      { lockedAgentId: 'm1', layout: 'page' }
    )
    // Locked wins over ?agent=c1 → the manager (Pearl) is shown, not the consultant.
    expect(html).toContain('Pearl')
    expect(html).not.toContain('Sage')
  })

  test('defaultCompose shows the compose view when no agent is selected', () => {
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant' })],
      [],
      false,
      undefined,
      {},
      { defaultCompose: true }
    )
    expect(html).toContain('consultant-chat-composer')
  })

  test('defaultCompose yields to an explicitly selected agent', () => {
    initialSearchParams = 'agent=c1'
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } })],
      [],
      false,
      undefined,
      {},
      { defaultCompose: true }
    )
    expect(html).not.toContain('consultant-chat-composer')
    expect(html).toContain('Agent chat body')
  })
})

describe('SquadAgentThreads page layout', () => {
  test('page layout drops the desktop sidebar (no left list)', () => {
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } })],
      [],
      false,
      undefined,
      {},
      { layout: 'page', agentTypeFilter: 'consultant' }
    )
    expect(html).not.toContain('md:w-64')
  })

  test('page layout shows the picker trigger at all widths (no static desktop title)', () => {
    initialSearchParams = 'agent=c1'
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } })],
      [],
      false,
      undefined,
      {},
      { layout: 'page', agentTypeFilter: 'consultant' }
    )
    expect(html).toContain('data-testid="agent-picker-trigger"')
    expect(html).not.toContain('data-testid="agent-picker-static"')
  })

  test('locked page renders a static title (no picker trigger)', () => {
    const html = renderThreads(
      [agent({ id: 'm1', agentTypeId: 'manager', metadata: { name: 'Pearl' } })],
      [],
      false,
      undefined,
      {},
      { layout: 'page', lockedAgentId: 'm1' }
    )
    expect(html).toContain('data-testid="agent-picker-static"')
    expect(html).not.toContain('data-testid="agent-picker-trigger"')
    expect(html).not.toContain('aria-label="Choose agent"')
  })

  test('page layout renders the headerLeading slot', () => {
    initialSearchParams = 'agent=c1'
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } })],
      [],
      false,
      undefined,
      {},
      { layout: 'page', agentTypeFilter: 'consultant', headerLeading: <span>Back to squad</span> }
    )
    expect(html).toContain('Back to squad')
  })
})

describe('SquadAgentThreads new-consultant affordance rule', () => {
  test('shows New consultant when filtered to consultants', () => {
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant' })],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'consultant' }
    )
    expect(html).toContain('New consultant chat')
  })

  test('hides New consultant when filtered to a non-consultant type', () => {
    const html = renderThreads(
      [agent({ id: 'm1', agentTypeId: 'manager' })],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'manager' }
    )
    expect(html).not.toContain('New consultant chat')
  })

  test('hides New consultant when locked to an agent', () => {
    const html = renderThreads(
      [agent({ id: 'm1', agentTypeId: 'manager' })],
      [],
      false,
      undefined,
      {},
      { lockedAgentId: 'm1' }
    )
    expect(html).not.toContain('New consultant chat')
  })
})

describe('SquadAgentThreads compose-mode picker', () => {
  test('the New consultant header offers a picker to switch to an existing agent', () => {
    initialSearchParams = 'newConsultant=1'
    const html = renderThreads(
      [agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } })],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'consultant' }
    )
    expect(html).toContain('New consultant')
    expect(html).toContain('data-testid="agent-picker-trigger"')
  })

  test('a filtered single category starts expanded', () => {
    const html = renderThreads(
      [
        agent({ id: 'c1', agentTypeId: 'consultant', metadata: { name: 'Sage' } }),
        agent({ id: 'c2', agentTypeId: 'consultant', metadata: { name: 'Cassius' } }),
      ],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'consultant' }
    )
    // Consultant recents start expanded even without workers.
    expect(html).toContain('Sage')
    expect(html).toContain('Cassius')
    expect(html).toContain('aria-expanded="true"')
  })

  test('the New consultant header has no picker when there is nothing to switch to', () => {
    initialSearchParams = 'newConsultant=1'
    const html = renderThreads(
      [agent({ id: 'm1', agentTypeId: 'manager' })],
      [],
      false,
      undefined,
      {},
      { agentTypeFilter: 'consultant' }
    )
    expect(html).toContain('New consultant')
    expect(html).not.toContain('data-testid="agent-picker-trigger"')
  })
})

describe('SquadAgentThreads new-consultant handoff', () => {
  test('keeps the compose view (no empty flash) until the new consultant + messages are ready', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()

      await dom.act(async () => {
        renderThreadsDom(root, queryClient, [agent({ id: 'mgr', agentTypeId: 'manager' })], [], {
          layout: 'page',
          agentTypeFilter: 'consultant',
          defaultCompose: true,
        })
      })

      // Compose view is shown initially.
      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeTruthy()

      // Create the consultant — its id lands in the URL, but it's not in the list and has no cached
      // messages yet, so the view must stay on the composer (no "choose an agent" flash).
      const createBtn = Array.from(window.document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Mock create consultant'
      ) as HTMLButtonElement
      await dom.act(async () => {
        fireEvent.click(createBtn)
      })

      expect(window.document.body.textContent).not.toContain('Select an agent')
      expect(window.document.querySelector('[data-testid="consultant-chat-composer"]')).toBeTruthy()

      await dom.act(async () => {
        root.unmount()
      })
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads active filter', () => {
  test('defaults to showing idle workers without a filter URL parameter', () => {
    const html = renderThreads([agent(), agent({ id: 'idle', agentTypeId: 'engineer' })])
    expect(html).toContain('aria-label="Active workers only" aria-pressed="false"')
    expect(html).toContain('data-agent-type-section="engineer"')
  })

  test('keeps a selected idle worker in a collapsed category and removes it after navigating away', async () => {
    includeIdleAgents = false
    initialSearchParams = 'agent=idle-worker'
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        renderThreadsDom(root, makeQueryClient(), [
          agent(),
          agent({ id: 'idle-worker', agentTypeId: 'engineer', metadata: { name: 'Selected worker' } }),
          agent({ id: 'other-idle', agentTypeId: 'engineer', metadata: { name: 'Other worker' } }),
        ])
      )
      const document = dom.window.document
      await dom.act(async () =>
        (document.querySelector('[aria-label="Collapse Engineer"]') as HTMLButtonElement).click()
      )
      expect(document.querySelector('[title="Selected worker · engineer · idle-worker"]')).not.toBeNull()
      expect(document.querySelector('[title="Other worker · engineer · other-idle"]')).toBeNull()
      await dom.act(async () =>
        (document.querySelector('[data-agent-type-section="manager"] button') as HTMLButtonElement).click()
      )
      expect(document.querySelector('[data-agent-type-section="engineer"]')).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  for (const status of ['idle', 'dormant', 'terminated'] as const) {
    test(`retains a selected ${status} agent and its category in the mobile picker with the filter on`, async () => {
      includeIdleAgents = false
      initialSearchParams = 'agent=selected-'
      const dom = await installDom()
      try {
        const { root } = dom.createRoot()
        const worker = agent({
          id: 'selected-worker',
          agentTypeId: 'engineer',
          status,
          metadata: { name: 'Selected worker' },
        })
        const other = agent({ id: 'other-worker', agentTypeId: 'reviewer', status, metadata: { name: 'Other worker' } })
        await dom.act(async () =>
          renderThreadsDom(
            root,
            makeQueryClient(),
            status === 'terminated' ? [agent()] : [agent(), worker, other],
            status === 'terminated' ? [worker, other] : []
          )
        )
        await dom.act(async () =>
          (dom.window.document.querySelector('[data-testid="agent-picker-trigger"]') as HTMLButtonElement).click()
        )
        const dialog = dom.window.document.querySelector('[role="dialog"]')!
        expect(dialog.querySelector('[aria-label="Active workers only"]')?.getAttribute('aria-pressed')).toBe('true')
        const category = status === 'idle' ? 'engineer' : 'recently-completed'
        expect(
          dialog.querySelector(
            `[data-agent-type-section="${category}"] [title="Selected worker · engineer · selected-worker"]`
          )
        ).not.toBeNull()
        expect(dialog.querySelector('[title="Other worker · reviewer · other-worker"]')).toBeNull()
        expect(dialog.textContent).not.toContain('No active agents')
      } finally {
        await dom.cleanup()
      }
    })
  }

  test('enabling active workers only keeps pinned controls above the empty state', () => {
    includeIdleAgents = false
    const html = renderThreads(
      [
        agent(),
        agent({ id: 'e1', agentTypeId: 'engineer', status: 'idle' }),
        agent({ id: 'c1', agentTypeId: 'consultant', status: 'dormant' }),
        agent({ id: 'd1', agentTypeId: 'reviewer', status: 'dormant' }),
      ],
      [agent({ id: 't1', agentTypeId: 'engineer', status: 'terminated' })]
    )

    expect(html).toContain('aria-label="Active workers only" aria-pressed="true"')
    expect(html).toContain('No active agents')
    expect(html).not.toContain('data-agent-type-section="engineer"')
    expect(html).not.toContain('data-agent-type-section="consultant"')
    expect(html).not.toContain('data-agent-type-section="recently-completed"')
    const manager = html.indexOf('data-agent-type-section="manager"')
    const compose = html.indexOf('title="New consultant chat"')
    const search = html.indexOf('Search conversations')
    expect(manager).toBeGreaterThan(-1)
    expect(compose).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(compose)
    expect(manager).toBeGreaterThan(search)
    expect(html.indexOf('No active agents')).toBeGreaterThan(search)
  })

  test('filters idle agents before grouping while retaining waiting, compacting, and resetting agents', () => {
    includeIdleAgents = false
    const html = renderThreads([
      agent(),
      agent({ id: 'e1', agentTypeId: 'engineer', status: 'active', metadata: { name: 'Working Engineer' } }),
      agent({ id: 'e2', agentTypeId: 'engineer', status: 'idle', metadata: { name: 'Idle Engineer' } }),
      agent({ id: 'r1', agentTypeId: 'reviewer', status: 'compacting', metadata: { name: 'Compacting Reviewer' } }),
      agent({ id: 'r2', agentTypeId: 'reviewer', status: 'resetting', metadata: { name: 'Resetting Reviewer' } }),
      agent({ id: 'r3', agentTypeId: 'reviewer', status: 'waiting-input', metadata: { name: 'Waiting Reviewer' } }),
    ])
    expect(html).toContain('Engineer</span><span class="ml-auto">1</span>')
    expect(html).toContain('Working Engineer')
    expect(html).not.toContain('Idle Engineer')
    expect(html).toContain('Reviewer</span><span class="ml-auto">3</span>')
    expect(html).toContain('Compacting Reviewer')
    expect(html).toContain('Resetting Reviewer')
    expect(html).toContain('Waiting Reviewer')
    expect(html).not.toContain('No active agents')
  })

  test('toggles the roster, combines with search, and preserves an idle deep-linked conversation', async () => {
    includeIdleAgents = false
    initialSearchParams = 'agent=e2'
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => {
        renderThreadsDom(root, makeQueryClient(), [
          agent(),
          agent({ id: 'e1', agentTypeId: 'engineer', status: 'active', metadata: { name: 'Working Engineer' } }),
          agent({ id: 'e2', agentTypeId: 'engineer', status: 'idle', metadata: { name: 'Idle Engineer' } }),
          agent({ id: 'd1', agentTypeId: 'reviewer', status: 'dormant' }),
        ])
      })
      const filter = window.document.querySelector('[aria-label="Active workers only"]') as HTMLButtonElement
      const search = window.document.querySelector('input[type="search"]') as HTMLInputElement
      const header = window.document.querySelector('[data-testid="agent-picker-static"]')!
      expect(header.textContent).toContain('Idle Engineer')
      expect(window.document.querySelector('[title="Idle Engineer · engineer · e2"]')).not.toBeNull()
      expect(window.document.body.textContent).toContain('Agent chat body')

      await dom.act(async () => filter.click())
      expect(filter.getAttribute('aria-pressed')).toBe('false')
      expect(window.document.querySelector('[title="Idle Engineer · engineer · e2"]')).not.toBeNull()
      expect(window.document.querySelector('[data-agent-type-section="recently-completed"]')).not.toBeNull()
      await dom.act(async () => changeSearchInput(window, search, 'Idle'))
      expect(window.document.querySelector('[title="Working Engineer · engineer · e1"]')).toBeNull()
      await dom.act(async () => filter.click())
      expect(window.document.querySelector('[title="Idle Engineer · engineer · e2"]')).not.toBeNull()
      await dom.act(async () => changeSearchInput(window, search, 'does not match'))
      expect(window.document.body.textContent).toContain('No conversations match your search')
      expect(header.textContent).toContain('Idle Engineer')
      expect(window.document.querySelector('[data-agent-type-section="manager"]')).not.toBeNull()
      expect(window.document.querySelector('button[title="New consultant chat"]')).not.toBeNull()
      expect(window.document.querySelector('[data-agent-type-section="recently-completed"]')).toBeNull()
    } finally {
      await dom.cleanup()
    }
  })

  test('updates the active roster when status changes without closing the conversation', async () => {
    includeIdleAgents = false
    initialSearchParams = 'agent=e1'
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      const queryClient = makeQueryClient()
      const worker = agent({ id: 'e1', agentTypeId: 'engineer', status: 'active', metadata: { name: 'Worker' } })
      await dom.act(async () => renderThreadsDom(root, queryClient, [agent(), worker]))
      expect(window.document.querySelector('[data-agent-type-section="engineer"]')).not.toBeNull()
      await dom.act(async () => renderThreadsDom(root, queryClient, [agent(), { ...worker, status: 'idle' }]))
      expect(window.document.querySelector('[data-agent-type-section="engineer"]')).not.toBeNull()
      expect(window.document.querySelector('[title="Worker · engineer · e1"]')?.getAttribute('aria-pressed')).toBe(
        'true'
      )
      expect(window.document.body.textContent).not.toContain('No active agents')
      expect(window.document.body.textContent).toContain('Agent chat body')
      expect(window.document.querySelector('[data-testid="agent-picker-static"]')?.textContent).toContain('Worker')
      await dom.act(async () => renderThreadsDom(root, queryClient, [agent(), worker]))
      expect(window.document.querySelector('[data-agent-type-section="engineer"]')).not.toBeNull()
      expect(window.document.body.textContent).not.toContain('No active agents')
    } finally {
      await dom.cleanup()
    }
  })

  test('defaults to all agents and offers activity filtering in the mobile picker', async () => {
    const dom = await installDom()
    const { window } = dom
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        renderThreadsDom(root, makeQueryClient(), [
          agent(),
          agent({ id: 'e1', agentTypeId: 'engineer', metadata: { name: 'Idle Engineer' } }),
        ])
      )
      const trigger = window.document.querySelector('[data-testid="agent-picker-trigger"]') as HTMLButtonElement
      await dom.act(async () => trigger.click())
      const dialog = window.document.querySelector('[role="dialog"]')!
      const filter = dialog.querySelector('[aria-label="Active workers only"]') as HTMLButtonElement
      expect(filter.getAttribute('aria-pressed')).toBe('false')
      expect(dialog.textContent).not.toContain('No active agents')
      expect(dialog.querySelector('[data-agent-type-section="engineer"]')).not.toBeNull()
      expect(dialog.querySelector('[data-agent-type-section="manager"]')).not.toBeNull()
      expect(dialog.querySelector('input[type="search"]')).not.toBeNull()
      expect(dialog.querySelector('[aria-label="New consultant chat"]')).not.toBeNull()
      await dom.act(async () => filter.click())
      expect(filter.getAttribute('aria-pressed')).toBe('true')
      expect(dialog.querySelector('[data-agent-type-section="engineer"]')).toBeNull()
      expect(dialog.textContent).toContain('No active agents')
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads consultant recency', () => {
  const history = () =>
    Array.from({ length: 12 }, (_, index) =>
      agent({
        id: `chat-${index}`,
        agentTypeId: 'consultant',
        status: 'idle',
        metadata: { name: `Chat ${String(index).padStart(2, '0')}` },
        createdAt: now,
        lastHumanMessageAt: new Date(now.getTime() + index * 60_000),
      })
    )

  test('shows the last five unarchived consultants by human recency regardless of status or age', () => {
    includeIdleAgents = false
    const chats = history()
    chats[0] = {
      ...chats[0]!,
      status: 'active',
      lastMessageAt: new Date('2026-09-05'),
      updatedAt: new Date('2026-09-05'),
    }
    const html = renderThreads(
      [
        agent(),
        ...chats,
        agent({ id: 'archived', agentTypeId: 'consultant', status: 'dormant', metadata: { name: 'Archived Chat' } }),
      ],
      [
        agent({
          id: 'terminated',
          agentTypeId: 'consultant',
          status: 'terminated',
          metadata: { name: 'Terminated Chat' },
        }),
      ]
    )
    const listed = [...html.matchAll(/title="Chat (\d+) · consultant · chat-\d+"/g)].map((match) => match[1])
    expect(listed).toEqual(['11', '10', '09', '08', '07'])
    expect(html).toContain('View all (12)')
    expect(html).not.toContain('Archived Chat')
    expect(html).not.toContain('Terminated Chat')
    expect(html).not.toContain('No active agents')
  })

  test('puts a newly created consultant first before its first human timestamp arrives', () => {
    includeIdleAgents = false
    const html = renderThreads([
      agent(),
      ...history(),
      agent({
        id: 'fresh',
        agentTypeId: 'consultant',
        metadata: { name: 'Fresh chat' },
        createdAt: new Date(now.getTime() + 60 * 60_000),
      }),
    ])
    expect(html.indexOf('Fresh chat · consultant')).toBeLessThan(html.indexOf('Chat 11 · consultant'))
    expect(html).not.toContain('Chat 02 · consultant')
  })

  test('View all reveals older chats, search spans the full history, and human messages promote a chat', async () => {
    includeIdleAgents = false
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      const client = makeQueryClient()
      let chats = history()
      await dom.act(async () => renderThreadsDom(root, client, [agent(), ...chats]))
      const section = () => dom.window.document.querySelector('[data-agent-type-section="consultant"]')!
      const rows = () => Array.from(section().querySelectorAll('button[title*=" · consultant · "]'))
      expect(rows()).toHaveLength(5)
      const toggle = Array.from(section().querySelectorAll('button')).find((button) =>
        button.textContent?.includes('View all')
      )!
      await dom.act(async () => toggle.click())
      expect(rows()).toHaveLength(12)
      expect(section().textContent).toContain('Show recent')
      await dom.act(async () => toggle.click())
      expect(rows()).toHaveLength(5)
      const search = dom.window.document.querySelector('input[type="search"]') as HTMLInputElement
      await dom.act(async () => changeSearchInput(dom.window, search, 'Chat 00'))
      expect(rows()).toHaveLength(1)
      expect(section().querySelector('[data-testid="terminate-all-consultant"]')).toBeNull()
      expect(rows()[0]?.getAttribute('title')).toContain('chat-0')
      await dom.act(async () => changeSearchInput(dom.window, search, ''))
      chats = chats.map((chat) =>
        chat.id === 'chat-0' ? { ...chat, lastHumanMessageAt: new Date(now.getTime() + 60 * 60_000) } : chat
      )
      await dom.act(async () => renderThreadsDom(root, client, [agent(), ...chats]))
      expect(rows()[0]?.getAttribute('title')).toContain('chat-0')
      chats = chats.map((chat) => (chat.id === 'chat-0' ? { ...chat, status: 'dormant' } : chat))
      await dom.act(async () => renderThreadsDom(root, client, [agent(), ...chats]))
      expect(rows().some((row) => row.getAttribute('title')?.includes('chat-0'))).toBe(false)
      expect(rows()).toHaveLength(5)
    } finally {
      await dom.cleanup()
    }
  })

  test.each([0, 2, 5])('keeps %i consultants without an unnecessary View all action', (count) => {
    const html = renderThreads([agent(), ...history().slice(0, count)])
    expect([...html.matchAll(/title="Chat \d+ · consultant · chat-\d+"/g)]).toHaveLength(count)
    expect(html).not.toContain('View all')
    expect(html.includes('Recent chats')).toBe(count > 0)
  })

  test('offers View all as soon as a sixth consultant exists, including during a cached refresh', () => {
    const html = renderThreads([agent(), ...history().slice(0, 6)], [], true)
    expect([...html.matchAll(/title="Chat \d+ · consultant · chat-\d+"/g)]).toHaveLength(5)
    expect(html).toContain('View all (6)')
    expect(html).not.toContain('Chat 00 · consultant')
    expect(html).not.toContain('Loading agent conversations')
  })

  test('collapses only consultant contents, retaining selection, worker nodes and focus', async () => {
    includeIdleAgents = false
    initialSearchParams = 'agent=chat-11'
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        renderThreadsDom(root, makeQueryClient(), [
          agent(),
          ...history(),
          agent({ id: 'engineer', agentTypeId: 'engineer', status: 'active' }),
          agent({ id: 'reviewer', agentTypeId: 'reviewer', status: 'waiting-input' }),
        ])
      )
      const doc = dom.window.document
      const section = doc.querySelector<HTMLElement>('[data-agent-type-section="consultant"]')!
      const toggle = getByRole(section, 'button', { name: 'Collapse Recent chats' })
      const contents = doc.getElementById(toggle.getAttribute('aria-controls')!)!
      const header = doc.querySelector('[data-testid="agent-picker-static"]')!
      const conversation = doc.querySelector('[data-agent-conversation]')
      expect(conversation).not.toBeNull()
      const workers = [
        ...doc.querySelectorAll('[data-agent-type-section="engineer"], [data-agent-type-section="reviewer"]'),
      ]
      const workerMarkup = workers.map((worker) => worker.outerHTML)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(contents.hidden).toBe(false)
      expect(queryAllByRole(contents, 'button', { name: /Chat/ })).toHaveLength(5)
      expect(header.textContent).toContain('Chat 11')
      expect(toggle.querySelector('button, a, input')).toBeNull()
      // Also protect click-without-focus browsers: focus must leave the rows before hiding them.
      getByRole(contents, 'button', { name: /Chat 11/ }).focus()
      await dom.act(async () => toggle.click())
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(contents.hidden).toBe(true)
      expect(queryAllByRole(contents, 'button')).toHaveLength(0)
      expect(doc.activeElement).toBe(toggle)
      expect(header.textContent).toContain('Chat 11')
      expect(doc.body.textContent).toContain('Agent chat body')
      expect(doc.querySelector('[data-agent-conversation]')).toBe(conversation)
      expect(workers.map((worker) => worker.outerHTML)).toEqual(workerMarkup)
      expect([
        ...doc.querySelectorAll('[data-agent-type-section="engineer"], [data-agent-type-section="reviewer"]'),
      ]).toEqual(workers)
      await dom.act(async () => toggle.click())
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(queryAllByRole(contents, 'button', { name: /Chat/ })).toHaveLength(5)
      expect(getByRole(contents, 'button', { name: /Chat 11/ }).getAttribute('aria-pressed')).toBe('true')
      expect(doc.activeElement).toBe(toggle)
    } finally {
      await dom.cleanup()
    }
  })

  test('search reveals older chats while collapsed and restores the disclosure on clearing', async () => {
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => renderThreadsDom(root, makeQueryClient(), [agent(), ...history()]))
      const section = dom.window.document.querySelector<HTMLElement>('[data-agent-type-section="consultant"]')!
      const toggle = getByRole(section, 'button', { name: 'Collapse Recent chats' })
      await dom.act(async () => toggle.click())
      const search = dom.window.document.querySelector<HTMLInputElement>('input[type="search"]')!
      await dom.act(async () => changeSearchInput(dom.window, search, 'Chat 00'))
      const older = getByRole(section, 'button', { name: /Chat 00/ })
      await dom.act(async () => older.click())
      expect(dom.window.document.querySelector('[data-testid="agent-picker-static"]')?.textContent).toContain('Chat 00')
      await dom.act(async () => changeSearchInput(dom.window, search, ''))
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(dom.window.document.querySelector('[data-testid="agent-picker-static"]')?.textContent).toContain('Chat 00')
    } finally {
      await dom.cleanup()
    }
  })

  test('the responsive panel picker has its own disclosure target, but the standalone page keeps ten recents', async () => {
    for (const layout of ['panel', 'page'] as const) {
      const dom = await installDom()
      try {
        const { root } = dom.createRoot()
        await dom.act(async () => renderThreadsDom(root, makeQueryClient(), [agent(), ...history()], [], { layout }))
        await dom.act(async () =>
          dom.window.document.querySelector<HTMLButtonElement>('[data-testid="agent-picker-trigger"]')!.click()
        )
        const dialog = dom.window.document.querySelector<HTMLElement>('[role="dialog"]')!
        const section = dialog.querySelector<HTMLElement>('[data-agent-type-section="consultant"]')!
        expect(section.querySelectorAll('button[title*=" · consultant · "]')).toHaveLength(layout === 'page' ? 10 : 5)
        const toggle = section.querySelector<HTMLButtonElement>('button[aria-controls]')
        if (layout === 'page') {
          expect(toggle).toBeNull()
        } else {
          expect(toggle).not.toBeNull()
          const targetId = toggle!.getAttribute('aria-controls')!
          expect([...dom.window.document.querySelectorAll('[id]')].filter((node) => node.id === targetId)).toHaveLength(
            1
          )
          expect(dialog.contains(dom.window.document.getElementById(targetId))).toBe(true)
          await dom.act(async () => toggle!.click())
          expect(toggle!.getAttribute('aria-expanded')).toBe('false')
        }
      } finally {
        await dom.cleanup()
      }
    }
  })

  test('the worker pulse toggle never hides idle consultant chats', async () => {
    includeIdleAgents = false
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      await dom.act(async () =>
        renderThreadsDom(root, makeQueryClient(), [
          agent(),
          ...history(),
          agent({ id: 'idle-worker', agentTypeId: 'engineer' }),
        ])
      )
      const filter = dom.window.document.querySelector('[aria-label="Active workers only"]') as HTMLButtonElement
      const consultantRows = () =>
        dom.window.document.querySelectorAll('[data-agent-type-section="consultant"] button[title*=" · consultant · "]')
      expect(consultantRows()).toHaveLength(5)
      expect(dom.window.document.querySelector('[data-agent-type-section="engineer"]')).toBeNull()
      await dom.act(async () => filter.click())
      expect(consultantRows()).toHaveLength(5)
      expect(dom.window.document.querySelector('[data-agent-type-section="engineer"]')).not.toBeNull()
      await dom.act(async () => filter.click())
      expect(consultantRows()).toHaveLength(5)
    } finally {
      await dom.cleanup()
    }
  })
})

describe('SquadAgentThreads sidebar actions', () => {
  test('keeps spawning in an accessible overflow and supports Escape and outside dismissal', async () => {
    const dom = await installDom()
    try {
      const { root } = dom.createRoot()
      await dom.act(async () => renderThreadsDom(root, makeQueryClient(), [agent()]))
      const options = dom.window.document.querySelector('[aria-label="Chat options"]') as HTMLButtonElement
      expect(dom.window.document.body.textContent).not.toContain('Spawn agent…')
      await dom.act(async () => options.click())
      expect(options.getAttribute('aria-expanded')).toBe('true')
      expect(dom.window.document.activeElement?.textContent).toContain('Manage chats')
      await dom.act(async () => fireEvent.keyDown(dom.window.document.activeElement!, { key: 'Escape' }))
      expect(options.getAttribute('aria-expanded')).toBe('false')
      expect(dom.window.document.activeElement).toBe(options)
      await dom.act(async () => options.click())
      await dom.act(async () => fireEvent.pointerDown(dom.window.document.body))
      expect(options.getAttribute('aria-expanded')).toBe('false')
      await dom.act(async () => options.click())
      const spawn = Array.from(dom.window.document.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Spawn agent…')
      )!
      await dom.act(async () => spawn.click())
      expect(dom.window.document.querySelector('[role="dialog"]')?.textContent).toContain('Spawn Agent')
    } finally {
      await dom.cleanup()
    }
  })

  test('keeps management available without run permission while hiding creation actions', () => {
    deniedPermissions = new Set(['agents:run'])
    const html = renderThreads([agent()])
    expect(html).not.toContain('aria-label="New consultant chat"')
    expect(html).toContain('aria-label="Chat options"')
    expect(html).toContain('Manager (Pearl)')
    expect(html).toContain('Search conversations')
  })

  test('keeps context usage out of roster rows', () => {
    const html = renderThreads([
      agent({
        lastMessageAt: now,
        sessionUsage: { context: { percent: 79.8, contextWindow: 272000 } } as Agent['sessionUsage'],
      }),
    ])
    expect(html).not.toContain('79.8%')
    expect(html).not.toContain('272.0k')
  })
})

test('archiving a recent consultant requires confirmation without selecting its conversation', async () => {
  includeIdleAgents = false
  const dom = await installDom()
  try {
    const { root } = dom.createRoot()
    await dom.act(async () =>
      renderThreadsDom(root, makeQueryClient(), [agent(), agent({ id: 'archive-me', agentTypeId: 'consultant' })])
    )
    const section = dom.window.document.querySelector('[data-agent-type-section="consultant"]')!
    expect(section.querySelector('[aria-label="Archive conversation"]')).toBeNull()
    expect(section.querySelector('.squad-chat-agent')?.textContent).not.toContain('Consultant')
    expect(section.querySelector('.squad-chat-agent svg')).toBeNull()
    await toggleManagingChats(dom)
    const archive = section.querySelector('[aria-label="Archive conversation"]') as HTMLButtonElement
    await dom.act(async () => archive.click())
    expect(singleArchiveCalls).toEqual([])
    expect(archive.getAttribute('aria-label')).toBe('Confirm archive conversation')
    await toggleManagingChats(dom)
    expect(section.querySelector('[aria-label="Confirm archive conversation"]')).toBeNull()
    await toggleManagingChats(dom)
    const freshArchive = section.querySelector('[aria-label="Archive conversation"]') as HTMLButtonElement
    await dom.act(async () => freshArchive.click())
    expect(
      dom.window.document.querySelector('[data-agent-type-section="manager"] button')?.getAttribute('aria-pressed')
    ).toBe('true')
    await dom.act(async () => freshArchive.click())
    expect(singleArchiveCalls).toEqual([['squad-1', 'archive-me']])
  } finally {
    await dom.cleanup()
  }
})

test('squad composer expansion includes the selected agent identity and view tabs', async () => {
  const dom = await installDom()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { root } = dom.createRoot()
  function Composer() {
    const expand = useContext(ChatFullscreenContext)
    return (
      <textarea
        aria-label="Test composer"
        onClick={() => {
          if (expand) flushSync(expand)
        }}
      />
    )
  }
  try {
    initialSearchParams = 'agent=agent-1'
    await dom.act(async () =>
      renderThreadsDom(
        root,
        client,
        [agent({ agentTypeId: 'consultant', metadata: { name: 'Kai', purpose: 'Investigate mobile startup crash' } })],
        [],
        {
          dependencies: { ...threadsDependencies, AgentConversation: Composer },
        }
      )
    )
    const textarea = dom.window.document.querySelector('textarea')!
    await dom.act(async () => textarea.click())
    const dialog = dom.window.document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('h3')!.textContent).toContain('Kai')
    expect(dialog.querySelector('h3')!.textContent).toContain('Investigate mobile startup crash')
    expect(dialog.querySelector('textarea')).toBe(textarea)
    expect(dialog.textContent).toContain('Chat')
    expect(dialog.textContent).toContain('Work')
  } finally {
    client.clear()
    await dom.cleanup()
  }
})
