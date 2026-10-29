import { describe, it, expect, mock } from 'bun:test'
import {
  PrecompactionController,
  BAKE_TIMEOUT_MS,
  BAKE_RETRY_COOLDOWN_MS,
  PRECOMPACTION_AWAIT_MS,
  type PrecompactionDeps,
} from './controller'
import type { CompactionResult, SessionBeforeCompactEvent, SessionEntry } from '@earendil-works/pi-coding-agent'

function entry(id: string, type = 'message'): SessionEntry {
  return { id, type } as unknown as SessionEntry
}

function compactionEntry(id: string): SessionEntry {
  return {
    id,
    type: 'compaction',
    summary: 'previous',
    firstKeptEntryId: 'a',
    tokensBefore: 10,
  } as unknown as SessionEntry
}

function makeDeps(over: Partial<PrecompactionDeps> = {}): PrecompactionDeps {
  const branch = [entry('a'), entry('b'), entry('keep')]
  const result: CompactionResult = {
    summary: 'S',
    firstKeptEntryId: 'keep',
    tokensBefore: 1000,
  }
  return {
    getContextUsage: () => ({ tokens: 160_000, contextWindow: 200_000 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: branch, latestCompactionEntryId: null }),
    getModelKey: () => 'anthropic/claude-sonnet-4-6/200000',
    bake: mock(async () => result),
    marginTokens: 24_576,
    inFlightMarginTokens: 8192,
    ...over,
  }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

const event = (entries: SessionEntry[]) =>
  ({
    type: 'session_before_compact',
    branchEntries: entries,
    signal: new AbortController().signal,
  }) as unknown as SessionBeforeCompactEvent

describe('PrecompactionController.onSettled', () => {
  it('emits started and succeeded lifecycle events with debug stats', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (event) => events.push(event)

    c.onSettled()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(1)
    expect(events.map((e) => e.kind)).toEqual(['started', 'succeeded'])
    expect(events[0]).toMatchObject({
      kind: 'started',
      contextTokens: 160_000,
      contextWindow: 200_000,
      reserveTokens: 16_384,
      earlyMarginTokens: 24_576,
    })
    expect(events[1]).toMatchObject({
      kind: 'succeeded',
      contextTokens: 160_000,
      contextWindow: 200_000,
      reserveTokens: 16_384,
      earlyMarginTokens: 24_576,
      result: { tokensBefore: 1000, firstKeptEntryId: 'keep' },
    })
    expect(events[1].elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('starts a bake once the early threshold is crossed', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('does not bake below the early threshold', async () => {
    const deps = makeDeps({ getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000 }) })
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    expect(deps.bake).not.toHaveBeenCalled()
  })

  it('does not start a second bake while one is in flight or ready', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    c.onSettled()
    await flush()
    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('skips when pi is already compacting', async () => {
    const deps = makeDeps({ isCompacting: () => true })
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    expect(deps.bake).not.toHaveBeenCalled()
  })

  it('skips when auto-compaction is disabled', async () => {
    const deps = makeDeps({
      getCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    })
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    expect(deps.bake).not.toHaveBeenCalled()
  })

  it('does not bake when margin <= 0 (hard disable)', async () => {
    const deps = makeDeps({ marginTokens: 0 })
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    expect(deps.bake).not.toHaveBeenCalled()
  })

  it('emits failed and waits for the cooldown before retrying a failed bake', async () => {
    const deps = makeDeps({
      getContextUsage: () => ({ tokens: 180_000, contextWindow: 200_000 }),
      bake: mock()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 }),
    })
    let now = 1000
    const c = new PrecompactionController(deps, () => now)
    const events: any[] = []
    c.onLifecycle = (event) => events.push(event)

    c.onSettled()
    await flush()
    c.onSettled()
    c.onContextGrowth()
    await flush()
    expect(deps.bake).toHaveBeenCalledTimes(1)
    // A new wrapper for this agent must not bypass the cooldown.
    c.rebind(deps)
    now += BAKE_RETRY_COOLDOWN_MS - 1
    c.onContextGrowth()
    expect(deps.bake).toHaveBeenCalledTimes(1)
    now += 1
    c.onContextGrowth()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(2)
    expect(events.map((e) => e.kind)).toEqual(['started', 'failed', 'started', 'succeeded'])
    expect(events[1]).toMatchObject({ kind: 'failed', contextTokens: 180_000, elapsedMs: expect.any(Number) })
  })

  it('guards lifecycle callback failures so a failed bake is not emitted twice', async () => {
    const deps = makeDeps({
      bake: mock()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 }),
    })
    let now = 1000
    const c = new PrecompactionController(deps, () => now)
    const events: string[] = []
    c.onLifecycle = (event) => {
      events.push(event.kind)
      if (event.kind === 'failed') throw new Error('debug hook failed')
    }

    c.onSettled()
    await flush()

    expect(events).toEqual(['started', 'failed'])
    now += BAKE_RETRY_COOLDOWN_MS
    c.onSettled()
    await flush()
    expect(deps.bake).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight bake on invalidate and emits an aborted lifecycle event', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const deps = makeDeps({ bake: mock(() => new Promise<CompactionResult | null>((r) => (resolveBake = r))) })
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (event) => events.push(event)

    c.onSettled()
    c.invalidate()
    resolveBake({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 })
    await flush()
    // After abort, controller is idle and can start a fresh bake.
    c.onSettled()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(2)
    expect(events.map((e) => e.kind)).toEqual(['started', 'aborted', 'started'])
    expect(events[1]).toMatchObject({ kind: 'aborted', contextTokens: 160_000, elapsedMs: expect.any(Number) })
  })

  it('keeps the newer ready cache when a superseded bake resolves late', async () => {
    const resolvers: Array<(v: CompactionResult | null) => void> = []
    const deps = makeDeps({
      bake: mock(() => new Promise<CompactionResult | null>((resolve) => resolvers.push(resolve))),
    })
    const c = new PrecompactionController(deps)

    c.onSettled()
    c.invalidate()
    c.onSettled()

    resolvers[1]({ summary: 'new', firstKeptEntryId: 'keep', tokensBefore: 2 })
    await flush()
    resolvers[0]({ summary: 'old', firstKeptEntryId: 'keep', tokensBefore: 1 })
    await flush()

    const r = c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(r?.summary).toBe('new')
  })

  it('ignores a late bake result after dispose', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const deps = makeDeps({
      bake: mock(() => new Promise<CompactionResult | null>((resolve) => (resolveBake = resolve))),
    })
    const c = new PrecompactionController(deps)

    c.onSettled()
    c.dispose()
    resolveBake({ summary: 'late', firstKeptEntryId: 'keep', tokensBefore: 1 })
    await flush()

    expect(c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))).toBeUndefined()
  })
})

