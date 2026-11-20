import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { useRef, type ReactNode } from 'react'
import type { Agent, Squad, WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queries } from '../queryOptions'
import { chatWindowsStorageKey } from '../lib/chatWindows'
import { untilRendered } from '../test/untilRendered'
import { webkitTap } from '../test/webkitTap'

// Load the lazy in-place reference modal before installing the DOM's constructor globals.
await import('./EntityReferenceModal')
const { FloatingWindowsProvider } = await import('./FloatingWindows')
const { AgentChatWindow } = await import('./AgentChatWindow')
const { FloatingChatButton } = await import('./FloatingChatButton')
const { MarkdownContent } = await import('./MarkdownContent')
const { WorkStreamList } = await import('./WorkStreamList')
const { SquadAgentThreads } = await import('./squads/SquadAgentThreads')
const { SquadAgentThreadsApiProvider } = await import('./squads/squadAgentThreadsApi')
const { AgentConversation } = await import('./AgentConversationBody')
const { HoverCard, Menu, MenuItem, Panel, useHoverCard, usePopover } = await import('./popover')

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const now = new Date('2026-11-20T00:00:00Z')

function agent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    squadId: 'squad-1',
    agentTypeId: 'consultant',
    status: 'idle',
    metadata: { name },
    createdAt: now,
    ...overrides,
  } as Agent
}

const squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Coordinate work',
  status: 'active',
  managerAgentId: null,
  metadata: {},
  createdAt: now,
  updatedAt: now,
} as unknown as Squad

/** Each window's conversation callback, so a test can deliver new activity to it. */
const conversations = new Map<string, (conversation: unknown) => void>()

/** The chat inside a window: a composer to focus, and the composer's floating-window control. */
function StubConversation({
  agentId,
  draftKey,
  onConversation,
}: {
  agentId: string
  draftKey?: string
  onConversation?: (conversation: unknown) => void
}) {
  if (onConversation) conversations.set(agentId, onConversation)
  return (
    <div data-stub-conversation={agentId} data-draft-key={draftKey}>
      <p data-transcript>Transcript</p>
      <textarea aria-label={`Message ${agentId}`} />
      <FloatingChatButton agentId={agentId} />
    </div>
  )
}

function Window(props: { win: Parameters<typeof AgentChatWindow>[0]['win'] }) {
  return <AgentChatWindow {...props} dependencies={{ ConversationComponent: StubConversation as never }} />
}

function Probe({ onLocation }: { onLocation: (location: string) => void }) {
  const current = useLocation()
  onLocation(current.pathname + current.search)
  return null
}

