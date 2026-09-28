import { expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { waitFor } from '@testing-library/dom'
import type { TrackedResourcesView } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { WorkStreamTrackedResources } from './WorkStreamTrackedResources'

type TrackedRow = TrackedResourcesView['resources'][number]

const deliveryPr: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'pull_request',
  number: 7,
  url: 'https://github.com/acme/api/pull/7',
  key: 'github:acme/api:pull_request:7',
  source: 'delivery',
  delivery: true,
  mergeState: 'merged',
  subscriptionIds: ['sub-delivery'],
  subscribed: true,
}
const trackedIssue: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'issue',
  number: 12,
  url: 'https://github.com/acme/api/issues/12',
  key: 'github:acme/api:issue:12',
  source: 'tracked',
  delivery: false,
  subscriptionIds: [],
  subscribed: false,
}
/** A tracked pull request that does not yet count toward delivery. */
const trackedPr: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'pull_request',
  number: 9,
  url: 'https://github.com/acme/api/pull/9',
  key: 'github:acme/api:pull_request:9',
  source: 'tracked',
  delivery: false,
  subscriptionIds: [],
  subscribed: false,
}
/** A tracked pull request explicitly designated as part of the delivery. */
const flaggedPr: TrackedRow = {
  integration: 'github',
  repository: 'acme/api',
  kind: 'pull_request',
  number: 11,
  url: 'https://github.com/acme/api/pull/11',
  key: 'github:acme/api:pull_request:11',
  source: 'tracked',
  delivery: true,
  mergeState: 'closed',
  subscriptionIds: ['sub-11'],
  subscribed: true,
}
const linearIssue: TrackedRow = {
  integration: 'linear',
  repository: 'eng',
  kind: 'issue',
  number: 12,
  externalId: 'issue-uuid-1',
  url: 'https://linear.app/acme/issue/ENG-12/fix-thing',
  key: 'linear:eng:issue:12',
  source: 'tracked',
  delivery: false,
  subscriptionIds: [],
  subscribed: false,
}
/** A Linear issue without a stored `url`: no code-host fallback exists for Linear, so it renders unlinked. */
const linearIssueWithoutUrl: TrackedRow = {
  ...linearIssue,
  number: 13,
  key: 'linear:eng:issue:13',
  url: undefined,
}
const deliveryState = (
  pullRequests: TrackedResourcesView['delivery']['pullRequests'] = [],
  complete = false
): TrackedResourcesView['delivery'] => ({ pullRequests, complete })
const deliveryEntry = (resource: TrackedRow, primary: boolean, state: 'open' | 'merged' | 'closed') => ({
  key: resource.key,
  repository: resource.repository,
  number: resource.number,
  url: resource.url,
  primary,
  state,
})
const view = (overrides: Partial<TrackedResourcesView> = {}): TrackedResourcesView => ({
  resources: [deliveryPr, trackedIssue],
  subscriptions: 'active',
  delivery: deliveryState([deliveryEntry(deliveryPr, true, 'merged')], true),
  ...overrides,
})

type Call = { url: string; method: string; body?: string }

/**
 * Drives the component through the real API functions: every assertion about a
 * request (path, method, body) is an assertion about what the server receives.
 */
async function renderTracked<T>(
  options: {
    view?: TrackedResourcesView
    canUpdate?: boolean
    respond?: (call: Call, dom: Awaited<ReturnType<typeof acquireDomHarness>>) => Response | undefined
  },
  inspect: (context: {
    dom: Awaited<ReturnType<typeof acquireDomHarness>>
    calls: Call[]
    cache: QueryClient
  }) => T | Promise<T>
): Promise<T> {
  const current = options.view ?? view()
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  cache.setQueryData(queryKeys.squads.workStreamTracked('ws-1'), current)
  const dom = await acquireDomHarness({
    url: 'http://localhost/work-streams/ws-1',
    beforeUnmount: async () => cache.cancelQueries(),
    afterUnmount: () => cache.clear(),
  })
  const calls: Call[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body as string | undefined,
    }
    calls.push(call)
    const custom = options.respond?.(call, dom)
    if (custom) return custom
    return new dom.window.Response(JSON.stringify(current), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response
  }) as unknown as typeof fetch
  const rendered = dom.createRoot()
  try {
    await dom.act(async () =>
      rendered.root.render(
        <QueryClientProvider client={cache}>
          <WorkStreamTrackedResources workStreamId="ws-1" canUpdate={options.canUpdate ?? true} />
        </QueryClientProvider>
      )
    )
    return await inspect({ dom, calls, cache })
  } finally {
    globalThis.fetch = originalFetch
    await dom.cleanup()
  }
}

const buttonWithLabel = (document: Document, label: string) =>
  [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label)

