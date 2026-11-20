import { expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { acquireDomHarness } from '../../test/domHarness'
import type { ActivityWorkStreamCard, SquadActivityItem } from '@ficus/shared'
import { ActivityFeedView } from './ActivityFeedView'

test('global and squad previews keep links separate from the source anchor', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  let opened = 0
  try {
    for (const global of [false, true]) {
      const view = dom.createRoot()
      await dom.act(() =>
        view.root.render(
          <MemoryRouter>
            <ActivityFeedView
              kinds={[]}
              onKindsChange={() => {}}
              isLoading={false}
              isError={false}
              items={[
                {
                  id: '10:test',
                  at: new Date().toISOString(),
                  agentId: null,
                  agentTypeId: null,
                  kind: 'message',
                  summary: '#241 docs bold',
                  preview: [
                    { text: '#241', href: 'ficus:ws:241' },
                    { text: ' docs', href: 'https://example.com' },
                    { text: ' bold', bold: true },
                    { text: 'bad', href: 'javascript:alert(1)' },
                  ],
                  ref: { type: 'agent', agentId: 'agent', view: 'chat' },
                },
              ]}
              loadingShapeKey="test"
              workingAgentIds={new Set()}
              agentDetailFor={() => undefined}
              hrefFor={() => '/source'}
              onOpenAgentReference={() => {}}
              onOpen={() => {
                opened++
              }}
              squadChipFor={global ? () => ({ label: 'Ficus', href: '/squads/tau' }) : undefined}
              hasNextPage={false}
              isFetchingNextPage={false}
              onLoadMore={() => {}}
            />
          </MemoryRouter>
        )
      )
      const row = dom.window.document.querySelector('li')!
      expect(row.querySelector('a a, a button, button a')).toBeNull()
      expect(row.textContent).toContain('#241 docs boldbad')
      expect(row.querySelector('strong')?.textContent).toBe(' bold')
      expect(row.querySelector('[href^="javascript:"]')).toBeNull()
      const external = row.querySelector<HTMLAnchorElement>('a[href="https://example.com"]')!
      expect(external?.target).toBe('_blank')
      const before = opened
      await dom.act(() => external.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
      expect(opened).toBe(before)
      const source = row.querySelector<HTMLAnchorElement>('a[href="/source"]')!
      await dom.act(() => source.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })))
      expect(opened).toBe(before)
      await dom.act(() => source.click())
      expect(opened).toBe(before + 1)
      await dom.act(() => view.root.unmount())
    }
  } finally {
    await dom.cleanup()
  }
})

test('activity references do not fetch entity sources merely by scrolling into view', async () => {
  const { ActivityPreview } = await import('./ActivityPreview')
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const original = globalThis.IntersectionObserver
  let observers = 0
  globalThis.IntersectionObserver = class {
    constructor() {
      observers++
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  try {
    const view = dom.createRoot()
    await dom.act(() => view.root.render(<ActivityPreview spans={[{ text: '#241', href: 'ficus:ws:241' }]} />))
    expect(observers).toBe(0)
  } finally {
    await dom.cleanup()
    globalThis.IntersectionObserver = original
  }
})

test('explicitly linked code labels stay clickable while unlinked code is literal', async () => {
  const { ActivityPreview } = await import('./ActivityPreview')
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <ActivityPreview
          spans={[
            { text: 'API', code: true, href: 'https://example.com' },
            { text: '[literal](https://example.com)', code: true },
          ]}
        />
      )
    )
    expect(view.container.querySelectorAll('a')).toHaveLength(1)
    expect(view.container.querySelector('a code')?.textContent).toBe('API')
    expect(view.container.querySelectorAll('code')).toHaveLength(2)
  } finally {
    await dom.cleanup()
  }
})

