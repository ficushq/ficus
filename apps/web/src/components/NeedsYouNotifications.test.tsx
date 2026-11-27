import { afterEach, describe, expect, test } from 'bun:test'
import { MemoryRouter, useLocation } from 'react-router'
import type { PendingAction } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { NeedsYouNotifications, type WindowFocus } from './NeedsYouNotifications'
import type { NeedsYouNoticePreferences } from '../lib/needsYouNotices'
import { otherAction, questionAction, waitAction } from '../lib/needsYouNotices.fixtures'

type Dom = Awaited<ReturnType<typeof acquireDomHarness>>
let dom: Dom | undefined

afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
})

const ON: NeedsYouNoticePreferences = { pushEnabled: true, mutedEvents: [] }

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

type PushCheck = (actionId: string) => Promise<boolean>

/** Renders the notices over a pending list the test changes, as the Action Center query would. */
async function mount({
  path = '/',
  initial = [] as PendingAction[],
  preferences = ON as NeedsYouNoticePreferences | 'unloaded',
  visible = true,
  osNotification = false,
  timeoutMs = 60_000,
} = {}) {
  dom = await acquireDomHarness({ url: `http://localhost${path}` })
  const harness = dom
  const { root } = harness.createRoot()
  let pending = initial
  let fetchedAt = Date.now()
  let focused = visible
  let since = 0
  // What the next refetch delivers, as the server would after a push.
  let onRefetch: (() => PendingAction[]) | null = null
  let pushCheck: PushCheck | null = null
  const render = () =>
    harness.act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <NeedsYouNotifications
            // A fresh object each render, so the component re-reads the pending list.
            dependencies={{
              usePendingActions: () => ({
                data: pending,
                dataUpdatedAt: fetchedAt,
                refetch: async () => {
                  if (!onRefetch) return
                  pending = onRefetch()
                  fetchedAt = Date.now()
                  onRefetch = null
                  await render()
                },
              }),
              usePreferences: () => (preferences === 'unloaded' ? undefined : preferences),
              useWindowFocus: (): WindowFocus => ({ isFocused: () => focused, since }),
              osNotificationReplacesCard: () => osNotification,
              subscribePushChecks: (handler) => {
                pushCheck = handler
                return () => {
                  if (pushCheck === handler) pushCheck = null
                }
              },
              timeoutMs,
            }}
          />
          <LocationProbe />
        </MemoryRouter>
      )
    )
  await render()
  return {
    async setPending(next: PendingAction[], at = Date.now()) {
      pending = next
      fetchedAt = at
      await render()
    },
    async setFocus(next: { focused: boolean; since: number }) {
      focused = next.focused
      since = next.since
      await render()
    },
    /** The service worker asks about a push; the next refetch returns `serverList` when given. */
    async askAboutPush(actionId: string, serverList?: PendingAction[]) {
      if (serverList) onRefetch = () => serverList
      // Outside act: the refetch renders in its own act, and the check then waits for the commit.
      return pushCheck!(actionId)
    },
    cards: () => [...document.querySelectorAll('[data-testid="needs-you-notice"]')] as HTMLElement[],
    headlines: () =>
      [...document.querySelectorAll('[data-testid="needs-you-notice"] button:first-of-type')].map(
        (button) => button.querySelector('.font-medium')?.textContent
      ),
    location: () => document.querySelector('[data-testid="location"]')?.textContent,
    act: harness.act,
  }
}

test('items already pending when the app opens raise no notice; only new ones do', async () => {
  const view = await mount({ initial: [questionAction('old')] })
  expect(view.cards()).toHaveLength(0)
  await view.setPending([questionAction('old'), questionAction('new', { createdAt: '2026-11-26T12:05:00.000Z' })])
  expect(view.cards()).toHaveLength(1)
  expect(view.cards()[0]!.textContent).toContain('Engineer has a question')
  expect(view.cards()[0]!.textContent).toContain('Retry on 409 as well?')
  expect(view.cards()[0]!.textContent).toContain('#8 · Make every payment retry safe')
})

test('the trigger set is exactly new questions and gates the user can act on', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setPending([
    questionAction('q', { createdAt: '2026-11-26T12:03:00.000Z' }),
    waitAction('review', { createdAt: '2026-11-26T12:02:00.000Z' }),
    waitAction('input', { type: 'workstream-blocked', createdAt: '2026-11-26T12:01:00.000Z' }),
    questionAction('unanswerable', { canRespond: false }),
    waitAction('shown-only', { alerts: undefined }),
    otherAction('agent-error', 'halted'),
    otherAction('assistant-needs-input', 'task'),
    otherAction('workstream-delivery', 'pr'),
  ])
  expect(view.headlines()).toEqual([
    'Engineer has a question',
    'Engineer requests review',
    'Engineer needs your input',
  ])
})

