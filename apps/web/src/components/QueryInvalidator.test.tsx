import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { StrictMode } from 'react'
import { acquireDomHarness } from '../test/domHarness'
import { onboardingQueryKeys, queryKeys, agentSlotHoldQueryKeys, agentSlotWaitQueryKeys } from '../queryKeys'

/**
 * QueryInvalidator is the single source of truth for WS-event-driven cache
 * invalidation (see its own doc comment) — its `subscribe('onboarding', ...)`
 * callback runs inside a useEffect, so proving it actually invalidates the
 * onboarding cache requires running real effects (createRoot + act), not
 * renderToStaticMarkup (which never invokes effects at all and is what every
 * other apps/web test in this repo uses). Follows the happy-dom + act +
 * createRoot pattern this repo already uses for effect-driven components
 * (see App.gate.test.tsx / useOnboarding.test.tsx's second describe block).
 *
 * The mocked `subscribe` captures the callback QueryInvalidator registers
 * for each topic, keyed by topic name, so the test can invoke the REAL
 * callback the component wired up — not a re-implementation of its logic.
 */
type Callback = (entry: { event: string; data: unknown }) => void

let captured: Map<string, Callback>

/** Minimal client surface used to observe the component's real invalidation callback. */
function createFakeQueryClient() {
  return {
    invalidateQueries: mock(
      (_options: { queryKey: readonly unknown[] }, _refetchOptions?: { cancelRefetch?: boolean }) => undefined
    ),
    // No cached descendants here — these tests assert which prefix keys get
    // invalidated. Exact in-flight serialization lives in the real-client suite.
    getQueryCache: () => ({ findAll: () => [] }),
  }
}

let fakeQueryClient = createFakeQueryClient()

import { QueryInvalidator } from './QueryInvalidator'
import { assistantQueryKeys } from '../queryKeys'

const subscribe = (topic: string, callback: Callback) => {
  captured.set(topic, callback)
  return () => captured.delete(topic)
}

