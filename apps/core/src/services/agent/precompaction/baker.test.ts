import { describe, it, expect, mock, beforeEach } from 'bun:test'
// Capture the real serializer/converter before mock.module below replaces the
// module: mock.module swaps the module in Bun's process-wide registry, not just
// for this file, so forwarding to the real functions (rather than a fake
// stand-in) keeps context-fit.ts's estimates correct for every other test file
// that imports this module in the same `bun test` run (e.g. context-fit.test.ts).
import {
  convertToLlm as realConvertToLlm,
  serializeConversation as realSerializeConversation,
} from '@earendil-works/pi-coding-agent'

// Mock the pi compaction pure functions BEFORE importing the baker.
const prepareCompaction = mock((): unknown => undefined)
const compact = mock((): Promise<CompactionResult | null> => Promise.resolve(null))

mock.module('@earendil-works/pi-coding-agent', () => ({
  prepareCompaction,
  compact,
  serializeConversation: realSerializeConversation,
  convertToLlm: realConvertToLlm,
}))

import { createPiCompactionBaker, createFitCompactionFallback } from './baker'
import type { CompactionResult } from '@earendil-works/pi-coding-agent'
import { resolveAgentModelSpec } from '../../../lib/utils/model-spec'
import { providerHealth } from '../../provider-health/registry'
import { setProviderEnabled } from '../../model-selection/disabled-providers'

/** Minimal PiAgentSession-shaped object for the baker. */
function fakeSession(over: Record<string, unknown> = {}) {
  return {
    model: { provider: 'anthropic', id: 'claude-sonnet-4-6', contextWindow: 200_000, maxTokens: 8_192 },
    thinkingLevel: 'medium',
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 }),
    },
    modelRuntime: {
      getAuth: mock(async () => ({ auth: { apiKey: 'k', headers: { h: '1' } }, env: { E: '2' } })),
    },
    agent: { streamFunction: mock(() => ({})) },
    ...over,
  } as never
}

const signal = new AbortController().signal
const result: CompactionResult = { summary: 'S', firstKeptEntryId: 'keep', tokensBefore: 10 }

