import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { queryKeys } from '../queryKeys'
import { RecommendationsPage } from './RecommendationsPage'

function renderPage(permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const filters = { status: 'open', squadId: undefined, limit: 50 }
  client.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  client.setQueryData(queryKeys.recommendations.infinite(filters), {
    pages: [{ items: [], nextCursor: null }],
    pageParams: [null],
  })
  client.setQueryData(queryKeys.squads.list(), [{ id: 'squad-1', name: 'Secret Squad' }])
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RecommendationsPage />
    </QueryClientProvider>
  )
}

describe('RecommendationsPage RBAC', () => {
  test('recommendations-only readers see an unfiltered feed without squad names', () => {
    const html = renderPage(['recommendations:read'])
    expect(html).toContain('Showing all authorized squads')
    expect(html).not.toContain('Secret Squad')
    expect(html).not.toContain('Filter recommendations by squad')
  })

  test('squad readers receive squad filtering navigation', () => {
    const html = renderPage(['recommendations:read', 'squads:read'])
    expect(html).toContain('Filter recommendations by squad')
    expect(html).toContain('Secret Squad')
  })

  test('denied readers degrade closed', () => {
    expect(renderPage([])).toContain('Access denied')
  })
})

async function mountPage(permissions: string[] | null, fetchImpl: typeof fetch) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const dom = await acquireDomHarness({
    url: 'http://localhost/recommendations',
    beforeUnmount: async () => {
      await client.cancelQueries()
    },
    afterUnmount: async () => {
      client.clear()
      // TanStack batches observer notifications on its scheduler after query
      // cancellation. Drain that production scheduler while this DOM owner is
      // still installed; otherwise its final setState can reach the next file.
      await Bun.sleep(50)
    },
  })
  if (permissions) client.setQueryData(queryKeys.auth.permissions(undefined), { permissions })
  const rendered = dom.createRoot()
  const container = rendered.container
  const root = rendered.root
  globalThis.fetch = fetchImpl
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RecommendationsPage />
      </QueryClientProvider>
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return {
    container,
    restore: async () => {
      await dom.cleanup()
    },
  }
}

const recommendation = {
  id: '00000000-0000-4000-8000-000000000001',
  squadId: '00000000-0000-4000-8000-000000000002',
  status: 'open',
  confidence: 'high',
  title: 'Recommendation',
  summary: 'Summary',
  recurrence: { occurrences: 1, executions: 1, agents: 1 },
  baseline: { sampleSize: 1, avgDurationMs: 1, avgTokens: 1, failedToolCalls: 0, estimatedAvoidableRetries: 0 },
  proposedRemediation: { type: 'add_sandbox_package', package: 'jq' },
  policy: 'recommendation-only',
  firstSeenAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

describe('RecommendationsPage request gating', () => {
  test('keeps protected requests disabled while permissions load or fail', async () => {
    let settleLoading!: (response: Response) => void
    const loading = new Promise<Response>((resolve) => {
      settleLoading = resolve
    })
    for (const fixture of [
      { response: loading, settle: () => settleLoading(Response.json({ permissions: [] })) },
      { response: Promise.resolve(Response.json({ error: 'no' }, { status: 500 })), settle: () => undefined },
    ]) {
      const calls: string[] = []
      const mounted = await mountPage(null, (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return fixture.response
      }) as typeof fetch)
      try {
        expect(calls.some((url) => url.includes('/recommendations'))).toBe(false)
        expect(calls.some((url) => url.includes('/squads'))).toBe(false)
      } finally {
        fixture.settle()
        await act(async () => Bun.sleep(0))
        await mounted.restore()
      }
    }
  })

  test('does not request squads or detail for a recommendations-only reader', async () => {
    const calls: string[] = []
    const mounted = await mountPage(['recommendations:read'], (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({ items: [], nextCursor: null })
    }) as typeof fetch)
    try {
      expect(calls.filter((url) => url.includes('/recommendations'))).toHaveLength(1)
      expect(calls.some((url) => url.includes('/squads'))).toBe(false)
      expect(calls.some((url) => /\/recommendations\/[0-9a-f-]+/.test(url))).toBe(false)
    } finally {
      await mounted.restore()
    }
  })

  test('restart discards the rejected cursor and fetches page one again', async () => {
    const calls: string[] = []
    const mounted = await mountPage(['recommendations:read'], (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('cursor=cursor-one')) {
        return Response.json(
          { error: 'Recommendation access changed', code: 'RECOMMENDATIONS_CURSOR_RESET_REQUIRED' },
          { status: 409 }
        )
      }
      return Response.json({ items: [recommendation], nextCursor: 'cursor-one' })
    }) as typeof fetch)
    try {
      const button = (label: string) =>
        [...mounted.container.querySelectorAll('button')].find((element) => element.textContent?.includes(label)) as
          HTMLButtonElement | undefined
      expect(mounted.container.textContent).toContain('Load more')
      await act(async () => {
        button('Load more')?.click()
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      expect(calls.some((url) => url.includes('cursor=cursor-one'))).toBe(true)
      expect(button('Restart results')).toBeDefined()
      await act(async () => {
        button('Restart results')?.click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(calls.filter((url) => !url.includes('cursor=')).length).toBe(2)
      expect(calls.filter((url) => url.includes('cursor=cursor-one'))).toHaveLength(1)
    } finally {
      await mounted.restore()
    }
  })
})