test('renders tracked issues and pull requests with their links, delivery badge and subscription hints', async () => {
  await renderTracked({ view: view({ subscriptions: 'not-following' }) }, ({ dom }) => {
    const { document } = dom.window
    const text = document.body.textContent ?? ''
    expect(text).toContain('Tracked issues and PRs')
    expect(text).toContain('acme/api#7')
    expect(text).toContain('acme/api#12')
    const links = [...document.querySelectorAll('a')]
    const pr = links.find((link) => link.getAttribute('href') === 'https://github.com/acme/api/pull/7')
    const issue = links.find((link) => link.getAttribute('href') === 'https://github.com/acme/api/issues/12')
    expect(pr).toBeDefined()
    expect(issue).toBeDefined()
    expect(pr!.getAttribute('target')).toBe('_blank')
    expect(pr!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(issue!.getAttribute('target')).toBe('_blank')
    // The delivery change request is labelled and cannot be untracked here.
    expect(text).toContain('delivery')
    expect(buttonWithLabel(document, 'Stop tracking acme/api#7')).toBeUndefined()
    expect(buttonWithLabel(document, 'Stop tracking acme/api#12')).toBeDefined()
    // Per-resource subscription state, plus one sentence for the whole stream.
    expect(text).toContain('not subscribed')
    expect(text).toContain('This workflow does not follow code-host changes')
    // Reference material never appears in this section.
    expect(text).not.toContain('sources')
  })
})

test('renders a Linear issue label with its link, and without an anchor when no url is stored', async () => {
  await renderTracked({ view: view({ resources: [linearIssue, linearIssueWithoutUrl] }) }, ({ dom }) => {
    const { document } = dom.window
    const text = document.body.textContent ?? ''
    expect(text).toContain('ENG-12')
    expect(text).toContain('ENG-13')
    const links = [...document.querySelectorAll('a')]
    const linked = links.find((link) => link.getAttribute('href') === 'https://linear.app/acme/issue/ENG-12/fix-thing')
    expect(linked).toBeDefined()
    expect(linked!.textContent).toContain('ENG-12')
    // No stored url and no GitHub fallback exists for Linear, so ENG-13 renders as plain text, not a link.
    expect(links.some((link) => link.textContent?.includes('ENG-13'))).toBe(false)
  })
})

test('hides every update affordance and shows the empty state without workstreams:update', async () => {
  await renderTracked({ view: view({ resources: [] }), canUpdate: false }, ({ dom }) => {
    const { document } = dom.window
    expect(document.body.textContent).toContain('Nothing tracked')
    expect(document.querySelector('input')).toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })
  await renderTracked({ canUpdate: false }, ({ dom }) => {
    expect(dom.window.document.body.textContent).not.toContain('Nothing tracked')
    expect(buttonWithLabel(dom.window.document, 'Stop tracking acme/api#12')).toBeUndefined()
    expect(dom.window.document.querySelector('input')).toBeNull()
  })
})

test('untracks a resource by identity and refreshes the list', async () => {
  await renderTracked({}, async ({ dom, calls }) => {
    await dom.act(async () => buttonWithLabel(dom.window.document, 'Stop tracking acme/api#12')!.click())
    const remove = calls.find((call) => call.method === 'DELETE')
    expect(remove).toBeDefined()
    expect(remove!.url).toContain('/api/workstreams/ws-1/tracked')
    expect(JSON.parse(remove!.body!)).toEqual({
      resource: { integration: 'github', repository: 'acme/api', kind: 'issue', number: 12 },
    })
    await waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true))
  })
})

test('adds a link by URL and surfaces the API error inline', async () => {
  await renderTracked(
    {
      respond: (call, dom) =>
        call.method === 'POST' && (call.body ?? '').includes('nope')
          ? (new dom.window.Response(JSON.stringify({ error: 'Link is not a supported issue or pull request URL' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }) as unknown as Response)
          : undefined,
    },
    async ({ dom, calls }) => {
      const { document } = dom.window
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="https://github.com/owner/repo/issues/12 or https://linear.app/team/issue/KEY-123"]'
      )!
      const setValue = async (value: string) =>
        dom.act(async () => {
          Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      const submit = () =>
        dom.act(async () =>
          [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add')!.click()
        )

      await setValue('https://github.com/acme/api/issues/99')
      await submit()
      const post = calls.find((call) => call.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.url).toContain('/api/workstreams/ws-1/tracked')
      expect(JSON.parse(post!.body!)).toEqual({ url: 'https://github.com/acme/api/issues/99' })
      await waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true))

      await setValue('nope')
      await submit()
      await waitFor(() =>
        expect(document.body.textContent).toContain('Link is not a supported issue or pull request URL')
      )
    }
  )
})

const textOf = (document: Document, text: string) =>
  [...document.querySelectorAll('span')].filter((element) => element.textContent === text)

