import { describe, expect, test } from 'bun:test'
import {
  EventPollingRunner,
  type EventPollingCursorStore,
  type EventPollingDispatchStore,
  type EventPollingWatch,
} from './event-polling-runner'
import type { EventPollingCapability, VerifiedIngressEvent } from './types'

class MemoryCursorStore implements EventPollingCursorStore {
  cursor: Record<string, unknown> | null = null
  claimed = false
  claims = 0
  saves = 0
  renewals = 0
  releases = 0
  failures = 0
  leaseUntil = 0
  async claim(_providerKey?: string, _resourceKey?: string, _now?: Date, leaseMs = 120_000) {
    await Promise.resolve()
    if (this.claimed && this.leaseUntil > Date.now()) return null
    this.claimed = true
    this.claims++
    this.leaseUntil = Date.now() + leaseMs
    return { cursor: this.cursor, leaseToken: 'lease', leaseUntil: new Date(this.leaseUntil) }
  }
  async save(_providerKey: string, _resourceKey: string, _lease: string, cursor: Record<string, unknown>) {
    this.cursor = cursor
    this.claimed = false
    this.saves++
  }
  async renew(_providerKey?: string, _resourceKey?: string, _lease?: string, leaseMs = 120_000) {
    if (!this.claimed) return null
    this.renewals++
    this.leaseUntil = Date.now() + leaseMs
    return new Date(this.leaseUntil)
  }
  async fail() {
    this.failures++
    this.claimed = false
    return true
  }
  async release() {
    this.releases++
    this.claimed = false
  }
}

class MemoryDispatchStore implements EventPollingDispatchStore {
  completed = new Set<string>()
  leased = new Map<string, string>()
  authorizations = 0
  async claim(providerKey: string, eventKey: string) {
    const key = `${providerKey}:${eventKey}`
    if (this.completed.has(key)) return { status: 'completed' as const }
    if (this.leased.has(key)) return { status: 'busy' as const }
    const leaseToken = crypto.randomUUID()
    this.leased.set(key, leaseToken)
    return { status: 'claimed' as const, leaseToken }
  }
  async complete(providerKey: string, eventKey: string, leaseToken: string) {
    const key = `${providerKey}:${eventKey}`
    if (this.leased.get(key) !== leaseToken) throw new Error('dispatch lease lost')
    this.leased.delete(key)
    this.completed.add(key)
  }
  async authorizeActivitySquad() {
    this.authorizations++
  }
  async release(providerKey: string, eventKey: string, leaseToken: string) {
    const key = `${providerKey}:${eventKey}`
    if (this.leased.get(key) === leaseToken) this.leased.delete(key)
  }
}

async function waitForRelease(store: MemoryCursorStore): Promise<void> {
  for (let attempt = 0; attempt < 20 && store.claimed; attempt++) await Promise.resolve()
  expect(store.claimed).toBe(false)
}

const watch: EventPollingWatch = {
  providerKey: 'fake',
  resourceKey: 'repo#1',
  active: true,
  connection: { id: 'fake:repo#1', squadId: 's1', providerKey: 'fake', adapterVersion: 1, configuration: {} },
}