describe('QueryInvalidator', () => {
  let dom: Awaited<ReturnType<typeof acquireDomHarness>>
  let root: ReturnType<typeof dom.createRoot>['root']

  beforeEach(async () => {
    captured = new Map()
    fakeQueryClient = createFakeQueryClient()
    dom = await acquireDomHarness({ url: 'http://localhost/' })
    ;({ root } = dom.createRoot())
  })

  afterEach(async () => {
    await dom.cleanup()
  })

  test('invalidates onboardingQueryKeys.all when an onboarding.updated event arrives', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    // The component actually subscribed to the 'onboarding' topic.
    expect(captured.has('onboarding')).toBe(true)
    expect(fakeQueryClient.invalidateQueries).not.toHaveBeenCalled()

    await dom.act(async () => {
      captured.get('onboarding')!({ event: 'onboarding.updated', data: {} })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: onboardingQueryKeys.all },
      { cancelRefetch: false }
    )
  })

  test('refreshes Assistant activity, conversation lists, and reconnect state for activity events', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe, isConnected: false }} />)
    })
    expect(captured.has('inbox')).toBe(true)
    const recipientId = 'assistant:507a9ac0-164e-4f49-9441-e57522bdc52b'
    await dom.act(async () => {
      captured.get('inbox')!({
        event: 'assistant.activityChanged',
        data: { conversationId: '507a9ac0-164e-4f49-9441-e57522bdc52b', recipientId },
      })
    })
    const invalidated = () =>
      (
        fakeQueryClient.invalidateQueries as unknown as { mock: { calls: Array<[{ queryKey: unknown }]> } }
      ).mock.calls.map(([options]) => JSON.stringify(options.queryKey))
    // The saved-conversation prefix covers activity, so the coalescer collapses both into one refresh.
    expect(invalidated()).toContain(JSON.stringify(assistantQueryKeys.all))
    // The activity event carries identifiers only and never touches the personal inbox queries.
    expect(invalidated()).not.toContain(JSON.stringify(queryKeys.inbox.minePrefix()))

    // Legacy mailbox traffic without the activity event still refreshes activity as a fallback.
    // The coalescer's trailing window is 150 ms; wait for it like the other event tests do.
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    ;(fakeQueryClient.invalidateQueries as unknown as { mockClear: () => void }).mockClear()
    await dom.act(async () => {
      captured.get('inbox')!({
        event: 'inbox.messageReceived',
        data: { messageId: 'm1', recipientType: 'voice_assistant', recipientId, senderAgentId: null },
      })
    })
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(invalidated()).toContain(JSON.stringify(assistantQueryKeys.activityPrefix))
    expect(invalidated()).toContain(JSON.stringify(queryKeys.inbox.minePrefix()))

    // Reconnecting repairs activity that events could not deliver while offline.
    ;(fakeQueryClient.invalidateQueries as unknown as { mockClear: () => void }).mockClear()
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe, isConnected: true }} />)
    })
    expect(invalidated()).toContain(JSON.stringify(assistantQueryKeys.activityPrefix))
  })

  test('StrictMode effect replay keeps the subscribed Action Center queue live', async () => {
    await dom.act(async () => {
      root.render(
        <StrictMode>
          <QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe, isConnected: false }} />
        </StrictMode>
      )
    })

    expect(captured.has('actions')).toBe(true)
    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledTimes(2)
  })

  test('an empty Action Center invalidation refreshes only actions and exact questions', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe, isConnected: false }} />)
    })

    expect(captured.has('actions')).toBe(true)
    await dom.act(async () => {
      captured.get('actions')!({ event: 'actions.invalidated', data: {} })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.actions.all },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.agentQuestions.all },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).not.toHaveBeenCalledWith(
      { queryKey: queryKeys.agents.all },
      { cancelRefetch: false }
    )
  })

  test('reconciles actions and exact questions once on every successful socket open', async () => {
    const render = (isConnected: boolean) =>
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe, isConnected }} />)

    await dom.act(async () => render(false))
    expect(fakeQueryClient.invalidateQueries).not.toHaveBeenCalled()

    // Each open repairs slot waits/holds, stream presentations, Assistant activity, actions, questions, and both storage views exactly once.
    await dom.act(async () => render(true))
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledTimes(8)

    await dom.act(async () => render(true))
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledTimes(8)

    await dom.act(async () => render(false))
    await dom.act(async () => render(true))
    await dom.act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledTimes(16)
    for (const key of [
      agentSlotWaitQueryKeys.all,
      agentSlotHoldQueryKeys.all,
      assistantQueryKeys.activityPrefix,
      queryKeys.system.storage(),
      queryKeys.system.storageStatus(),
    ])
      expect(
        fakeQueryClient.invalidateQueries.mock.calls.filter(
          ([options]) => JSON.stringify(options.queryKey) === JSON.stringify(key)
        )
      ).toHaveLength(2)
  })

  test.each([
    'agent-question.created',
    'agent-question.answered',
    'agent-question.delivery-failed',
    'agent-question.delivery-retrying',
    'agent-question.dismissed',
  ])('%s refreshes pending questions and Action Center actions', async (event) => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      captured.get('agents')!({ event, data: { questionId: 'question-1', agentId: 'agent-1', squadId: 'squad-1' } })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.agentQuestions.all },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.actions.all },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).not.toHaveBeenCalledWith(
      { queryKey: queryKeys.agents.all },
      { cancelRefetch: false }
    )
  })

  test('agent.updated refreshes the agent, the lists used by activity dots, and its squad', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-1', squadId: 'squad-1' } })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.agents.detail('agent-1') },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.agents.listPrefix() },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      {
        queryKey: queryKeys.squads.agents('squad-1'),
      },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      {
        queryKey: queryKeys.squads.agentsWithRecent('squad-1'),
      },
      { cancelRefetch: false }
    )
  })

  /**
   * The regression this narrowing exists for. `queryKeys.agents.all` is the
   * prefix of EVERY agent's detail/messages/sandboxStatus, so invalidating it on
   * one agent's status tick refetched every agent the UI had mounted — measured
   * as six identical `GET /api/agents/:id` inside 8ms under ~44 `agent.updated`
   * frames a minute.
   *
   * Asserting the positive keys above cannot catch a regression here, because
   * re-broadening to `agents.all` still satisfies every one of them by prefix.
   * Only the negative assertions below fail when the breadth comes back.
   */
  test('agent.updated does not invalidate other agents, their messages, or the agents prefix', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-1', squadId: 'squad-1' } })
    })

    const invalidatedKeys = fakeQueryClient.invalidateQueries.mock.calls.map(([options]) =>
      JSON.stringify(options.queryKey)
    )

    // The broad prefix itself must never be requested.
    expect(invalidatedKeys).not.toContain(JSON.stringify(queryKeys.agents.all))
    // No key may target a different agent.
    expect(invalidatedKeys.filter((key) => key.includes('agent-2'))).toEqual([])
    // The updated agent's own message list is served by message.* events.
    expect(invalidatedKeys).not.toContain(JSON.stringify(queryKeys.agents.messagesInfinite('agent-1')))
  })

  test('a burst of agent.updated frames collapses into one round of invalidations', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      for (let i = 0; i < 10; i++) {
        captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-1', squadId: 'squad-1' } })
      }
    })

    // Ten identical frames, one leading-edge flush: every key appears once.
    const detailCalls = fakeQueryClient.invalidateQueries.mock.calls.filter(
      ([options]) => JSON.stringify(options.queryKey) === JSON.stringify(queryKeys.agents.detail('agent-1'))
    )
    expect(detailCalls).toHaveLength(1)
  })

  test('sustained agent.updated ticks stop re-fetching the squad roster every window', async () => {
    // The storm: `GET /squads/:id/agents` embeds every agent's status, so a
    // status tick genuinely changes it — but a streaming squad emits ticks
    // continuously, leaving a pending key in EVERY 150ms coalescer window.
    // Two roster keys at ~6.7 flushes/sec each is the ~13 identical requests
    // per second seen while merely viewing the squad home page.
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    const countFor = (queryKey: readonly unknown[]) =>
      fakeQueryClient.invalidateQueries.mock.calls.filter(
        ([options]) => JSON.stringify(options.queryKey) === JSON.stringify(queryKey)
      ).length

    const tick = () =>
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-1', squadId: 'squad-1' } })

    await dom.act(async () => tick())
    expect(countFor(queryKeys.squads.agents('squad-1'))).toBe(1)

    // Wait past the COALESCER's window (150ms) but well inside the roster
    // window, then tick again. Without the throttle this is a second roster
    // refetch — the behavior that repeats ~7x/sec.
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
      tick()
    })

    expect(countFor(queryKeys.agents.detail('agent-1'))).toBe(2)
    expect(countFor(queryKeys.squads.agents('squad-1'))).toBe(1)
    expect(countFor(queryKeys.squads.agentsWithRecent('squad-1'))).toBe(1)

    // The last tick is not dropped: it lands on the trailing edge, so the
    // roster still converges on the final state.
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100))
    })
    expect(countFor(queryKeys.squads.agents('squad-1'))).toBe(2)
  })

  test('agent.new-message refreshes only the squad roster, not the agent query family', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.new-message', data: { agentId: 'agent-1', squadId: 'squad-1' } })
    })

    const invalidated = fakeQueryClient.invalidateQueries.mock.calls.map(([options]) =>
      JSON.stringify(options.queryKey)
    )
    expect(invalidated).toContain(JSON.stringify(queryKeys.squads.agents('squad-1')))
    expect(invalidated).toContain(JSON.stringify(queryKeys.squads.agentsWithRecent('squad-1')))

    // A persisted message changes none of these. They used to be refetched on
    // every message because this arrived as `agent.updated`.
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.agents.detail('agent-1')))
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.agents.context('agent-1')))
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.agents.sandboxStatus('agent-1')))
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.agents.activeExecution('agent-1')))
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.artifacts.all))
    expect(invalidated).not.toContain(JSON.stringify(queryKeys.actions.all))
  })

  test('membership changes still invalidate the roster immediately', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    const countFor = (queryKey: readonly unknown[]) =>
      fakeQueryClient.invalidateQueries.mock.calls.filter(
        ([options]) => JSON.stringify(options.queryKey) === JSON.stringify(queryKey)
      ).length

    // A status tick opens the throttle window...
    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.updated', data: { agentId: 'agent-1', squadId: 'squad-1' } })
    })
    expect(countFor(queryKeys.squads.agents('squad-1'))).toBe(1)

    // ...but an agent appearing or disappearing changes the roster's MEMBERSHIP
    // and must not wait for it.
    await dom.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
      captured.get('agents')!({ event: 'agent.terminated', data: { agentId: 'agent-2', squadId: 'squad-1' } })
    })
    expect(countFor(queryKeys.squads.agents('squad-1'))).toBe(2)
  })

  test('unmount removes live subscriptions before later events can invalidate queries', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })
    const agentsCallback = captured.get('agents')!

    await dom.act(async () => root.unmount())
    expect(captured.size).toBe(0)

    agentsCallback({ event: 'execution.updated', data: { agentId: 'agent-1' } })
    await Promise.resolve()
    expect(fakeQueryClient.invalidateQueries).not.toHaveBeenCalled()
  })

  test('slot lifecycle refreshes stream presentation as well as agent details', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })
    await dom.act(async () => {
      captured.get('squads')!({ event: 'slots.updated', data: { squadId: 'squad-1' } })
    })
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.squads.all },
      { cancelRefetch: false }
    )
  })

  test('workStream.updated invalidates the squad query prefix used by home and work graphs', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    await dom.act(async () => {
      captured.get('workstreams')!({ event: 'workStream.updated', data: { workStreamId: 'ws-1', squadId: 'squad-1' } })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.squads.all },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      { queryKey: queryKeys.actions.all },
      { cancelRefetch: false }
    )
  })

  /**
   * Unspawning an agent (DELETE /api/squads/:id/agents/:agentId) terminates it, and the server's
   * ONLY event for that is `agent.terminated` on the `agents` topic — there is no squad-scoped
   * unspawn event. So this handler is what makes the squad UI live-refresh on unspawn: it must
   * invalidate BOTH squad agent lists (`agents` and `agentsWithRecent`, the latter being the key
   * SquadDetailPage actually renders its roster from). If this branch stops invalidating them,
   * unspawn goes stale until a manual refetch.
   */
  test('agent.terminated invalidates both squad agent lists — the live refresh unspawn rides on', async () => {
    await dom.act(async () => {
      root.render(<QueryInvalidator dependencies={{ queryClient: fakeQueryClient, subscribe }} />)
    })

    expect(captured.has('agents')).toBe(true)

    await dom.act(async () => {
      captured.get('agents')!({ event: 'agent.terminated', data: { agentId: 'agent-1', squadId: 'squad-1' } })
    })

    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      {
        queryKey: queryKeys.squads.agents('squad-1'),
      },
      { cancelRefetch: false }
    )
    expect(fakeQueryClient.invalidateQueries).toHaveBeenCalledWith(
      {
        queryKey: queryKeys.squads.agentsWithRecent('squad-1'),
      },
      { cancelRefetch: false }
    )
  })
})
