import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { InboxMessageResponse } from '../api/inbox'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { InboxPage } from './InboxPage'
import { InboxPopup } from './InboxPopup'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let client: QueryClient | undefined
afterEach(async () => {
  await dom?.cleanup()
  client?.clear()
})

test('page and popup share rounded, spaced cards for personal/system and unread/read messages', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/inbox' })
  client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.auth.permissions(), {
    permissions: ['inbox:system'],
    identity: { type: 'user', userId: 'test' },
  })
  client.setQueryData(queryKeys.squads.list(), [])
  const message = (id: string, read: boolean, system: boolean): InboxMessageResponse =>
    ({
      id,
      senderType: system ? 'system' : read ? 'user' : 'agent',
      senderId: system ? null : 'sender',
      senderAgent: !system && !read ? { id: 'sender', squadId: null, metadata: { name: 'Ficus' } } : undefined,
      subject: system && read ? null : id,
      content: 'Message body',
      createdAt: new Date().toISOString(),
      readAt: read ? new Date().toISOString() : null,
      metadata: { workStreamId: 'ws-9', squadId: 'sq-2' },
      attachments: [
        {
          id: 'attachment',
          messageId: id,
          filename: 'note.txt',
          contentType: 'text/plain',
          byteSize: 5,
          sha256: 'x',
          createdAt: new Date().toISOString(),
        },
      ],
    }) as InboxMessageResponse
  client.setQueryData(queryKeys.inbox.mine(true), [
    message('Personal unread', false, false),
    message('Personal read', true, false),
  ])
  client.setQueryData(queryKeys.inbox.system(true), [
    message('System unread', false, true),
    message('System read', true, true),
  ])
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={['/inbox']}>
          <div data-surface="page">
            <InboxPage />
          </div>
          <div data-surface="popup">
            <InboxPopup />
          </div>
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  await dom.act(async () => window.dispatchEvent(new CustomEvent('open-inbox-popup')))
  const page = container.querySelector('[data-surface="page"]')!
  const popup = container.querySelector('[data-surface="popup"]')!
  const readToggle = [...popup.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Read messages')
  )!
  await dom.act(async () => readToggle.click())

  for (const surface of [page, popup]) {
    const expandButtons = [...surface.querySelectorAll<HTMLButtonElement>('[aria-label="Expand"]')]
    expect(expandButtons).toHaveLength(4)
    for (const button of expandButtons) {
      const header = button.parentElement!
      const card = header.parentElement!
      expect(card.classList.contains('rounded-lg')).toBe(true)
      expect(header.classList.contains('pl-6')).toBe(true)
      expect(header.classList.contains('pr-3')).toBe(true)
      expect(header.classList.contains('py-3.5')).toBe(true)
      expect(card.parentElement!.classList.contains('space-y-1')).toBe(true)
      expect(card.parentElement!.className).not.toContain('divide-y')
      expect(card.classList.contains('bg-accent/5')).toBe(card.textContent!.includes('unread'))
      const attachment = card.querySelector('a[download="note.txt"]')!
      expect(attachment).not.toBeNull()
      expect(attachment.parentElement!.classList.contains('pl-6')).toBe(true)
      expect(attachment.parentElement!.classList.contains('pr-3')).toBe(true)
      await dom.act(async () => button.click())
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(card.querySelector('a[href="/squads/sq-2/work?ws=ws-9"]')).not.toBeNull()
      const detail = card.lastElementChild!
      expect(detail.classList.contains('pl-6')).toBe(true)
      expect(detail.classList.contains('pr-3')).toBe(true)
    }
  }
  for (const section of page.querySelectorAll('section')) {
    expect(section.classList.contains('p-2')).toBe(true)
    expect(section.classList.contains('overflow-hidden')).toBe(false)
    expect(section.firstElementChild!.classList.contains('pl-6')).toBe(true)
  }
  // The page keeps its mobile controls and URL-synced read-section toggle.
  expect(page.querySelectorAll('[data-testid="inbox-row-meta-mobile"]')).toHaveLength(4)
  expect(popup.querySelector('[data-testid="inbox-row-meta-mobile"]')).toBeNull()
  const pageReadToggle = [...page.querySelectorAll('button')].find((button) => button.textContent === 'Read2')!
  expect(pageReadToggle.classList.contains('rounded-lg')).toBe(true)
  expect(pageReadToggle.classList.contains('focus-visible:outline-offset-[-2px]')).toBe(true)
  await dom.act(async () => pageReadToggle.click())
  expect(pageReadToggle.getAttribute('aria-expanded')).toBe('false')
  expect(page.querySelectorAll('[aria-label="Collapse"]')).toHaveLength(2)
})