async function setup(
  page: ReactNode,
  {
    wide = true,
    url = '/',
    stored,
    seed,
  }: { wide?: boolean; url?: string; stored?: unknown; seed?: (cache: QueryClient) => void } = {}
) {
  const dom = await acquireDomHarness({
    url: `http://localhost${url}`,
    windowOptions: { innerWidth: 1400, innerHeight: 900 },
    configureWindow(window) {
      Object.assign(window, { SyntaxError })
    },
  })
  // The md breakpoint, switchable mid-test like a resized browser window.
  let matches = wide
  const listeners = new Set<() => void>()
  const media = {
    get matches() {
      return matches
    },
    media: '(min-width: 768px)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  Object.defineProperty(dom.window, 'matchMedia', { configurable: true, value: () => media })
  dom.window.localStorage.clear()
  if (stored) dom.window.localStorage.setItem(chatWindowsStorageKey('user:u1'), JSON.stringify(stored))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const [key, value] of [
    [queries.agents.detail(A).queryKey, agent(A, 'Researcher')],
    [queries.agents.detail(B).queryKey, agent(B, 'Reviewer', { agentTypeId: 'reviewer' })],
    [queries.agents.detail('bbbbbbbb').queryKey, agent(B, 'Reviewer', { agentTypeId: 'reviewer' })],
    [queries.squads.list().queryKey, [squad]],
    [queries.agentTypes.list().queryKey, [{ id: 'consultant', name: 'Consultant' }]],
    [queries.agents.activeExecution(A).queryKey, null],
  ] as const)
    cache.setQueryData(key, value)
  seed?.(cache)
  let location = ''
  const onLocation = (next: string) => {
    location = next
  }
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={[url]}>
          <PermissionsProvider
            usePermissions={() => ({
              can: () => true,
              permissions: [],
              isLoading: false,
              isError: false,
              identity: { type: 'user', userId: 'u1' },
            })}
          >
            <SquadAgentThreadsApiProvider
              api={{
                terminateSquadAgent: async () => {},
                terminateSquadAgentsBulk: async () => ({ terminated: [], deferred: [], skipped: [] }),
              }}
            >
              <FloatingWindowsProvider dependencies={{ WindowComponent: Window }}>
                {page}
                <Probe onLocation={onLocation} />
              </FloatingWindowsProvider>
            </SquadAgentThreadsApiProvider>
          </PermissionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const windows = () => [...document.querySelectorAll<HTMLElement>('[data-floating-window]')]
  const windowFor = (id: string) => document.querySelector<HTMLElement>(`[data-floating-window="${id}"]`)
  const click = async (target: Element, init: MouseEventInit = {}) => {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
    await dom.act(async () => target.dispatchEvent(event))
    return event
  }
  const key = async (target: Element | Document, init: KeyboardEventInit) => {
    const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    await dom.act(async () => target.dispatchEvent(event))
    return event
  }
  const press = async (target: Element) => {
    const event = new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(event, 'pointerId', { value: 1 })
    await dom.act(async () => target.dispatchEvent(event))
  }
  const stored_ = () => JSON.parse(dom.window.localStorage.getItem(chatWindowsStorageKey('user:u1')) ?? 'null')
  return {
    dom,
    root,
    cache,
    location: () => location,
    windows,
    windowFor,
    click,
    key,
    press,
    stored: stored_,
    setWide: async (next: boolean) => {
      matches = next
      await dom.act(async () => listeners.forEach((listener) => listener()))
    },
    cleanup: async () => {
      await dom.cleanup()
      cache.clear()
    },
  }
}

test('the pop-out button opens one floating window per agent, and inside it opens the full page instead', async () => {
  const t = await setup(<FloatingChatButton agentId={A} />, { url: '/feed' })
  try {
    const popOut = document.querySelector<HTMLButtonElement>('button[aria-label="Open in floating window"]')!
    expect(popOut.title).toContain('Shift-click')
    await t.click(popOut)
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    const win = t.windowFor(A)!
    expect(win.getAttribute('role')).toBe('dialog')
    expect(win.querySelector('header')!.textContent).toContain('Researcher')
    expect(win.querySelector('header')!.textContent).toContain('Consultant · Ficus')
    expect(win.querySelector('[aria-label^="Agent activity"]')).not.toBeNull()
    // Opening again does not duplicate it.
    await t.click(popOut)
    expect(t.windows()).toHaveLength(1)
    // It survives a refresh: stored for this user.
    expect(t.stored().windows.map((w: { agentId: string }) => w.agentId)).toEqual([A])

    // Inside its own window, the composer control opens the full page and closes the window.
    const fullPage = win.querySelector<HTMLButtonElement>(
      '[data-stub-conversation] button[aria-label="Open full page"]'
    )!
    expect(win.querySelector('[data-stub-conversation] [aria-label="Open in floating window"]')).toBeNull()
    await t.click(fullPage)
    expect(t.location()).toBe(`/squads/ficus/agents?agent=${A}`)
    expect(t.windows()).toHaveLength(0)
  } finally {
    await t.cleanup()
  }
})

