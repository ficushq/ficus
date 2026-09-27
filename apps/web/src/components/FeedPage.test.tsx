import { acquireDomHarness } from '../test/domHarness'
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { PendingAction } from '@ficus/shared'
import { queryKeys } from '../queryKeys'

let domHarness: Awaited<ReturnType<typeof acquireDomHarness>> | undefined

let pendingActions: PendingAction[] = []
let actionsLoading = false
let actionsError = false
let actionsFetching = false
let invalidatedQueries: unknown[] = []
let finishInvalidations: Array<() => void> = []
let currentQueryClient: ReturnType<typeof createTrackingQueryClient> | null = null

import { ReactQueryHooksProvider } from '../reactQueryHooks'

const reactQueryOverrides = {
  useQueryClient: () => currentQueryClient,
  useInfiniteQuery: () => ({ data: undefined, isLoading: false, isFetchingNextPage: false, hasNextPage: false }),
  useQuery: (options: { queryKey?: readonly unknown[] }) => {
    const key = options.queryKey ?? []
    const cachedData = currentQueryClient?.getQueryData(key)
    if (cachedData !== undefined) return { data: cachedData, isLoading: false, isError: false }
    if (key[0] === 'auth' && key[1] === 'permissions') return { data: undefined, isLoading: true, isError: false }
    return { data: undefined, isLoading: false, isError: false }
  },
}

import { FeedPage } from './FeedPage'
import { pendingActionsPresentation } from '../hooks/usePendingActions'

const dependencies = {
  FeedVisitSummary: () => null,
  usePendingActions: () => ({
    data: pendingActions,
    isLoading: actionsLoading,
    isError: actionsError,
    isFetching: actionsFetching,
    error: actionsError ? new Error('Needs attention unavailable') : null,
    refetch: () => Promise.resolve(),
  }),
  WorkStreamListAll: () => <div data-test-slot="feed">Work stream fixture</div>,
  ActionCenterContent: ({ actions, isLoading }: { actions: PendingAction[]; isLoading: boolean }) => (
    <div data-test-slot="actions">
      {isLoading ? 'Loading actions' : null}
      {actions.map((action) => (
        <div key={action.id}>{action.id}</div>
      ))}
    </div>
  ),
}

function createTrackingQueryClient() {
  const data = new Map<string, unknown>()
  return {
    setQueryData(key: readonly unknown[], value: unknown) {
      data.set(JSON.stringify(key), value)
    },
    getQueryData(key: readonly unknown[]) {
      return data.get(JSON.stringify(key))
    },
    invalidateQueries(options: unknown) {
      invalidatedQueries.push(options)
      return new Promise<void>((resolve) => finishInvalidations.push(resolve))
    },
  }
}

function withQueryClient(children: ReactNode) {
  currentQueryClient = createTrackingQueryClient()
  return children
}

async function installDom() {
  return (domHarness = await acquireDomHarness({ url: 'http://localhost/feed' }))
}

function touchEvent(window: Awaited<ReturnType<typeof acquireDomHarness>>['window'], type: string, clientY: number) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : [{ clientY }],
  })
  Object.defineProperty(event, 'changedTouches', {
    value: [{ clientY }],
  })
  return event
}

async function renderFeedPageWithEffects() {
  const dom = await installDom()
  const { window } = dom
  const { root } = domHarness!.createRoot()

  await domHarness!.act(async () => {
    root.render(
      <ReactQueryHooksProvider hooks={reactQueryOverrides}>
        {withQueryClient(<FeedPage dependencies={dependencies} />)}
      </ReactQueryHooksProvider>
    )
  })
  await domHarness!.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  return { window, root }
}

function renderFeedPage() {
  return renderToStaticMarkup(
    <ReactQueryHooksProvider hooks={reactQueryOverrides}>
      {withQueryClient(<FeedPage dependencies={dependencies} />)}
    </ReactQueryHooksProvider>
  )
}

function action(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'action-1',
    type: 'workstream-review',
    priority: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    canRespond: true,
    data: {
      workStreamId: 'ws-1',
      workStreamTitle: 'Review mobile behavior',
      squadId: 'squad-1',
      squadName: 'Ficus',
      assigneeAgentId: null,
      assigneeName: null,
      completionMode: 'pr-merge',
      prompt: 'Please review',
    },
    ...overrides,
  }
}

describe('pendingActionsPresentation', () => {
  test('uses loading only before a pending-actions result resolves', () => {
    expect(pendingActionsPresentation({ data: undefined, isLoading: true, isFetching: true, isError: false })).toEqual({
      actions: [],
      count: null,
      status: 'loading',
    })
  })

  test('keeps cached empty data ready during a background refetch', () => {
    expect(pendingActionsPresentation({ data: [], isLoading: false, isFetching: true, isError: false })).toEqual({
      actions: [],
      count: 0,
      status: 'ready',
    })
  })

  test('keeps errors unavailable rather than presenting cached data as ready', () => {
    expect(pendingActionsPresentation({ data: [], isError: true })).toEqual({
      actions: [],
      count: null,
      status: 'error',
    })
  })
})