test('subjects identify row destinations, not actors, in both feeds', async () => {
  const { squadActivityItemHref } = await import('./squadActivityView')
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const common = { at: new Date().toISOString(), agentId: 'recipient', agentTypeId: 'engineer' }
  const items = [
    {
      ...common,
      id: '20:received',
      kind: 'message' as const,
      summary: 'Received message from Manager: hello',
      ref: { type: 'agent' as const, agentId: 'recipient', view: 'inbox' as const, messageId: 'received' },
    },
    {
      ...common,
      id: '22:report',
      kind: 'subagent' as const,
      summary: 'Received report from Subagent (audit): done',
      ref: { type: 'agent' as const, agentId: 'recipient', view: 'inbox' as const },
    },
    {
      ...common,
      id: '60:spawn',
      kind: 'execution' as const,
      summary: 'Subagent spawned.',
      ref: { type: 'agent' as const, agentId: 'recipient', view: 'chat' as const },
    },
    {
      ...common,
      id: '40:wait',
      kind: 'wait' as const,
      summary: 'Review opened',
      ref: { type: 'workstream' as const, workStreamId: 'work', workStreamNumber: 42 },
    },
    {
      ...common,
      id: '70:pr',
      kind: 'pr' as const,
      summary: 'Reviewed by octocat',
      ref: { type: 'pr' as const, url: 'https://github.com/acme/app/pull/123' },
    },
    {
      ...common,
      id: '21:system',
      kind: 'message' as const,
      summary: 'Received system notification: CI passed',
      ref: { type: 'agent' as const, agentId: 'recipient', view: 'inbox' as const },
    },
  ].map((item) => ({ ...item, preview: [{ text: item.summary }] }))
  try {
    for (const global of [false, true]) {
      const opened: string[] = []
      const view = dom.createRoot()
      await dom.act(() =>
        view.root.render(
          <MemoryRouter>
            <ActivityFeedView
              kinds={[]}
              onKindsChange={() => {}}
              isLoading={false}
              isError={false}
              items={items}
              loadingShapeKey="subjects"
              workingAgentIds={new Set(['recipient'])}
              agentDetailFor={() => 'Engineer detail'}
              hrefFor={(item) => squadActivityItemHref(item, 'team')}
              onOpen={(item) => {
                opened.push(item.id)
              }}
              onOpenAgentReference={() => {}}
              squadChipFor={global ? () => ({ label: 'Team', href: '/squads/team/activity' }) : undefined}
              hasNextPage={false}
              isFetchingNextPage={false}
              onLoadMore={() => {}}
            />
          </MemoryRouter>
        )
      )
      const rows = [...view.container.querySelectorAll('li')]
      expect(rows.map((row) => row.querySelector('[data-activity-column="agent"]')?.textContent)).toEqual([
        'Engineer',
        'Engineer',
        'Engineer',
        'Work stream #42',
        'PR #123',
        'Engineer',
      ])
      expect(rows[3].textContent).toContain('By Engineer')
      expect(rows[3].querySelector('[data-activity-column="agent"]')?.getAttribute('title')).not.toBe('Engineer detail')
      expect(view.container.querySelectorAll('[title="Working now"]')).toHaveLength(1)
      const received = rows[0].querySelector<HTMLAnchorElement>('a[aria-label^="Open activity source"]')!
      expect(received.getAttribute('href')).toBe('/squads/team?agent=recipient&view=inbox')
      await dom.act(() => received.click())
      expect(opened).toEqual(['20:received'])
      const work = rows[3].querySelector<HTMLAnchorElement>('a[aria-label^="Open activity source"]')!
      expect(work.getAttribute('href')).toBe('/squads/team/work?ws=42')
      await dom.act(() => work.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ctrlKey: true })))
      expect(opened).toEqual(['20:received'])
      await dom.act(() => work.click())
      expect(opened).toEqual(['20:received', '40:wait'])
      const pr = rows[4].querySelector<HTMLAnchorElement>('a[aria-label^="Open activity source"]')!
      expect(pr.href).toBe('https://github.com/acme/app/pull/123')
      expect(pr.target).toBe('_blank')
      await dom.act(() => view.root.unmount())
    }
  } finally {
    await dom.cleanup()
  }
})

const streamContext = {
  id: '00000000-0000-4000-8000-000000001352',
  number: 1352,
  title: 'Floating agent windows',
  squadId: 'squad',
  status: 'active' as const,
  step: 'Implement',
}