test('minimize sends a window to the tray, a chip restores it, and close all empties the tray', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 },
        { agentId: B, rect: { x: 600, y: 80, w: 420, h: 500 }, z: 2 },
      ],
      remembered: {},
    },
  })
  try {
    expect(t.windows()).toHaveLength(2)
    await t.click(t.windowFor(B)!.querySelector('button[aria-label="Minimize"]')!)
    expect(t.windowFor(B)!.style.display).toBe('none')
    const tray = document.querySelector('nav[aria-label="Minimized chat windows"]')!
    const chip = tray.querySelector<HTMLButtonElement>('button[aria-label^="Restore Reviewer"]')!
    expect(chip.querySelector('[aria-label^="Agent activity"]')).not.toBeNull()
    await t.click(chip)
    expect(t.windowFor(B)!.style.display).toBe('')
    expect(document.querySelector('nav[aria-label="Minimized chat windows"]')).toBeNull()
    // Restored to the front.
    expect(Number(t.windowFor(B)!.style.zIndex)).toBeGreaterThan(Number(t.windowFor(A)!.style.zIndex))

    await t.click(t.windowFor(A)!.querySelector('button[aria-label="Minimize"]')!)
    await t.click(document.querySelector('nav[aria-label="Minimized chat windows"] button[title^="Close every"]')!)
    expect(t.windows()).toHaveLength(0)
    // Each closed window remembers where it was.
    expect(Object.keys(t.stored().remembered).sort()).toEqual([A, B])
  } finally {
    await t.cleanup()
  }
})

test('narrow screens draw no windows or pop-out, modifier-clicks navigate normally, and stored windows come back when wide', async () => {
  const t = await setup(
    <>
      <FloatingChatButton agentId={A} />
      <a href={`/squads/ficus/agents?agent=${A}`}>Researcher</a>
    </>,
    {
      wide: false,
      stored: {
        assistantZ: 0,
        windows: [{ agentId: B, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 }],
        remembered: {},
      },
    }
  )
  try {
    expect(t.windows()).toHaveLength(0)
    expect(document.querySelector('button[aria-label="Open in floating window"]')).toBeNull()
    const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Researcher')!
    const event = await t.click(link, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    expect(t.windows()).toHaveLength(0)
    await t.setWide(true)
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([B])
  } finally {
    await t.cleanup()
  }
})

test("Shift- or Alt-click on a work stream row's agent caption opens a floating window; a plain click still navigates", async () => {
  const stream = {
    id: 'ws-1',
    number: 7,
    squadId: 'squad-1',
    title: 'Ship floating windows',
    description: null,
    status: 'active',
    derivedState: 'in_progress',
    assigneeAgentId: A,
    ownerAgentId: null,
    agentIds: [A],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  } as unknown as WorkStream
  const t = await setup(
    <WorkStreamList
      feedLayout
      hideFilters
      workStreams={[stream]}
      squadMap={new Map([[squad.id, squad]])}
      agentMap={new Map([[A, agent(A, 'Researcher') as never]])}
      squads={[squad]}
    />,
    { url: '/' }
  )
  try {
    const caption = document.querySelector<HTMLAnchorElement>(
      'a[title^="Open Consultant agent thread"], a[title$="agent thread"]'
    )!
    expect(caption.getAttribute('href')).toBe(`/squads/ficus/agents?agent=${A}`)
    const shift = await t.click(caption, { shiftKey: true })
    expect(shift.defaultPrevented).toBe(true)
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    expect(t.location()).toBe('/')
    await t.click(t.windowFor(A)!.querySelector('button[aria-label="Close window"]')!)
    const alt = await t.click(caption, { altKey: true })
    expect(alt.defaultPrevented).toBe(true)
    expect(t.windows()).toHaveLength(1)
    // Cmd/Ctrl+click and plain clicks keep their behavior.
    await t.click(t.windowFor(A)!.querySelector('button[aria-label="Close window"]')!)
    const meta = await t.click(caption, { metaKey: true, shiftKey: true })
    expect(t.windows()).toHaveLength(0)
    expect(meta.defaultPrevented).toBe(false)
    await t.click(caption)
    expect(t.windows()).toHaveLength(0)
    expect(t.location()).toBe(`/squads/ficus/agents?agent=${A}`)
  } finally {
    await t.cleanup()
  }
})

test('Shift-click on a markdown ficus:agent: reference opens a floating window, resolving a prefix to its agent', async () => {
  const t = await setup(
    <MarkdownContent>{`Ask [the researcher](ficus:agent:${A}) or [the reviewer](ficus:agent:bbbbbbbb).`}</MarkdownContent>
  )
  try {
    const [researcher, reviewer] = [...document.querySelectorAll<HTMLButtonElement>('button[data-agent-chat-id]')]
    expect(researcher!.textContent).toBe('the researcher')
    await t.click(researcher!, { shiftKey: true })
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    // No reference modal opened for the modifier-click.
    expect(document.querySelector('[role="dialog"]:not([data-floating-window])')).toBeNull()
    await t.click(reviewer!, { altKey: true })
    await t.dom.act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A, B])
  } finally {
    await t.cleanup()
  }
})

