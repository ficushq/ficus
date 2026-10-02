import { expect, test } from 'bun:test'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
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