describe('EventPollingRunner', () => {
  test('each authorized connection observes an event even when legacy dispatch is deduplicated', async () => {
    const observed: string[] = [],
      dispatched: string[] = []
    const cursorStore = new MemoryCursorStore()
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: new MemoryDispatchStore(),
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'changed', payload: {}, logicalEventKey: 'same-event' }],
          nextCursor: {},
          suggestedIntervalMs: 60_000,
        }),
      }),
      observe: async (_event, current) => {
        observed.push(current.connection.id)
      },
      dispatch: async (event) => {
        dispatched.push(event.type)
      },
    })
    await runner.runOnce()
    await runner.runOnce()
    expect(observed).toHaveLength(2)
    expect(dispatched).toHaveLength(1)
  })

  test('races concurrent ticks without polling or dispatching a claimed resource twice', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let releasePoll!: () => void
    const blocked = new Promise<void>((resolve) => {
      releasePoll = resolve
    })
    const provider: EventPollingCapability = {
      poll: async () => {
        polls++
        await blocked
        return { events: [{ type: 'changed', payload: {} }], nextCursor: { n: 1 }, suggestedIntervalMs: 60_000 }
      },
    }
    const dispatched: VerifiedIngressEvent[] = []
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => provider,
      dispatch: async (event) => {
        dispatched.push(event)
      },
      random: () => 0.5,
    })

    const first = runner.runOnce()
    await Promise.resolve()
    await Promise.resolve()
    const second = runner.runOnce()
    releasePoll()
    await Promise.all([first, second])

    expect(polls).toBe(1)
    expect(dispatched).toHaveLength(1)
    expect(store.saves).toBe(1)
  })

  test('applies active and inactive adaptive cadence bounds with jitter', async () => {
    const dueDates: Date[] = []
    const store: EventPollingCursorStore = {
      claim: async () => ({ cursor: null, leaseToken: 'x', leaseUntil: new Date(Date.now() + 120_000) }),
      save: async (_p, _r, _l, _c, nextPollAt) => {
        dueDates.push(nextPollAt)
      },
      renew: async () => new Date(Date.now() + 120_000),
      fail: async () => true,
      release: async () => {},
    }
    const provider: EventPollingCapability = {
      poll: async () => ({ events: [], nextCursor: {}, suggestedIntervalMs: 1 }),
    }
    const now = new Date('2026-08-26T00:00:00Z')
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2', active: false }],
      cursorStore: store,
      resolveCapability: () => provider,
      dispatch: async () => {},
      now: () => now,
      random: () => 0,
    })

    await runner.runOnce()

    expect(dueDates.map((date) => date.getTime() - now.getTime())).toEqual([60_000, 300_000])
  })

  test('continues polling other resources after one provider fails', async () => {
    const store = new MemoryCursorStore()
    let attempts = 0
    const errors: unknown[] = []
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          attempts++
          if (attempts === 1) throw new Error('bad credential')
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      onError: (error) => errors.push(error),
    })

    await runner.runOnce()
    expect(attempts).toBe(2)
    expect(errors).toHaveLength(1)
  })

  test('dispatches one logical transition across squad cursors and each later version once', async () => {
    const cursors = new Map<string, Record<string, unknown>>()
    const cursorStore: EventPollingCursorStore = {
      claim: async (_provider, resource) => ({
        cursor: cursors.get(resource) ?? null,
        leaseToken: resource,
        leaseUntil: new Date(Date.now() + 120_000),
      }),
      save: async (_provider, resource, _token, cursor) => {
        cursors.set(resource, cursor)
      },
      renew: async () => new Date(Date.now() + 120_000),
      fail: async () => true,
      release: async () => {},
    }
    const dispatchStore = new MemoryDispatchStore()
    const watches = ['s1:repo#1', 's2:repo#1'].map((resourceKey, index) => ({
      ...watch,
      resourceKey,
      connection: { ...watch.connection, id: `connection-${index}`, squadId: `s${index + 1}` },
    }))
    let version = 1
    let dispatches = 0
    const runner = new EventPollingRunner({
      listWatches: async () => watches,
      cursorStore,
      dispatchStore,
      resolveCapability: () => ({
        poll: async () => ({
          events: ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].map(
            (type) => ({ type, payload: {}, logicalEventKey: `${type}:42:v${version}` })
          ),
          nextCursor: { version },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        dispatches++
      },
    })

    await runner.runOnce()
    expect(dispatches).toBe(4)

    version = 2
    await runner.runOnce()
    expect(dispatches).toBe(8)
  })

  test('keeps durable dispatch and cursor success independent of Activity projection failure', async () => {
    const cursorStore = new MemoryCursorStore()
    const dispatch = {
      activityId: crypto.randomUUID(),
      eventFact: { occurredAt: '2026-08-26T00:00:00.000Z' },
      eventOccurredAt: new Date('2026-08-26T00:00:00.000Z'),
    }
    let completed = false
    let webhookDispatches = 0
    let projectionAttempts = 0
    let laterAuthorizations = 0
    let firstOwner: string | undefined
    const errors: unknown[] = []
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: {
        claim: async () =>
          completed ? { status: 'completed' as const, dispatch } : { status: 'claimed' as const, leaseToken: 'lease' },
        complete: async (_provider, _event, _lease, fact) => {
          completed = true
          firstOwner = fact?.activitySquadId
          return dispatch
        },
        authorizeActivitySquad: async () => {
          laterAuthorizations++
        },
        release: async () => undefined,
      },
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'pull_request', payload: {}, logicalEventKey: 'projection-failure' }],
          nextCursor: { observed: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        webhookDispatches++
      },
      extractDispatchFact: () => ({ occurredAt: '2026-08-26T00:00:00.000Z' }),
      onCompletedDispatch: async () => {
        projectionAttempts++
        throw new Error('projection failed')
      },
      onError: (error) => errors.push(error),
    })
    await runner.runOnce()
    await Promise.resolve()
    expect(webhookDispatches).toBe(1)
    expect(cursorStore.saves).toBe(1)
    expect(projectionAttempts).toBe(1)
    expect(firstOwner).toBe(watch.connection.squadId)
    expect(laterAuthorizations).toBe(0)
    expect(errors).toHaveLength(1)
    await runner.runOnce()
    await Promise.resolve()
    expect(webhookDispatches).toBe(1)
    expect(cursorStore.saves).toBe(2)
    expect(laterAuthorizations).toBe(1)
  })

  test('records no first owner when authoritative fact extraction rejects the watch', async () => {
    const cursorStore = new MemoryCursorStore()
    let completedFact: unknown = 'not-called'
    let projected = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: {
        claim: async () => ({ status: 'claimed' as const, leaseToken: 'lease' }),
        complete: async (_provider, _event, _lease, fact) => {
          completedFact = fact
        },
        authorizeActivitySquad: async () => {
          throw new Error('first owner must be atomic with fact completion')
        },
        release: async () => undefined,
      },
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'pull_request', payload: {}, logicalEventKey: 'first-owner-mismatch' }],
          nextCursor: { observed: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => undefined,
      extractDispatchFact: () => null,
      onCompletedDispatch: () => {
        projected++
      },
    })
    await runner.runOnce()
    expect(completedFact).toBeUndefined()
    expect(projected).toBe(0)
    expect(cursorStore.saves).toBe(1)
  })

  test('awaits later-owner authorization before projecting a completed dispatch', async () => {
    const cursorStore = new MemoryCursorStore()
    const authorization = Promise.withResolvers<void>()
    let projected = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: {
        claim: async () => ({
          status: 'completed' as const,
          dispatch: {
            activityId: crypto.randomUUID(),
            eventFact: { repository: 'acme/widgets', prNumber: 42 },
            eventOccurredAt: new Date(),
          },
        }),
        complete: async () => undefined,
        authorizeActivitySquad: async () => authorization.promise,
        release: async () => undefined,
      },
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'pull_request', payload: {}, logicalEventKey: 'later-owner' }],
          nextCursor: { observed: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        throw new Error('completed dispatch must not replay')
      },
      validateCompletedDispatch: () => true,
      onCompletedDispatch: () => {
        projected++
      },
    })
    const run = runner.runOnce()
    await Promise.resolve()
    expect(projected).toBe(0)
    authorization.resolve()
    await run
    await Promise.resolve()
    expect(projected).toBe(1)
  })

  test('does not project a completed legacy dispatch whose owner set is empty', async () => {
    const cursorStore = new MemoryCursorStore()
    let projected = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: {
        claim: async () => ({
          status: 'completed' as const,
          dispatch: {
            activityId: crypto.randomUUID(),
            eventFact: { repository: 'acme/widgets', prNumber: 42 },
            eventOccurredAt: new Date(),
          },
        }),
        complete: async () => undefined,
        authorizeActivitySquad: async () => false,
        release: async () => undefined,
      },
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'pull_request', payload: {}, logicalEventKey: 'legacy-empty-owner' }],
          nextCursor: { observed: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        throw new Error('completed dispatch must not replay')
      },
      validateCompletedDispatch: () => true,
      onCompletedDispatch: () => {
        projected++
      },
    })
    await runner.runOnce()
    await Promise.resolve()
    expect(projected).toBe(0)
    expect(cursorStore.saves).toBe(1)
  })

  test('does not project a completed shared dispatch through a mismatched watch', async () => {
    const cursorStore = new MemoryCursorStore()
    let completed = 0
    let authorizations = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore: {
        claim: async () => ({
          status: 'completed' as const,
          dispatch: {
            activityId: crypto.randomUUID(),
            eventFact: { repository: 'other/private', prNumber: 1 },
            eventOccurredAt: new Date(),
          },
        }),
        complete: async () => undefined,
        authorizeActivitySquad: async () => {
          authorizations++
        },
        release: async () => undefined,
      },
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'pull_request', payload: {}, logicalEventKey: 'shared-mismatch' }],
          nextCursor: { observed: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        throw new Error('completed dispatch must not replay')
      },
      validateCompletedDispatch: () => false,
      onCompletedDispatch: () => {
        completed++
      },
    })
    await runner.runOnce()
    await Promise.resolve()
    expect(completed).toBe(0)
    expect(authorizations).toBe(0)
    expect(cursorStore.saves).toBe(1)
  })

  test('does not advance a busy observer and retries after the first claimant releases', async () => {
    const dispatchStore = new MemoryDispatchStore()
    const firstCursorStore = new MemoryCursorStore()
    const secondCursorStore = new MemoryCursorStore()
    let enteredFirstDispatch!: () => void
    const firstDispatchStarted = new Promise<void>((resolve) => {
      enteredFirstDispatch = resolve
    })
    let releaseFirstDispatch!: () => void
    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve
    })
    const capability: EventPollingCapability = {
      poll: async () => ({
        events: [{ type: 'issue_comment', payload: {}, logicalEventKey: 'comment:busy-version' }],
        nextCursor: { observed: true },
        suggestedIntervalMs: 60_000,
      }),
    }
    const firstRunner = new EventPollingRunner({
      listWatches: async () => [{ ...watch, resourceKey: 's1:repo#1' }],
      cursorStore: firstCursorStore,
      dispatchStore,
      resolveCapability: () => capability,
      dispatch: async () => {
        enteredFirstDispatch()
        await releaseFirst
        throw new Error('first claimant failed before side effect')
      },
    })
    let successfulDispatches = 0
    const secondRunner = new EventPollingRunner({
      listWatches: async () => [
        { ...watch, resourceKey: 's2:repo#1', connection: { ...watch.connection, squadId: 's2' } },
      ],
      cursorStore: secondCursorStore,
      dispatchStore,
      resolveCapability: () => capability,
      dispatch: async () => {
        successfulDispatches++
      },
    })

    const firstRun = firstRunner.runOnce()
    await firstDispatchStarted
    await secondRunner.runOnce()

    expect(successfulDispatches).toBe(0)
    expect(secondCursorStore.saves).toBe(0)
    expect(secondCursorStore.failures).toBe(1)
    expect(secondCursorStore.cursor).toBeNull()
    expect(dispatchStore.authorizations).toBe(0)

    releaseFirstDispatch()
    await firstRun
    expect(firstCursorStore.failures).toBe(1)

    await secondRunner.runOnce()
    expect(successfulDispatches).toBe(1)
    expect(secondCursorStore.saves).toBe(1)
    expect(secondCursorStore.cursor).toEqual({ observed: true })
  })

  test('lets a working squad emit when another squad credential fails', async () => {
    const dispatchStore = new MemoryDispatchStore()
    let dispatches = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [
        { ...watch, resourceKey: 's1:repo#1' },
        { ...watch, resourceKey: 's2:repo#1', connection: { ...watch.connection, squadId: 's2' } },
      ],
      cursorStore: {
        claim: async (_provider, resource) => ({
          cursor: null,
          leaseToken: resource,
          leaseUntil: new Date(Date.now() + 120_000),
        }),
        save: async () => {},
        renew: async () => new Date(Date.now() + 120_000),
        fail: async () => true,
        release: async () => {},
      },
      dispatchStore,
      resolveCapability: (current) => ({
        poll: async () => {
          if (current.connection.squadId === 's1') throw new Error('bad credential')
          return {
            events: [{ type: 'issue_comment', payload: {}, logicalEventKey: 'comment:42:created' }],
            nextCursor: {},
            suggestedIntervalMs: 60_000,
          }
        },
      }),
      dispatch: async () => {
        dispatches++
      },
    })

    await runner.runOnce()
    expect(dispatches).toBe(1)
    expect(dispatchStore.completed.has('fake:comment:42:created')).toBe(true)
  })

  test('retries dispatch after pre-effect failure and skips it after cursor-save failure', async () => {
    const dispatchStore = new MemoryDispatchStore()
    const cursorStore = new MemoryCursorStore()
    let dispatchAttempts = 0
    let failDispatch = true
    let failSave = false
    const originalSave = cursorStore.save.bind(cursorStore)
    cursorStore.save = async (...args) => {
      if (failSave) {
        failSave = false
        throw new Error('crash before cursor save')
      }
      await originalSave(...args)
    }
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore,
      dispatchStore,
      resolveCapability: () => ({
        poll: async () => ({
          events: [{ type: 'changed', payload: {}, logicalEventKey: 'transition-1' }],
          nextCursor: { done: true },
          suggestedIntervalMs: 60_000,
        }),
      }),
      dispatch: async () => {
        dispatchAttempts++
        if (failDispatch) throw new Error('failed before side effect')
      },
    })

    await runner.runOnce()
    expect(dispatchAttempts).toBe(1)
    failDispatch = false
    failSave = true
    await runner.runOnce()
    expect(dispatchAttempts).toBe(2)
    await runner.runOnce()
    expect(dispatchAttempts).toBe(2)
    expect(cursorStore.saves).toBe(1)
  })

  test('backs off enough failing resources for a healthy tail watch to run next tick', async () => {
    const now = new Date('2026-08-26T00:00:00Z')
    const retryAt = new Map<string, Date>()
    const claimed = new Set<string>()
    const saved: string[] = []
    const store: EventPollingCursorStore = {
      claim: async (_provider, resource, claimNow, leaseMs) => {
        if (claimed.has(resource) || (retryAt.get(resource)?.getTime() ?? 0) > claimNow.getTime()) return null
        claimed.add(resource)
        return { cursor: null, leaseToken: resource, leaseUntil: new Date(Date.now() + leaseMs) }
      },
      save: async (_provider, resource) => {
        claimed.delete(resource)
        saved.push(resource)
      },
      renew: async () => new Date(Date.now() + 120_000),
      fail: async (_provider, resource, token, nextRetryAt) => {
        if (!claimed.has(resource) || token !== resource) return false
        claimed.delete(resource)
        retryAt.set(resource, nextRetryAt)
        return true
      },
      release: async (_provider, resource) => {
        claimed.delete(resource)
      },
    }
    const watches = ['s1:fail-1', 's1:fail-2', 's2:healthy'].map((resourceKey) => ({ ...watch, resourceKey }))
    const attempts: string[] = []
    const runner = new EventPollingRunner({
      listWatches: async () => watches,
      cursorStore: store,
      resolveCapability: (current) => ({
        poll: async () => {
          attempts.push(current.resourceKey)
          if (current.resourceKey.startsWith('s1:fail')) throw new Error('credential unavailable')
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      maxResourcesPerTick: 2,
      failureBackoffMinMs: 60_000,
      failureBackoffMaxMs: 60_000,
      now: () => now,
      random: () => 0,
    })

    await runner.runOnce()
    expect(attempts).toEqual(['s1:fail-1', 's1:fail-2'])
    expect([...retryAt.values()].every((date) => date.getTime() === now.getTime() + 60_000)).toBe(true)

    await runner.runOnce()
    expect(attempts).toEqual(['s1:fail-1', 's1:fail-2', 's2:healthy'])
    expect(saved).toEqual(['s2:healthy'])
    expect(retryAt.has('s2:healthy')).toBe(false)
  })

  test('does not let not-due resources consume the global tick budget', async () => {
    let claims = 0
    let polls = 0
    const store: EventPollingCursorStore = {
      claim: async () =>
        ++claims === 1 ? null : { cursor: null, leaseToken: 'x', leaseUntil: new Date(Date.now() + 120_000) },
      save: async () => {},
      renew: async () => new Date(Date.now() + 120_000),
      fail: async () => true,
      release: async () => {},
    }
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      maxResourcesPerTick: 1,
    })

    await runner.runOnce()
    expect(polls).toBe(1)
    expect(claims).toBe(2)
  })

  test('never exceeds the global request cap across successful paginated polls', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let requests = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }, { ...watch, resourceKey: 'repo#3' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async (_connection, _cursor, signal) => {
          polls++
          for (let page = 0; page < 30; page++) {
            signal!.reserveRequest()
            requests++
          }
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      maxBudgetUnitsPerTick: 40,
    })

    await runner.runOnce()
    expect(requests).toBe(40)
    expect(polls).toBe(2)
  })

  test('retains consumed request charges when a provider fails on a late page', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let requests = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }, { ...watch, resourceKey: 'repo#3' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async (_connection, _cursor, signal) => {
          polls++
          for (let page = 0; page < 30; page++) {
            signal!.reserveRequest()
            requests++
            if (polls === 1 && page === 24) throw new Error('late page failed')
          }
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      maxBudgetUnitsPerTick: 40,
    })

    await runner.runOnce()
    expect(requests).toBe(40)
    expect(polls).toBe(2)
  })

  test('fails closed for malformed and fractional provider accounting', async () => {
    for (const reported of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.2]) {
      const store = new MemoryCursorStore()
      let polls = 0
      const runner = new EventPollingRunner({
        listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
        cursorStore: store,
        resolveCapability: () => ({
          poll: async () => {
            polls++
            return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000, budgetUnitsConsumed: reported }
          },
        }),
        dispatch: async () => {},
        maxBudgetUnitsPerTick: 2,
      })

      await runner.runOnce()
      expect(polls).toBe(1)
    }
  })

  test('enforces the typed provider-neutral reservation contract for a generic adapter', async () => {
    const store = new MemoryCursorStore()
    let requests = 0
    const capability: EventPollingCapability = {
      poll: async (_connection, _cursor, signal) => {
        for (let request = 0; request < 3; request++) {
          signal!.reserveRequest()
          requests++
        }
        return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
      },
    }
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
      cursorStore: store,
      resolveCapability: () => capability,
      dispatch: async () => {},
      maxBudgetUnitsPerTick: 3,
    })

    await runner.runOnce()
    expect(requests).toBe(3)
  })

  test('aborts a slow poll below the lease before another claim can run', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let active = 0
    let maxActive = 0
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve
    })
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async (_connection, _cursor, signal) => {
          polls++
          active++
          maxActive = Math.max(maxActive, active)
          if (polls === 1) {
            await new Promise<void>((_resolve, reject) => {
              signal!.addEventListener(
                'abort',
                () => {
                  active--
                  observedAbort()
                  reject(signal!.reason)
                },
                { once: true }
              )
            })
          }
          active--
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      leaseMs: 100,
      pollTimeoutMs: 20,
    })

    const first = runner.runOnce()
    await aborted
    await first
    await waitForRelease(store)
    await runner.runOnce()
    expect(polls).toBe(2)
    expect(maxActive).toBe(1)
    expect(store.saves).toBe(1)
  })

  test('retains and renews ownership until a non-cooperative timed-out poll settles', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let settle!: () => void
    const blocked = new Promise<void>((resolve) => {
      settle = resolve
    })
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          if (polls === 1) await blocked
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      leaseMs: 60,
      pollTimeoutMs: 20,
    })

    await runner.runOnce()
    expect(store.claimed).toBe(true)
    await Bun.sleep(70)
    expect(store.renewals).toBeGreaterThan(1)
    await runner.runOnce()
    expect(polls).toBe(1)
    settle()
    await waitForRelease(store)
    await runner.runOnce()
    expect(polls).toBe(2)
  })

  test('retries a failed first heartbeat without releasing in-flight work', async () => {
    class RejectOnceRenewStore extends MemoryCursorStore {
      attempts = 0
      override async renew(provider: string, resource: string, lease: string, leaseMs: number) {
        this.attempts++
        if (this.attempts === 1) throw new Error('temporary database outage')
        return super.renew(provider, resource, lease, leaseMs)
      }
    }
    const store = new RejectOnceRenewStore()
    const errors: unknown[] = []
    let polls = 0
    let settle!: () => void
    const blocked = new Promise<void>((resolve) => {
      settle = resolve
    })
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [{ type: 'changed', payload: {} }], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {
        if (polls === 1) await blocked
      },
      onError: (error) => errors.push(error),
      leaseMs: 60,
      pollTimeoutMs: 20,
    })

    await runner.runOnce()
    await Bun.sleep(70)
    expect(store.attempts).toBeGreaterThan(1)
    expect(store.releases).toBe(0)
    await runner.runOnce()
    expect(polls).toBe(1)
    expect(errors.some((error) => String(error).includes('temporary database outage'))).toBe(true)
    settle()
    await waitForRelease(store)
    expect(store.releases).toBe(0)
    expect(store.failures).toBe(1)
  })

  test('reports lost heartbeat ownership without proactively releasing in-flight work', async () => {
    class LostRenewStore extends MemoryCursorStore {
      override async renew() {
        return null
      }
    }
    const store = new LostRenewStore()
    const errors: unknown[] = []
    let polls = 0
    let settle!: () => void
    const blocked = new Promise<void>((resolve) => {
      settle = resolve
    })
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [{ type: 'changed', payload: {} }], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {
        if (polls === 1) await blocked
      },
      onError: (error) => errors.push(error),
      leaseMs: 100,
      pollTimeoutMs: 20,
    })

    await runner.runOnce()
    for (let attempt = 0; attempt < 20 && errors.length < 2; attempt++) await Promise.resolve()
    expect(errors.some((error) => String(error).includes('lease ownership lost'))).toBe(true)
    expect(store.releases).toBe(0)
    await runner.runOnce()
    expect(polls).toBe(1)
    settle()
    for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve()
    expect(store.releases).toBe(0)
    expect(store.failures).toBe(0)
  })

  test('keeps a timed-out slow dispatch fenced until its side effects settle', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    let dispatches = 0
    let activeDispatches = 0
    let maxActiveDispatches = 0
    let settle!: () => void
    const blocked = new Promise<void>((resolve) => {
      settle = resolve
    })
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [{ type: 'changed', payload: {} }], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {
        dispatches++
        activeDispatches++
        maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches)
        if (dispatches === 1) await blocked
        activeDispatches--
      },
      leaseMs: 60,
      pollTimeoutMs: 20,
    })

    await runner.runOnce()
    expect(store.claimed).toBe(true)
    await Bun.sleep(70)
    expect(store.renewals).toBeGreaterThan(1)
    await runner.runOnce()
    expect(polls).toBe(1)
    settle()
    await waitForRelease(store)
    await runner.runOnce()
    expect(maxActiveDispatches).toBe(1)
    expect(dispatches).toBe(2)
  })

  test('keeps a timed-out slow save fenced until the write settles', async () => {
    let settle!: () => void
    const blocked = new Promise<void>((resolve) => {
      settle = resolve
    })
    class SlowSaveStore extends MemoryCursorStore {
      saveAttempts = 0
      override async save(provider: string, resource: string, lease: string, cursor: Record<string, unknown>) {
        this.saveAttempts++
        if (this.saveAttempts === 1) await blocked
        await super.save(provider, resource, lease, cursor)
      }
    }
    const store = new SlowSaveStore()
    let polls = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      leaseMs: 60,
      pollTimeoutMs: 20,
    })

    await runner.runOnce()
    expect(store.claimed).toBe(true)
    await Bun.sleep(70)
    expect(store.renewals).toBeGreaterThan(1)
    await runner.runOnce()
    expect(polls).toBe(1)
    settle()
    await waitForRelease(store)
    await runner.runOnce()
    expect(polls).toBe(2)
    expect(store.saveAttempts).toBe(2)
  })

  test('rejects a polling timeout that can outlive its lease', () => {
    expect(
      () =>
        new EventPollingRunner({
          listWatches: async () => [],
          cursorStore: new MemoryCursorStore(),
          resolveCapability: () => undefined,
          dispatch: async () => {},
          leaseMs: 100,
          pollTimeoutMs: 100,
        })
    ).toThrow('shorter than its lease')
  })

  test('does not start work when the returned database lease is already expired', async () => {
    let polls = 0
    let releases = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch],
      cursorStore: {
        claim: async () => ({ cursor: null, leaseToken: 'stale', leaseUntil: new Date(Date.now() - 1) }),
        save: async () => {},
        renew: async () => null,
        fail: async () => true,
        release: async () => {
          releases++
        },
      },
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
    })

    await runner.runOnce()
    expect(polls).toBe(0)
    expect(releases).toBe(1)
  })

  test('a poll that runs out of shared tick budget is released for the next tick, not backed off', async () => {
    const store = new MemoryCursorStore()
    const errors: unknown[] = []
    let polls = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async (_connection, _cursor, signal) => {
          polls++
          signal!.reserveRequest()
          signal!.reserveRequest()
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      onError: (error) => errors.push(error),
      maxBudgetUnitsPerTick: 1,
    })

    await runner.runOnce()
    expect(polls).toBe(1)
    expect(store.releases).toBe(1)
    expect(store.failures).toBe(0)
    expect(store.saves).toBe(0)
    expect(errors).toEqual([])
  })

  test('respects a global per-tick request budget', async () => {
    const store = new MemoryCursorStore()
    let polls = 0
    const runner = new EventPollingRunner({
      listWatches: async () => [watch, { ...watch, resourceKey: 'repo#2' }],
      cursorStore: store,
      resolveCapability: () => ({
        poll: async () => {
          polls++
          return { events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }
        },
      }),
      dispatch: async () => {},
      maxResourcesPerTick: 1,
    })

    await runner.runOnce()
    expect(polls).toBe(1)
  })
})