test('Shift-click on an agents sidebar row opens it in a floating window without selecting it', async () => {
  const t = await setup(
    <SquadAgentThreads
      agents={[agent('manager-1', 'Pearl', { agentTypeId: 'manager' }), agent(A, 'Researcher')]}
      recentlyTerminatedAgents={[]}
      squadId="squad-1"
      dependencies={{
        Chat: () => <div />,
        AgentConversation: () => <div data-agent-conversation />,
        SubagentsInlinePanel: () => <div />,
        AgentWorkStreamsPanel: () => <div />,
        AgentInboxPanel: () => <div />,
        AgentContextPanel: () => <div />,
      }}
    />,
    { url: '/squads/squad-1/agents?agent=manager-1' }
  )
  try {
    const row = document.querySelector<HTMLButtonElement>(`button[data-agent-chat-id="${A}"]`)!
    expect(row).not.toBeNull()
    await t.click(row, { shiftKey: true })
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    expect(new URLSearchParams(t.location().split('?')[1]).get('agent')).toBe('manager-1')
    await t.click(row)
    expect(new URLSearchParams(t.location().split('?')[1]).get('agent')).toBe(A)
  } finally {
    await t.cleanup()
  }
})

/** A row menu and a panel holding agent links, inside a focusable section as on real pages (WebKit taps). */
function PopupsWithAgentLinks({ ran }: { ran: string[] }) {
  const menu = usePopover<HTMLButtonElement>({ kind: 'menu' })
  const panel = usePopover<HTMLButtonElement>({ kind: 'dialog' })
  return (
    <section tabIndex={-1}>
      <button {...menu.triggerProps} type="button" onClick={menu.toggle}>
        Agents
      </button>
      <Menu {...menu.popoverProps} label="Agents">
        <MenuItem data-agent-chat-id={A} onClick={() => ran.push('row')}>
          Researcher
        </MenuItem>
      </Menu>
      <button {...panel.triggerProps} type="button" onClick={panel.toggle}>
        Details
      </button>
      <Panel {...panel.popoverProps} label="Details">
        <a href={`/squads/ficus/agents?agent=${B}`}>Reviewer</a>
      </Panel>
    </section>
  )
}

