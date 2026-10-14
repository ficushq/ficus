import { afterEach, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AssistantRoutingPreview } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import {
  ASSISTANT_ROUTING_PREVIEW_DEBOUNCE_MS,
  normalizeRoutingDraft,
  useAssistantRoutingPreview,
} from './useAssistantRoutingPreview'

type Hook = ReturnType<typeof useAssistantRoutingPreview>
type Fetch = (conversationId: string, draft: string, signal?: AbortSignal) => Promise<AssistantRoutingPreview>

const chleaId = 'a1b2c3d4-0000-4000-8000-000000000001'
const billingId = 'b2c3d4e5-0000-4000-8000-000000000002'

let dom: Awaited<ReturnType<typeof acquireDomHarness>> | undefined
let queryClient: QueryClient | undefined
let latest: Hook

afterEach(async () => {
  await dom?.act(async () => {
    await queryClient?.cancelQueries()
    queryClient?.clear()
  })
  await dom?.cleanup()
  dom = undefined
  queryClient = undefined
})

async function mount(fetchPreview: Fetch, enabled = true) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let pending: Array<{ run: () => void; ms: number }> = []
  const schedule = (run: () => void, ms: number) => {
    const entry = { run, ms }
    pending.push(entry)
    return () => {
      pending = pending.filter((other) => other !== entry)
    }
  }
  function Probe() {
    latest = useAssistantRoutingPreview({ conversationId: 'c1', enabled, fetchPreview, schedule })
    return null
  }
  const { root } = dom.createRoot()
  await dom.act(async () =>
    root.render(
      <QueryClientProvider client={queryClient!}>
        <Probe />
      </QueryClientProvider>
    )
  )
  const act = (fn: () => void) => dom!.act(async () => fn())
  return {
    delays: () => pending.map((entry) => entry.ms),
    type: (text: string) => act(() => latest.onDraftChange(text)),
    pause: () =>
      act(() => {
        const due = pending
        pending = []
        for (const entry of due) entry.run()
      }),
    act,
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt++)
    await dom!.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  expect(check()).toBe(true)
}

const chlea = { scope: 'squad' as const, squadId: chleaId, squadName: 'Chlea', confidence: 0.86 }

test('a paused draft is routed once; the answer goes with exactly that text', async () => {
  const fetchPreview = mock<Fetch>(async () => ({ hint: chlea }))
  const f = await mount(fetchPreview)
  await f.type('The checkout   button is broken')
  expect(f.delays()).toEqual([ASSISTANT_ROUTING_PREVIEW_DEBOUNCE_MS])
  expect(fetchPreview).not.toHaveBeenCalled()
  await f.pause()
  await until(() => latest.hint !== null)
  expect(fetchPreview).toHaveBeenCalledTimes(1)
  expect(fetchPreview.mock.calls[0]![1]).toBe('The checkout button is broken')
  expect(latest.hint).toEqual(chlea)

  // Sent as it stands (spacing aside): the preview goes with it.
  expect(latest.routingFor('The checkout button  is broken ')).toEqual({
    hint: { scope: 'squad', squadId: chleaId, confidence: 0.86 },
  })
  // Edited since: the pill stays up while typing, but the old answer is not sent for new text.
  await f.type('The checkout button is broken on mobile')
  expect(latest.hint).toEqual(chlea)
  expect(latest.routingFor('The checkout button is broken on mobile')).toBeUndefined()
})

test("the user's pick goes with the message whatever the text; clearing the draft forgets it", async () => {
  const f = await mount(mock<Fetch>(async () => ({ hint: null })))
  await f.type('Fix the invoices export')
  await f.act(() => latest.setPick({ scope: 'squad', squadId: billingId, squadName: 'Billing' }))
  expect(latest.routingFor('Fix the invoices export please')).toEqual({ pick: { scope: 'squad', squadId: billingId } })
  await f.act(() => latest.setPick({ scope: 'none' }))
  expect(latest.routingFor('x')).toEqual({ pick: { scope: 'none' } })
  await f.type('')
  expect(latest.pick).toBeNull()
  expect(latest.routingFor('Fix the invoices export')).toBeUndefined()
})

test('short drafts and a disabled preview ask nothing', async () => {
  const fetchPreview = mock<Fetch>(async () => ({ hint: chlea }))
  const f = await mount(fetchPreview)
  await f.type('fix it')
  await f.pause()
  expect(fetchPreview).not.toHaveBeenCalled()
  await dom!.cleanup()
  dom = undefined
  const off = await mount(fetchPreview, false)
  await off.type('The checkout button is broken')
  await off.pause()
  expect(fetchPreview).not.toHaveBeenCalled()
  expect(latest.hint).toBeNull()
  expect(latest.routingFor('The checkout button is broken')).toBeUndefined()
  expect(normalizeRoutingDraft('  a \n b ')).toBe('a b')
})
