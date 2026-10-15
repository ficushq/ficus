import { afterEach, describe, expect, test } from 'bun:test'
import { flushInferenceUsage, setInferenceUsageSinkForTest } from '../inference-usage'
import type { InferenceUsageEvent } from '../inference-usage/types'
import { recordLightCompletionUsage } from './light-completion-runtime'

const usage = (input: number, output: number, total: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
})

afterEach(() => setInferenceUsageSinkForTest(undefined))

describe('Lite-tier cost accounting', () => {
  test('each candidate that reached a provider is one lite:<purpose> row, failed ones included', async () => {
    const seen: InferenceUsageEvent[] = []
    setInferenceUsageSinkForTest((event) => void seen.push(event))
    const agentId = '88888888-8888-4888-8888-888888888888'
    const squadId = '99999999-9999-4999-8999-999999999999'
    const call = { tier: 'lite', purpose: 'reply-suggestions', source: { agentId, squadId } }
    recordLightCompletionUsage('anthropic', 'claude-haiku-4-5', { usage: usage(50, 0, 0), stopReason: 'error' }, call)
    recordLightCompletionUsage(
      'openai-codex',
      'gpt-6-luna',
      { usage: usage(120, 30, 0.0004), stopReason: 'stop' },
      call
    )
    recordLightCompletionUsage('zai', 'glm', { stopReason: 'aborted' }, call)
    await flushInferenceUsage()
    expect(seen).toEqual([
      expect.objectContaining({
        feature: 'lite:reply-suggestions',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 },
        listCostUsd: undefined,
        attribution: expect.objectContaining({ agentId, squadId }),
        source: { tier: 'lite', purpose: 'reply-suggestions', stopReason: 'error' },
      }),
      expect.objectContaining({
        feature: 'lite:reply-suggestions',
        provider: 'openai-codex',
        model: 'gpt-6-luna',
        listCostUsd: 0.0004,
        source: { tier: 'lite', purpose: 'reply-suggestions', stopReason: 'stop' },
      }),
    ])
  })
})
