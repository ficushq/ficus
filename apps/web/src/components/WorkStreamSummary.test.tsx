/**
 * Work stream summaries on the web: the peek card on Feed, Home and Work list rows and graph nodes
 * (hover after a delay, keyboard focus, Escape and blur; participants link to their chats), the
 * "Summaries" switch in each list's Active header remembered per surface, the board card line and the
 * detail modal's "Now" line.
 */
import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router'
import { agentChatTargetOf } from '../lib/agentChatLinks'
import type { AgentSummary, Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { WorkStreamList } from './WorkStreamList'
import { WorkStreamGraph } from './WorkStreamGraph'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'
import { WorkStreamList as SquadWorkStreamList } from './squads/WorkStreamList'
import { WORK_STREAM_PEEK_OPEN_DELAY_MS, workStreamPeekFacts, workStreamSummariesStorageKey } from './WorkStreamSummary'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  dom?.window.localStorage.clear()
  await dom?.cleanup()
  dom = undefined
})

const now = new Date()
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)

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

const SUMMARY = 'Wiring the peek card into Feed rows'

function workStream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    number: 1354,
    squadId: squad.id,
    title: 'Work stream summaries',
    description: 'One line per stream.',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    assigneeAgentId: 'agent-1',
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: ['agent-1', 'agent-2'],
    dependsOn: [],
    dependedOnBy: [],
    handoffMessage: null,
    files: [],
    metadata: {},
    completionMode: 'pr-merge',
    createdAt: minutesAgo(60),
    updatedAt: minutesAgo(2),
    step: 'Implement',
    summary: { text: SUMMARY, generatedAt: minutesAgo(4).toISOString(), step: 'Implement' },
    openWaits: [
      {
        id: 'wait-1',
        workStreamId: 'ws-1',
        type: 'question',
        referenceId: null,
        message: null,
        createdBy: 'agent',
        createdByAgentId: null,
        openedAt: minutesAgo(1).toISOString(),
        closedAt: null,
        resolution: null,
        resolutionNote: null,
      },
    ],
    ...overrides,
  } as WorkStream
}

const agents: AgentSummary[] = [
  { id: 'agent-1', agentTypeId: 'engineer', squadId: squad.id, parentAgentId: null, status: 'active' },
  { id: 'agent-2', agentTypeId: 'reviewer', squadId: squad.id, parentAgentId: null, status: 'idle' },
]

/** Renders into a fresh window; `storage` is written to its localStorage before the first render. */
async function render(node: ReactNode, storage: Record<string, string> = {}) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value)
  const { root } = dom.createRoot()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.agentTypes.list(), [
    { id: 'engineer', name: 'Engineer' },
    { id: 'reviewer', name: 'Reviewer' },
  ])
  client.setQueryData(queryKeys.squads.agents(squad.id), agents)
  const draw = (content: ReactNode) =>
    dom!.act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>{content}</MemoryRouter>
        </QueryClientProvider>
      )
    )
  await draw(node)
  const doc = dom.window.document
  const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
  const peekCard = () => doc.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')
  const mouse = (target: Element, type: 'mouseover' | 'mouseout') =>
    dom!.act(async () => void target.dispatchEvent(new dom!.window.MouseEvent(type, { bubbles: true })))
  const key = (key: string) =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    })
  /** Keyboard focus: jsdom has no :focus-visible, so the element claims it. */
  const keyboardFocus = (element: HTMLElement | SVGElement) =>
    dom!.act(async () => {
      element.matches = ((selector: string) => selector === ':focus-visible') as typeof element.matches
      element.focus()
    })
  return { doc, draw, wait, peekCard, mouse, key, keyboardFocus }
}

/** The Feed as FeedPage renders it: filters (and the switch) in a popover in the page header. */
function Feed({ streams }: { streams: WorkStream[] }) {
  const [filterContainer, setFilterContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setFilterContainer} />
      <WorkStreamList
        workStreams={streams}
        squadMap={new Map([[squad.id, squad]])}
        agentMap={new Map(agents.map((agent) => [agent.id, agent]))}
        squads={[squad]}
        feedLayout
        filterContainer={filterContainer}
        summarySurface="feed"
      />
    </>
  )
}
const feedList = (streams: WorkStream[]) => <Feed streams={streams} />

