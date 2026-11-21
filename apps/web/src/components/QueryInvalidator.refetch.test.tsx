import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import { acquireDomHarness } from '../test/domHarness'
import { QueryInvalidator } from './QueryInvalidator'

/**
 * Counts REAL refetches, driven through a real `QueryClient` with real mounted
 * observers.
 *
 * The sibling suite (`QueryInvalidator.test.tsx`) injects a fake client and
 * asserts which keys were passed to `invalidateQueries`. That shape cannot see
 * silence: a whole event branch can be deleted and every one of those tests
 * still passes, because they only assert about the branches they name. An
 * adversarial review of this component deleted the entire `execution.*` handler,
 * the `agent.deleted` handler, the `message.*` handler, and four of the six keys
 * in `invalidateForAgent` — nine mutations in total — with a fully green suite.
 *
 * A narrowing whose entire risk is that some query silently stops refreshing
 * needs assertions that break on silence. That is what this file is: for each
 * event, the queries that must refetch and the queries that must not.
 *
 * Plain `QueryObserver` is used even for the infinite-message key — invalidation
 * matches on the key, and the observer type does not change which keys match.
 */
type Callback = (entry: { event: string; data: unknown }) => void

/** Mounted, counting observer for one key. */
function observe(client: QueryClient, queryKey: readonly unknown[]) {
  let fetches = 0
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: async () => {
      fetches += 1
      return null
    },
    staleTime: 0,
    retry: false,
  })
  const unsubscribe = observer.subscribe(() => {})
  return { fetches: () => fetches, unsubscribe }
}

