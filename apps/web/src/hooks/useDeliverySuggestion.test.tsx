import { afterEach, describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { DeliverySuggestion } from '@ficus/shared'
import { acquireDomHarness } from '../test/domHarness'
import { composerQueryKeys } from '../queryKeys'
import {
  DELIVERY_SUGGESTION_DEBOUNCE_MS,
  confidentSuggestion,
  normalizeDraft,
  useDeliverySuggestion,
} from './useDeliverySuggestion'

type Hook = ReturnType<typeof useDeliverySuggestion>
type Fetch = (agentId: string, draft: string, signal?: AbortSignal) => Promise<DeliverySuggestion>

/** A clock the test advances: debounce timers run only when flushed. */
function manualClock() {
  let pending: Array<{ id: number; ms: number; run: () => void }> = []
  let nextId = 0
  return {
    schedule: (run: () => void, ms: number) => {
      const id = nextId++
      pending.push({ id, ms, run })
      return () => {
        pending = pending.filter((entry) => entry.id !== id)
      }
    },
    delays: () => pending.map((entry) => entry.ms),
    flush: () => {
      const due = pending
      pending = []
      for (const entry of due) entry.run()
    },
  }
}

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

async function mount(fetchSuggestion: Fetch, { busy = true, agentId = 'agent-1' } = {}) {
  dom = await acquireDomHarness({ url: 'http://localhost/' })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const clock = manualClock()
  function Probe(props: { busy: boolean; agentId: string }) {
    latest = useDeliverySuggestion({ ...props, fetchSuggestion, schedule: clock.schedule })
    return null
  }
  const { root } = dom.createRoot()
  const render = async (props: { busy: boolean; agentId: string }) =>
    dom!.act(async () => {
      root.render(
        <QueryClientProvider client={queryClient!}>
          <Probe {...props} />
        </QueryClientProvider>
      )
    })
  await render({ busy, agentId })
  const act = (fn: () => void) => dom!.act(async () => fn())
  return {
    clock,
    rerender: render,
    type: (text: string) => act(() => latest.onDraftChange(text)),
    pause: () => act(() => clock.flush()),
    act,
  }
}

/** Waits for the hook to reach a state: React Query resolves and re-renders asynchronously. */
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await dom!.act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
  }
  expect(check()).toBe(true)
}

/** What Core answers for a draft scored `related` (its rule lives in delivery-suggestion.ts). */
const answer = (related: number): DeliverySuggestion => ({
  suggestion: related >= 0.7 ? 'steer' : related <= 0.3 ? 'follow-up' : null,
  related,
  now: related,
})

