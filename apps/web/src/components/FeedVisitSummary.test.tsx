import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, test } from 'bun:test'
import type { WorkStream } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { ReactQueryHooksProvider } from '../reactQueryHooks'
import { ApiError } from '../api/client'
import { AccountFeedVisit } from './FeedVisitSummary'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
const observers = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>()
afterEach(async () => {
  await dom?.cleanup()
  dom = undefined
  observers.clear()
})
const at = '2026-10-28T12:00:00.000Z'
const stream = (id: string, squadId = 's1') => ({ id, title: id, squadId, completedAt: at }) as WorkStream

async function setup() {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  Object.defineProperty(dom.window, 'IntersectionObserver', {
    configurable: true,
    value: class {
      entry: { callback: IntersectionObserverCallback; targets: Set<Element> }
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, targets: new Set<Element>() }
        observers.add(this.entry)
      }
      observe(target: Element) {
        this.entry.targets.add(target)
        observers.add(this.entry)
      }
      disconnect() {
        observers.delete(this.entry)
      }
    },
  })
  const { root } = dom.createRoot()
  const saved: string[] = []
  const revisions: string[] = []
  let failedId: string | undefined
  let rows: WorkStream[] = [stream('missed')]
  let fail: boolean | 'conflict' = false
  let attempts = 0
  let squadIds: string[] = []
  let userId = 'one'
  let hasNextPage = false
  let fetched = true
  let totalCount = 42
  let pending: Promise<void> | undefined
  const keys: unknown[][] = []
  const hooks = {
    useQuery: (() => ({
      isSuccess: true,
      isFetchedAfterMount: true,
      data: { lastVisitedAt: '2026-01-01T00:00:00.000Z', observedAt: at },
    })) as never,
    useInfiniteQuery: ((options: { queryKey: unknown[] }) => {
      keys.push(options.queryKey)
      return {
        isSuccess: true,
        isFetchedAfterMount: fetched,
        data: {
          pages: [
            { items: rows.slice(0, 1), totalCount },
            { items: rows.slice(1), totalCount },
          ],
        },
        hasNextPage,
        fetchNextPage: async () => {
          rows = [...rows, stream('next-page')]
          await render()
        },
      }
    }) as never,
  }
  const acknowledge = async (id: string, revision: string) => {
    attempts++
    revisions.push(revision)
    await pending
    if (fail === 'conflict')
      throw new ApiError(409, 'This completion was replaced. Refresh to see the latest revision.')
    if (fail || id === failedId) throw new Error('offline')
    saved.push(id)
    return { seen: true as const }
  }
  const useActivity = (() => ({
    ownerId: userId,
    activity: {
      conversations: [
        {
          id: 'chat',
          title: 'Assistant pointer',
          unreadUpdates: 1,
          latestUpdate: { createdAt: at, preview: 'Still unread' },
        },
      ],
    },
  })) as never
  const render = async () =>
    dom!.act(async () =>
      root.render(
        <MemoryRouter initialEntries={['/?squad=s1']}>
          <ReactQueryHooksProvider hooks={hooks}>
            <AccountFeedVisit
              key={userId}
              userId={userId}
              squadIds={squadIds}
              acknowledge={acknowledge}
              useActivity={useActivity}
            />
          </ReactQueryHooksProvider>
        </MemoryRouter>
      )
    )
  const expose = async (id: string, visible = true) =>
    dom!.act(async () => {
      for (const observer of [...observers])
        for (const target of observer.targets) {
          if (target.getAttribute('data-completion-id') === id)
            observer.callback(
              [{ target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry],
              {} as IntersectionObserver
            )
        }
    })
  const visibility = async (value: 'hidden' | 'visible') =>
    dom!.act(async () => {
      Object.defineProperty(dom!.window.document, 'visibilityState', { configurable: true, value })
      dom!.window.document.dispatchEvent(new dom!.window.Event('visibilitychange'))
    })
  return {
    render,
    expose,
    visibility,
    saved,
    revisions,
    failId: (value: string | undefined) => {
      failedId = value
    },
    keys,
    setRows: (value: WorkStream[]) => {
      rows = value
    },
    attempts: () => attempts,
    delay: (value: Promise<void> | undefined) => {
      pending = value
    },
    setTotal: (value: number) => {
      totalCount = value
    },
    setFail: (value: boolean | 'conflict') => {
      fail = value
    },
    setSquads: (value: string[]) => {
      squadIds = value
    },
    setUser: (value: string) => {
      userId = value
    },
    setPaging: () => {
      hasNextPage = true
    },
    setFetched: (value: boolean) => {
      fetched = value
    },
  }
}
const text = () => dom!.window.document.body.textContent ?? ''