function card(overrides: Partial<ActivityWorkStreamCard> = {}): ActivityWorkStreamCard {
  return {
    id: streamContext.id,
    number: 1352,
    squadId: 'squad',
    title: 'Floating agent windows',
    status: 'active',
    step: 'Implement',
    waits: [],
    needsYou: false,
    pullRequest: null,
    ci: null,
    deliveryLabel: null,
    workingAgentIds: [],
    lastEventAt: new Date().toISOString(),
    ...overrides,
  }
}

const feedProps = {
  kinds: [],
  onKindsChange: () => {},
  isLoading: false,
  isError: false,
  loadingShapeKey: 'context',
  workingAgentIds: new Set<string>(),
  agentDetailFor: () => undefined,
  hrefFor: (item: SquadActivityItem) =>
    item.ref.type === 'workstream' ? `/squads/team/work?ws=${item.ref.workStreamNumber}` : '/source',
  onOpenAgentReference: () => {},
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: () => {},
}

test('agent rows show their stream (opening it in place) or their purpose, never both', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const opened: SquadActivityItem[] = []
  const at = new Date().toISOString()
  const items: SquadActivityItem[] = [
    {
      id: '10:engineer',
      at,
      agentId: 'engineer',
      agentTypeId: 'engineer',
      kind: 'message',
      summary: 'Now the shared frame component',
      preview: [{ text: 'Now the shared frame component' }],
      ref: { type: 'agent', agentId: 'engineer', view: 'chat' },
      context: { workStream: streamContext, purpose: 'not shown' },
    },
    {
      id: '10:manager',
      at,
      agentId: 'manager',
      agentTypeId: 'manager',
      kind: 'message',
      summary: 'Checking the queue',
      preview: [{ text: 'Checking the queue' }],
      ref: { type: 'agent', agentId: 'manager', view: 'chat' },
      context: { purpose: 'Squad coordination' },
    },
    {
      id: '10:consultant',
      at,
      agentId: 'consultant',
      agentTypeId: 'consultant',
      kind: 'message',
      summary: 'Hello',
      preview: [{ text: 'Hello' }],
      ref: { type: 'agent', agentId: 'consultant', view: 'chat' },
    },
  ]
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <MemoryRouter>
          <ActivityFeedView {...feedProps} items={items} onOpen={(item) => opened.push(item)} />
        </MemoryRouter>
      )
    )
    const rows = [...view.container.querySelectorAll('li')]
    const stream = rows[0].querySelector<HTMLAnchorElement>('[data-activity-context="work-stream"] a')!
    expect(stream.textContent).toBe('#1352 Floating agent windows · Implement')
    expect(stream.getAttribute('href')).toBe('/squads/team/work?ws=1352')
    expect(rows[0].textContent).not.toContain('not shown')
    expect(rows[1].querySelector('[data-activity-context="purpose"]')?.textContent).toBe('Squad coordination')
    expect(rows[1].querySelector('[data-activity-context="work-stream"]')).toBeNull()
    expect(rows[2].querySelector('[data-activity-context]')).toBeNull()
    expect(rows[0].querySelector('a a, a button, button a')).toBeNull()

    // Modified clicks keep navigation; a plain click opens the stream in place, not the agent.
    await dom.act(() => stream.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, metaKey: true })))
    expect(opened).toHaveLength(0)
    await dom.act(() => stream.click())
    expect(opened.map((item) => item.ref)).toEqual([
      { type: 'workstream', workStreamId: streamContext.id, workStreamNumber: 1352 },
    ])
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('sender rows hide only while a matching received row is shown, and Show everything restores them', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const at = '2026-11-20T08:00:00.000Z'
  const sender: SquadActivityItem = {
    id: '10:exec',
    at,
    agentId: 'engineer',
    agentTypeId: 'engineer',
    kind: 'message',
    summary: 'Sending the handoff',
    preview: [{ text: 'Sending the handoff' }],
    ref: { type: 'agent', agentId: 'engineer', view: 'chat' },
  }
  const received = (id: string, recipient: string): SquadActivityItem => ({
    id,
    at: '2026-11-20T08:00:02.000Z',
    agentId: recipient,
    agentTypeId: 'manager',
    kind: 'message',
    summary: 'Received message from Engineer: handoff',
    preview: [{ text: 'Received message from Engineer: handoff' }],
    ref: { type: 'agent', agentId: recipient, view: 'inbox' },
    senderActivityId: '10:exec',
  })
  const changes: boolean[] = []
  try {
    const view = dom.createRoot()
    const render = (items: SquadActivityItem[], showEverything = false) =>
      dom.act(() =>
        view.root.render(
          <MemoryRouter>
            <ActivityFeedView
              {...feedProps}
              items={items}
              onOpen={() => {}}
              showEverything={showEverything}
              onShowEverythingChange={(value) => changes.push(value)}
            />
          </MemoryRouter>
        )
      )
    const ids = () =>
      [...view.container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Open activity source"]')].map((a) =>
        a.getAttribute('aria-label')
      )

    await render([received('20:a', 'manager'), received('20:b', 'reviewer'), sender])
    expect(ids()).toHaveLength(2)
    expect(view.container.textContent).not.toContain('Sending the handoff')

    // The received rows are filtered out (or belong to a squad the viewer cannot see): keep the sender.
    await render([sender])
    expect(view.container.textContent).toContain('Sending the handoff')

    await render([received('20:a', 'manager'), sender], true)
    expect(view.container.textContent).toContain('Sending the handoff')
    expect(ids()).toHaveLength(2)

    const toggle = view.container.querySelector<HTMLButtonElement>('[data-testid="activity-show-everything"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await dom.act(() => toggle.click())
    expect(changes).toEqual([false])
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('the Active work list shows one row per stream, counts what the rows show, caps at five and filters on click', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  dom.window.localStorage.removeItem('ficus.activityWork.expanded')
  const cards = [
    card({
      waits: [{ type: 'review', needsYou: true }],
      needsYou: true,
      pullRequest: { number: 996, repository: 'ficushq/ficus', state: 'open' },
      ci: 'failing',
      deliveryLabel: 'CI failed',
      workingAgentIds: ['engineer', 'reviewer'],
    }),
    card({ id: 'working', number: 1395, title: 'Spend tiers', step: 'implement', workingAgentIds: ['engineer-2'] }),
    card({ id: 'paused', number: 1392, title: 'Linear verification', step: 'Verify', derivedState: 'paused' }),
    card({
      id: 'blocked',
      number: 1391,
      title: 'Dependency',
      step: 'Verify',
      waits: [{ type: 'dependency', needsYou: false }],
    }),
    ...Array.from({ length: 4 }, (_, index) =>
      card({ id: `stream-${index}`, number: 2000 + index, title: `Other ${index}`, step: null, status: 'queued' })
    ),
  ]
  let filter: string | null = null
  try {
    const view = dom.createRoot()
    const render = () =>
      dom.act(() =>
        view.root.render(
          <MemoryRouter>
            <ActivityFeedView
              {...feedProps}
              items={[]}
              onOpen={() => {}}
              workingAgentIds={new Set(['engineer', 'reviewer', 'engineer-2', 'manager'])}
              presence={{ workingCount: 4, needsYouCount: 1, streamCount: 9, streams: cards }}
              workStreamFilter={filter}
              onWorkStreamFilterChange={(next) => {
                filter = next
              }}
              workListHref="/squads/team/work"
            />
          </MemoryRouter>
        )
      )
    await render()
    const list = view.container.querySelector('[data-testid="activity-work-list"]')!
    // The header counts the rows by state; agents outside every listed stream are counted apart.
    const counts = list.querySelector('[data-testid="activity-presence"]')!.textContent
    expect(counts).toContain('1 waiting on you')
    expect(counts).toContain('1 working')
    expect(counts).toContain('1 waiting')
    expect(counts).toContain('1 paused')
    expect(counts).toContain('4 queued')
    expect(counts).toContain('1 other agent working')
    expect(counts).not.toContain('active streams')

    const rows = () => [...list.querySelectorAll<HTMLButtonElement>('button[data-work-stream-card]')]
    expect(rows()).toHaveLength(5)
    const first = rows()[0]
    expect(first.textContent).toContain('#1352 Floating agent windows')
    expect(first.textContent).toContain('Waiting on you: review · Implement')
    expect(first.textContent).toContain('PR #996 · CI failing')
    expect(first.textContent).not.toContain('CI failed')
    expect(first.querySelector('time')?.getAttribute('dateTime')).toBe(cards[0].lastEventAt)
    // One state each, marked differently: working, paused and waiting never look alike.
    expect(rows().map((row) => row.getAttribute('data-activity-work-state'))).toEqual([
      'needs-you',
      'working',
      'paused',
      'waiting',
      'queued',
    ])
    // Step labels are normalized ("implement" reads "Implement"); a paused row does not repeat itself.
    expect(rows()[1].textContent).toContain('Working · Implement')
    expect(rows()[2].textContent).toContain('Paused · Verify')
    expect(rows()[3].textContent).toContain('Waiting: dependency · Verify')
    expect(rows()[4].textContent).toContain('Queued')

    // "Show 3 more" expands in place and is remembered; streams past the server's cards link to the list.
    const more = [...list.querySelectorAll('button')].find((button) => button.textContent === 'Show 3 more')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(list.querySelector<HTMLAnchorElement>('a[href="/squads/team/work"]')?.textContent).toBe(
      'All 9 active streams'
    )
    await dom.act(() => more.click())
    expect(rows()).toHaveLength(8)
    expect(dom.window.localStorage.getItem('ficus.activityWork.expanded')).toBe('true')
    const fewer = [...list.querySelectorAll('button')].find((button) => button.textContent === 'Show fewer')!
    expect(fewer.getAttribute('aria-expanded')).toBe('true')
    await dom.act(() => fewer.click())
    expect(rows()).toHaveLength(5)
    expect(dom.window.localStorage.getItem('ficus.activityWork.expanded')).toBeNull()

    await dom.act(() => first.click())
    expect(filter).toBe(streamContext.id)
    await render()
    const selected = view.container.querySelector<HTMLButtonElement>('button[data-work-stream-card="1352"]')!
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    // Clicking the selected row again clears the filter; so does Clear in the details panel.
    await dom.act(() => selected.click())
    expect(filter).toBeNull()
    filter = 'stream-3'
    await render()
    // A selected row beyond the cap stays visible.
    expect(view.container.querySelector('button[data-work-stream-card="2003"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
    const clear = [...view.container.querySelectorAll('button')].find((button) => button.textContent === 'Clear')!
    await dom.act(() => clear.click())
    expect(filter).toBeNull()
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('Summaries shows each row a full-width summary line, never an empty gap, and is remembered', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  dom.window.localStorage.removeItem('ficus.wsSummaries.activity')
  const cards = [
    card({ summary: 'Writing tests for holding human PR comments', summaryGeneratedAt: new Date().toISOString() }),
    card({ id: 'no-summary', number: 7, title: 'Quiet stream' }),
  ]
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <MemoryRouter>
          <ActivityFeedView
            {...feedProps}
            items={[]}
            onOpen={() => {}}
            presence={{ workingCount: 0, needsYouCount: 0, streamCount: 2, streams: cards }}
            onWorkStreamFilterChange={() => {}}
          />
        </MemoryRouter>
      )
    )
    const toggle = view.container.querySelector<HTMLButtonElement>('[data-testid="show-summaries-activity"]')!
    expect(toggle.textContent).toBe('Summaries')
    expect(toggle.getAttribute('aria-label')).toBe('Show work stream summaries')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const lines = () => [...view.container.querySelectorAll('[data-testid="activity-work-summary"]')]
    expect(lines().map((line) => line.textContent)).toEqual(['Writing tests for holding human PR comments'])
    const quiet = view.container.querySelector('button[data-work-stream-card="7"]')!
    expect(quiet.children).toHaveLength(2) // the title line and the narrow-width state line, no summary slot
    await dom.act(() => toggle.click())
    expect(lines()).toHaveLength(0)
    expect(dom.window.localStorage.getItem('ficus.wsSummaries.activity')).toBe('false')
    await dom.act(() => toggle.click())
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('the selected stream details show everything in full and open the stream and a chat in place', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const longTitle =
    'Deliver human PR comments when the commenter is the GitHub connection account, and record skipped deliveries'
  const longSummary =
    "Writing tests for holding human PR comments from the GitHub connection account's author filter, then the docs."
  const selected = card({
    title: longTitle,
    step: 'implement',
    summary: longSummary,
    summaryGeneratedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    pullRequest: {
      number: 1026,
      repository: 'ficushq/ficus',
      url: 'https://github.com/ficushq/ficus/pull/1026',
      state: 'open',
    },
    workingAgentIds: ['engineer'],
  })
  const participantRow: SquadActivityItem = {
    id: '10:engineer-row',
    at: new Date().toISOString(),
    agentId: 'engineer',
    agentTypeId: 'engineer',
    kind: 'message',
    summary: 'Renewing the claim',
    preview: [{ text: 'Renewing the claim' }],
    ref: { type: 'agent', agentId: 'engineer', view: 'chat' },
    context: { workStream: { ...streamContext, title: longTitle, step: 'implement' } },
  }
  const opened: SquadActivityItem[] = []
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <MemoryRouter>
          <ActivityFeedView
            {...feedProps}
            items={[participantRow]}
            onOpen={(item) => opened.push(item)}
            presence={{ workingCount: 1, needsYouCount: 0, streamCount: 1, streams: [selected] }}
            workStreamFilter={selected.id}
            onWorkStreamFilterChange={() => {}}
          />
        </MemoryRouter>
      )
    )
    const panel = view.container.querySelector<HTMLElement>('[data-testid="activity-work-stream-filter"]')!
    expect(panel.tagName).toBe('SECTION')
    const heading = panel.querySelector('h2')!
    expect(panel.getAttribute('aria-labelledby')).toBe(heading.id)
    expect(heading.textContent).toBe(`Showing only activity for #1352 ${longTitle}`)
    expect(panel.querySelector('[data-testid="activity-work-details-summary"]')?.textContent).toContain(longSummary)
    expect(panel.textContent).toContain('Generated summary · updated 4 min ago')
    const state = panel.querySelector('[data-testid="activity-work-details-state"]')!.textContent
    expect(state).toContain('Working')
    expect(state).toContain('Step: Implement')
    expect(state).toContain('Working now: Engineer')
    expect(panel.querySelector<HTMLAnchorElement>('a[href="https://github.com/ficushq/ficus/pull/1026"]')?.target).toBe(
      '_blank'
    )

    const openStream = [...panel.querySelectorAll('a')].find((link) => link.textContent === 'Open work stream')!
    expect(openStream.getAttribute('href')).toBe('/squads/team/work?ws=1352')
    await dom.act(() => openStream.click())
    expect(opened.at(-1)?.ref).toEqual({ type: 'workstream', workStreamId: selected.id, workStreamNumber: 1352 })
    const openChat = panel.querySelector<HTMLAnchorElement>('a[aria-label="Open chat with Engineer"]')!
    expect(openChat.textContent).toBe('Open chat · Engineer')
    await dom.act(() => openChat.click())
    expect(opened.at(-1)?.ref).toEqual({ type: 'agent', agentId: 'engineer', view: 'chat' })
    // A modified click keeps the link's own navigation (new tab, floating window).
    const before = opened.length
    await dom.act(() =>
      openChat.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    )
    expect(opened).toHaveLength(before)

    // Filtered to this stream, the participant row no longer repeats the stream's title and step.
    const row = view.container.querySelector('[data-activity-column="summary"]')!
    expect(row.querySelector('[data-activity-context]')).toBeNull()
    expect(row.textContent).toBe('Renewing the claim')
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('without server cards the strip keeps the plain stream count', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <MemoryRouter>
          <ActivityFeedView
            {...feedProps}
            items={[]}
            onOpen={() => {}}
            presence={{ workingCount: 0, needsYouCount: 0, streamCount: 3 }}
            onWorkStreamFilterChange={() => {}}
          />
        </MemoryRouter>
      )
    )
    expect(view.container.textContent).toContain('3 active streams')
    expect(view.container.querySelector('[data-testid="activity-work-list"]')).toBeNull()
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})

test('a clipped chat row expands in place to its full message, and only the button toggles it', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const at = '2026-11-20T14:27:00.000Z'
  const clipped = (id: string, messageId: string): SquadActivityItem => ({
    id,
    at,
    agentId: 'engineer',
    agentTypeId: 'engineer',
    kind: 'message',
    summary: 'One failure: an existing test asserting own comments create no delivery row. Renewing the c…',
    preview: [
      { text: 'One failure: an existing test asserting own comments create no delivery row. Renewing the c' },
      { text: '…' },
    ],
    ref: { type: 'agent', agentId: 'engineer', view: 'chat', messageId },
  })
  const short: SquadActivityItem = { ...clipped('10:short', 'm-short'), preview: [{ text: 'Short and whole' }] }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const message = (id: string, createdAt: string) => ({
    id,
    agentId: 'engineer',
    role: 'assistant',
    content: 'One failure: an existing test asserting own comments create no delivery row. Renewing the claim **now**.',
    createdAt,
  })
  client.setQueryData(['agents', 'message', 'engineer', 'm-full'], message('m-full', at))
  // Mid-step the row links the previous message: that one is not this row's text.
  client.setQueryData(['agents', 'message', 'engineer', 'm-old'], message('m-old', '2026-11-20T14:20:00.000Z'))
  const opened: SquadActivityItem[] = []
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ActivityFeedView
              {...feedProps}
              items={[clipped('10:full', 'm-full'), clipped('10:live', 'm-old'), short]}
              onOpen={(item) => opened.push(item)}
            />
          </MemoryRouter>
        </QueryClientProvider>
      )
    )
    const rows = [...view.container.querySelectorAll('li')]
    expect(rows[2].querySelector('[data-activity-row-expand]')).toBeNull()
    const toggle = rows[0].querySelector<HTMLButtonElement>('[data-activity-row-expand]')!
    expect(toggle.textContent).toBe('Show more')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await dom.act(() => toggle.click())
    expect(opened).toHaveLength(0)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Show less')
    const full = rows[0].querySelector('[data-activity-row-full]')!
    expect(toggle.getAttribute('aria-controls')).toBe(full.id)
    expect(full.textContent).toContain('Renewing the claim now.')
    expect(full.querySelector('strong')?.textContent).toBe('now')
    await dom.act(() => toggle.click())
    expect(rows[0].querySelector('[data-activity-row-full]')).toBeNull()

    const live = rows[1].querySelector<HTMLButtonElement>('[data-activity-row-expand]')!
    await dom.act(() => live.click())
    expect(rows[1].textContent).toContain('This step is still writing; open the chat for the latest text.')
    await dom.act(() => view.root.unmount())
  } finally {
    client.clear()
    await dom.cleanup()
  }
})

test('without agents:read the details panel shows the stream without chat or participant links', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  // Presence withholds working agents and the feed withholds agent rows from such a viewer.
  const selected = card({ workingAgentIds: [] })
  const streamRow: SquadActivityItem = {
    id: '30:created',
    at: new Date().toISOString(),
    agentId: null,
    agentTypeId: null,
    kind: 'workstream',
    summary: 'created',
    preview: [{ text: 'created' }],
    ref: { type: 'workstream', workStreamId: selected.id, workStreamNumber: selected.number },
  }
  try {
    const view = dom.createRoot()
    await dom.act(() =>
      view.root.render(
        <MemoryRouter>
          <ActivityFeedView
            {...feedProps}
            items={[streamRow]}
            onOpen={() => {}}
            presence={{ workingCount: 0, needsYouCount: 0, streamCount: 1, streams: [selected] }}
            workStreamFilter={selected.id}
            onWorkStreamFilterChange={() => {}}
          />
        </MemoryRouter>
      )
    )
    const panel = view.container.querySelector('[data-testid="activity-work-stream-filter"]')!
    expect(panel.textContent).toContain('Open work stream')
    expect(panel.textContent).not.toContain('Open chat')
    expect(panel.textContent).not.toContain('Working now')
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})