test('badges every delivery pull request, chips resolved merge state and summarizes delivery progress', async () => {
  await renderTracked(
    {
      canUpdate: false,
      view: view({
        resources: [deliveryPr, { ...trackedPr, mergeState: 'open' }, flaggedPr, trackedIssue],
        delivery: deliveryState(
          [
            deliveryEntry(deliveryPr, true, 'merged'),
            deliveryEntry(flaggedPr, false, 'closed'),
            deliveryEntry({ ...trackedPr, delivery: true }, false, 'open'),
          ],
          false
        ),
      }),
    },
    ({ dom }) => {
      const { document } = dom.window
      const text = document.body.textContent ?? ''
      // Both the primary change request and any flagged pull request read as delivery.
      expect(textOf(document, 'delivery')).toHaveLength(2)
      // Settled merge states are visible; an open pull request needs no chip.
      const merged = textOf(document, 'merged')
      expect(merged).toHaveLength(1)
      expect(merged[0]!.className).toContain('bg-status-success-badge-surface')
      expect(textOf(document, 'closed')).toHaveLength(1)
      expect(textOf(document, 'open')).toHaveLength(0)
      expect(text).toContain('Delivery: 1 of 3 pull requests merged')
    }
  )
  // Nothing counts toward delivery, so there is no progress to summarize.
  await renderTracked({ view: view({ delivery: deliveryState() }) }, ({ dom }) => {
    expect(dom.window.document.body.textContent).not.toContain('pull requests merged')
  })
})

test('offers the delivery checkbox only for pull request links and sends the flag', async () => {
  await renderTracked({}, async ({ dom, calls }) => {
    const { document } = dom.window
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')!
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(document.body.textContent).toContain('Counts toward delivery')
    const setValue = async (value: string) =>
      dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    const submit = () =>
      dom.act(async () =>
        [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add')!.click()
      )

    expect(checkbox.disabled).toBe(true)
    await setValue('https://github.com/acme/api/issues/99')
    expect(checkbox.disabled).toBe(true)
    await setValue('https://github.com/acme/api/pull/99')
    expect(checkbox.disabled).toBe(false)

    await dom.act(async () => checkbox.click())
    await submit()
    expect(JSON.parse(calls.find((call) => call.method === 'POST')!.body!)).toEqual({
      url: 'https://github.com/acme/api/pull/99',
      delivery: true,
    })

    // A link that is not a pull request can never carry the flag.
    await setValue('https://github.com/acme/api/issues/99')
    expect(checkbox.disabled).toBe(true)
    await submit()
    const posts = calls.filter((call) => call.method === 'POST')
    expect(JSON.parse(posts[posts.length - 1]!.body!)).toEqual({ url: 'https://github.com/acme/api/issues/99' })
  })
})

test('never offers the delivery flag for a Linear issue link', async () => {
  await renderTracked({}, async ({ dom, calls }) => {
    const { document } = dom.window
    const input = document.querySelector<HTMLInputElement>('input[type="text"]')!
    const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await dom.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'https://linear.app/acme/issue/ENG-12/fix-thing'
      )
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    // Linear has no pull requests, so nothing about a Linear link can count toward delivery.
    expect(checkbox.disabled).toBe(true)
    await dom.act(async () =>
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Add')!.click()
    )
    expect(JSON.parse(calls.find((call) => call.method === 'POST')!.body!)).toEqual({
      url: 'https://linear.app/acme/issue/ENG-12/fix-thing',
    })
  })
})

test('marks a tracked pull request as delivery and refreshes the list', async () => {
  const marked = view({ resources: [deliveryPr, trackedPr, flaggedPr, trackedIssue] })
  await renderTracked({ view: marked }, async ({ dom, calls }) => {
    const { document } = dom.window
    // Only a tracked pull request that is not already part of the delivery can be designated.
    expect(buttonWithLabel(document, 'Mark acme/api#9 as delivery')).toBeDefined()
    expect(buttonWithLabel(document, 'Mark acme/api#7 as delivery')).toBeUndefined()
    expect(buttonWithLabel(document, 'Mark acme/api#11 as delivery')).toBeUndefined()
    expect(buttonWithLabel(document, 'Mark acme/api#12 as delivery')).toBeUndefined()

    await dom.act(async () => buttonWithLabel(document, 'Mark acme/api#9 as delivery')!.click())
    const post = calls.find((call) => call.method === 'POST')
    expect(post).toBeDefined()
    expect(post!.url).toContain('/api/workstreams/ws-1/tracked')
    expect(JSON.parse(post!.body!)).toEqual({
      resource: { integration: 'github', repository: 'acme/api', kind: 'pull_request', number: 9 },
      delivery: true,
    })
    await waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true))
  })
  await renderTracked({ view: marked, canUpdate: false }, ({ dom }) => {
    expect(buttonWithLabel(dom.window.document, 'Mark acme/api#9 as delivery')).toBeUndefined()
  })
})
