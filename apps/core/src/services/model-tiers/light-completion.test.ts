import { describe, expect, test } from 'bun:test'
import {
  completeLight,
  LIGHT_COMPLETION_MAX_TOKENS,
  LIGHT_COMPLETION_MAX_TOKENS_CEILING,
  type LightCompletionCall,
  type LightCompletionDeps,
} from './light-completion'

const CHAIN = 'anthropic:claude-haiku-4-5:off,openai-codex:gpt-6-luna:off,zai:glm-5.3-flash:off'
const request = { tier: 'lite', system: 'sys', prompt: 'hello' }

/** Timers the test fires by hand, so deadlines are deterministic. */
function manualTimers() {
  const pending = new Map<number, { fire: () => void; ms: number }>()
  let next = 0
  return {
    setTimer: (fire: () => void, ms: number) => {
      const id = next++
      pending.set(id, { fire, ms })
      return () => pending.delete(id)
    },
    fireAll: () => {
      for (const [id, timer] of [...pending]) {
        pending.delete(id)
        timer.fire()
      }
    },
    pending,
  }
}

/** A fake provider: each spec answers with a function of the call. */
function fakeDeps(
  answers: Record<string, (call: LightCompletionCall) => Promise<string | null>>,
  overrides: Partial<LightCompletionDeps> = {}
) {
  const calls: Array<{ spec: string; call: LightCompletionCall }> = []
  const errors: string[] = []
  const deps: LightCompletionDeps = {
    tierChain: async (slug) => (slug === 'lite' ? CHAIN : null),
    usableCandidates: (chain) => chain.split(','),
    complete: (spec, call) => {
      calls.push({ spec, call })
      const answer = answers[spec]
      return answer ? answer(call) : Promise.reject(new Error(`no fake for ${spec}`))
    },
    onCandidateError: (spec) => errors.push(spec),
    ...overrides,
  }
  return { deps, calls, errors }
}

const never = () => new Promise<string>(() => {})

