import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import type { InboxMessageResponse } from '../api/inbox'
import { PermissionsProvider } from '../hooks/usePermissions'
import { queries } from '../queryOptions'
import { acquireDomHarness } from '../test/domHarness'
import { InboxPage } from './InboxPage'

describe('InboxPage responsive list gutters', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let client: QueryClient

  beforeEach(async () => {
    dom = await acquireDomHarness({ url: 'http://localhost/inbox' })
    client = new QueryClient()
    client.setQueryData(queries.squads.list().queryKey, [])
  })

  afterEach(async () => {
    client.clear()
    await dom.cleanup()
  })

  for (const mixed of [false, true]) {
    test(`widens ${mixed ? 'mixed unread/read' : 'read-only'} lists only below the desktop breakpoint`, () => {
      const messages = [
        {
          id: 'read',
          senderType: 'system',
          senderId: 'system',
          subject: 'A long inbox subject that should have room to wrap on a narrow screen',
          content: 'Message preview',
          createdAt: '2026-10-02T12:00:00Z',
          readAt: '2026-10-02T13:00:00Z',
          metadata: {},
        },
      ] as InboxMessageResponse[]
      if (mixed) messages.unshift({ ...messages[0], id: 'unread', readAt: null })
      client.setQueryData(queries.inbox.mine(true).queryKey, messages)

      const container = document.createElement('div')
      container.innerHTML = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <PermissionsProvider
            usePermissions={() => ({ permissions: [], can: () => false, isLoading: false, isError: false })}
          >
            <MemoryRouter initialEntries={['/inbox']}>
              <InboxPage />
            </MemoryRouter>
          </PermissionsProvider>
        </QueryClientProvider>
      )

      const sections = container.querySelectorAll('section')
      expect(sections.length).toBe(mixed ? 2 : 1)
      for (const section of sections) {
        // The app shell supplies 16px. Give back 8px on phones and avoid
        // adding another section gutter; desktop keeps its original inset.
        expect(section.parentElement?.classList.contains('-mx-2')).toBe(true)
        expect(section.parentElement?.classList.contains('md:mx-0')).toBe(true)
        expect(section.classList.contains('py-2')).toBe(true)
        expect(section.classList.contains('md:p-2')).toBe(true)
        expect(section.classList.contains('p-2')).toBe(false)
        // Keep the shared row's separate unread-dot slot and touch height.
        const row = section.querySelector('[class*="cursor-pointer"][class*="relative"]')!
        expect(row.classList.contains('pl-6')).toBe(true)
        expect(row.classList.contains('pr-3')).toBe(true)
        expect(row.classList.contains('py-3.5')).toBe(true)
      }
      // The page title/toolbar must not inherit the list's outdent.
      expect(container.querySelector('h1')?.closest('[class*="-mx-2"]')).toBeNull()
    })
  }
})
