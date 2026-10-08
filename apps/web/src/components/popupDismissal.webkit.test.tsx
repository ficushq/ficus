/**
 * Every popup on `usePopupDismiss`, tapped the way Safari and iOS deliver a tap (`test/webkitTap.ts`): the
 * tapped button never takes focus, so the focused item blurs to the nearest focusable ancestor — here a
 * settings-style `<section tabIndex={-1}>` — before the click. Each popup must run the tapped item, and
 * still close on an outside tap, Escape and keyboard Tab out. The popups with richer fixtures are covered
 * beside their own tests (RelayConnectionSettings, ThemedPopup, ThemeQuickPicker, WorkStreamActionsMenu,
 * SettingsNavigation, AssistantSnapMenu, EntityReferenceLink, VoiceCompanionWidget). The mobile dock's More
 * menu (AppNav) is on the primitive too, but unreachable while only one secondary destination is visible.
 */
import { afterEach, expect, spyOn, test } from 'bun:test'
import { useRef, useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { Agent } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { webkitTap } from '../test/webkitTap'
import { queryKeys } from '../queryKeys'
import { OverflowMenu } from './OverflowMenu'
import { WorkStreamFiltersPopover } from './WorkStreamFiltersPopover'
import { AssistantConversationSwitcher } from './AssistantConversations'
import { FileMentionAutocomplete } from './FileMentionAutocomplete'
import { AttentionMenu } from './AttentionMenu'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let restore: Array<() => void> = []
afterEach(async () => {
  for (const undo of restore.reverse()) undo()
  restore = []
  await dom?.cleanup()
  dom = undefined
})

async function render(node: ReactNode) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  const { root, container } = dom.createRoot()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  restore.push(() => queryClient.clear())
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <section data-setting-target="example" tabIndex={-1}>
            {node}
          </section>
          <button type="button">Outside</button>
        </MemoryRouter>
      </QueryClientProvider>
    )
  )
  const doc = dom.window.document
  const button = (text: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!
  const escape = () =>
    dom!.act(async () => {
      ;(doc.activeElement ?? doc.body).dispatchEvent(
        new dom!.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
  /** Lets an earlier tap's press tracking finish, as the time between a tap and a later key press does. */
  const settle = () => dom!.act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  return { container, doc, button, escape, settle, queryClient }
}

test('OverflowMenu: a WebKit tap runs the action; outside tap, Escape and Tab out close it', async () => {
  const ran: string[] = []
  const { button, escape, doc, settle } = await render(
    <OverflowMenu label="Row actions" itemsMarker="data-row-actions">
      <button type="button" onClick={() => ran.push('rename')}>
        Rename
      </button>
      <button type="button" onClick={() => ran.push('delete')}>
        Delete
      </button>
    </OverflowMenu>
  )
  const trigger = doc.querySelector<HTMLButtonElement>('[aria-label="Row actions"]')!
  const expanded = () => trigger.getAttribute('aria-expanded')
  await dom!.act(async () => trigger.click())
  expect(doc.activeElement?.textContent).toBe('Rename')
  expect(await webkitTap(button('Delete'))).toBe(true)
  expect(ran).toEqual(['delete'])
  expect(expanded()).toBe('false')
  expect(doc.activeElement).toBe(trigger)

  await dom!.act(async () => trigger.click())
  await webkitTap(button('Outside'))
  expect(expanded()).toBe('false')

  await dom!.act(async () => trigger.click())
  await escape()
  expect(expanded()).toBe('false')
  expect(doc.activeElement).toBe(trigger)

  await settle()
  await dom!.act(async () => trigger.click())
  await dom!.act(async () => button('Outside').focus())
  expect(expanded()).toBe('false')
})

test('WorkStreamFiltersPopover: a WebKit tap toggles a filter and keeps the panel open', async () => {
  function Filters() {
    const [on, setOn] = useState(false)
    return (
      <WorkStreamFiltersPopover count={on ? 1 : 0}>
        <button type="button" aria-pressed={on} onClick={() => setOn(!on)}>
          Blocked
        </button>
        <button type="button">Done</button>
      </WorkStreamFiltersPopover>
    )
  }
  const { button, escape, doc, settle } = await render(<Filters />)
  const trigger = () => doc.querySelector<HTMLButtonElement>('[aria-controls]')!
  await dom!.act(async () => trigger().click())
  expect(doc.activeElement?.textContent).toBe('Blocked')
  expect(await webkitTap(button('Done'), { touch: true })).toBe(true)
  expect(await webkitTap(button('Blocked'))).toBe(true)
  expect(button('Blocked').getAttribute('aria-pressed')).toBe('true')
  expect(trigger().getAttribute('aria-expanded')).toBe('true')

  await webkitTap(button('Outside'))
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  await dom!.act(async () => trigger().click())
  await escape()
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger())
  await settle()
  await dom!.act(async () => trigger().click())
  await dom!.act(async () => button('Outside').focus())
  expect(trigger().getAttribute('aria-expanded')).toBe('false')
})

test('AssistantConversationSwitcher: with the search field focused, a WebKit tap opens a conversation', async () => {
  const agents = [
    { id: 'a1', status: 'idle', metadata: { name: 'Planning' }, updatedAt: '2026-10-01T00:00:00.000Z' },
  ] as unknown as Agent[]
  const selected: string[] = []
  const { doc, escape, button, settle } = await render(
    <AssistantConversationSwitcher agents={agents} onSelect={(id) => selected.push(id)} onNew={() => {}} canCreate />
  )
  const trigger = doc.querySelector<HTMLButtonElement>('[aria-controls="assistant-conversations"]')!
  await dom!.act(async () => trigger.click())
  expect(doc.activeElement?.tagName).toBe('INPUT')
  expect(await webkitTap(doc.querySelector('#assistant-conversations a')!, { touch: true })).toBe(true)
  expect(selected).toEqual(['a1'])
  expect(trigger.getAttribute('aria-expanded')).toBe('false')

  await dom!.act(async () => trigger.click())
  await webkitTap(button('Outside'))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  await dom!.act(async () => trigger.click())
  await escape()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(doc.activeElement).toBe(trigger)
  await settle()
  await dom!.act(async () => trigger.click())
  await dom!.act(async () => button('Outside').focus())
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
})

test('FileMentionAutocomplete: a WebKit tap picks a file while the composer keeps focus; an outside tap closes it', async () => {
  const api = await import('../api/squads')
  const search = spyOn(api, 'searchWorkspaceFiles').mockResolvedValue({ files: ['src/app.ts', 'src/main.ts'] })
  restore.push(() => search.mockRestore())
  const picked: string[] = []
  let closed = 0
  function Composer() {
    const textarea = useRef<HTMLTextAreaElement>(null)
    const [open, setOpen] = useState(true)
    return (
      <>
        <textarea ref={textarea} aria-label="Message" />
        {open && (
          <FileMentionAutocomplete
            squadId="squad"
            query="src"
            textareaRef={textarea}
            onSelect={(file) => {
              picked.push(file)
              setOpen(false)
            }}
            onClose={() => {
              closed++
              setOpen(false)
            }}
          />
        )}
        <button type="button" onClick={() => setOpen(true)}>
          Reopen
        </button>
      </>
    )
  }
  const { doc, button } = await render(<Composer />)
  await dom!.act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  await dom!.act(async () => doc.querySelector('textarea')!.focus())
  expect(await webkitTap(button('@src/main.ts'))).toBe(true)
  expect(picked).toEqual(['src/main.ts'])
  expect(closed).toBe(0)

  await dom!.act(async () => button('Reopen').click())
  await dom!.act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(button('@src/app.ts')).toBeDefined()
  await webkitTap(button('Outside'))
  expect(closed).toBe(1)
})

test('AttentionMenu: WebKit taps on a level label set it and keep the panel open', async () => {
  const api = await import('../api/squads')
  const subscription = { subscribed: true, count: 1, attention: { decisions: 'notify', progress: 'mute' } }
  const subscribe = spyOn(api, 'subscribeSquad').mockImplementation(async () => subscription as never)
  const get = spyOn(api, 'getSquadSubscription').mockImplementation(async () => subscription as never)
  restore.push(
    () => subscribe.mockRestore(),
    () => get.mockRestore()
  )
  const fixture = await render(<AttentionMenu target={{ kind: 'squad', id: 'squad-1' }} />)
  fixture.queryClient.setQueryData(queryKeys.squadSubscription.detail('squad-1'), subscription)
  const { doc, escape, button, settle } = fixture
  const summary = doc.querySelector('summary')!
  const details = doc.querySelector('details')!
  expect(await webkitTap(summary)).toBe(true)
  expect(details.open).toBe(true)
  expect(await webkitTap(doc.querySelector('[aria-label="Progress: Show"]')!.closest('label')!, { touch: true })).toBe(
    true
  )
  expect(subscribe).toHaveBeenCalledWith('squad-1', { decisions: 'notify', progress: 'show' })
  expect(details.open).toBe(true)

  await webkitTap(button('Outside'))
  expect(details.open).toBe(false)
  await dom!.act(async () => summary.click())
  await dom!.act(async () => summary.focus())
  await escape()
  expect(details.open).toBe(false)
  expect(doc.activeElement).toBe(summary)
  await settle()
  await dom!.act(async () => summary.click())
  await dom!.act(async () => button('Outside').focus())
  expect(details.open).toBe(false)
})
