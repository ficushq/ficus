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

test('the Active work strip shows step, waits, PR and CI, working dots and time, and filters on click', async () => {
  const dom = await acquireDomHarness({ url: 'http://localhost/' })
  const cards = [
    card({
      waits: [{ type: 'review', needsYou: true }],
      needsYou: true,
      pullRequest: { number: 996, repository: 'ficushq/ficus', state: 'open' },
      ci: 'failing',
      deliveryLabel: 'CI failed',
      workingAgentIds: ['engineer', 'reviewer'],
    }),
    ...Array.from({ length: 7 }, (_, index) =>
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
              presence={{ workingCount: 2, needsYouCount: 1, streamCount: 9, streams: cards }}
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
    const presence = view.container.querySelector('[data-testid="activity-presence"]')!
    expect(presence.textContent).toContain('2 working')
    expect(presence.textContent).toContain('1 waiting on you')
    expect(presence.textContent).not.toContain('active streams')

    const strip = view.container.querySelector('[data-testid="activity-work-strip"]')!
    const buttons = [...strip.querySelectorAll<HTMLButtonElement>('button[data-work-stream-card]')]
    expect(buttons).toHaveLength(6)
    const first = buttons[0]
    expect(first.textContent).toContain('#1352 Floating agent windows')
    expect(first.textContent).toContain('Implement · Waiting on you: review')
    expect(first.textContent).toContain('PR #996 · CI failing')
    expect(first.textContent).not.toContain('CI failed')
    expect(first.querySelector('[title="Working now"]')?.textContent).toContain('2 working')
    expect(first.querySelector('time')?.getAttribute('dateTime')).toBe(cards[0].lastEventAt)
    expect(buttons[1].textContent).toContain('Queued')
    const more = strip.querySelector<HTMLAnchorElement>('a[href="/squads/team/work"]')!
    expect(more.textContent).toBe('+3 more')

    await dom.act(() => first.click())
    expect(filter).toBe(streamContext.id)
    await render()
    const selected = view.container.querySelector<HTMLButtonElement>('button[data-work-stream-card="1352"]')!
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(view.container.querySelector('[data-testid="activity-work-stream-filter"]')?.textContent).toContain(
      'Showing #1352 Floating agent windows'
    )
    // Clicking the selected card again clears the filter; so does Clear.
    await dom.act(() => selected.click())
    expect(filter).toBeNull()
    filter = 'stream-6'
    await render()
    // A selected card beyond the cap stays visible.
    expect(view.container.querySelector('button[data-work-stream-card="2006"]')?.getAttribute('aria-pressed')).toBe(
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
    expect(view.container.querySelector('[data-testid="activity-work-strip"]')).toBeNull()
    await dom.act(() => view.root.unmount())
  } finally {
    await dom.cleanup()
  }
})