describe('createPiCompactionBaker', () => {
  beforeEach(() => {
    // Each test starts from a clean provider-health state so exhaustion
    // side effects from one case can't bleed into another.
    providerHealth.clear()
    providerHealth.disablePersistence()
  })

  it('returns null when there is no model', async () => {
    const bake = createPiCompactionBaker(fakeSession({ model: undefined }))
    expect(await bake([], signal)).toBeNull()
    expect(prepareCompaction).not.toHaveBeenCalled()
  })

  it('returns null when prepareCompaction yields nothing', async () => {
    prepareCompaction.mockReturnValueOnce(undefined)
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], signal)).toBeNull()
    expect(compact).not.toHaveBeenCalled()
  })

  it('returns null when auth is not ok', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const session = fakeSession({
      modelRuntime: { getAuth: mock(async () => undefined) },
    })
    const bake = createPiCompactionBaker(session)
    expect(await bake([], signal)).toBeNull()
    expect(compact).not.toHaveBeenCalled()
  })

  it('returns null when the signal is already aborted before compact', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const ctrl = new AbortController()
    ctrl.abort()
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], ctrl.signal)).toBeNull()
    expect(compact).not.toHaveBeenCalled()
  })

  it('calls compact with auth + stream fn and returns its result', async () => {
    const prep = {
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    }
    prepareCompaction.mockReturnValueOnce(prep)
    compact.mockResolvedValueOnce(result)
    const streamFunction = mock(() => ({}))
    const session = fakeSession({ agent: { streamFunction } })
    const bake = createPiCompactionBaker(session)
    const r = await bake([], signal)
    expect(r).toEqual(result)
    expect(compact).toHaveBeenCalledTimes(1)
    // compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFunction, env)
    const args = compact.mock.calls[0] as unknown[]
    expect(args[0]).toBe(prep)
    expect(args[2]).toBe('k')
    expect(args[3]).toEqual({ h: '1' })
    expect(args[4]).toBeUndefined() // customInstructions
    expect(args[6]).toBe('medium') // thinkingLevel
    expect(args[7]).toBe(streamFunction)
    expect(args[8]).toEqual({ E: '2' }) // env
  })

  it('returns null when compact throws', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    compact.mockRejectedValueOnce(new Error('boom'))
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], signal)).toBeNull()
  })

  // --- Provider-exhaustion failover (e.g. codex usage_limit_reached) ---

  it('marks the provider exhausted when compact throws a plan-limit error', async () => {
    // A real codex usage_limit_reached failure during compaction must mark the
    // provider exhausted so subsequent compaction attempts skip it and fail over
    // instead of retrying the dead one.
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const resetUnix = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
    compact.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          type: 'error',
          error: { type: 'usage_limit_reached', resets_at: resetUnix, plan_type: 'free' },
        })
      )
    )
    const bake = createPiCompactionBaker(fakeSession())
    // Without a priority list/failover configuration, compaction failure stays non-fatal.
    expect(await bake([], signal)).toBeNull()
    // ...but the provider is now marked exhausted with the long plan-credit cooldown.
    const h = providerHealth.getHealth('anthropic')
    expect(h.state).toBe('exhausted')
    expect(h.reason).toBe('plan-credit')
    expect(h.retryAt).toBe(resetUnix * 1000)
  })

  it('attributes compaction failure only to the active account', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    compact.mockRejectedValueOnce(new Error('429 Too Many Requests'))
    const bake = createPiCompactionBaker(fakeSession(), {
      modelFailover: { priorityList: 'anthropic:claude-haiku-4-5', getActiveAccountId: () => 'a1' },
    })

    expect(await bake([], signal)).toBeNull()
    expect(providerHealth.getRecord('anthropic', 'a1')).toMatchObject({ kind: 'rate-limit' })
    expect(providerHealth.getRecord('anthropic')).toBeUndefined()
  })

  it('guards Ficus internal compaction errors before classification and mutation', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    compact.mockRejectedValueOnce(new Error('Execution session capacity reservation was refused'))
    const bake = createPiCompactionBaker(fakeSession(), {
      modelFailover: {
        priorityList: 'anthropic:claude-haiku-4-5',
        classifyError: () => ({ kind: 'capacity' }),
      },
    })

    expect(await bake([], signal)).toBeNull()
    expect(providerHealth.snapshotRecords()).toEqual([])
  })

  it('fails over compaction to the next provider after codex plan exhaustion', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const codex = resolveAgentModelSpec('openai-codex:gpt-5.6-luna').model
    const zai = resolveAgentModelSpec('zai:glm-5-turbo').model
    const session = fakeSession({ model: codex }) as {
      model: typeof codex
      setModel: ReturnType<typeof mock>
      setThinkingLevel: ReturnType<typeof mock>
    }
    session.setModel = mock(async (model: typeof codex) => {
      session.model = model
    })
    session.setThinkingLevel = mock(() => {})

    const resetUnix = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
    const compactCallsBefore = compact.mock.calls.length
    compact.mockImplementationOnce(async (...args: unknown[]) => {
      expect((args[1] as { provider: string }).provider).toBe('openai-codex')
      throw new Error(
        JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: resetUnix, plan_type: 'free' } })
      )
    })
    compact.mockImplementationOnce(async (...args: unknown[]) => {
      expect((args[1] as { provider: string }).provider).toBe('zai')
      return result
    })

    const bake = createPiCompactionBaker(session as never, {
      modelFailover: {
        priorityList: 'openai-codex:gpt-5.6-luna,zai:glm-5-turbo',
        selectNextSpec: () => 'zai:glm-5-turbo',
      },
    })

    await expect(bake([], signal)).resolves.toEqual({
      compaction: result,
      modelKey: 'zai/glm-5-turbo/200000',
    })
    expect(compact.mock.calls.length - compactCallsBefore).toBe(2)
    expect(session.setModel).toHaveBeenCalledTimes(1)
    expect(session.model.provider).toBe('zai')
    expect(providerHealth.getHealth('openai-codex').state).toBe('exhausted')
    expect(providerHealth.getHealth('openai-codex').reason).toBe('plan-credit')
    expect(providerHealth.getHealth('zai').state).toBe('available')
    expect(zai.provider).toBe('zai')
  })

  it('iterates past an auth-failed fallback candidate and rolls back its provider switch preparation', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const codex = resolveAgentModelSpec('openai-codex:gpt-5.6-luna').model
    const session = fakeSession({
      model: codex,
      modelRuntime: {
        getAuth: mock(async (model: { provider: string }) => {
          if (model.provider === 'anthropic') return undefined
          return { auth: { apiKey: `key-${model.provider}`, headers: {} }, env: {} }
        }),
      },
    }) as {
      model: typeof codex
      setModel: ReturnType<typeof mock>
      setThinkingLevel: ReturnType<typeof mock>
    }
    session.setModel = mock(async (model: typeof codex) => {
      session.model = model
    })
    session.setThinkingLevel = mock(() => {})

    const resetUnix = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
    const compactCallsBefore = compact.mock.calls.length
    compact.mockImplementationOnce(async (...args: unknown[]) => {
      expect((args[1] as { provider: string }).provider).toBe('openai-codex')
      throw new Error(
        JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: resetUnix, plan_type: 'free' } })
      )
    })
    compact.mockImplementationOnce(async (...args: unknown[]) => {
      expect((args[1] as { provider: string }).provider).toBe('zai')
      return result
    })

    const anthropicRollback = mock(() => {})
    const anthropicCommit = mock(() => {})
    const zaiCommit = mock(() => {})
    // Other test files intentionally toggle provider flags in the shared test
    // settings store. This case exercises an auth failure (not a disabled
    // provider), so explicitly restore Anthropic before selecting candidates.
    await setProviderEnabled('anthropic', true)

    const bake = createPiCompactionBaker(session as never, {
      modelFailover: {
        priorityList: 'openai-codex:gpt-5.6-luna,anthropic:claude-sonnet-4-6,zai:glm-5-turbo',
        prepareProviderSwitch: (provider) => {
          if (provider === 'anthropic') return { commit: anthropicCommit, rollback: anthropicRollback }
          if (provider === 'zai') return { commit: zaiCommit }
        },
      },
    })

    await expect(bake([], signal)).resolves.toEqual({
      compaction: result,
      modelKey: 'zai/glm-5-turbo/200000',
    })
    expect(compact.mock.calls.length - compactCallsBefore).toBe(2)
    expect(anthropicCommit).not.toHaveBeenCalled()
    expect(anthropicRollback).toHaveBeenCalledTimes(1)
    expect(zaiCommit).toHaveBeenCalledTimes(1)
    expect(session.model.provider).toBe('zai')
  })

  it('restores the original model and rolls back provider switch state when fallback compact fails after switching', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const codex = resolveAgentModelSpec('openai-codex:gpt-5.6-luna').model
    const session = fakeSession({ model: codex, thinkingLevel: 'high' }) as {
      model: typeof codex
      thinkingLevel: string
      setModel: ReturnType<typeof mock>
      setThinkingLevel: ReturnType<typeof mock>
    }
    session.setModel = mock(async (model: typeof codex) => {
      session.model = model
    })
    session.setThinkingLevel = mock((level: string) => {
      session.thinkingLevel = level
    })

    const resetUnix = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
    compact.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: resetUnix, plan_type: 'free' } }))
    )
    compact.mockRejectedValueOnce(new Error('fallback transport failed'))

    const commit = mock(() => {})
    const rollback = mock(() => {})
    const onModelSwitched = mock(() => {})
    const bake = createPiCompactionBaker(session as never, {
      modelFailover: {
        priorityList: 'openai-codex:gpt-5.6-luna,zai:glm-5-turbo',
        selectNextSpec: () => 'zai:glm-5-turbo',
        prepareProviderSwitch: () => ({ commit, rollback }),
        onModelSwitched,
      },
    })

    await expect(bake([], signal)).resolves.toBeNull()
    expect(session.model.provider).toBe('openai-codex')
    expect(session.thinkingLevel).toBe('high')
    expect(commit).not.toHaveBeenCalled()
    expect(onModelSwitched).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('restores the original model and rolls back provider switch state when aborted after switching', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    const codex = resolveAgentModelSpec('openai-codex:gpt-5.6-luna').model
    const ctrl = new AbortController()
    const session = fakeSession({ model: codex, thinkingLevel: 'high' }) as {
      model: typeof codex
      thinkingLevel: string
      setModel: ReturnType<typeof mock>
      setThinkingLevel: ReturnType<typeof mock>
    }
    session.setModel = mock(async (model: typeof codex) => {
      session.model = model
      if (model.provider === 'zai') ctrl.abort()
    })
    session.setThinkingLevel = mock((level: string) => {
      session.thinkingLevel = level
    })

    const resetUnix = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000)
    compact.mockRejectedValueOnce(
      new Error(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: resetUnix, plan_type: 'free' } }))
    )

    const commit = mock(() => {})
    const rollback = mock(() => {})
    const onModelSwitched = mock(() => {})
    const bake = createPiCompactionBaker(session as never, {
      modelFailover: {
        priorityList: 'openai-codex:gpt-5.6-luna,zai:glm-5-turbo',
        selectNextSpec: () => 'zai:glm-5-turbo',
        prepareProviderSwitch: () => ({ commit, rollback }),
        onModelSwitched,
      },
    })

    await expect(bake([], ctrl.signal)).resolves.toBeNull()
    expect(session.model.provider).toBe('openai-codex')
    expect(session.thinkingLevel).toBe('high')
    expect(commit).not.toHaveBeenCalled()
    expect(onModelSwitched).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
  })

  it('does not mark exhausted when compact throws a non-exhaustion error', async () => {
    prepareCompaction.mockReturnValueOnce({
      firstKeptEntryId: 'keep',
      messagesToSummarize: [],
      turnPrefixMessages: [],
      settings: { reserveTokens: 16_384 },
    })
    compact.mockRejectedValueOnce(new Error('connection reset by peer'))
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], signal)).toBeNull()
    expect(providerHealth.getHealth('anthropic').state).toBe('available')
  })
})