describe('PrecompactionController.onContextGrowth', () => {
  it('starts a bake at the in-flight threshold', async () => {
    const deps = makeDeps({
      getContextUsage: () => ({ tokens: 180_000, contextWindow: 200_000 }),
      inFlightMarginTokens: 8192,
    })
    const c = new PrecompactionController(deps)

    c.onContextGrowth()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('does not bake below the in-flight threshold even if above the settled threshold', async () => {
    const deps = makeDeps({
      getContextUsage: () => ({ tokens: 165_000, contextWindow: 200_000 }),
      marginTokens: 24_576,
      inFlightMarginTokens: 8192,
    })
    const c = new PrecompactionController(deps)

    c.onContextGrowth()
    await flush()
    expect(deps.bake).not.toHaveBeenCalled()

    c.onSettled()
    await flush()
    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('does not start a second bake while precomputing from onSettled', async () => {
    const deps = makeDeps({ bake: mock(() => new Promise<CompactionResult | null>(() => {})) })
    const c = new PrecompactionController(deps)

    c.onSettled()
    c.onContextGrowth()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('does not start a second bake while a result is ready', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)

    c.onSettled()
    await flush()
    c.onContextGrowth()
    await flush()

    expect(deps.bake).toHaveBeenCalledTimes(1)
  })

  it('does not bake when inFlightMarginTokens <= 0', async () => {
    const deps = makeDeps({ inFlightMarginTokens: 0 })
    const c = new PrecompactionController(deps)

    c.onContextGrowth()
    await flush()

    expect(deps.bake).not.toHaveBeenCalled()
  })
})

describe('PrecompactionController.awaitReadyResult', () => {
  it('exposes the default bounded wait time', () => {
    expect(PRECOMPACTION_AWAIT_MS).toBe(10_000)
  })

  it('consumes a ready result immediately', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)

    c.onSettled()
    await flush()
    const r = await c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]))

    expect(r?.summary).toBe('S')
  })

  it('waits for an in-flight bake and consumes it when it finishes in time', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const deps = makeDeps({
      bake: mock(() => new Promise<CompactionResult | null>((resolve) => (resolveBake = resolve))),
    })
    const c = new PrecompactionController(deps)

    c.onSettled()
    const resultPromise = c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]), 5000)
    resolveBake({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 })
    const r = await resultPromise

    expect(r?.summary).toBe('S')
  })

  it('consumes a failover-produced bake cached under the post-failover model key', async () => {
    let modelKey = 'openai-codex/gpt-5.6-luna/200000'
    let resolveBake!: (v: { compaction: CompactionResult; modelKey: string }) => void
    const deps = makeDeps({
      getModelKey: () => modelKey,
      bake: mock(
        () =>
          new Promise<{ compaction: CompactionResult; modelKey: string }>((resolve) => {
            resolveBake = resolve
          })
      ),
    })
    const c = new PrecompactionController(deps)

    c.onSettled()
    const resultPromise = c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]), 5000)
    // The baker's failover path switched the live session model before resolving.
    modelKey = 'zai/glm-5.1/200000'
    resolveBake({ compaction: { summary: 'fallback', firstKeptEntryId: 'keep', tokensBefore: 1 }, modelKey })
    const r = await resultPromise

    expect(r?.summary).toBe('fallback')
  })

  it('times out and falls back to synchronous compaction', async () => {
    const deps = makeDeps({
      bake: mock(() => new Promise<CompactionResult | null>(() => {})),
    })
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)

    c.onSettled()
    const r = await c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]), 10)

    expect(r).toBeUndefined()
    expect(events.some((e) => e.kind === 'superseded')).toBe(true)
  })

  it('returns undefined when no bake exists', async () => {
    const c = new PrecompactionController(makeDeps())

    const r = await c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]))

    expect(r).toBeUndefined()
  })

  it('cancels immediately when waitMs is zero', async () => {
    const deps = makeDeps({ bake: mock(() => new Promise<CompactionResult | null>(() => {})) })
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)

    c.onSettled()
    const r = await c.awaitReadyResult(event([entry('a'), entry('b'), entry('keep')]), 0)

    expect(r).toBeUndefined()
    expect(events.some((e) => e.kind === 'superseded')).toBe(true)
  })

  it('preserves validation by rejecting a divergent prefix after waiting', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const deps = makeDeps({
      bake: mock(() => new Promise<CompactionResult | null>((resolve) => (resolveBake = resolve))),
    })
    const c = new PrecompactionController(deps)

    c.onSettled()
    const resultPromise = c.awaitReadyResult(event([entry('a'), entry('b2'), entry('keep')]), 5000)
    resolveBake({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 })
    const r = await resultPromise

    expect(r).toBeUndefined()
  })
})