/** Open the Feed's Filters panel and return its "Summaries" row (the Feed keeps it under View). */
async function feedSwitch(doc: Document) {
  const existing = doc.querySelector<HTMLButtonElement>('[data-testid="show-summaries-feed"]')
  if (existing) return existing
  const filters = doc.querySelector<HTMLButtonElement>('[data-testid="work-stream-filters"] button')!
  await dom!.act(async () => filters.click())
  return doc.querySelector<HTMLButtonElement>('[data-testid="show-summaries-feed"]')!
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

test('hovering a Feed row opens the peek card after about half a second', async () => {
  const { doc, wait, peekCard, mouse } = await render(feedList([workStream()]))
  const row = doc.querySelector('[data-testid="feed-work-row"]')!
  await mouse(row, 'mouseover')
  await wait(WORK_STREAM_PEEK_OPEN_DELAY_MS - 200)
  expect(peekCard()).toBeNull()
  await wait(300)
  const card = peekCard()!
  expect(card.getAttribute('aria-label')).toBe('#1354 · Work stream summaries at a glance')
  expect(card.textContent).toContain(SUMMARY)
  expect(card.textContent).toContain('Generated summary · updated 4 min ago')
  expect(card.textContent).toContain('Implement · Waiting on you: question')
  expect(card.textContent).toContain('Engineer')
  expect(card.textContent).toContain('Reviewer')
  expect(card.querySelectorAll('[aria-label^="Agent activity"]')).toHaveLength(2)
  await mouse(row, 'mouseout')
  await wait(200)
  expect(peekCard()).toBeNull()
})

test('the peek card names a review gate queued behind other waits as next, and Feed rows leave it out', async () => {
  const question = workStream().openWaits![0]!
  const gate = {
    ...question,
    id: 'wait-gate',
    type: 'manual' as const,
    flowAttemptId: 3,
    resolutionHandler: 'workflow' as const,
    workflowHumanGate: true,
  }
  const queued = workStream({ openWaits: [{ ...question, flowAttemptId: 3 }, gate] })
  expect(workStreamPeekFacts(queued).waitLabel).toBe('Waiting on you: question · review next')
  // A gate nothing blocks is the person's review now, not a queued one.
  expect(workStreamPeekFacts(workStream({ openWaits: [gate] })).waitLabel).toBe('Waiting on you: review')

  const { doc, wait, peekCard, mouse } = await render(feedList([queued]))
  const row = doc.querySelector('[data-testid="feed-work-row"]')!
  expect(row.textContent).not.toContain('Review queued')
  await mouse(row, 'mouseover')
  await wait(WORK_STREAM_PEEK_OPEN_DELAY_MS + 100)
  expect(peekCard()!.textContent).toContain('Waiting on you: question · review next')
})

test('keyboard focus opens the peek at once; Escape and blur dismiss it; the row is described by it', async () => {
  const { doc, peekCard, key, keyboardFocus, wait } = await render(feedList([workStream()]))
  const button = doc.querySelector<HTMLButtonElement>('[data-testid="feed-work-row"] button')!
  const description = doc.getElementById(button.getAttribute('aria-describedby')!)!
  expect(description.textContent).toContain(`Generated summary: ${SUMMARY}`)
  expect(description.textContent).toContain('Step: Implement')

  await keyboardFocus(button)
  expect(peekCard()?.textContent).toContain(SUMMARY)
  await key('Escape')
  expect(peekCard()).toBeNull()

  await dom!.act(async () => button.blur())
  await keyboardFocus(button)
  expect(peekCard()).not.toBeNull()
  await dom!.act(async () => button.blur())
  await wait(200)
  expect(peekCard()).toBeNull()
})

test('touch never opens the peek on hover', async () => {
  const { doc, wait, peekCard } = await render(feedList([workStream()]))
  const row = doc.querySelector('[data-testid="feed-work-row"]')!
  await dom!.act(async () => {
    const enter = new dom!.window.MouseEvent('pointerover', { bubbles: true }) as MouseEvent & { pointerType: string }
    Object.defineProperty(enter, 'pointerType', { value: 'touch' })
    row.dispatchEvent(enter)
    row.dispatchEvent(new dom!.window.MouseEvent('mouseover', { bubbles: true }))
  })
  await wait(WORK_STREAM_PEEK_OPEN_DELAY_MS + 100)
  expect(peekCard()).toBeNull()
})

test('"Summaries" is on by default, shows the line under active rows only, and is remembered per surface', async () => {
  const done = workStream({ id: 'ws-2', title: 'Finished work', status: 'done', derivedState: 'done' })
  const { doc, draw } = await render(feedList([workStream(), done]))
  const lines = [...doc.querySelectorAll('[data-testid="work-stream-summary-line"]')]
  expect(lines.map((line) => line.textContent)).toEqual([SUMMARY])
  expect(lines[0]!.getAttribute('title')).toContain('Generated summary')
  const toggle = await feedSwitch(doc)
  expect(toggle.getAttribute('aria-checked')).toBe('true')

  await dom!.act(async () => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()
  expect(dom!.window.localStorage.getItem(workStreamSummariesStorageKey('feed'))).toBe('false')

  // The Work tab remembers its own choice: still on there.
  await draw(<SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} />)
  expect(doc.querySelector('[data-testid="show-summaries-work"]')?.getAttribute('aria-checked')).toBe('true')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')?.textContent).toBe(SUMMARY)

  // Back on the Feed, the choice is still off.
  await draw(feedList([workStream()]))
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()
})

const homeList = () => (
  <SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} compact activeOnly />
)
const homeSwitch = (doc: Document) => doc.querySelector<HTMLButtonElement>('[data-testid="show-summaries-home"]')!