test('live completions join retained Updates without duplicate actions or acknowledgement on mount', async () => {
  const view = await setup()
  await view.render()
  expect(text()).toContain('Updates')
  expect(text()).not.toContain('Since your last visit')
  expect(text()).not.toContain('needs your input')
  expect(view.saved).toEqual([])
  await view.expose('missed')
  expect(view.saved).toEqual(['missed'])
  view.setRows([stream('live')])
  await view.render()
  expect(text()).toContain('missed')
  expect(text()).toContain('live')
  await view.expose('live')
  expect(view.saved).toEqual(['missed', 'live'])
  view.setRows([stream('live')])
  await view.render()
  await view.expose('live')
  expect(dom!.window.document.querySelectorAll('[data-completion-id="live"]')).toHaveLength(1)
  expect(view.saved).toEqual(['missed', 'live'])
  expect(dom!.window.document.querySelector('time[title]')).not.toBeNull()
  expect(dom!.window.document.querySelector('a[href*="ws=live"]')).not.toBeNull()
})

test('background, collapsed, offscreen, filtered and unfetched pages are not acknowledged', async () => {
  const view = await setup()
  view.setPaging()
  await view.visibility('hidden')
  await view.render()
  await view.expose('missed')
  expect(view.saved).toEqual([])
  await view.visibility('visible')
  expect(view.saved).toEqual([]) // wait for fresh observer evidence
  const details = dom!.window.document.querySelector('details')!
  details.open = false
  await view.expose('missed')
  expect(view.saved).toEqual([])
  details.open = true
  await view.expose('missed', false)
  expect(view.saved).toEqual([])
  view.setSquads(['s2'])
  view.setRows([stream('filtered-in', 's2')])
  await view.render()
  expect(dom!.window.document.querySelector('[data-completion-id="missed"]')).toBeNull()
  expect(view.saved).toEqual([])
  await view.expose('filtered-in')
  expect(view.saved).toEqual(['filtered-in'])
  expect(view.saved).not.toContain('next-page')
  expect(text()).not.toContain('Assistant pointer')
})