test('Shift- or Alt-click on an agent link inside an open menu or panel opens a window and closes the popup, without running the row', async () => {
  const ran: string[] = []
  const t = await setup(<PopupsWithAgentLinks ran={ran} />, { url: '/feed' })
  try {
    const trigger = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find((b) => b.textContent === name)!
    const shown = (role: string) => document.querySelector(`[role="${role}"][data-popover]:not([data-state="closed"])`)
    const item = () => document.querySelector<HTMLButtonElement>(`[role="menuitem"][data-agent-chat-id="${A}"]`)!

    await t.click(trigger('Agents'))
    expect(shown('menu')).not.toBeNull()
    const shift = await t.click(item(), { shiftKey: true })
    expect(shift.defaultPrevented).toBe(true)
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    expect(ran).toEqual([])
    expect(shown('menu')).toBeNull()
    expect(trigger('Agents').getAttribute('aria-expanded')).toBe('false')

    // Safari: the press never focuses the item, and focus falls back to the section before the click.
    await t.click(t.windowFor(A)!.querySelector('button[aria-label="Close window"]')!)
    await t.click(trigger('Agents'))
    expect(await webkitTap(item(), { modifiers: { altKey: true } })).toBe(true)
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    expect(ran).toEqual([])
    expect(shown('menu')).toBeNull()

    await t.click(trigger('Details'))
    const link = document.querySelector<HTMLAnchorElement>('[role="dialog"][data-popover] a')!
    await t.click(link, { shiftKey: true })
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A, B])
    expect(shown('dialog')).toBeNull()
    expect(t.location()).toBe('/feed')

    // A plain click on the item still runs it, and the menu closes as before.
    await t.click(trigger('Agents'))
    await t.click(item())
    expect(ran).toEqual(['row'])
    expect(shown('menu')).toBeNull()
    expect(t.windows()).toHaveLength(2)
  } finally {
    await t.cleanup()
  }
})

function PreviewWithAgentLink() {
  const anchor = useRef<HTMLButtonElement>(null)
  const hover = useHoverCard({ openDelay: 10, closeDelay: 10 })
  return (
    <>
      <button ref={anchor} type="button" {...hover.anchorHandlers}>
        Reference
      </button>
      <HoverCard hover={hover} anchor={anchor} label="Preview">
        <a href={`/squads/ficus/agents?agent=${A}`}>Researcher</a>
      </HoverCard>
    </>
  )
}

test('Shift-click on an agent link in a hover card the pointer is still over opens a window and closes the card', async () => {
  const t = await setup(<PreviewWithAgentLink />, { url: '/feed' })
  try {
    const mouseover = (target: Element) =>
      t.dom.act(async () => void target.dispatchEvent(new t.dom.window.MouseEvent('mouseover', { bubbles: true })))
    const wait = (ms: number) => t.dom.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
    const card = () => document.querySelector('[data-popover]:not([data-state="closed"])')
    await mouseover(document.querySelector('button')!)
    await wait(30)
    expect(card()).not.toBeNull()
    await mouseover(card()!)
    await t.click(card()!.querySelector('a')!, { shiftKey: true })
    expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A])
    // Closed at once, although the pointer still rests on the card.
    expect(card()).toBeNull()
    await wait(30)
    expect(card()).toBeNull()
    expect(t.location()).toBe('/feed')
  } finally {
    await t.cleanup()
  }
})

test('Ctrl+Option shortcuts move the window holding focus, else the frontmost, and never another', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 },
        { agentId: B, rect: { x: 600, y: 80, w: 420, h: 500 }, z: 2 },
      ],
      remembered: {},
    },
  })
  try {
    const box = (id: string) => {
      const style = t.windowFor(id)!.style
      return { left: parseFloat(style.left), width: parseFloat(style.width) }
    }
    // B is in front, but focus is in A's composer: A snaps.
    const composer = t.windowFor(A)!.querySelector('textarea')!
    await t.dom.act(async () => composer.focus())
    await t.key(composer, { code: 'ArrowLeft', ctrlKey: true, altKey: true })
    expect(box(A)).toEqual({ left: 8, width: (1400 - 16 - 8) / 2 })
    expect(box(B)).toEqual({ left: 600, width: 420 })
    // Focus on the page: the frontmost window (B, pressed last) takes it.
    await t.dom.act(async () => composer.blur())
    await t.press(t.windowFor(B)!.querySelector('[data-transcript]')!)
    await t.key(document.body, { code: 'ArrowRight', ctrlKey: true, altKey: true })
    expect(box(B)).toEqual({ left: 8 + 688 + 8, width: 688 })
    expect(box(A)).toEqual({ left: 8, width: 688 })
    // Center: B goes back to its free size, centered.
    await t.key(document.body, { code: 'KeyC', ctrlKey: true, altKey: true })
    expect(box(B)).toEqual({ left: (1400 - 420) / 2, width: 420 })
    expect(t.stored().windows.find((w: { agentId: string }) => w.agentId === A).snap).toBe('left')
  } finally {
    await t.cleanup()
  }
})