describe('PrecompactionController.getReadyResult', () => {
  function readyController(over: Partial<PrecompactionDeps> = {}) {
    const deps = makeDeps(over)
    const c = new PrecompactionController(deps)
    c.onSettled()
    return { c, deps }
  }
  it('returns the cached result when valid', async () => {
    const { c } = readyController()
    await flush()
    const r = c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(r?.summary).toBe('S')
  })

  it('returns undefined when firstKeptEntryId is gone from the branch', async () => {
    const { c } = readyController()
    await flush()
    const r = c.getReadyResult(event([entry('x'), entry('y')]))
    expect(r).toBeUndefined()
  })

  it('returns undefined when the model changed', async () => {
    const { c, deps } = readyController()
    await flush()
    ;(deps as { getModelKey: () => string }).getModelKey = () => 'anthropic/claude-opus-4-8/200000'
    const r = c.getReadyResult(event([entry('keep')]))
    expect(r).toBeUndefined()
  })

  it('returns undefined when compaction settings changed since snapshot', async () => {
    const { c, deps } = readyController()
    await flush()
    ;(
      deps as { getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }
    ).getCompactionSettings = () => ({
      enabled: true,
      reserveTokens: 32_768,
      keepRecentTokens: 20_000,
    })
    const r = c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(r).toBeUndefined()
  })

  it('returns undefined when a new compaction was added after the snapshot', async () => {
    const { c } = readyController({
      snapshot: () => ({ entries: [entry('a'), entry('b'), entry('keep')], latestCompactionEntryId: 'compact-before' }),
    })
    await flush()
    const r = c.getReadyResult(
      event([compactionEntry('compact-before'), entry('a'), compactionEntry('compact-after'), entry('keep')])
    )
    expect(r).toBeUndefined()
  })

  it('returns undefined and clears the cache when nothing is ready', () => {
    const deps = makeDeps({ getContextUsage: () => ({ tokens: 1, contextWindow: 200_000 }) })
    const c = new PrecompactionController(deps)
    expect(c.getReadyResult(event([entry('keep')]))).toBeUndefined()
  })
})

