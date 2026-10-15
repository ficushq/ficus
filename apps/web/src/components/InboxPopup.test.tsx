import { afterEach, expect, mock, test } from 'bun:test'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { InboxMessageResponse, InboxMessagesPage } from '../api/inbox'
import { INBOX_SEARCH_DEBOUNCE_MS } from '../hooks/useInboxFeed'
import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { InboxPopup } from './InboxPopup'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let client: QueryClient | undefined
const originalIntersectionObserver = globalThis.IntersectionObserver
afterEach(async () => {
  client?.clear()
  await dom?.cleanup()
  globalThis.IntersectionObserver = originalIntersectionObserver
})

const message = (id: string, minute: number, read: boolean, subject = id): InboxMessageResponse =>
  ({
    id,
    senderType: 'system',
    senderId: null,
    subject,
    content: `${id} body`,
    createdAt: new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString(),
    readAt: read ? new Date(Date.UTC(2026, 0, 2)).toISOString() : null,
    metadata: {},
  }) as InboxMessageResponse

/** Serves a list the way the server does: newest first, cursor = last id of the page, total on page 1. */
function serve(all: InboxMessageResponse[], params: URLSearchParams): InboxMessagesPage {
  const limit = Number(params.get('limit'))
  const start = params.get('cursor') ? all.findIndex((m) => m.id === params.get('cursor')) + 1 : 0
  const items = all.slice(start, start + limit)
  const hasMore = start + limit < all.length
  return {
    items,
    hasMore,
    nextCursor: hasMore ? items[items.length - 1]!.id : null,
    totalCount: params.get('cursor') ? 0 : all.length,
  }
}

// 130 read personal messages (more than the old 100 cap) plus a few in the system inbox.
const personalRead = Array.from({ length: 130 }, (_, i) => message(`read-${i}`, 1000 - i, true))
// Falls between read-60 and read-61, i.e. on the personal inbox's second page.
const systemRead = [message('system-read', 939.5, true)]
const personalUnread = [message('personal-unread', 2000, false)]
const systemUnread = [message('system-unread', 1990, false)]
const needles = [message('needle-new', 1500, false, 'Needle'), message('needle-old', 5, true, 'Old needle')]

async function renderPopup() {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const requests: URL[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://x')
    requests.push(url)
    const system = url.pathname.endsWith('/inbox/system/system')
    const search = url.searchParams.get('search')
    const state = url.searchParams.get('readState') ?? (url.searchParams.get('all') ? 'all' : 'unread')
    const list = search
      ? system
        ? []
        : needles.filter((m) => `${m.subject} ${m.content}`.toLowerCase().includes(search.toLowerCase()))
      : state === 'unread'
        ? system
          ? systemUnread
          : personalUnread
        : system
          ? systemRead
          : personalRead
    return new dom!.window.Response(JSON.stringify(serve(list, url.searchParams)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch

  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.auth.permissions(), {
    permissions: ['inbox:system'],
    identity: { type: 'user', userId: 'test' },
  })
  client.setQueryData(queryKeys.squads.list(), [])
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter>
          <InboxPopup />
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const settle = (ms = 30) => dom!.act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))))
  await dom.act(async () => window.dispatchEvent(new CustomEvent('open-inbox-popup')))
  await settle()
  const subjects = () =>
    [...container.querySelectorAll('[aria-label="Expand"]')].map(
      (button) => button.parentElement!.querySelector('.mt-1 p')!.textContent
    )
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text))
  return { container, requests, settle, subjects, button }
}