describe('FeedPage', () => {
  afterEach(() => {
    pendingActions = []
    actionsLoading = false
    actionsError = false
    actionsFetching = false
    invalidatedQueries = []
    finishInvalidations = []
  })

  test('keeps work stream actions in Needs you before the work stream feed', () => {
    pendingActions = [action({ id: 'review-action' })]

    const html = renderFeedPage()

    expect(html.indexOf('data-test-slot="actions"')).toBeLessThan(html.indexOf('data-test-slot="feed"'))
    expect(html.indexOf('review-action')).toBeLessThan(html.indexOf('Work stream fixture'))
  })

  test('renders needs you expanded by default with pending action count', () => {
    pendingActions = [action(), action({ id: 'action-2' })]
    actionsLoading = false

    const html = renderFeedPage()

    expect(html).toContain('<details')
    expect(html).toContain('<details open')
    expect(html).toContain('Needs you')
    expect(html).toContain('2 pending')
    expect(html).not.toContain('aria-label=')
  })

  test('shows the Needs you loading state before the initial result resolves', () => {
    actionsLoading = true
    actionsFetching = true

    const html = renderFeedPage()

    expect(html).toContain('Needs you')
    expect(html).toContain('Loading')
  })

  test('keeps a cached empty layout stable while a real background query is in flight', async () => {
    const queryKey = ['test', 'pending-actions', 'background-refetch'] as const
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    queryClient.setQueryData(queryKey, [] as PendingAction[])
    let finishFetch!: (actions: PendingAction[]) => void
    const useRefreshingPendingActions = () =>
      useQuery({
        queryKey,
        queryFn: () => new Promise<PendingAction[]>((resolve) => (finishFetch = resolve)),
      })
    const dom = await installDom()
    const { root } = dom.createRoot()

    await dom.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <FeedPage dependencies={{ ...dependencies, usePendingActions: useRefreshingPendingActions }} />
        </QueryClientProvider>
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const activeFetches = queryClient.isFetching({ queryKey })
    const bodyText = dom.window.document.body.textContent

    await dom.act(async () => {
      finishFetch([])
      await Promise.resolve()
      root.unmount()
    })

    expect(activeFetches).toBe(1)
    expect(bodyText).toContain('Needs you')
    expect(bodyText).toContain('You’re all caught up')
    expect(bodyText).toContain('Work stream fixture')
  })

  test('retains a nonempty count during a background refetch', () => {
    pendingActions = [action()]
    actionsFetching = true

    const html = renderFeedPage()

    expect(html).toContain('1 pending')
    expect(html).not.toContain('Loading')
  })

  test('keeps the Needs you disclosure visible when its query fails', () => {
    actionsError = true

    const html = renderFeedPage()

    expect(html).toContain('<details')
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('0 pending')
  })

  test('keeps action center content free of a redundant divider', () => {
    pendingActions = [action()]
    actionsLoading = false

    const html = renderFeedPage()

    expect(html).not.toContain('border-t border-th-border')
    expect(html).not.toContain('border-t border-border')
  })

  test('uses the shared brand pull-to-refresh container', () => {
    const html = renderFeedPage()

    expect(html).toContain('data-testid="feed-pull-to-refresh"')
    expect(html).toContain('data-testid="pull-to-refresh-indicator"')
    expect(html).toContain('var(--brand-gradient-to)')
  })

  test('does not force the pull-to-refresh root to full height so app shell bottom padding remains visible', () => {
    const html = renderFeedPage()

    const feedContainer = html.match(/<div[^>]*data-testid="feed-pull-to-refresh"[^>]*>/)?.[0]
    expect(feedContainer).toBeDefined()
    expect(feedContainer).not.toContain('h-full')
  })

  test('renders action center content for pending actions', () => {
    pendingActions = [action()]
    actionsLoading = false

    const html = renderFeedPage()

    expect(html).toContain('<details')
    expect(html).toContain('action-1')
  })

  test('pulling down at the top refreshes feed work stream and action queries', async () => {
    const { window, root } = await renderFeedPageWithEffects()
    const pullTarget = window.document.getElementById('feed-pull-to-refresh') as HTMLElement

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })

    await domHarness!.act(async () => {
      pullTarget.dispatchEvent(touchEvent(window, 'touchstart', 10))
      pullTarget.dispatchEvent(touchEvent(window, 'touchmove', 95))
      pullTarget.dispatchEvent(touchEvent(window, 'touchend', 95))
      await Promise.resolve()
    })

    expect(window.document.body.textContent).toContain('Refreshing feed')
    expect(invalidatedQueries).toContainEqual({ queryKey: queryKeys.squads.all })
    expect(invalidatedQueries).toContainEqual({ queryKey: queryKeys.actions.pending() })

    await domHarness!.act(async () => {
      finishInvalidations.forEach((finish) => finish())
      await Promise.resolve()
    })
    expect(window.document.body.textContent).not.toContain('Refreshing feed')

    await domHarness!.act(async () => {
      root.unmount()
    })
  })
})

afterEach(async () => {
  await domHarness?.cleanup()
  domHarness = undefined
})

test('anchors the Feed heading before Needs you in loading, empty, and pending states', () => {
  for (const state of ['loading', 'empty', 'pending']) {
    actionsLoading = state === 'loading'
    pendingActions = state === 'pending' ? [action()] : []
    const html = renderFeedPage()
    expect(html.indexOf('>Feed</h2>')).toBeLessThan(html.indexOf('Needs you'))
    expect(html).toContain('Needs you')
    if (state === 'empty') expect(html).toContain('You’re all caught up')
    if (state === 'loading') expect(html).not.toContain('data-test-slot="actions"')
  }
  actionsLoading = false
  pendingActions = []
})
