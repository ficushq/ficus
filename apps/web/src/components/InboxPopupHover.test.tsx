import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PermissionsProvider } from '../hooks/usePermissions'
import { ThemeProvider } from '../providers/ThemeProvider'
import { acquireDomHarness } from '../test/domHarness'
import { queries } from '../queryOptions'
import { AppHeader } from './AppNav'
import { InboxPopup } from './InboxPopup'
import { INBOX_POPUP_ID, InboxPopupProvider } from './InboxPopupProvider'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let client: QueryClient | undefined
afterEach(async () => {
  client?.clear()
  await dom?.cleanup()
  dom = undefined
})

/** The real header and popup, wired through the provider as in `App`. */
async function renderInbox() {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  globalThis.fetch = mock(
    async () =>
      new dom!.window.Response(JSON.stringify({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ) as unknown as typeof fetch
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  for (const [key, value] of [
    [queries.voice.status().queryKey, { enabled: false }],
    [queries.inbox.mineCount().queryKey, { count: 0 }],
    [queries.squads.list().queryKey, []],
    [queries.actions.pending().queryKey, []],
  ] as const)
    client.setQueryData(key, value)
  const { container, root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={client!}>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/feed']}>
            <PermissionsProvider
              usePermissions={() => ({ can: () => false, permissions: [], isLoading: false, isError: false })}
            >
              <InboxPopupProvider>
                <input aria-label="Composer" />
                <AppHeader usePendingActions={() => ({ data: [] })} />
                <InboxPopup />
              </InboxPopupProvider>
            </PermissionsProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    )
  )
  const doc = dom.window.document
  const trigger = container.querySelector<HTMLButtonElement>('button[title="Inbox (I)"]')!
  const panel = () => doc.querySelector<HTMLElement>(`#${INBOX_POPUP_ID}[data-state="open"]`)
  const scrim = () => doc.querySelector<HTMLElement>('.fixed.inset-0.z-40')
  const wait = (ms: number) => dom!.act(() => new Promise((resolve) => setTimeout(resolve, ms)))
  /** A pointer arriving on (`over`) or leaving (`out`) an element; React derives enter/leave from these. */
  const pointer = (target: Element, type: 'over' | 'out', pointerType = 'mouse') =>
    dom!.act(async () => {
      target.dispatchEvent(new dom!.window.PointerEvent(`pointer${type}`, { bubbles: true, pointerType }))
    })
  const press = (target: Element) =>
    dom!.act(async () => {
      target.dispatchEvent(new dom!.window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    })
  const click = (target: HTMLElement) => dom!.act(async () => target.click())
  const key = (key: string) =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    })
  return { doc, trigger, panel, scrim, wait, pointer, press, click, key }
}

describe('inbox nav button hover', () => {
  test('a mouse hovering opens it without taking focus or a scrim; leaving closes it after a short delay', async () => {
    const { doc, trigger, panel, scrim, wait, pointer } = await renderInbox()
    const composer = doc.querySelector<HTMLInputElement>('input[aria-label="Composer"]')!
    await dom!.act(async () => composer.focus())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe(INBOX_POPUP_ID)

    await pointer(trigger, 'over')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(panel()).not.toBeNull()
    expect(doc.activeElement).toBe(composer)
    // No scrim over the trigger, so it keeps getting the pointer (leave closes, a click pins).
    expect(scrim()).toBeNull()

    await pointer(trigger, 'out')
    await wait(50)
    expect(panel()).not.toBeNull() // not yet: the pointer may be crossing the gap to the panel
    await wait(150)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(panel()).toBeNull()
    expect(doc.activeElement).toBe(composer)
  })

  test('re-entering the panel or the trigger cancels the close', async () => {
    const { trigger, panel, wait, pointer } = await renderInbox()
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await pointer(panel()!, 'over') // crossed the gap into the panel
    await wait(200)
    expect(panel()).not.toBeNull()

    await pointer(panel()!, 'out')
    await pointer(trigger, 'over') // and back to the trigger
    await wait(200)
    expect(panel()).not.toBeNull()

    await pointer(trigger, 'out')
    await wait(200)
    expect(panel()).toBeNull()
  })

  test('a click on the hover-opened trigger pins it open; it then behaves as a click-open', async () => {
    const { trigger, panel, scrim, wait, pointer, click } = await renderInbox()
    await pointer(trigger, 'over')
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true') // pinned, not toggled closed
    expect(scrim()).not.toBeNull()
    await pointer(trigger, 'out')
    await wait(200)
    expect(panel()).not.toBeNull()
    // The scrim closes it, as before.
    await click(scrim()!)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  test('a press inside a hover-opened panel pins it, so working in it survives the pointer leaving', async () => {
    const { trigger, panel, wait, pointer, press } = await renderInbox()
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await pointer(panel()!, 'over')
    await press(panel()!.querySelector('input')!)
    await pointer(panel()!, 'out')
    await wait(200)
    expect(panel()).not.toBeNull()
  })

  test('opened by click it stays open when the pointer leaves, with its scrim', async () => {
    const { trigger, panel, scrim, wait, pointer, click } = await renderInbox()
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(scrim()).not.toBeNull()
    await pointer(trigger, 'out')
    await wait(200)
    expect(panel()).not.toBeNull()
  })

  test('opened by the I shortcut it ignores the pointer; the shortcut and Escape still close it', async () => {
    const { trigger, panel, wait, pointer, key } = await renderInbox()
    await key('i')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await pointer(trigger, 'over')
    await pointer(trigger, 'out')
    await wait(200)
    expect(panel()).not.toBeNull()
    await key('i')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    // Hover-opened, Escape and the shortcut close it too, and a later shortcut open is not a hover one.
    await pointer(trigger, 'over')
    await key('Escape')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await key('i')
    await pointer(trigger, 'out')
    await wait(200)
    expect(panel()).not.toBeNull()
  })

  test('touch and pen never open it on hover; a tap still does and stays open', async () => {
    const { trigger, panel, wait, pointer, click } = await renderInbox()
    await pointer(trigger, 'over', 'touch')
    await pointer(trigger, 'over', 'pen')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    await pointer(trigger, 'out', 'touch')
    await wait(200)
    expect(panel()).not.toBeNull()
  })
})