test('pressing anywhere in a window brings it to the front; Escape never closes one', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 },
        { agentId: B, rect: { x: 300, y: 80, w: 420, h: 500 }, z: 2 },
      ],
      remembered: {},
    },
  })
  try {
    const z = (id: string) => Number(t.windowFor(id)!.style.zIndex)
    expect(z(B)).toBeGreaterThan(z(A))
    await t.press(t.windowFor(A)!.querySelector('[data-transcript]')!)
    expect(z(A)).toBeGreaterThan(z(B))
    // Focus moving into a window (keyboard) brings it forward too.
    await t.dom.act(async () => t.windowFor(B)!.querySelector('textarea')!.focus())
    expect(z(B)).toBeGreaterThan(z(A))
    const composer = t.windowFor(B)!.querySelector('textarea')!
    await t.key(composer, { key: 'Escape' })
    await t.key(document.body, { key: 'Escape' })
    expect(t.windows()).toHaveLength(2)
  } finally {
    await t.cleanup()
  }
})

test('windows for agents that no longer exist or are not accessible close themselves', async () => {
  const gone = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const { HttpResponseError } = await import('@ficus/client-core')
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 },
        { agentId: gone, rect: { x: 300, y: 80, w: 420, h: 500 }, z: 2 },
      ],
      remembered: {},
    },
    seed: (cache) =>
      void cache.prefetchQuery({
        ...queries.agents.detail(gone),
        queryFn: () => Promise.reject(new HttpResponseError(404, 'Not found')),
      }),
  })
  try {
    await untilRendered(t.dom, () => expect(t.windows().map((w) => w.dataset.floatingWindow)).toEqual([A]))
    expect(t.stored().windows.map((w: { agentId: string }) => w.agentId)).toEqual([A])
    expect(t.stored().remembered[gone]).toBeUndefined()
  } finally {
    await t.cleanup()
  }
})

