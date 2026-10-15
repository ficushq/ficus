import { describe, expect, test } from 'bun:test'
import {
  completeLight,
  LIGHT_COMPLETION_MAX_TOKENS,
  LIGHT_COMPLETION_MAX_TOKENS_CEILING,
  LightCompletionProviderError,
  lightCompletionTotals,
  lightCompletionUsage,
  type LightCandidateReply,
  type LightCompletionCall,
  type LightCompletionDeps,
  type LightCompletionReport,
} from './light-completion'

const CHAIN = 'anthropic:claude-haiku-4-5:off,openai-codex:gpt-6-luna:off,zai:glm-5.3-flash:off'
const request = { tier: 'lite', purpose: 'reply-suggestions', system: 'sys', prompt: 'hello' }

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
  answers: Record<string, (call: LightCompletionCall) => Promise<LightCandidateReply | string | null>>,
  overrides: Partial<LightCompletionDeps> = {}
) {
  const calls: Array<{ spec: string; call: LightCompletionCall }> = []
  const errors: string[] = []
  const reports: LightCompletionReport[] = []
  const deps: LightCompletionDeps = {
    tierChain: async (slug) => (slug === 'lite' ? CHAIN : null),
    usableCandidates: (chain) => chain.split(','),
    complete: (spec, call) => {
      calls.push({ spec, call })
      const answer = answers[spec]
      return answer ? answer(call) : Promise.reject(new Error(`no fake for ${spec}`))
    },
    onCandidateError: (spec) => errors.push(spec),
    record: (report) => reports.push(report),
    ...overrides,
  }
  return { deps, calls, errors, reports }
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

const haiku = 'anthropic:claude-haiku-4-5:off'
const luna = 'openai-codex:gpt-6-luna:off'
const usage = (inputTokens: number, outputTokens: number, costUsd: number | null) => ({
  inputTokens,
  outputTokens,
  costUsd,
})

describe('completeLight accounting', () => {
  test('a successful call reports its purpose, tier, source, answering model and usage', async () => {
    let clock = 1_000
    const { deps, reports } = fakeDeps(
      {
        [haiku]: async () => {
          clock += 420
          return { text: '["Yes"]', usage: usage(512, 18, 0.000602) }
        },
      },
      { now: () => clock }
    )
    const result = await completeLight({ ...request, source: { agentId: 'agent-1', squadId: 'squad-1' } }, deps)
    expect(result).toEqual({ text: '["Yes"]', model: haiku })
    expect(reports).toEqual([
      {
        tier: 'lite',
        purpose: 'reply-suggestions',
        source: { agentId: 'agent-1', squadId: 'squad-1' },
        model: haiku,
        attempts: [{ model: haiku, failure: null, usage: usage(512, 18, 0.000602) }],
        latencyMs: 420,
      },
    ])
  })

  test('the reporter gets the request but the report itself holds no prompt or answer', async () => {
    let seen: { system: string; prompt: string } | undefined
    const { deps, reports } = fakeDeps({ [haiku]: async () => ({ text: 'secret answer', usage: usage(1, 1, 0) }) })
    deps.record = (report, req) => {
      reports.push(report)
      seen = req
    }
    await completeLight({ ...request, prompt: 'secret prompt' }, deps)
    expect(seen?.prompt).toBe('secret prompt')
    expect(JSON.stringify(reports)).not.toContain('secret')
  })

  test('a provider without usage data is still reported, with no usage', async () => {
    const { deps, reports } = fakeDeps({ [haiku]: async () => 'plain text' })
    expect(await completeLight(request, deps)).toEqual({ text: 'plain text', model: haiku })
    expect(reports[0].attempts).toEqual([{ model: haiku, failure: null, usage: null }])
    expect(lightCompletionTotals(reports[0].attempts)).toEqual({
      inputTokens: null,
      outputTokens: null,
      costNanodollars: null,
      costEstimated: true,
    })
  })

  test('failed candidates are reported with a fixed failure word and any usage the provider billed', async () => {
    const { deps, reports } = fakeDeps({
      [haiku]: async () => {
        throw new LightCompletionProviderError('500 overloaded: echoing "hello"', usage(300, 0, 0.0003))
      },
      [luna]: async () => '   ',
      'zai:glm-5.3-flash:off': async () => ({ text: 'ok', usage: usage(200, 10, 0.0001) }),
    })
    expect(await completeLight(request, deps)).toEqual({ text: 'ok', model: 'zai:glm-5.3-flash:off' })
    expect(reports[0].model).toBe('zai:glm-5.3-flash:off')
    expect(reports[0].attempts).toEqual([
      { model: haiku, failure: 'error', usage: usage(300, 0, 0.0003) },
      { model: luna, failure: 'empty', usage: null },
      { model: 'zai:glm-5.3-flash:off', failure: null, usage: usage(200, 10, 0.0001) },
    ])
    expect(JSON.stringify(reports)).not.toContain('overloaded')
  })

  test('no answer at all is reported with no model; timeouts and aborts are named', async () => {
    const timers = manualTimers()
    const controller = new AbortController()
    const { deps, reports } = fakeDeps(
      {
        [haiku]: () => {
          queueMicrotask(() => timers.fireAll())
          return never()
        },
        [luna]: () => {
          queueMicrotask(() => controller.abort())
          return never()
        },
      },
      { setTimer: timers.setTimer }
    )
    expect(await completeLight({ ...request, signal: controller.signal }, deps)).toBeNull()
    expect(reports).toHaveLength(1)
    expect(reports[0].model).toBeNull()
    expect(reports[0].attempts).toEqual([
      { model: haiku, failure: 'timeout', usage: null },
      { model: luna, failure: 'aborted', usage: null },
    ])
  })

  test('nothing is reported when no provider was asked', async () => {
    const missing = fakeDeps({})
    await completeLight({ ...request, tier: 'nope' }, missing.deps)
    const unserved = fakeDeps({ [haiku]: async () => null }, { usableCandidates: () => [haiku] })
    expect(await completeLight(request, unserved.deps)).toBeNull()
    expect(missing.reports).toHaveLength(0)
    expect(unserved.reports).toHaveLength(0)
  })

  test('a reporter that throws does not change the returned completion', async () => {
    const { deps, errors } = fakeDeps(
      { [haiku]: async () => ({ text: 'still here', usage: usage(10, 2, 0.00001) }) },
      {
        record: () => {
          throw new Error('log table missing')
        },
      }
    )
    expect(await completeLight(request, deps)).toEqual({ text: 'still here', model: haiku })
    expect(errors).toEqual(['(record)'])
  })
})

describe('lightCompletionUsage', () => {
  const price = { input: 1, output: 5 }

  test('counts cache reads and writes as input and keeps the list-price cost', () => {
    expect(
      lightCompletionUsage({ input: 400, cacheRead: 100, cacheWrite: 12, output: 30, cost: { total: 0.00066 } }, price)
    ).toEqual({ inputTokens: 512, outputTokens: 30, costUsd: 0.00066 })
  })

  test('no reported tokens means no usage', () => {
    expect(lightCompletionUsage({ input: 0, output: 0, cost: { total: 0 } }, price)).toBeNull()
    expect(lightCompletionUsage(undefined, price)).toBeNull()
  })

  test('a model without a price has tokens but no cost, rather than reading as free', () => {
    expect(lightCompletionUsage({ input: 50, output: 5, cost: { total: 0 } }, { input: 0, output: 0 })).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      costUsd: null,
    })
    expect(lightCompletionUsage({ input: 50, output: 5, cost: { total: 0.1 } }, undefined)?.costUsd).toBeNull()
  })
})

describe('lightCompletionTotals', () => {
  test('sums every attempt that reported usage, in nanodollars', () => {
    expect(
      lightCompletionTotals([
        { model: haiku, failure: 'error', usage: usage(300, 0, 0.0003) },
        { model: luna, failure: null, usage: usage(200, 10, 0.0001) },
      ])
    ).toEqual({ inputTokens: 500, outputTokens: 10, costNanodollars: 400_000, costEstimated: false })
  })

  test('is an estimate when an attempt’s usage or price is unknown', () => {
    expect(
      lightCompletionTotals([
        { model: haiku, failure: 'timeout', usage: null },
        { model: luna, failure: null, usage: usage(200, 10, null) },
      ])
    ).toEqual({ inputTokens: 200, outputTokens: 10, costNanodollars: null, costEstimated: true })
  })
})
