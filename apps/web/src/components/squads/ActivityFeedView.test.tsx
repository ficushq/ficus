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
