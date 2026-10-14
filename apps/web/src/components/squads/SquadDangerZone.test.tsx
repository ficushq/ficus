import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { acquireDomHarness } from '../../test/domHarness'
import { queryKeys } from '../../queryKeys'
import { SquadDangerZone } from './SquadDangerZone'

function seededClient(permissions: string[] | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  if (permissions) queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions })
  return queryClient
}

function dangerZoneElement(queryClient: QueryClient) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <SquadDangerZone squadId="squad-1" squadName="Ficus" />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const renderDangerZone = (permissions: string[] | undefined) =>
  renderToStaticMarkup(dangerZoneElement(seededClient(permissions)))

describe('SquadDangerZone', () => {
  // Archiving is gated on squads:delete alone. squads:update gates editing the
  // other General fields and must neither grant nor be required for this block.
  test('renders for squads:delete without squads:update', () => {
    const html = renderDangerZone(['squads:delete'])

    expect(html).toContain('Danger zone')
    expect(html).toContain('data-setting-target="archive-squad"')
    expect(html).toContain('history is preserved')
    expect(html).toMatch(/<button[^>]*ficus-button-danger[^>]*>Archive squad<\/button>/)
  })

  test('renders nothing without squads:delete, even with squads:update', () => {
    expect(renderDangerZone(['squads:update'])).toBe('')
    expect(renderDangerZone([])).toBe('')
  })

  // Fail closed: an unresolved permission set must not flash a destructive control.
  test('renders nothing while permissions are unresolved', () => {
    expect(renderDangerZone(undefined)).toBe('')
  })

  test('opens the existing typed confirmation and archives only after the name is typed', async () => {
    const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1/settings' })
    const rendered = dom.createRoot()
    const queryClient = seededClient(['squads:delete'])
    const calls: Array<{ url: string; method?: string }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      return new dom.window.Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) as unknown as Response
    }) as typeof fetch
    try {
      await dom.act(async () => rendered.root.render(dangerZoneElement(queryClient)))
      const doc = dom.window.document
      const button = (label: string) => [...doc.querySelectorAll('button')].find((b) => b.textContent === label)

      // Closed until asked for: the confirmation is not on the page yet.
      expect(doc.body.textContent).not.toContain('to confirm')

      await dom.act(async () => button('Archive squad')!.click())
      expect(doc.body.textContent).toContain('to confirm')
      const confirm = button('Archive Squad') as HTMLButtonElement
      expect(confirm.disabled).toBe(true)
      await dom.act(async () => confirm.click())
      expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)

      const input = doc.querySelector('input[placeholder="Ficus"]') as HTMLInputElement
      await dom.act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ficus')
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      expect(confirm.disabled).toBe(false)
      await dom.act(async () => confirm.click())
      await dom.act(async () => Bun.sleep(10))

      const deletes = calls.filter((call) => call.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(deletes[0]!.url).toMatch(/\/squads\/squad-1$/)
    } finally {
      globalThis.fetch = originalFetch
      await queryClient.cancelQueries()
      queryClient.clear()
      await dom.cleanup()
    }
  })
})