test('failed persistence stays new and retries only with exposure; Assistant unread is independent', async () => {
  const view = await setup()
  view.setFail(true)
  await view.render()
  await view.expose('missed')
  expect(view.saved).toEqual([])
  expect(text()).toContain('Could not save seen state')
  expect(text()).toContain('New')
  expect(text()).toContain('1 unread update')
  view.setFail(false)
  const retry = [...dom!.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!
  await dom!.act(async () => retry.click())
  expect(view.saved).toEqual(['missed'])
  expect(text()).not.toContain('Could not save seen state')
  expect(text()).toContain('1 unread update')
})

test('fresh mounts and accounts do not replay cached acknowledged rows', async () => {
  const view = await setup()
  await view.render()
  await view.expose('missed')
  view.setUser('two')
  view.setFetched(false)
  await view.render()
  expect(text()).not.toContain('missed')
  expect(view.keys.at(-1)).toContain('two')
  view.setRows([stream('other-account')])
  view.setFetched(true)
  await view.render()
  expect(text()).toContain('other-account')
  expect(text()).not.toContain('missed')
  await view.expose('other-account')
  expect(view.saved).toEqual(['missed', 'other-account'])
})

test('offscreen live updates offer an upward control without scrolling automatically', async () => {
  const view = await setup()
  await view.render()
  const section = dom!.window.document.querySelector('details')!
  let scrolls = 0
  section.getBoundingClientRect = () => ({ top: -200, bottom: -100 }) as DOMRect
  section.scrollIntoView = () => {
    scrolls++
  }
  view.setRows([stream('live-offscreen')])
  await view.render()
  expect(scrolls).toBe(0)
  expect(view.saved).toEqual([])
  const jump = [...dom!.window.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'New updates ↑'
  )!
  expect(jump).toBeDefined()
  await dom!.act(async () => jump.click())
  expect(scrolls).toBe(1)
  expect(section.open).toBe(true)
  expect(view.saved).toEqual([])
})

test('seen state survives section filtering within the visit and unloaded pagination stays unseen', async () => {
  const view = await setup()
  view.setPaging()
  await view.render()
  await view.expose('missed')
  view.setSquads(['s2'])
  view.setRows([])
  await view.render()
  view.setSquads([])
  await view.render()
  expect(dom!.window.document.querySelector('[data-completion-id="missed"]')?.textContent).not.toContain('New')
  const more = [...dom!.window.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Show more updates'
  )!
  await dom!.act(async () => more.click())
  expect(text()).toContain('next-page')
  expect(view.saved).not.toContain('next-page')
})

test('overlapping refetched pages do not create duplicate completion rows', async () => {
  const view = await setup()
  view.setRows([stream('overlap'), stream('overlap')])
  await view.render()
  expect(dom!.window.document.querySelectorAll('[data-completion-id="overlap"]')).toHaveLength(1)
})

test('the upward affordance clears when the Updates heading is exposed without clicking it', async () => {
  const view = await setup()
  await view.render()
  const section = dom!.window.document.querySelector('details')!
  section.getBoundingClientRect = () => ({ top: -200, bottom: -100 }) as DOMRect
  view.setRows([stream('arrived-above')])
  await view.render()
  expect(text()).toContain('New updates ↑')
  const heading = section.querySelector('summary')!
  await dom!.act(async () => {
    for (const observer of [...observers])
      if (observer.targets.has(heading))
        observer.callback(
          [
            {
              target: heading,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: { top: 0 },
            } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        )
  })
  expect(text()).not.toContain('New updates ↑')
  expect(view.saved).toEqual([]) // heading exposure is not row exposure
})

test('compact timestamps expose exact date and time to assistive technology', async () => {
  const view = await setup()
  await view.render()
  for (const time of dom!.window.document.querySelectorAll('time')) {
    expect(time.hasAttribute('aria-label')).toBe(false)
    expect(time.querySelector('.sr-only')?.textContent).toBe(new Date(time.dateTime).toLocaleString())
    expect(time.querySelector('[aria-hidden="true"]')).not.toBeNull()
  }
})

test('real query cache isolates remounts and accounts while concurrent visits retain their own rows', async () => {
  const { QueryClient, QueryClientProvider, useInfiniteQuery } = await import('@tanstack/react-query')
  await setup() // Installs the DOM/observer harness; the unused fixture root remains empty.
  const first = dom!.createRoot()
  const second = dom!.createRoot()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const receipts = new Map<string, Set<string>>()
  const rows = [stream('visible'), stream('offscreen')]
  let reads = 0
  const hooks = {
    useInfiniteQuery: ((options: Parameters<typeof useInfiniteQuery>[0]) =>
      useInfiniteQuery({
        ...options,
        queryFn: async () => {
          reads++
          const user = options.queryKey[2] as string
          return { items: rows.filter((row) => !receipts.get(user)?.has(row.id)), hasMore: false, totalCount: 2 }
        },
      })) as never,
  }
  const emptyActivity = (() => ({ ownerId: null, activity: undefined })) as never
  const save = (user: string) => async (id: string) => {
    const seen = receipts.get(user) ?? new Set<string>()
    seen.add(id)
    receipts.set(user, seen)
    return { seen: true as const }
  }
  const saveOne = save('one')
  const saveTwo = save('two')
  const render = async (target: typeof first, user: string, visit: number) => {
    await dom!.act(async () => {
      target.root.render(
        <MemoryRouter>
          <QueryClientProvider client={cache}>
            <ReactQueryHooksProvider hooks={hooks}>
              <AccountFeedVisit
                key={`${user}:${visit}`}
                userId={user}
                acknowledge={user === 'one' ? saveOne : saveTwo}
                useActivity={emptyActivity}
              />
            </ReactQueryHooksProvider>
          </QueryClientProvider>
        </MemoryRouter>
      )
    })
    await dom!.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  try {
    await render(first, 'one', 1)
    await render(second, 'one', 1)
    expect(first.container.textContent).toContain('visible')
    expect(second.container.textContent).toContain('visible')
    const visible = first.container.querySelector('[data-completion-id="visible"]')!
    await dom!.act(async () => {
      for (const observer of [...observers])
        if (observer.targets.has(visible))
          observer.callback(
            [{ target: visible, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
            {} as IntersectionObserver
          )
    })
    expect(receipts.get('one')).toEqual(new Set(['visible']))
    await dom!.act(async () => {
      await cache.invalidateQueries({ queryKey: ['squads'] })
    })
    await dom!.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    // A refetch cannot remove an already displayed completion from either current visit.
    expect(first.container.textContent).toContain('visible')
    expect(second.container.textContent).toContain('visible')
    await render(first, 'one', 2)
    expect(first.container.textContent).not.toContain('visible')
    expect(first.container.textContent).toContain('offscreen')
    await render(first, 'two', 1)
    expect(first.container.textContent).toContain('visible')
    expect(receipts.get('two')).toBeUndefined()
    expect(reads).toBeGreaterThanOrEqual(6)
  } finally {
    await cache.cancelQueries()
    cache.clear()
  }
})

test('a stale completion response is terminal instead of retrying the same revision forever', async () => {
  const view = await setup()
  view.setFail('conflict')
  await view.render()
  await view.expose('missed')
  expect(text()).toContain('This completion was replaced. Refresh to see the latest revision.')
  expect(dom!.window.document.querySelector('[data-completion-id="missed"]')?.textContent).not.toContain('New')
  expect(text()).not.toContain('Could not save seen state')
  expect([...dom!.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(
    false
  )
  await view.expose('missed', false)
  await view.expose('missed')
  expect(view.attempts()).toBe(1)
  expect(view.saved).toEqual([])
})

test('the upward affordance stays in the Feed scroll pane rather than overlapping fixed app controls', async () => {
  const view = await setup()
  await view.render()
  dom!.window.document.querySelector('details')!.getBoundingClientRect = () => ({ top: -200 }) as DOMRect
  view.setRows([stream('offscreen-arrival')])
  await view.render()
  const jump = [...dom!.window.document.querySelectorAll('button')].find(
    (button) => button.textContent === 'New updates ↑'
  )!
  expect(jump.classList.contains('fixed')).toBe(false)
  expect(jump.parentElement?.classList.contains('sticky')).toBe(true)
  expect(jump.parentElement?.classList.contains('h-0')).toBe(true)
})

test('the count uses the server total while more pages remain', async () => {
  const view = await setup()
  view.setPaging()
  await view.render()
  expect(text()).toContain('42 completed')
  expect(text()).toContain('Show more updates')
})

const click = async (label: string) => {
  const button = [...dom!.window.document.querySelectorAll('button')].find((button) => button.textContent === label)
  expect(button).toBeDefined()
  await dom!.act(async () => button!.click())
}
const newer = (id: string) => ({ ...stream(id), completedAt: '2026-10-29T12:00:00.000Z' }) as WorkStream

test('Dismiss uses a compact ghost control while preserving its pending state and event handling', async () => {
  const view = await setup()
  let resolve!: () => void
  view.delay(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  await view.render()
  const summary = dom!.window.document.querySelector('summary')!
  const button = summary.querySelector('button')!
  expect(button.classList.contains('ficus-button-ghost')).toBe(true)
  expect(button.classList.contains('ficus-button-link')).toBe(false)
  for (const token of ['rounded-md', 'px-2', 'py-1', 'shrink-0']) {
    expect(button.classList.contains(token)).toBe(true)
  }
  let bubbled = false
  // React delegates at the root, so observe propagation above that root.
  const onClick = () => {
    bubbled = true
  }
  dom!.window.document.addEventListener('click', onClick)
  const event = new dom!.window.MouseEvent('click', { bubbles: true, cancelable: true })
  await dom!.act(async () => {
    button.dispatchEvent(event)
  })
  dom!.window.document.removeEventListener('click', onClick)
  expect(event.defaultPrevented).toBe(true)
  expect(bubbled).toBe(false)
  expect(button.disabled).toBe(true)
  expect(button.textContent).toBe('Dismissing…')
  expect(button.classList.contains('ficus-button-ghost')).toBe(true)
  await dom!.act(async () => resolve())
  expect(view.saved).toEqual(['missed'])
  expect(text()).not.toContain('Updates')
})

test('Dismiss explicitly receipts all loaded pages including offscreen rows but never unfetched rows', async () => {
  const view = await setup()
  view.setRows([stream('first'), stream('offscreen'), stream('last-page')])
  view.setPaging()
  await view.render()
  await view.expose('first')
  await click('Dismiss')
  expect(view.saved.sort()).toEqual(['first', 'last-page', 'offscreen'])
  expect(view.attempts()).toBe(3)
  expect(view.revisions).toEqual([at, at, at])
  expect(text()).not.toContain('Updates')
  // A refetch fills the first page with a previously unfetched OLD completion.
  view.setRows([{ ...stream('unfetched'), completedAt: '2026-10-27T12:00:00.000Z' } as WorkStream])
  await view.render()
  expect(text()).not.toContain('Updates')
  expect(view.saved).not.toContain('unfetched')
  view.setRows([stream('unfetched-tie')])
  await view.render()
  expect(text()).not.toContain('Updates')
  expect(view.saved).not.toContain('unfetched-tie')
  view.setRows([newer('actual-new')])
  await view.render()
  expect(text()).toContain('Updates')
  expect(text()).toContain('actual-new')
  expect(view.saved).not.toContain('actual-new')
  expect(text()).toContain('1 unread update') // Dismiss never consumes Assistant pointers.
})

test('Dismiss failures remain visible and retry without resending successful receipts', async () => {
  const view = await setup()
  await view.render()
  view.setFail(true)
  await click('Dismiss')
  expect(text()).toContain('Could not save seen state')
  expect(text()).toContain('New')
  expect(text()).toContain('Updates')
  view.setFail(false)
  await click('Dismiss')
  expect(view.saved).toEqual(['missed'])
  expect(text()).not.toContain('Updates')
})

test('409 on explicit Dismiss stays terminal across filtering without claiming persistence', async () => {
  const view = await setup()
  view.setFail('conflict')
  await view.render()
  await click('Dismiss')
  expect(text()).toContain('This completion was replaced. Refresh to see the latest revision.')
  expect(dom!.window.document.querySelector('[data-completion-id="missed"]')?.textContent).not.toContain('New')
  view.setSquads(['s2'])
  view.setRows([])
  await view.render()
  view.setSquads([])
  await view.render()
  await view.expose('missed')
  await click('Dismiss')
  expect(view.attempts()).toBe(1)
  expect(view.saved).toEqual([])
})

test('exposure racing Dismiss shares one receipt and arrivals during the save are not dismissed', async () => {
  const view = await setup()
  let resolve!: () => void
  view.delay(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  await view.render()
  await view.expose('missed')
  await click('Dismiss')
  expect(view.attempts()).toBe(1)
  view.setRows([newer('during-save')])
  await view.render()
  await dom!.act(async () => resolve())
  expect(view.saved).toEqual(['missed'])
  expect(text()).toContain('during-save')
  expect(text()).toContain('Updates')
})

test('account switch during Dismiss cannot hide or acknowledge the new account', async () => {
  const view = await setup()
  let resolve!: () => void
  view.delay(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  view.setRows([stream('old-1'), stream('old-2')])
  await view.render()
  await click('Dismiss')
  view.setUser('two')
  view.setRows([stream('new-account')])
  await view.render()
  await dom!.act(async () => resolve())
  expect(text()).toContain('new-account')
  expect(text()).toContain('Updates')
  expect(view.saved).not.toContain('new-account')
  expect(view.saved).not.toContain('old-2') // no queued writes after unmount
})

test('a partial dismissal retries only failed rows and new completion revisions reopen it', async () => {
  const view = await setup()
  view.setRows([stream('success'), stream('failure')])
  view.failId('failure')
  await view.render()
  await click('Dismiss')
  expect(view.saved).toEqual(['success'])
  expect(view.attempts()).toBe(2)
  expect(dom!.window.document.querySelector('[data-completion-id="success"]')?.textContent).not.toContain('New')
  view.failId(undefined)
  await click('Dismiss')
  expect(view.saved).toEqual(['success', 'failure'])
  expect(view.attempts()).toBe(3)
  view.setRows([newer('success')])
  await view.render()
  expect(text()).toContain('Updates')
  await view.expose('success')
  expect(view.revisions.at(-1)).toBe('2026-10-29T12:00:00.000Z')
})

test('Dismiss works without observer evidence even when collapsed or in a background tab', async () => {
  const view = await setup()
  await view.visibility('hidden')
  await view.render()
  dom!.window.document.querySelector('details')!.open = false
  await click('Dismiss')
  expect(view.saved).toEqual(['missed'])
  expect(text()).not.toContain('Updates')
})

test('refetched server totals are authoritative even while seen rows stay retained', async () => {
  const view = await setup()
  view.setPaging()
  await view.render()
  await view.expose('missed')
  view.setRows([])
  view.setTotal(41)
  await view.render()
  expect(text()).toContain('41 completed')
  expect(text()).toContain('missed')
})

test('Retry is still exposure-gated after a failed automatic receipt', async () => {
  const view = await setup()
  view.setFail(true)
  await view.render()
  await view.expose('missed')
  view.setFail(false)
  await view.expose('missed', false)
  await click('Retry')
  expect(view.attempts()).toBe(1)
  expect(view.saved).toEqual([])
  await view.expose('missed')
  expect(view.saved).toEqual(['missed'])
})

test('a newer offscreen arrival during Dismiss keeps its jump affordance after the save', async () => {
  const view = await setup()
  let resolve!: () => void
  view.delay(
    new Promise<void>((done) => {
      resolve = done
    })
  )
  await view.render()
  dom!.window.document.querySelector('details')!.getBoundingClientRect = () => ({ top: -200 }) as DOMRect
  await click('Dismiss')
  view.setRows([newer('race-above')])
  await view.render()
  expect(text()).toContain('New updates ↑')
  await dom!.act(async () => resolve())
  expect(text()).toContain('New updates ↑')
})