test('Home shows summaries by default and remembers turning them off across a remount', async () => {
  const { doc, draw } = await render(homeList())
  expect(homeSwitch(doc).getAttribute('aria-checked')).toBe('true')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')?.textContent).toBe(SUMMARY)

  await dom!.act(async () => homeSwitch(doc).click())
  expect(homeSwitch(doc).getAttribute('aria-checked')).toBe('false')
  expect(dom!.window.localStorage.getItem(workStreamSummariesStorageKey('home'))).toBe('false')

  // Unmount, then mount Home again: the choice comes back from storage.
  await draw(null)
  expect(homeSwitch(doc)).toBeNull()
  await draw(homeList())
  expect(homeSwitch(doc).getAttribute('aria-checked')).toBe('false')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()

  // Turning it back on is remembered the same way.
  await dom!.act(async () => homeSwitch(doc).click())
  expect(dom!.window.localStorage.getItem(workStreamSummariesStorageKey('home'))).toBe('true')
  await draw(null)
  await draw(homeList())
  expect(homeSwitch(doc).getAttribute('aria-checked')).toBe('true')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')?.textContent).toBe(SUMMARY)
})

test('a corrupt stored "Summaries" value falls back to on', async () => {
  const { doc } = await render(homeList(), { [workStreamSummariesStorageKey('home')]: '{not-a-boolean' })
  expect(homeSwitch(doc).getAttribute('aria-checked')).toBe('true')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')?.textContent).toBe(SUMMARY)
})

test('a summary generated for an older step is not shown', async () => {
  const stale = workStream({ step: 'Code review' })
  const { doc } = await render(feedList([stale]))
  const toggle = await feedSwitch(doc)
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()
  const button = doc.querySelector<HTMLButtonElement>('[data-testid="feed-work-row"] button')!
  expect(doc.getElementById(button.getAttribute('aria-describedby')!)!.textContent).not.toContain(SUMMARY)
})

test('Home puts the switch in the Active header; the Work list rows peek on focus', async () => {
  const { doc, peekCard, keyboardFocus } = await render(
    <SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} compact activeOnly />
  )
  expect(doc.querySelector('[data-testid="show-summaries-home"]')).not.toBeNull()
  const title = [...doc.querySelectorAll<HTMLButtonElement>('li button')].find((button) =>
    button.textContent?.endsWith('Work stream summaries')
  )!
  await keyboardFocus(title)
  expect(peekCard()?.textContent).toContain(SUMMARY)
})

test('the board card shows the summary inline', async () => {
  const { doc } = await render(<SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} />)
  // Choose the board view the way the toggle does.
  await dom!.act(async () => {
    dom!.window.localStorage.setItem(`ficus.wsView.${squad.id}`, 'kanban')
    dom!.window.dispatchEvent(
      new dom!.window.CustomEvent('ficus:work-stream-view-changed', { detail: `work:${squad.id}` })
    )
  })
  const line = doc.querySelector('[data-testid="work-stream-card-summary"]')!
  expect(line.textContent).toBe(SUMMARY)
  expect(line.className).toContain('line-clamp-2')
})

test('graph nodes peek on hover and focus', async () => {
  const { doc, peekCard, keyboardFocus, mouse, wait, key } = await render(
    <WorkStreamGraph
      workStreams={[workStream()]}
      agentMap={new Map(agents.map((agent) => [agent.id, agent as never]))}
      onSelectWorkStream={() => undefined}
    />
  )
  const node = doc.querySelector<SVGGElement>('g[role="button"]')!
  expect(doc.getElementById(node.getAttribute('aria-describedby')!)!.textContent).toContain(SUMMARY)
  await mouse(node, 'mouseover')
  await wait(WORK_STREAM_PEEK_OPEN_DELAY_MS + 100)
  expect(peekCard()?.textContent).toContain(SUMMARY)
  await mouse(node, 'mouseout')
  await wait(200)
  expect(peekCard()).toBeNull()
  await keyboardFocus(node)
  expect(peekCard()?.textContent).toContain(SUMMARY)
  await key('Escape')
  expect(peekCard()).toBeNull()
})

test('the detail modal shows the summary as "Now" under the title', async () => {
  const { doc } = await render(
    <WorkStreamDetailModal
      workStream={workStream()}
      squadMap={new Map([[squad.id, squad]])}
      agentMap={new Map()}
      onClose={() => undefined}
    />
  )
  const now = doc.querySelector('[data-testid="work-stream-now"]')!
  expect(now.textContent).toContain('Now')
  expect(now.textContent).toContain(SUMMARY)
  expect(now.textContent).toContain('Generated summary · updated 4 min ago')
})