test('more than three new items show the newest three', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setPending(
    [1, 2, 3, 4].map((minute) =>
      questionAction(`q${minute}`, { createdAt: `2026-11-26T12:0${minute}:00.000Z` }, { agentPurpose: `Task ${minute}`, workStream: undefined })
    )
  )
  expect(view.headlines()).toEqual([
    'Engineer (Task 4) has a question',
    'Engineer (Task 3) has a question',
    'Engineer (Task 2) has a question',
  ])
})

test('no notice for an item the user already has open', async () => {
  const view = await mount({ path: '/actions/agent-question%3Aq1' })
  await view.setPending([])
  await view.setPending([questionAction('q1')])
  expect(view.cards()).toHaveLength(0)
})

test("no notice for a question while its agent's conversation is open, or a gate while its work stream is", async () => {
  const chat = await mount({ path: '/squads/product-engineering/agents?agent=agent-1' })
  await chat.setPending([])
  await chat.setPending([questionAction('q1')])
  expect(chat.cards()).toHaveLength(0)
  await dom!.cleanup()

  const work = await mount({ path: '/squads/product-engineering/work?ws=8' })
  await work.setPending([])
  await work.setPending([waitAction('w1')])
  expect(work.cards()).toHaveLength(0)
})

test('dismissing a notice hides it without touching the item, and it does not come back', async () => {
  const view = await mount()
  await view.setPending([])
  const pending = [questionAction('q1')]
  // The DOM harness refuses any request, so a dismissal that called the API would fail here.
  await view.setPending(pending)
  const close = view.cards()[0]!.querySelector('button[aria-label^="Dismiss"]') as HTMLButtonElement
  await view.act(async () => close.click())
  expect(view.cards()).toHaveLength(0)
  expect(view.location()).toBe('/')
  await view.setPending([...pending])
  expect(view.cards()).toHaveLength(0)
})

test('Escape dismisses a focused notice', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setPending([questionAction('q1')])
  const card = view.cards()[0]!
  await view.act(async () => {
    card.querySelector('button')!.focus()
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(view.cards()).toHaveLength(0)
})

test('clicking a notice opens the item, the same destination as Needs you', async () => {
  const view = await mount({ path: '/squads' })
  await view.setPending([])
  await view.setPending([questionAction('q1')])
  await view.act(async () => (view.cards()[0]!.querySelector('button') as HTMLButtonElement).click())
  expect(view.location()).toBe('/actions/agent-question%3Aq1')
  expect(view.cards()).toHaveLength(0)
})

test('a workflow gate opens its review over the current page', async () => {
  const view = await mount({ path: '/squads' })
  await view.setPending([])
  await view.setPending([
    waitAction('w9', { type: 'workstream-blocked', wait: { resolutionHandler: 'workflow', workflowHumanGate: true } }),
  ])
  expect(view.headlines()).toEqual(['Engineer requests review'])
  await view.act(async () => (view.cards()[0]!.querySelector('button') as HTMLButtonElement).click())
  expect(view.location()).toBe('/squads?review=ws-uuid-8&reviewWait=w9')
})

test('a notice dismisses itself after its timeout, unless hovered', async () => {
  const view = await mount({ timeoutMs: 40 })
  await view.setPending([])
  await view.setPending([questionAction('q1'), questionAction('q2', { createdAt: '2026-11-26T12:01:00.000Z' })])
  expect(view.cards()).toHaveLength(2)
  const hovered = view.cards().find((card) => card.textContent?.includes('Retry'))!
  await view.act(async () => {
    hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
  })
  await view.act(() => new Promise((resolve) => setTimeout(resolve, 120)))
  expect(view.cards()).toHaveLength(1)
})

test('keyboard focus pauses the timeout, including while focus moves between the card buttons', async () => {
  const view = await mount({ timeoutMs: 40 })
  await view.setPending([])
  await view.setPending([questionAction('q1')])
  const [open, close] = [...view.cards()[0]!.querySelectorAll('button')] as HTMLButtonElement[]
  await view.act(async () => open!.focus())
  await view.act(() => new Promise((resolve) => setTimeout(resolve, 80)))
  await view.act(async () => close!.focus())
  await view.act(() => new Promise((resolve) => setTimeout(resolve, 80)))
  expect(view.cards()).toHaveLength(1)
})

test('a notice leaves when its item is settled elsewhere', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setPending([questionAction('q1')])
  expect(view.cards()).toHaveLength(1)
  await view.setPending([])
  expect(view.cards()).toHaveLength(0)
})

test('notification preferences off shows nothing', async () => {
  const off = await mount({ preferences: { pushEnabled: false, mutedEvents: [] } })
  await off.setPending([])
  await off.setPending([questionAction('q1'), waitAction('w1')])
  expect(off.cards()).toHaveLength(0)
  await dom!.cleanup()

  const mutedQuestions = await mount({ preferences: { pushEnabled: true, mutedEvents: ['question'] } })
  await mutedQuestions.setPending([])
  await mutedQuestions.setPending([questionAction('q1'), waitAction('w1')])
  expect(mutedQuestions.headlines()).toEqual(['Engineer requests review'])
  await dom!.cleanup()

  const unloaded = await mount({ preferences: 'unloaded' })
  await unloaded.setPending([])
  await unloaded.setPending([questionAction('q1')])
  expect(unloaded.cards()).toHaveLength(0)
})

