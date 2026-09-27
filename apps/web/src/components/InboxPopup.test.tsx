import { afterEach, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { InboxPopup } from './InboxPopup'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

test('does not mount a popup or skeleton until requested, and hides it immediately on dismissal', async () => {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  client.setQueryData(queryKeys.auth.permissions(), { permissions: [], identity: { type: 'user', userId: 'test' } })
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
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
  client.clear()
})