describe('PrecompactionController cross-session additions', () => {
  it('rebind swaps deps without disturbing an in-flight bake', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const depsA = makeDeps({ bake: mock(() => new Promise<CompactionResult | null>((r) => (resolveBake = r))) })
    const c = new PrecompactionController(depsA)
    c.onSettled() // precomputing
    // Rebind to a new session's deps mid-bake (model unchanged here).
    c.rebind(makeDeps())
    resolveBake({ summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 1 })
    await flush()
    // The in-flight bake still cached its result.
    const r = c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(r?.summary).toBe('S')
  })

  it('rejects a ready result whose summarized prefix diverged (prefix fingerprint)', async () => {
    const deps = makeDeps() // snapshot = [a, b, keep], cut = keep
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)
    c.onSettled()
    await flush()
    // Later branch keeps the cut id but an earlier entry changed (b -> b2).
    const r = c.getReadyResult(event([entry('a'), entry('b2'), entry('keep')]))
    expect(r).toBeUndefined()
    expect(events.some((e) => e.kind === 'rejected' && e.reason === 'prefix')).toBe(true)
  })

  it('emits consumed on a valid serve', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)
    c.onSettled()
    await flush()
    c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(events.some((e) => e.kind === 'consumed' && e.firstKeptEntryId === 'keep')).toBe(true)
  })

  it('cancels an in-flight bake and emits superseded when the hook fires mid-bake', async () => {
    let resolveBake!: (v: CompactionResult | null) => void
    const deps = makeDeps({ bake: mock(() => new Promise<CompactionResult | null>((r) => (resolveBake = r))) })
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)
    c.onSettled() // precomputing
    const r = c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))
    expect(r).toBeUndefined()
    expect(events.map((e) => e.kind)).toEqual(['started', 'superseded'])
    // The abort signal handed to the bake is aborted.
    resolveBake(null)
    await flush()
  })

  it('aborts the bake after the wall-clock cap (timeout → failed)', async () => {
    let seenSignal!: AbortSignal
    const deps = makeDeps({
      bake: mock(
        (_e: SessionEntry[], signal: AbortSignal) =>
          new Promise<CompactionResult | null>((resolve) => {
            seenSignal = signal
            // Resolve null once the wall-clock cap aborts the bake.
            signal.addEventListener('abort', () => resolve(null))
          })
      ),
    })
    const c = new PrecompactionController(deps)
    const events: any[] = []
    c.onLifecycle = (e) => events.push(e)
    c.onSettled()
    expect(seenSignal.aborted).toBe(false)
    c.forceTimeoutForTest()
    expect(seenSignal.aborted).toBe(true)
    await flush()
    expect(events.some((e) => e.kind === 'failed' && e.error === 'timeout')).toBe(true)
  })

  it('rejects a partial result returned after timeout, without caching or immediately retrying it', async () => {
    const deps = makeDeps({
      bake: mock(
        (_entries, signal) =>
          new Promise<CompactionResult | null>((resolve) => {
            signal.addEventListener('abort', () =>
              resolve({ summary: 'partial', firstKeptEntryId: 'keep', tokensBefore: 1 })
            )
          })
      ),
    })
    const c = new PrecompactionController(deps, () => 1000)
    const events: string[] = []
    c.onLifecycle = (event) => events.push(event.kind)
    c.onSettled()
    c.forceTimeoutForTest()
    await flush()
    expect(c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))).toBeUndefined()
    c.onSettled()
    expect(events).toEqual(['started', 'failed'])
    expect(deps.bake).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('reserves the slot before bake invocation and handles synchronous throws without restarting', async () => {
    const deps = makeDeps({
      bake: mock(() => {
        c.onSettled()
        throw new Error('synchronous failure')
      }),
    })
    const c = new PrecompactionController(deps, () => 1000)
    const events: string[] = []
    c.onLifecycle = (event) => events.push(event.kind)
    c.onSettled()
    await flush()
    c.onSettled()
    expect(events).toEqual(['started', 'failed'])
    expect(deps.bake).toHaveBeenCalledTimes(1)
    c.dispose()
  })

  it('reclaimIfStale drops a ready result older than the ttl', async () => {
    const deps = makeDeps()
    const c = new PrecompactionController(deps)
    c.onSettled()
    await flush()
    // Not stale yet.
    c.reclaimIfStale(60_000)
    expect(c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))).toBeDefined()
    // Re-bake then reclaim with ttl 0 (everything is stale).
    c.onSettled()
    await flush()
    c.reclaimIfStale(0)
    expect(c.getReadyResult(event([entry('a'), entry('b'), entry('keep')]))).toBeUndefined()
  })

  it('exposes BAKE_TIMEOUT_MS, isDisposed, and getLastActivityAt', () => {
    expect(BAKE_TIMEOUT_MS).toBe(90_000)
    const c = new PrecompactionController(makeDeps())
    expect(c.isDisposed()).toBe(false)
    const before = c.getLastActivityAt()
    c.onSettled()
    expect(c.getLastActivityAt()).toBeGreaterThanOrEqual(before)
    c.dispose()
    expect(c.isDisposed()).toBe(true)
  })
})