test('dragging the title bar previews and snaps at screen edges and picker zones, Alt suppresses it, and dragging out restores the free size', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [{ agentId: A, rect: { x: 300, y: 200, w: 420, h: 500 }, z: 1 }],
      remembered: {},
    },
  })
  try {
    const frame = t.windowFor(A)!
    Object.assign(frame, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} })
    const title = frame.querySelector('header')!
    const pointer = async (target: Element, type: string, x: number, y: number, init: MouseEventInit = {}) => {
      const event = new t.dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        ...init,
      })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await t.dom.act(async () => target.dispatchEvent(event))
    }
    const box = () => {
      const style = frame.style
      return {
        x: parseFloat(style.left),
        y: parseFloat(style.top),
        w: parseFloat(style.width),
        h: parseFloat(style.height),
      }
    }
    // To the left edge: the left half is previewed under the picker, and taken on release.
    await pointer(title, 'pointerdown', 400, 210)
    await pointer(frame, 'pointermove', 200, 300)
    expect(document.querySelector('[data-snap-zone-picker]')).not.toBeNull()
    expect(document.querySelector('[data-snap-preview]')).toBeNull()
    await pointer(frame, 'pointermove', 0, 450)
    expect(document.querySelector('[data-snap-preview]')!.getAttribute('data-snap-preview')).toBe('left')
    await pointer(frame, 'pointerup', 0, 450)
    expect(document.querySelector('[data-snap-drag-overlay]')).toBeNull()
    expect(box()).toEqual({ x: 8, y: 8, w: 688, h: 884 })

    // Dragged out of the snap: back to 420x500, still held a share of the way across its title bar.
    await pointer(title, 'pointerdown', 352, 20)
    await pointer(frame, 'pointermove', 600, 300)
    expect(box().w).toBe(420)
    expect(box().h).toBe(500)
    expect(box().x).toBe(Math.round(600 - ((352 - 8) / 688) * 420))
    // Dropped on the picker's middle-third zone: thirds are reachable by drag.
    const zone = document.querySelector<HTMLElement>('[data-snap-zone="middle-third"]')!
    const group = zone.parentElement!
    const picker = group.parentElement!
    const at = (element: HTMLElement) => ({ x: parseFloat(element.style.left), y: parseFloat(element.style.top) })
    const zx = at(picker).x + 1 + at(group).x + 1 + at(zone).x + 3
    const zy = at(picker).y + 1 + at(group).y + 1 + at(zone).y + 3
    await pointer(frame, 'pointermove', zx, zy)
    expect(document.querySelector('[data-snap-zone="middle-third"]')!.getAttribute('data-active')).toBe('true')
    await pointer(frame, 'pointerup', zx, zy)
    expect(t.stored().windows[0].snap).toBe('middle-third')

    // Holding Alt/Option while dragging to an edge places it freely instead.
    await pointer(title, 'pointerdown', 700, 20)
    await pointer(frame, 'pointermove', 1399, 450, { altKey: true })
    expect(document.querySelector('[data-snap-preview]')).toBeNull()
    await pointer(frame, 'pointerup', 1399, 450, { altKey: true })
    expect(t.stored().windows[0].snap).toBeUndefined()
    expect(box().w).toBe(420)

    // Double-click on the title bar fills the screen, and again goes back.
    await t.dom.act(async () => title.dispatchEvent(new t.dom.window.MouseEvent('dblclick', { bubbles: true })))
    expect(t.stored().windows[0].snap).toBe('full')
    await t.dom.act(async () => title.dispatchEvent(new t.dom.window.MouseEvent('dblclick', { bubbles: true })))
    expect(t.stored().windows[0].snap).toBeUndefined()
  } finally {
    await t.cleanup()
  }
})

test('resizing from an edge keeps the opposite edge put', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [{ agentId: A, rect: { x: 300, y: 200, w: 420, h: 500 }, z: 1 }],
      remembered: {},
    },
  })
  try {
    const frame = t.windowFor(A)!
    const west = frame.querySelector<HTMLElement>('[data-resize-edge="w"]')!
    for (const element of [frame, west])
      Object.assign(element, { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} })
    const pointer = async (target: Element, type: string, x: number, y: number) => {
      const event = new t.dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      await t.dom.act(async () => target.dispatchEvent(event))
    }
    await pointer(west, 'pointerdown', 300, 400)
    await pointer(west, 'pointermove', 250, 400)
    await pointer(west, 'pointerup', 250, 400)
    expect(t.stored().windows[0].rect).toEqual({ x: 250, y: 200, w: 470, h: 500 })
    expect(frame.querySelectorAll('[data-resize-edge]')).toHaveLength(7)
    expect(frame.querySelector('button[aria-label="Resize window"]')).not.toBeNull()
  } finally {
    await t.cleanup()
  }
})

test('nothing to pop out before the agent exists (a new consultant chat before its first message)', async () => {
  const t = await setup(<FloatingChatButton agentId={undefined} />)
  try {
    expect(document.querySelector('button[aria-label="Open in floating window"]')).toBeNull()
  } finally {
    await t.cleanup()
  }
})

test('a window keeps its own composer draft, apart from the same chat on the page', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [{ agentId: A, rect: { x: 300, y: 200, w: 420, h: 500 }, z: 1 }],
      remembered: {},
    },
  })
  try {
    expect(t.windowFor(A)!.querySelector('[data-stub-conversation]')!.getAttribute('data-draft-key')).toBe(
      `agent-window:${A}`
    )
  } finally {
    await t.cleanup()
  }
})