test('no notice while the window is away, or where this browser shows the OS notification itself', async () => {
  const hidden = await mount({ visible: false })
  await hidden.setPending([])
  await hidden.setPending([questionAction('q1')])
  expect(hidden.cards()).toHaveLength(0)
  await dom!.cleanup()

  const webkit = await mount({ osNotification: true })
  await webkit.setPending([])
  await webkit.setPending([questionAction('q1')])
  expect(webkit.cards()).toHaveLength(0)
})

test('the notices region is a polite live region', async () => {
  await mount()
  const region = document.querySelector('section[aria-label="Needs you notifications"]')
  expect(region?.getAttribute('aria-live')).toBe('polite')
})

test('no notice while the window is not focused, even when it is visible', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setFocus({ focused: false, since: 0 })
  await view.setPending([questionAction('q1')])
  expect(view.cards()).toHaveLength(0)
})

test('items that arrived while the window was away raise no notice when it comes back', async () => {
  const view = await mount()
  await view.setPending([])
  await view.setFocus({ focused: false, since: 0 })
  const back = Date.now()
  await view.setFocus({ focused: true, since: back })
  // The list fetched on return carries what arrived while away: recorded, not announced.
  await view.setPending([questionAction('while-away')], back + 100)
  expect(view.cards()).toHaveLength(0)
  // Something genuinely new afterwards still announces itself.
  await view.setPending(
    [questionAction('while-away'), questionAction('later', { createdAt: '2026-11-26T12:09:00.000Z' })],
    back + 10_000
  )
  expect(view.cards()).toHaveLength(1)
})

describe('confirming a card to the service worker, so it skips the OS notification', () => {
  test('a push for an item that gets a card is confirmed, and the card shows', async () => {
    const view = await mount()
    await view.setPending([])
    expect(await view.askAboutPush('agent-question:q1', [questionAction('q1')])).toBe(true)
    expect(view.cards()).toHaveLength(1)
  })

  test("a later push reusing a shown card's id for an item with no card is not confirmed", async () => {
    // Card shown for the question, then the user answers it and delivery fails: the failure alert
    // carries the same agent-question id, and the refetched item no longer gets a card.
    const view = await mount()
    await view.setPending([])
    await view.setPending([questionAction('q1')])
    expect(view.cards()).toHaveLength(1)
    const failed = questionAction(
      'q1',
      {},
      {
        answerDelivery: {
          status: 'failed',
          generation: 1,
          attemptCount: 3,
          nextAttemptAt: null,
          lastError: 'gone',
          deliveredAt: null,
        } as never,
      }
    )
    expect(await view.askAboutPush('agent-question:q1', [failed])).toBe(false)
    expect(view.cards()).toHaveLength(0)
  })

  test('a shown card whose item was settled elsewhere is not confirmed', async () => {
    const view = await mount()
    await view.setPending([])
    await view.setPending([questionAction('q1')])
    expect(await view.askAboutPush('agent-question:q1', [])).toBe(false)
  })

  test('a card already shown, or dismissed, stays confirmed while its item is still pending', async () => {
    const view = await mount()
    await view.setPending([])
    await view.setPending([questionAction('q1')])
    const close = view.cards()[0]!.querySelector('button[aria-label^="Dismiss"]') as HTMLButtonElement
    await view.act(async () => close.click())
    expect(await view.askAboutPush('agent-question:q1')).toBe(true)
  })

  test('items that never get a card are not confirmed, so their OS notification shows', async () => {
    const failedDelivery = questionAction(
      'failed',
      {},
      {
        answerDelivery: {
          status: 'failed',
          generation: 1,
          attemptCount: 3,
          nextAttemptAt: null,
          lastError: 'gone',
          deliveredAt: null,
        } as never,
      }
    )
    const recovery = waitAction('recover', {
      type: 'workstream-blocked',
      wait: { structured: { request: { kind: 'continue', recoveryId: 'r1' } } as never },
    })
    const watcher = waitAction('watch', { canRespond: false })
    const shownOnly = waitAction('show', { alerts: undefined })
    for (const action of [failedDelivery, recovery, watcher, shownOnly]) {
      const view = await mount()
      await view.setPending([])
      expect(await view.askAboutPush(action.id, [action])).toBe(false)
      expect(view.cards()).toHaveLength(0)
      await dom!.cleanup()
    }
  })

  test('an item already pending when the page loaded is not confirmed', async () => {
    const view = await mount({ initial: [questionAction('old')] })
    expect(await view.askAboutPush('agent-question:old')).toBe(false)
  })

  test('a window that is not focused confirms nothing', async () => {
    const view = await mount()
    await view.setPending([])
    await view.setFocus({ focused: false, since: 0 })
    expect(await view.askAboutPush('agent-question:q1', [questionAction('q1')])).toBe(false)
  })
})