test('presentation-only cursor changes notify only after durable save, without dispatching activity', async () => {
  const cursorStore = new MemoryCursorStore()
  let notified = 0,
    dispatched = 0
  const runner = new EventPollingRunner({
    listWatches: async () => [watch],
    cursorStore,
    resolveCapability: () => ({
      poll: async () => ({ events: [], nextCursor: { presentation: 'new' }, suggestedIntervalMs: 60_000 }),
    }),
    dispatch: async () => {
      dispatched++
    },
    onCursorSaved: async (_watch, previous, next) => {
      expect(previous).toBeNull()
      expect(cursorStore.cursor).toEqual(next)
      notified++
    },
  })
  await runner.runOnce()
  expect(notified).toBe(1)
  expect(dispatched).toBe(0)
})

test('failed cursor saves cannot publish a presentation observation', async () => {
  const cursorStore = new MemoryCursorStore()
  cursorStore.save = async () => {
    throw new Error('save failed')
  }
  let notified = false
  const runner = new EventPollingRunner({
    listWatches: async () => [watch],
    cursorStore,
    resolveCapability: () => ({ poll: async () => ({ events: [], nextCursor: {}, suggestedIntervalMs: 60_000 }) }),
    dispatch: async () => {},
    onCursorSaved: async () => {
      notified = true
    },
  })
  await runner.runOnce()
  expect(notified).toBe(false)
  expect(cursorStore.failures).toBe(1)
})