test('shows the server totals and pages the read archive past 100 messages', async () => {
  const { container, settle, subjects, button } = await renderPopup()

  expect(container.textContent).toContain('2 unread')
  expect(subjects()).toEqual(['personal-unread', 'system-unread'])
  // The real total across both inboxes, not the size of the loaded page.
  expect(button('Read messages')!.textContent).toBe('Read messages (131)')

  await dom!.act(async () => button('Read messages')!.click())
  // The first personal page ends at read-49; the older system message stays held back until the
  // personal inbox has loaded past it, so the merged order never jumps.
  expect(subjects()).toHaveLength(2 + 50)
  expect(subjects()).not.toContain('system-read')

  for (let page = 0; page < 2; page++) {
    await dom!.act(async () => button('Load more')!.click())
    await settle()
  }
  const read = subjects().slice(2)
  expect(read).toHaveLength(131)
  expect(read.slice(60, 63)).toEqual(['read-60', 'system-read', 'read-61'])
  expect(read.at(-1)).toBe('read-129')
  expect(button('Load more')).toBeUndefined()
})

test('scrolling the load-more trigger into view fetches the next page', async () => {
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
  globalThis.IntersectionObserver = class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      observers.push(callback)
    }
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
  const { requests, settle, subjects, button } = await renderPopup()
  await dom!.act(async () => button('Read messages')!.click())
  expect(subjects()).toHaveLength(52)

  await dom!.act(async () => observers.at(-1)!([{ isIntersecting: true }]))
  await settle()
  expect(requests.some((url) => url.searchParams.get('cursor') === 'read-49')).toBe(true)
  // 2 unread + 100 personal read + the system message now that page 2 reached past it.
  expect(subjects()).toHaveLength(103)
})

test('searches the whole archive on the server, across personal and system inboxes', async () => {
  const { container, requests, settle, subjects, button } = await renderPopup()
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
  expect(input.getAttribute('aria-label')).toBe('Search inbox')

  await dom!.act(async () => void fireEvent.change(input, { target: { value: '  needle ' } }))
  await settle(INBOX_SEARCH_DEBOUNCE_MS + 50)
  await settle()

  const searches = requests.filter((url) => url.searchParams.get('search'))
  expect(searches.map((url) => [url.pathname.replace(/^.*\/inbox/, ''), url.searchParams.get('search')])).toEqual([
    ['/user/me', 'needle'],
    ['/system/system', 'needle'],
  ])
  expect(searches.every((url) => url.searchParams.get('all') === 'true')).toBe(true)
  expect(container.textContent).toContain('2 results')
  expect(subjects()).toEqual(['Needle', 'Old needle'])
  expect(button('Read messages')).toBeUndefined()
  // Unread matches can still be marked read from the results.
  expect(
    [...container.querySelectorAll('button')].filter((candidate) => candidate.textContent === 'Read')
  ).toHaveLength(1)

  await dom!.act(async () => void fireEvent.change(input, { target: { value: 'nothing-matches' } }))
  await settle(INBOX_SEARCH_DEBOUNCE_MS + 50)
  await settle()
  expect(container.textContent).toContain('No messages match your search')

  // Clearing the search returns to the unread and read lists immediately.
  await dom!.act(async () => void fireEvent.change(input, { target: { value: '' } }))
  expect(subjects()).toEqual(['personal-unread', 'system-unread'])
  expect(button('Read messages')!.textContent).toBe('Read messages (131)')
})

test('does not mount a popup or skeleton until requested, and hides it immediately on dismissal', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  globalThis.fetch = mock(
    async () =>
      new dom!.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  client.setQueryData(queryKeys.auth.permissions(), { permissions: [], identity: { type: 'user', userId: 'test' } })
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client!}>
          <InboxPopup />
        </QueryClientProvider>
      </MemoryRouter>
    )
  )
  expect(container.querySelector('.ficus-overlay')).toBeNull()
  await dom.act(async () => window.dispatchEvent(new CustomEvent('open-inbox-popup')))
  expect(container.querySelector('.ficus-overlay')?.getAttribute('data-state')).toBe('open')
  expect(container.textContent).toContain('Inbox')
  await dom.act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close inbox"]')!.click())
  expect(container.querySelector('.ficus-overlay')?.getAttribute('aria-hidden')).toBe('true')
  expect(container.querySelector('.ficus-overlay')?.hasAttribute('inert')).toBe(true)
})