describe('completeLight', () => {
  test('answers from the first candidate with a small output cap', async () => {
    const { deps, calls } = fakeDeps({ 'anthropic:claude-haiku-4-5:off': async () => '  ["Yes"]  ' })
    const result = await completeLight(request, deps)
    expect(result).toEqual({ text: '["Yes"]', model: 'anthropic:claude-haiku-4-5:off' })
    expect(calls).toHaveLength(1)
    expect(calls[0].call).toMatchObject({ system: 'sys', prompt: 'hello', maxTokens: LIGHT_COMPLETION_MAX_TOKENS })
  })

  test('passes the tier, purpose and source to every candidate for cost accounting', async () => {
    const { deps, calls } = fakeDeps({
      'anthropic:claude-haiku-4-5:off': async () => {
        throw new Error('down')
      },
      'openai-codex:gpt-6-luna:off': async () => 'ok',
    })
    await completeLight({ ...request, purpose: 'reply-suggestions', source: { agentId: 'a1' } }, deps)
    expect(calls.map((entry) => entry.call)).toEqual([
      expect.objectContaining({ tier: 'lite', purpose: 'reply-suggestions', source: { agentId: 'a1' } }),
      expect.objectContaining({ tier: 'lite', purpose: 'reply-suggestions', source: { agentId: 'a1' } }),
    ])
  })

  test('falls back to the next candidate when one throws or cannot serve', async () => {
    const { deps, calls, errors } = fakeDeps({
      'anthropic:claude-haiku-4-5:off': async () => {
        throw new Error('429 rate limited')
      },
      'openai-codex:gpt-6-luna:off': async () => null,
      'zai:glm-5.3-flash:off': async () => 'from zai',
    })
    expect(await completeLight(request, deps)).toEqual({ text: 'from zai', model: 'zai:glm-5.3-flash:off' })
    expect(calls.map((call) => call.spec)).toEqual(CHAIN.split(','))
    expect(errors).toEqual(['anthropic:claude-haiku-4-5:off'])
  })

  test('only tries the candidates model selection allows', async () => {
    const { deps, calls } = fakeDeps(
      { 'zai:glm-5.3-flash:off': async () => 'ok' },
      { usableCandidates: () => ['zai:glm-5.3-flash:off'] }
    )
    expect(await completeLight(request, deps)).toEqual({ text: 'ok', model: 'zai:glm-5.3-flash:off' })
    expect(calls.map((call) => call.spec)).toEqual(['zai:glm-5.3-flash:off'])
  })

  test('returns null without calling anything when the tier is missing or has no usable candidate', async () => {
    const missing = fakeDeps({})
    expect(await completeLight({ ...request, tier: 'nope' }, missing.deps)).toBeNull()
    const unusable = fakeDeps({}, { usableCandidates: () => [] })
    expect(await completeLight(request, unusable.deps)).toBeNull()
    expect(missing.calls).toHaveLength(0)
    expect(unusable.calls).toHaveLength(0)
  })

  test('never throws, even when the tier lookup or candidate filter does', async () => {
    const lookup = fakeDeps({}, { tierChain: () => Promise.reject(new Error('db down')) })
    expect(await completeLight(request, lookup.deps)).toBeNull()
    const filter = fakeDeps(
      {},
      {
        usableCandidates: () => {
          throw new Error('bad chain')
        },
      }
    )
    expect(await completeLight(request, filter.deps)).toBeNull()
    const sync = fakeDeps(
      {},
      {
        complete: () => {
          throw new Error('sync throw')
        },
      }
    )
    expect(await completeLight(request, sync.deps)).toBeNull()
  })

  test('empty answers count as no answer', async () => {
    const { deps } = fakeDeps({
      'anthropic:claude-haiku-4-5:off': async () => '   ',
      'openai-codex:gpt-6-luna:off': async () => 'second',
    })
    expect(await completeLight(request, deps)).toEqual({ text: 'second', model: 'openai-codex:gpt-6-luna:off' })
  })

  test('a candidate that outlives its timeout is aborted and the next one is asked', async () => {
    const timers = manualTimers()
    let firstSignal: AbortSignal | undefined
    const { deps, calls } = fakeDeps(
      {
        'anthropic:claude-haiku-4-5:off': (call) => {
          firstSignal = call.signal
          // The deadline fires while this call hangs.
          queueMicrotask(() => timers.fireAll())
          return never()
        },
        'openai-codex:gpt-6-luna:off': async () => 'late but fine',
      },
      { setTimer: timers.setTimer }
    )
    const result = await completeLight({ ...request, timeoutMs: 1234 }, deps)
    expect(result).toEqual({ text: 'late but fine', model: 'openai-codex:gpt-6-luna:off' })
    expect(firstSignal?.aborted).toBe(true)
    expect(calls[0].call.timeoutMs).toBe(1234)
    expect(timers.pending.size).toBe(0)
  })

  test('stops trying candidates once the overall deadline has passed', async () => {
    let clock = 0
    const { deps, calls } = fakeDeps(
      {
        'anthropic:claude-haiku-4-5:off': async () => {
          clock += 20_000
          throw new Error('slow failure')
        },
        'openai-codex:gpt-6-luna:off': async () => 'should not be asked',
      },
      { now: () => clock }
    )
    expect(await completeLight({ ...request, totalTimeoutMs: 15_000 }, deps)).toBeNull()
    expect(calls.map((call) => call.spec)).toEqual(['anthropic:claude-haiku-4-5:off'])
  })

  test('a later candidate only gets what is left of the overall budget', async () => {
    let clock = 0
    const { deps, calls } = fakeDeps(
      {
        'anthropic:claude-haiku-4-5:off': async () => {
          clock += 10_000
          return null
        },
        'openai-codex:gpt-6-luna:off': async () => 'ok',
      },
      { now: () => clock }
    )
    await completeLight({ ...request, timeoutMs: 8_000, totalTimeoutMs: 15_000 }, deps)
    expect(calls.map((call) => call.call.timeoutMs)).toEqual([8_000, 5_000])
  })

  test('the caller signal cancels the call in flight and skips the rest', async () => {
    const controller = new AbortController()
    let inFlight: AbortSignal | undefined
    const { deps, calls } = fakeDeps({
      'anthropic:claude-haiku-4-5:off': (call) => {
        inFlight = call.signal
        queueMicrotask(() => controller.abort())
        return never()
      },
      'openai-codex:gpt-6-luna:off': async () => 'not asked',
    })
    expect(await completeLight({ ...request, signal: controller.signal }, deps)).toBeNull()
    expect(inFlight?.aborted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(await completeLight({ ...request, signal: controller.signal }, deps)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  test('caps the requested output tokens', async () => {
    const { deps, calls } = fakeDeps({ 'anthropic:claude-haiku-4-5:off': async () => 'ok' })
    await completeLight({ ...request, maxTokens: 100_000 }, deps)
    expect(calls[0].call.maxTokens).toBe(LIGHT_COMPLETION_MAX_TOKENS_CEILING)
  })
})