test('new activity in a window that is not in front marks it unread until it is used', async () => {
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: [
        { agentId: A, rect: { x: 100, y: 80, w: 420, h: 500 }, z: 1 },
        { agentId: B, rect: { x: 600, y: 80, w: 420, h: 500 }, z: 2 },
      ],
      remembered: {},
    },
  })
  try {
    const reply = (id: string) => ({ kind: 'persisted', id, message: { role: 'assistant' } })
    const deliver = (agentId: string, items: unknown[]) =>
      t.dom.act(async () => conversations.get(agentId)!({ isLoading: false, items }))
    const unread = (id: string) => t.windowFor(id)!.querySelector('header [aria-label="Unread activity"]')
    await deliver(A, [reply('m1')])
    expect(unread(A)).toBeNull()
    // The user's own message is not news.
    await deliver(A, [reply('m1'), { kind: 'persisted', id: 'm2', message: { role: 'human' } }])
    expect(unread(A)).toBeNull()
    await deliver(A, [reply('m1'), { kind: 'persisted', id: 'm2', message: { role: 'human' } }, reply('m3')])
    expect(unread(A)).not.toBeNull()
    // The frontmost window is being watched: no badge.
    await deliver(B, [reply('x1')])
    await deliver(B, [reply('x1'), reply('x2')])
    expect(unread(B)).toBeNull()
    await t.press(t.windowFor(A)!.querySelector('[data-transcript]')!)
    expect(unread(A)).toBeNull()
  } finally {
    await t.cleanup()
  }
})

test('agent chats offer the pop-out in their composer controls, except embedded transcripts', async () => {
  const seen: Record<string, unknown>[] = []
  const Chat = (props: Record<string, unknown>) => {
    seen.push(props)
    return <div data-chat={String(props.embedded ?? false)}>{props.composerControls as ReactNode}</div>
  }
  const t = await setup(
    <>
      <AgentConversation agentId={A} dependencies={{ AgentChatComponent: Chat as never }} />
      <AgentConversation agentId={B} embedded dependencies={{ AgentChatComponent: Chat as never }} />
    </>
  )
  try {
    expect(document.querySelector('[data-chat="false"] button[aria-label="Open in floating window"]')).not.toBeNull()
    expect(document.querySelector('[data-chat="true"] button[aria-label="Open in floating window"]')).toBeNull()
    // The page keeps its own draft key.
    expect(seen.find((props) => props.agentId === A)!.inputStorageKey).toBe(`agent:${A}`)
  } finally {
    await t.cleanup()
  }
})

test('with more windows than stacking layers, the window in use is still drawn in front of every other', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`)
  const t = await setup(null, {
    stored: {
      assistantZ: 0,
      windows: ids.map((agentId, index) => ({
        agentId,
        rect: { x: 40 + index * 20, y: 80, w: 420, h: 500 },
        z: index + 1,
      })),
      remembered: {},
    },
  })
  try {
    const z = (id: string) => Number(t.windowFor(id)!.style.zIndex)
    const others = (id: string) => ids.filter((other) => other !== id).map(z)
    expect(z(ids[9]!)).toBeGreaterThan(Math.max(...others(ids[9]!)))
    // The window opened first, furthest back, comes to the very front when pressed.
    await t.press(t.windowFor(ids[0]!)!.querySelector('[data-transcript]')!)
    expect(z(ids[0]!)).toBeGreaterThan(Math.max(...others(ids[0]!)))
    // The one just behind it is next, and all stay between the page and modals.
    expect(z(ids[9]!)).toBeGreaterThan(Math.max(...others(ids[9]!).filter((value) => value !== z(ids[0]!))))
    for (const id of ids) {
      expect(z(id)).toBeGreaterThanOrEqual(51)
      expect(z(id)).toBeLessThan(60)
    }
  } finally {
    await t.cleanup()
  }
})
