import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { fireEvent, getByRole, queryByRole, waitFor } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { ProductFeedbackStatus } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { PermissionsProvider, type PermissionsResult } from '../hooks/usePermissions'
import { productFeedbackQueryKeys } from '../queryKeys'
import { SendFeedbackButton } from './ProductFeedbackModal'
import { HelpFeedbackSection } from './settings/HelpFeedbackSection'

const REPORT_ID = '44444444-4444-4444-8444-444444444444'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname + location.search}</output>
}

async function render(
  options: {
    status?: ProductFeedbackStatus
    admin?: boolean
    respond?: () => Response
    section?: boolean
  } = {}
) {
  const dom = await acquireDomHarness({ url: 'https://ficus.example.test' })
  const posts: unknown[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname === '/api/product-feedback' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return options.respond ? options.respond() : Response.json({ id: REPORT_ID }, { status: 201 })
    }
    return Response.json(options.status ?? { connected: true, managed: false })
  }) as typeof fetch
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(productFeedbackQueryKeys.status(), options.status ?? { connected: true, managed: false })
  cleanup = async () => {
    await dom.cleanup()
    queryClient.clear()
    globalThis.fetch = previousFetch
  }
  const admin = options.admin ?? true
  const permissions: PermissionsResult = {
    permissions: admin ? ['settings:read'] : [],
    identity: { type: 'user', userId: 'test-user' },
    can: (permission) => admin && permission === 'settings:read',
    isLoading: false,
    isError: false,
  }
  const { root, container } = dom.createRoot()
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider usePermissions={() => permissions}>
          <MemoryRouter initialEntries={['/squads/demo']}>
            <Routes>
              <Route
                path="*"
                element={
                  options.section ? <HelpFeedbackSection /> : <SendFeedbackButton>Open feedback</SendFeedbackButton>
                }
              />
            </Routes>
            <LocationProbe />
          </MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const open = async (name = 'Open feedback') => {
    await dom.act(async () => fireEvent.click(getByRole(container, 'button', { name })))
    return getByRole(document.body, 'dialog', { name: 'Send feedback to Ficus' })
  }
  const fill = async (dialog: HTMLElement, message = 'The feed did not refresh after a reply.') => {
    await dom.act(async () => {
      fireEvent.change(getByRole(dialog, 'combobox', { name: 'Category' }), { target: { value: 'bug' } })
      fireEvent.change(getByRole(dialog, 'textbox', { name: 'Message' }), { target: { value: message } })
    })
  }
  // Settle the request and its state updates inside act so the result renders before assertions.
  const submit = (dialog: HTMLElement) =>
    dom.act(async () => {
      const before = posts.length
      fireEvent.click(getByRole(dialog, 'button', { name: 'Send feedback' }))
      await waitFor(() => expect(posts).toHaveLength(before + 1))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  return { container, dom, posts, open, fill, submit }
}

test('the name and email checkbox is checked by default and sends the opt-in', async () => {
  const { open, fill, submit, posts } = await render()
  const dialog = await open()
  const checkbox = getByRole(dialog, 'checkbox', { name: /Include my name and email/ }) as HTMLInputElement
  expect(checkbox.checked).toBe(true)
  expect(dialog.textContent).toContain('Reports are always linked to the Ficus account of this server’s owner')
  await fill(dialog, '   The feed did not refresh after a reply.   ')
  await submit(dialog)
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toEqual({
    category: 'bug',
    message: 'The feed did not refresh after a reply.',
    includeSubmitter: true,
    page: '/squads/demo',
  })
})

test('unchecking sends the opt-out, and success shows the reference id', async () => {
  const { open, fill, submit, posts } = await render()
  const dialog = await open()
  await fill(dialog)
  await act(async () => fireEvent.click(getByRole(dialog, 'checkbox', { name: /Include my name and email/ })))
  await submit(dialog)
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toMatchObject({ includeSubmitter: false })
  await waitFor(() => expect(document.body.textContent).toContain(REPORT_ID))
  expect(document.body.textContent).toContain('your feedback was sent')
})

test('send stays disabled until a category and at least 10 characters are given', async () => {
  const { open, fill } = await render()
  const dialog = await open()
  const send = getByRole(dialog, 'button', { name: 'Send feedback' }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  await fill(dialog, '  short  ')
  expect(send.disabled).toBe(true)
  await fill(dialog)
  expect(send.disabled).toBe(false)
})

test('not connected: the form is disabled and offers Connect Ficus account', async () => {
  const { open, posts, container } = await render({ status: { connected: false, managed: false } })
  const dialog = await open()
  expect(dialog.textContent).toContain('This server is not connected to a Ficus account')
  expect((dialog.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
  expect((getByRole(dialog, 'button', { name: 'Send feedback' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => fireEvent.click(getByRole(dialog, 'button', { name: 'Connect Ficus account' })))
  expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
    '/settings?section=mobile-pro&setting=mobile-pro'
  )
  expect(posts).toHaveLength(0)
})

test('not connected: a member without settings access is told to ask an administrator', async () => {
  const { open } = await render({ status: { connected: false, managed: false }, admin: false })
  const dialog = await open()
  expect(dialog.textContent).toContain('Ask an administrator to connect it.')
  expect(queryByRole(dialog, 'button', { name: 'Connect Ficus account' })).toBeNull()
})

test('a platform error shows the server message and keeps the form', async () => {
  const { open, fill, submit } = await render({
    respond: () =>
      Response.json(
        {
          error: 'Too much feedback has been sent from this server recently. Try again in an hour.',
          code: 'rate_limited',
        },
        { status: 429 }
      ),
  })
  const dialog = await open()
  await fill(dialog)
  await submit(dialog)
  await waitFor(() => expect(getByRole(dialog, 'alert').textContent).toContain('Try again in an hour.'))
  expect((getByRole(dialog, 'textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toContain('feed')
})

test('the Help & feedback settings section opens the same modal', async () => {
  const { open, container } = await render({ section: true })
  expect(getByRole(container, 'heading', { name: 'Send feedback to Ficus' })).toBeTruthy()
  const dialog = await open('Send feedback')
  expect(getByRole(dialog, 'checkbox', { name: /Include my name and email/ })).toBeTruthy()
})