describe('createPiCompactionBaker context fit', () => {
  it('clamps an oversized preparation to the session model budget before compact', async () => {
    const bigPrep = {
      firstKeptEntryId: 'keep',
      messagesToSummarize: [{ role: 'user', content: 'x'.repeat(4_000_000), timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 900_000,
      fileOps: { created: [], modified: [], deleted: [], read: [] },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    }
    prepareCompaction.mockReturnValueOnce(bigPrep)
    compact.mockResolvedValueOnce(result)

    // 200k-window session model: 4M chars ≈ 1M tokens can never fit.
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], signal)).toEqual(result)

    // compact.mock accumulates calls across the whole file (never reset between
    // tests), so index into the most recent call rather than [0].
    const lastCall = compact.mock.calls[compact.mock.calls.length - 1] as unknown[]
    const passedPrep = lastCall[0] as typeof bigPrep
    expect(passedPrep).not.toBe(bigPrep)
    const passedChars = JSON.stringify(passedPrep.messagesToSummarize).length
    // Clamped to well under the 200k-token (~800k-char) budget.
    expect(passedChars).toBeLessThan(800_000)
    expect(passedPrep.firstKeptEntryId).toBe('keep')
  })

  it('passes a small preparation through unchanged', async () => {
    const smallPrep = {
      firstKeptEntryId: 'keep',
      messagesToSummarize: [{ role: 'user', content: 'short', timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: { created: [], modified: [], deleted: [], read: [] },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    }
    prepareCompaction.mockReturnValueOnce(smallPrep)
    compact.mockResolvedValueOnce(result)
    const bake = createPiCompactionBaker(fakeSession())
    expect(await bake([], signal)).toEqual(result)
    // See the comment above: index into the most recent call, not [0].
    const lastCall = compact.mock.calls[compact.mock.calls.length - 1] as unknown[]
    expect(lastCall[0]).toBe(smallPrep)
  })
})

function fitEvent(prepOver: Record<string, unknown> = {}) {
  return {
    type: 'session_before_compact',
    preparation: {
      firstKeptEntryId: 'keep',
      messagesToSummarize: [{ role: 'user', content: 'x'.repeat(4_000_000), timestamp: 1 }],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 900_000,
      fileOps: { created: [], modified: [], deleted: [], read: [] },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      ...prepOver,
    },
    branchEntries: [],
    reason: 'threshold',
    willRetry: false,
    signal: new AbortController().signal,
  } as never
}

describe('createFitCompactionFallback', () => {
  beforeEach(() => {
    providerHealth.clear()
    providerHealth.disablePersistence()
  })

  it('returns undefined when the summarize request already fits', async () => {
    // compact.mock accumulates calls across the whole file (never reset between
    // tests), so assert no NEW call happened rather than zero calls ever.
    const callsBefore = compact.mock.calls.length
    const fallback = createFitCompactionFallback(fakeSession())
    const event = fitEvent({ messagesToSummarize: [{ role: 'user', content: 'short', timestamp: 1 }] })
    expect(await fallback(event)).toBeUndefined()
    expect(compact.mock.calls.length).toBe(callsBefore)
  })

  it('summarizes with a healthy bigger-window candidate at full fidelity', async () => {
    const callsBefore = compact.mock.calls.length
    compact.mockResolvedValueOnce(result)
    // Session window 200k; candidate glm-5.2 has 1M. 1.2M chars ≈ 300k tokens:
    // over the session budget, under the candidate budget.
    const event = fitEvent({ messagesToSummarize: [{ role: 'user', content: 'x'.repeat(1_200_000), timestamp: 1 }] })
    const fallbackWithList = createFitCompactionFallback(fakeSession(), {
      modelFailover: { priorityList: 'anthropic:claude-sonnet-4-6,zai:glm-5.2' },
    })
    expect(await fallbackWithList(event)).toEqual(result)
    // Full fidelity: the candidate got the UNCLAMPED preparation.
    const call = compact.mock.calls[callsBefore] as unknown[]
    expect((call[0] as { messagesToSummarize: unknown[] }).messagesToSummarize).toHaveLength(1)
    const passedModel = call[1] as { provider: string; id: string }
    expect(passedModel.provider).toBe('zai')
    expect(passedModel.id).toBe('glm-5.2')
  })

  it('skips unhealthy candidates and falls back to the clamped current model', async () => {
    providerHealth.markExhausted('zai', { reason: 'plan-credit', retryAt: Date.now() + 60_000 })
    const callsBefore = compact.mock.calls.length
    compact.mockResolvedValueOnce(result)
    const fallback = createFitCompactionFallback(fakeSession(), {
      modelFailover: { priorityList: 'anthropic:claude-sonnet-4-6,zai:glm-5.2' },
    })
    const event = fitEvent()
    expect(await fallback(event)).toEqual(result)
    const call = compact.mock.calls[callsBefore] as unknown[]
    const passedModel = call[1] as { provider: string; id: string }
    expect(passedModel.provider).toBe('anthropic')
    const passedChars = JSON.stringify((call[0] as { messagesToSummarize: unknown[] }).messagesToSummarize).length
    expect(passedChars).toBeLessThan(800_000)
  })

  it('runs prepareProviderSwitch rollback after a candidate summarize (success case)', async () => {
    const rollback = mock(() => {})
    compact.mockResolvedValueOnce(result)
    const fallback = createFitCompactionFallback(fakeSession(), {
      modelFailover: {
        priorityList: 'zai:glm-5.2',
        prepareProviderSwitch: () => ({ rollback }),
      },
    })
    const event = fitEvent({ messagesToSummarize: [{ role: 'user', content: 'x'.repeat(1_200_000), timestamp: 1 }] })
    expect(await fallback(event)).toEqual(result)
    expect(rollback).toHaveBeenCalled()
  })

  it('marks an exhausted candidate and still falls back to the clamped current model', async () => {
    const callsBefore = compact.mock.calls.length
    compact.mockRejectedValueOnce(new Error('429 usage_limit_reached'))
    compact.mockResolvedValueOnce(result)
    const fallback = createFitCompactionFallback(fakeSession(), {
      modelFailover: { priorityList: 'zai:glm-5.2' },
    })
    const event = fitEvent({ messagesToSummarize: [{ role: 'user', content: 'x'.repeat(1_200_000), timestamp: 1 }] })
    expect(await fallback(event)).toEqual(result)
    expect(providerHealth.isProviderHealthy('zai')).toBe(false)
    const call = compact.mock.calls[callsBefore + 1] as unknown[]
    expect((call[1] as { provider: string }).provider).toBe('anthropic')
  })

  it('resolves undefined when everything fails (compaction stays non-fatal)', async () => {
    compact.mockRejectedValue(new Error('boom'))
    const fallback = createFitCompactionFallback(fakeSession())
    expect(await fallback(fitEvent())).toBeUndefined()
  })
})
