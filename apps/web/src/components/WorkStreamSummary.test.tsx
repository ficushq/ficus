/**
 * Work stream summaries on the web: the peek card on Feed, Home and Work list rows and graph nodes
 * (hover after a delay, keyboard focus, Escape and blur), the "Show summaries" switch remembered per
 * surface, the board card line and the detail modal's "Now" line.
 */
import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import type { AgentSummary, Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { WorkStreamList } from './WorkStreamList'
import { WorkStreamGraph } from './WorkStreamGraph'
import { WorkStreamDetailModal } from './WorkStreamDetailModal'
import { WorkStreamList as SquadWorkStreamList } from './squads/WorkStreamList'
import { WORK_STREAM_PEEK_OPEN_DELAY_MS, workStreamSummariesStorageKey } from './WorkStreamSummary'

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

async function render(node: ReactNode) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
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

/** Open the Feed's Filters popover and return its "Show summaries" switch. */
async function feedSwitch(doc: Document) {
  const filters = [...doc.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.startsWith('Filters')
  )!
  await dom!.act(async () => filters.click())
  return doc.querySelector<HTMLButtonElement>('[data-testid="show-summaries-feed"]')!
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
  expect(card.textContent).toContain('Updated 4 min ago')
  expect(card.textContent).toContain('Implement · Waiting on you: question')
  expect(card.textContent).toContain('Engineer')
  expect(card.textContent).toContain('Reviewer')
  expect(card.querySelectorAll('[aria-label^="Agent activity"]')).toHaveLength(2)
  await mouse(row, 'mouseout')
  await wait(200)
  expect(peekCard()).toBeNull()
})

test('keyboard focus opens the peek at once; Escape and blur dismiss it; the row is described by it', async () => {
  const { doc, peekCard, key, keyboardFocus, wait } = await render(feedList([workStream()]))
  const button = doc.querySelector<HTMLButtonElement>('[data-testid="feed-work-row"] button')!
  const description = doc.getElementById(button.getAttribute('aria-describedby')!)!
  expect(description.textContent).toContain(SUMMARY)
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

test('"Show summaries" adds the line under active rows only, and is remembered per surface', async () => {
  const done = workStream({ id: 'ws-2', title: 'Finished work', status: 'done', derivedState: 'done' })
  const { doc, draw } = await render(feedList([workStream(), done]))
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()
  const toggle = await feedSwitch(doc)
  expect(toggle.getAttribute('aria-checked')).toBe('false')

  await dom!.act(async () => toggle.click())
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  const lines = [...doc.querySelectorAll('[data-testid="work-stream-summary-line"]')]
  expect(lines.map((line) => line.textContent)).toEqual([SUMMARY])
  expect(dom!.window.localStorage.getItem(workStreamSummariesStorageKey('feed'))).toBe('true')

  // The Work tab remembers its own choice: still off there.
  await draw(<SquadWorkStreamList workStreams={[workStream()]} squadId={squad.id} squad={squad} />)
  expect(doc.querySelector('[data-testid="show-summaries-work"]')?.getAttribute('aria-checked')).toBe('false')
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')).toBeNull()

  // Back on the Feed, the choice is still on.
  await draw(feedList([workStream()]))
  expect(doc.querySelector('[data-testid="work-stream-summary-line"]')?.textContent).toBe(SUMMARY)
})

test('a summary generated for an older step is not shown', async () => {
  const stale = workStream({ step: 'Code review' })
  const { doc } = await render(feedList([stale]))
  const toggle = await feedSwitch(doc)
  await dom!.act(async () => toggle.click())
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
  expect(now.textContent).toContain('updated 4 min ago')
})