describe('useDeliverySuggestion', () => {
  test('asks only after a 400ms pause, once per meaningful change', async () => {
    const fetchSuggestion = mock<Fetch>(async () => answer(0.9))
    const { clock, type, pause } = await mount(fetchSuggestion)

    await type('also fix the')
    await type('also fix the login form')
    // Each keystroke replaces the pending pause rather than adding one.
    expect(clock.delays()).toEqual([DELIVERY_SUGGESTION_DEBOUNCE_MS])
    expect(fetchSuggestion).not.toHaveBeenCalled()

    await pause()
    await until(() => fetchSuggestion.mock.calls.length === 1)
    expect(fetchSuggestion.mock.calls[0]!.slice(0, 2)).toEqual(['agent-1', 'also fix the login form'])

    // Spacing alone is not a new draft.
    await type('  also fix   the login form ')
    await pause()
    await until(() => latest.suggested?.mode === 'steer')
    expect(fetchSuggestion).toHaveBeenCalledTimes(1)
  })

  test('pre-selects a confident answer and says why; an unsure one keeps the current mode', async () => {
    const answers: Record<string, number> = {
      'book the offsite in lisbon': 0.12,
      'and maybe something else too': 0.55,
      'also update the login tests': 0.85,
    }
    const { type, pause } = await mount(async (_agent, draft) => answer(answers[draft]!))
    expect(latest.deliveryMode).toBe('steer')
    expect(latest.suggested).toBeNull()

    await type('book the offsite in lisbon')
    await pause()
    await until(() => latest.deliveryMode === 'follow-up')
    expect(latest.suggested).toEqual({ mode: 'follow-up', now: false })

    // 0.55 is neither sure enough to interrupt nor to follow up: nothing changes.
    await type('and maybe something else too')
    await pause()
    await until(
      () =>
        queryClient!.getQueryData(composerQueryKeys.deliverySuggestion('agent-1', 'and maybe something else too')) !==
        undefined
    )
    expect(latest.deliveryMode).toBe('follow-up')

    await type('also update the login tests')
    await pause()
    await until(() => latest.deliveryMode === 'steer')
    expect(latest.suggested).toEqual({ mode: 'steer', now: true })
  })

  test('a manual choice wins for the rest of the draft; clearing it lets suggestions apply again', async () => {
    const fetchSuggestion = mock<Fetch>(async () => answer(0.1))
    const { type, pause, act } = await mount(fetchSuggestion)

    await type('book the offsite in lisbon')
    await pause()
    await until(() => latest.deliveryMode === 'follow-up')

    await act(() => latest.chooseMode('steer'))
    expect(latest.deliveryMode).toBe('steer')
    expect(latest.suggested).toBeNull()

    // Still the same draft: no more asking, and the manual choice holds.
    await type('book the offsite in lisbon for june')
    await pause()
    expect(fetchSuggestion).toHaveBeenCalledTimes(1)
    expect(latest.deliveryMode).toBe('steer')

    // Clearing the composer resets to the default; the next draft takes its suggestion.
    await type('')
    expect(latest.deliveryMode).toBe('steer')
    await pause()
    await type('plan the team dinner next week')
    await pause()
    await until(() => latest.deliveryMode === 'follow-up')
    expect(latest.suggested).toEqual({ mode: 'follow-up', now: false })
  })

  test('sending resets to Interrupt for the next draft', async () => {
    const { type, pause, act } = await mount(async () => answer(0.05))
    await type('book the offsite in lisbon')
    await pause()
    await until(() => latest.deliveryMode === 'follow-up')
    await act(() => latest.chooseMode('steer'))

    await act(() => latest.reset())
    await type('')
    expect(latest.deliveryMode).toBe('steer')
    expect(latest.suggested).toBeNull()
  })

  test('never asks while the agent is idle or for drafts under three words', async () => {
    const fetchSuggestion = mock<Fetch>(async () => answer(0.1))
    const { type, pause, rerender } = await mount(fetchSuggestion, { busy: false })
    await type('book the offsite in lisbon')
    await pause()
    expect(fetchSuggestion).not.toHaveBeenCalled()
    expect(latest.deliveryMode).toBe('steer')

    await type('fix it')
    await pause()
    await rerender({ busy: true, agentId: 'agent-1' })
    expect(fetchSuggestion).not.toHaveBeenCalled()

    // Once the agent is working, a full draft is judged.
    await type('book the offsite in lisbon')
    await pause()
    await until(() => latest.deliveryMode === 'follow-up')
    expect(fetchSuggestion).toHaveBeenCalledTimes(1)
  })

  test("cancels the previous draft's request when a newer draft is asked", async () => {
    const signals: AbortSignal[] = []
    const { type, pause } = await mount(
      (_agent, _draft, signal) =>
        new Promise<DeliverySuggestion>(() => {
          signals.push(signal!)
        })
    )
    await type('first draft of the message')
    await pause()
    await until(() => signals.length === 1)
    await type('second draft of the message')
    await pause()
    await until(() => signals.length === 2)
    await until(() => signals[0]!.aborted)
    expect(signals[1]!.aborted).toBe(false)
  })
})

test('normalizeDraft collapses whitespace and caps the length', () => {
  expect(normalizeDraft('  a \n\n b\tc ')).toBe('a b c')
  expect(normalizeDraft('x'.repeat(5000))).toHaveLength(4000)
})

test("confidentSuggestion takes Core's pick; no pick keeps the current mode", () => {
  expect(confidentSuggestion({ suggestion: 'steer', related: 0.37, now: 0.83 })).toEqual({ mode: 'steer', now: true })
  expect(confidentSuggestion({ suggestion: 'follow-up', related: 0.1, now: 0.2 })).toEqual({
    mode: 'follow-up',
    now: false,
  })
  expect(confidentSuggestion({ suggestion: null, related: 0.5, now: 0.5 })).toBeNull()
  expect(confidentSuggestion({ suggestion: null })).toBeNull()
  expect(confidentSuggestion(undefined)).toBeNull()
})