describe('QueryInvalidator — refetch behaviour', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: import('react-dom/client').Root
  let client: QueryClient
  let captured: Map<string, Callback>
  let observers: { unsubscribe: () => void }[]

  const subscribe = (topic: string, callback: Callback) => {
    captured.set(topic, callback)
    return () => captured.delete(topic)
  }

  beforeEach(async () => {
    captured = new Map()
    observers = []
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    root = dom.createRoot().root
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } })
  })

  afterEach(async () => {
    observers.forEach((observer) => observer.unsubscribe())
    await dom.cleanup()
    client.clear()
  })

  /** Mount the component, observe each key, and let the initial fetches settle. */
  async function setup(keys: Record<string, readonly unknown[]>, isConnected = false) {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected }} />)
    })
    const tracked: Record<string, { fetches: () => number }> = {}
    for (const [name, queryKey] of Object.entries(keys)) {
      const handle = observe(client, queryKey)
      observers.push(handle)
      tracked[name] = handle
    }
    await settle()
    return tracked
  }

  /** Drain the coalescer's leading-edge microtask and any refetch it triggers. */
  async function settle() {
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }

  async function emit(event: string, data: unknown) {
    const before = new Map<string, number>()
    await dom.act(async () => {
      captured.get('agents')!({ event, data })
    })
    await settle()
    return before
  }

  const AGENT = 'agent-1'
  const OTHER = 'agent-2'

  function agentKeys() {
    return {
      detail: queryKeys.agents.detail(AGENT),
      otherDetail: queryKeys.agents.detail(OTHER),
      list: queryKeys.agents.list(),
      children: queryKeys.agents.children('parent-1'),
      activeExecution: queryKeys.agents.activeExecution(AGENT),
      context: queryKeys.agents.context(AGENT),
      sandboxStatus: queryKeys.agents.sandboxStatus(AGENT),
      messages: queryKeys.agents.messagesInfinite(AGENT),
      otherMessages: queryKeys.agents.messagesInfinite(OTHER),
    }
  }

  test('an empty Action Center frame refetches pending actions and exact questions', async () => {
    const q = await setup({
      actions: queryKeys.actions.pending(),
      questions: queryKeys.agentQuestions.byAgent(AGENT),
    })
    const baseline = { actions: q.actions.fetches(), questions: q.questions.fetches() }

    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })
    await settle()

    expect(q.actions.fetches()).toBe(baseline.actions + 1)
    expect(q.questions.fetches()).toBe(baseline.questions + 1)
  })

  test('first socket open and reconnect refetch pending actions and exact questions', async () => {
    const q = await setup({
      actions: queryKeys.actions.pending(),
      questions: queryKeys.agentQuestions.byAgent(AGENT),
    })
    const baseline = { actions: q.actions.fetches(), questions: q.questions.fetches() }
    const render = (isConnected: boolean) =>
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected }} />)

    await dom.act(async () => render(true))
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(q.actions.fetches()).toBe(baseline.actions + 1)
    expect(q.questions.fetches()).toBe(baseline.questions + 1)

    await dom.act(async () => render(false))
    await dom.act(async () => render(true))
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(q.actions.fetches()).toBe(baseline.actions + 2)
    expect(q.questions.fetches()).toBe(baseline.questions + 2)
  })

  test('coalesces socket open with the immediate subscription snapshot but not a later lifecycle frame', async () => {
    const q = await setup({
      actions: queryKeys.actions.pending(),
      questions: queryKeys.agentQuestions.byAgent(AGENT),
    })
    const baseline = { actions: q.actions.fetches(), questions: q.questions.fetches() }

    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: true }} />)
    })
    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(q.actions.fetches()).toBe(baseline.actions + 1)
    expect(q.questions.fetches()).toBe(baseline.questions + 1)

    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(q.actions.fetches()).toBe(baseline.actions + 2)
    expect(q.questions.fetches()).toBe(baseline.questions + 2)
  })

  test('coalesces a subscription snapshot delivered before the connected render', async () => {
    const q = await setup({
      actions: queryKeys.actions.pending(),
      questions: queryKeys.agentQuestions.byAgent(AGENT),
    })
    const baseline = { actions: q.actions.fetches(), questions: q.questions.fetches() }

    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })
    await settle()
    expect(q.actions.fetches()).toBe(baseline.actions + 1)
    expect(q.questions.fetches()).toBe(baseline.questions + 1)

    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: true }} />)
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(q.actions.fetches()).toBe(baseline.actions + 1)
    expect(q.questions.fetches()).toBe(baseline.questions + 1)
  })

  test('an aborted pre-open snapshot expires before a later old-Core reconnect', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: false }} />)
    })
    let authoritative = 'initial'
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.actions.pending(),
      queryFn: async () => authoritative,
      retry: false,
    })
    observers.push({ unsubscribe: observer.subscribe(() => {}) })
    await settle()

    authoritative = 'pre-open snapshot'
    await dom.act(async () => captured.get('actions')!({ event: 'actions.invalidated', data: {} }))
    await settle()
    expect(observer.getCurrentResult().data).toBe('pre-open snapshot')

    // That connection aborts before a connected render. Its marker must not be
    // allowed to suppress a later old-Core open that sends no snapshot.
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    authoritative = 'changed during outage'
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: true }} />)
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(observer.getCurrentResult().data).toBe('changed during outage')
  })

  test('one squad frame with ancestor and descendant keys refetches a mounted descendant once', async () => {
    const q = await setup({ squadAgents: queryKeys.squads.agents('squad-1') })
    const baseline = q.squadAgents.fetches()

    await dom.act(async () => {
      captured.get('squads')!({ event: 'squad.agentSpawned', data: { squadId: 'squad-1' } })
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 250)))

    expect(q.squadAgents.fetches()).toBe(baseline + 1)
  })

  test('agent.updated refetches the agent and the collections, and nothing belonging to another agent', async () => {
    const q = await setup(agentKeys())
    const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

    await emit('agent.updated', { agentId: AGENT, squadId: 'squad-1' })

    // Each of these dying is a separate mutation that previously survived.
    expect(q.detail.fetches()).toBe(baseline.detail + 1)
    expect(q.list.fetches()).toBe(baseline.list + 1)
    expect(q.children.fetches()).toBe(baseline.children + 1)
    expect(q.activeExecution.fetches()).toBe(baseline.activeExecution + 1)
    expect(q.context.fetches()).toBe(baseline.context + 1)
    expect(q.sandboxStatus.fetches()).toBe(baseline.sandboxStatus + 1)

    // The regression this narrowing exists to fix.
    expect(q.otherDetail.fetches()).toBe(baseline.otherDetail)
    expect(q.otherMessages.fetches()).toBe(baseline.otherMessages)
    // A status tick must not drag a whole message list with it.
    expect(q.messages.fetches()).toBe(baseline.messages)
  })

  test('an execution event refetches the mounted scheduler-ordered work list', async () => {
    const q = await setup({
      workList: queryKeys.squads.activeWorkStreamsInfinite('squad-1'),
    })
    const baseline = q.workList.fetches()

    await emit('execution.started', { executionId: 'exec-1', agentId: AGENT, status: 'running' })

    expect(q.workList.fetches()).toBe(baseline + 1)
  })

  test.each([
    ['agent status', 'agents', 'agent.updated', { agentId: AGENT, squadId: 'squad-1' }],
    ['work-stream', 'workstreams', 'workStream.updated', { squadId: 'squad-1' }],
  ] as const)('%s events refresh global activity presence', async (_label, topic, event, data) => {
    const q = await setup({ presence: queryKeys.activity.presence() })
    const baseline = q.presence.fetches()

    await dom.act(async () => {
      captured.get(topic)!({ event, data })
    })
    await settle()
    expect(q.presence.fetches()).toBe(baseline + 1)
  })

  test('a burst of execution events refetches the mounted work list once per coalesced window', async () => {
    const q = await setup({
      workList: queryKeys.squads.activeWorkStreamsInfinite('squad-1'),
    })
    const baseline = q.workList.fetches()

    await dom.act(async () => {
      for (let i = 0; i < 10; i++) {
        captured.get('agents')!({
          event: 'execution.updated',
          data: { executionId: `exec-${i}`, agentId: AGENT, status: 'running' },
        })
      }
    })
    await settle()

    expect(q.workList.fetches()).toBe(baseline + 1)
  })

  test.each(['execution.completed', 'execution.failed', 'execution.stopped'])(
    '%s refetches the agent AND its message history',
    async (event) => {
      const q = await setup(agentKeys())
      const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

      await emit(event, { executionId: 'exec-1', agentId: AGENT, status: 'completed' })

      expect(q.detail.fetches()).toBe(baseline.detail + 1)
      expect(q.activeExecution.fetches()).toBe(baseline.activeExecution + 1)
      expect(q.list.fetches()).toBe(baseline.list + 1)

      /**
       * The end-of-turn tool-result patch (`updateActiveToolMessage` in
       * apps/core/src/entities/agent-runners/session-message-persistence.ts)
       * writes the assistant row with NO event, and `saveAndPushDone` then skips
       * `recordMessage` because the row exists. Terminal execution events are
       * the only thing that repairs that list on a focused tab. Dropping this
       * line is invisible to every other test in the suite.
       */
      expect(q.messages.fetches()).toBe(baseline.messages + 1)

      expect(q.otherDetail.fetches()).toBe(baseline.otherDetail)
    }
  )

  test('non-terminal execution events refresh status without refetching history', async () => {
    const q = await setup(agentKeys())
    const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

    await emit('execution.started', { executionId: 'exec-1', agentId: AGENT, status: 'running' })

    expect(q.detail.fetches()).toBe(baseline.detail + 1)
    expect(q.activeExecution.fetches()).toBe(baseline.activeExecution + 1)
    // History is refreshed once per turn, not on every frame of it.
    expect(q.messages.fetches()).toBe(baseline.messages)
    expect(q.otherDetail.fetches()).toBe(baseline.otherDetail)
  })

  test('message.created refetches only that agent’s history', async () => {
    const q = await setup(agentKeys())
    const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

    await emit('message.created', { messageId: 'msg-1', agentId: AGENT })

    expect(q.messages.fetches()).toBe(baseline.messages + 1)
    expect(q.otherMessages.fetches()).toBe(baseline.otherMessages)
    expect(q.detail.fetches()).toBe(baseline.detail)
  })

  test('agent.deleted refreshes the collections so the removed row disappears', async () => {
    const q = await setup(agentKeys())
    const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

    await emit('agent.deleted', { agentId: AGENT, squadId: 'squad-1' })

    expect(q.list.fetches()).toBe(baseline.list + 1)
    expect(q.children.fetches()).toBe(baseline.children + 1)
    expect(q.detail.fetches()).toBe(baseline.detail + 1)
    expect(q.otherDetail.fetches()).toBe(baseline.otherDetail)
  })

  test('sandbox.ensured refetches that agent’s sandbox status only', async () => {
    const q = await setup(agentKeys())
    const baseline = Object.fromEntries(Object.entries(q).map(([name, handle]) => [name, handle.fetches()]))

    await emit('sandbox.ensured', { agentId: AGENT })

    expect(q.sandboxStatus.fetches()).toBe(baseline.sandboxStatus + 1)
    expect(q.detail.fetches()).toBe(baseline.detail)
    expect(q.list.fetches()).toBe(baseline.list)
  })

  test('a burst of frames costs one refetch round, not one per frame', async () => {
    const q = await setup(agentKeys())
    const baseline = q.detail.fetches()

    await dom.act(async () => {
      for (let i = 0; i < 10; i++) {
        captured.get('agents')!({ event: 'agent.updated', data: { agentId: AGENT, squadId: 'squad-1' } })
      }
    })
    await settle()

    // Ten frames, one leading-edge flush. Without coalescing this is 10.
    expect(q.detail.fetches()).toBe(baseline + 1)
  })

  test('a slow exact question does not block a later authoritative sibling update', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: false }} />)
    })
    let slowStarts = 0
    let fastStarts = 0
    let fastAuthoritative = 'initial'
    const slowGates: Array<() => void> = []
    const slowObserver = new QueryObserver(client, {
      queryKey: queryKeys.agentQuestions.byAgent('slow-agent'),
      queryFn: () =>
        new Promise<number>((resolve) => {
          slowStarts += 1
          slowGates.push(() => resolve(slowStarts))
        }),
      retry: false,
    })
    const fastObserver = new QueryObserver(client, {
      queryKey: queryKeys.agentQuestions.byAgent('fast-agent'),
      queryFn: async () => {
        fastStarts += 1
        return fastAuthoritative
      },
      retry: false,
    })
    observers.push({ unsubscribe: slowObserver.subscribe(() => {}) }, { unsubscribe: fastObserver.subscribe(() => {}) })
    const releaseSlow = () => slowGates.splice(0).forEach((open) => open())
    await settle()
    releaseSlow()
    await settle()
    const baselineFast = fastStarts

    fastAuthoritative = 'first update'
    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })
    await settle()
    expect(fastStarts).toBe(baselineFast + 1)
    expect(fastObserver.getCurrentResult().data).toBe('first update')

    fastAuthoritative = 'later update'
    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    // The idle sibling applies the later authoritative update immediately.
    expect(fastStarts).toBe(baselineFast + 2)
    expect(fastObserver.getCurrentResult().data).toBe('later update')

    releaseSlow()
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    // Only the previously in-flight exact query catches up after release.
    expect(fastStarts).toBe(baselineFast + 2)
    releaseSlow()
  })

  test('an exact slow ancestor retry does not refetch its fast descendant', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe, isConnected: false }} />)
    })
    let detailStarts = 0
    let scopesStarts = 0
    const detailGates: Array<() => void> = []
    const detailObserver = new QueryObserver(client, {
      queryKey: queryKeys.agents.detail(AGENT),
      queryFn: () =>
        new Promise<number>((resolve) => {
          detailStarts += 1
          detailGates.push(() => resolve(detailStarts))
        }),
      retry: false,
    })
    const scopesObserver = new QueryObserver(client, {
      queryKey: queryKeys.agents.scopes(AGENT),
      queryFn: async () => ++scopesStarts,
      retry: false,
    })
    observers.push(
      { unsubscribe: detailObserver.subscribe(() => {}) },
      { unsubscribe: scopesObserver.subscribe(() => {}) }
    )
    const releaseDetail = () => detailGates.splice(0).forEach((open) => open())
    await settle()
    releaseDetail()
    await settle()
    const baselineScopes = scopesStarts
    void detailObserver.refetch()
    await settle()

    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: AGENT } })
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(scopesStarts).toBe(baselineScopes + 1)

    releaseDetail()
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 250)))
    expect(scopesStarts).toBe(baselineScopes + 1)
    releaseDetail()
  })

  /**
   * The live storm this guards against: with `cancelRefetch: true` (React
   * Query's default), every coalesced flush during a slow refetch cancelled it
   * CLIENT-side and fired another request — the server kept processing the
   * abandoned ones, measured as ~17 identical concurrent squad-agents GETs
   * during a 7s stall. Refetches must be serialized per key: a frame landing
   * mid-refetch starts nothing, and one trailing refetch after it settles
   * picks up whatever that frame announced.
   */
  test('a frame landing mid-refetch stacks no second request; one trailing refetch follows', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: client, subscribe }} />)
    })

    // Gated observer: fetches resolve only when released, so the test controls
    // exactly when a refetch is "in flight".
    let starts = 0
    const gates: Array<() => void> = []
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.agents.detail(AGENT),
      queryFn: () =>
        new Promise<null>((resolve) => {
          starts += 1
          gates.push(() => resolve(null))
        }),
      staleTime: 0,
      retry: false,
    })
    observers.push({ unsubscribe: observer.subscribe(() => {}) })
    const release = () => gates.splice(0).forEach((open) => open())
    const wait = (ms: number) => dom.act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

    // Let the mount fetch finish.
    await wait(30)
    release()
    await wait(30)
    const baseline = starts

    // Frame 1: flushes leading-edge, starts a refetch that stays in flight.
    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: AGENT, squadId: 'squad-1' } })
    })
    await wait(30)
    expect(starts).toBe(baseline + 1)

    // Frame 2 lands while that refetch is in flight. Its trailing flush (the
    // coalescer window is 150ms) must reuse the in-flight request, not stack
    // a second one.
    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: AGENT, squadId: 'squad-1' } })
    })
    await wait(250)
    expect(starts).toBe(baseline + 1)

    // Once it settles, exactly one catch-up refetch collects frame 2's change.
    release()
    await wait(250)
    expect(starts).toBe(baseline + 2)

    // And the chain converges — no further refetches after the catch-up.
    release()
    await wait(250)
    expect(starts).toBe(baseline + 2)
  })
})