test('"Summaries" sits with the view controls on Work and Home, and in the Feed\'s Filters panel under View', async () => {
  const { doc, draw } = await render(feedList([workStream()]))
  // The Feed: not in the list header, but a padded row in the Filters panel's View group.
  expect(doc.querySelector('[data-testid="show-summaries-feed"]')).toBeNull()
  const feed = await feedSwitch(doc)
  expect(feed.getAttribute('aria-label')).toBe('Show work stream summaries')
  expect(feed.textContent).toContain('Summaries')
  expect(feed.closest('[aria-label="Feed filters"]')).not.toBeNull()
  expect(feed.closest('[role="group"]')?.getAttribute('aria-label')).toBe('View')

  // Work tab: the filter row holds only Filters and the page action; the switch is with List / Kanban / Graph.
  await draw(<SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} />)
  const work = doc.querySelector('[data-testid="show-summaries-work"]')!
  const viewToggle = doc.querySelector('[aria-label="Work stream view"]')!
  expect(work.closest('section')).toBe(viewToggle.closest('section'))
  expect(doc.querySelector('[data-testid="work-stream-filters"]')!.closest('section')).toBeNull()
  // The board has no summary lines to toggle (cards always show it), so the switch is not offered there.
  await dom!.act(async () => {
    dom!.window.localStorage.setItem(`ficus.wsView.${squad.id}`, 'kanban')
    dom!.window.dispatchEvent(
      new dom!.window.CustomEvent('ficus:work-stream-view-changed', { detail: `work:${squad.id}` })
    )
  })
  expect(doc.querySelector('[data-testid="show-summaries-work"]')).toBeNull()

  // Home: inside the Active header, and the graph action is labelled and set apart from it.
  await draw(
    <SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} compact activeOnly expandable />
  )
  const home = doc.querySelector('[data-testid="show-summaries-home"]')!
  const graph = doc.querySelector<HTMLButtonElement>('button[aria-label="Show work stream graph"]')!
  expect(graph.textContent).toBe('Graph')
  expect(home.parentElement!.parentElement).toBe(graph.parentElement)
  expect(graph.previousElementSibling?.getAttribute('aria-hidden')).toBe('true')
})

test('peek card participants link to their chats: click navigates, Shift/Alt-click is a floating-window target, keyboard reaches them', async () => {
  const { doc, wait, peekCard, mouse, keyboardFocus } = await render(
    <>
      <LocationProbe />
      <WorkStreamList
        workStreams={[workStream()]}
        squadMap={new Map([[squad.id, squad]])}
        agentMap={new Map(agents.map((agent) => [agent.id, agent]))}
        squads={[squad]}
        feedLayout
        hideFilters
        summarySurface="feed"
      />
    </>
  )
  const row = doc.querySelector('[data-testid="feed-work-row"]')!
  await mouse(row, 'mouseover')
  await wait(WORK_STREAM_PEEK_OPEN_DELAY_MS + 100)
  const card = peekCard()!
  // Moving the pointer from the row into the card keeps it open.
  await dom!.act(async () => {
    row.dispatchEvent(new dom!.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: card }))
    card.dispatchEvent(new dom!.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: row }))
  })
  await wait(300)
  expect(peekCard()).toBe(card)

  const links = [...card.querySelectorAll<HTMLAnchorElement>('[data-testid="work-stream-peek-participant"]')]
  expect(links.map((link) => link.textContent)).toEqual(['Engineer', 'Reviewer'])
  expect(links[0].getAttribute('href')).toBe('/squads/squad-1/agents?agent=agent-1')
  expect(links[0].tagName).toBe('A')
  expect(links[0].tabIndex).toBe(0)
  // The same recognition the floating windows use for Shift- or Alt/Option-click on the row subtitle.
  expect(agentChatTargetOf(links[1], dom!.window.location.origin)).toBe('agent-2')

  await dom!.act(async () => links[0].click())
  expect(doc.querySelector('[data-testid="location"]')?.textContent).toBe('/squads/squad-1/agents?agent=agent-1')
  // Following the link closes the card and does not open the row's own stream dialog.
  expect(peekCard()).toBeNull()
  expect(doc.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull()

  // Keyboard: focus the row (the card opens), then the links are in the card's tab order.
  const button = doc.querySelector<HTMLButtonElement>('[data-testid="feed-work-row"] button')!
  await keyboardFocus(button)
  const again = peekCard()!
  const link = again.querySelector<HTMLAnchorElement>('[data-testid="work-stream-peek-participant"]')!
  await dom!.act(async () => link.focus())
  expect(doc.activeElement).toBe(link)
  expect(peekCard()).toBe(again)
})
