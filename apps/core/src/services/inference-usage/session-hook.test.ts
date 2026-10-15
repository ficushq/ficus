import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { flushInferenceUsage, setInferenceUsageSinkForTest } from './record'
import { attachInferenceUsageRecorder, recordCompactionSummary, type SessionUsageContext } from './session-hook'
import type { InferenceUsageEvent } from './types'

const usage = (input: number, output = 0, total = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
})

const assistant = (provider: string, model: string, tokens: number, extra: Record<string, unknown> = {}) =>
  ({
    type: 'message_end',
    message: { role: 'assistant', provider, model, usage: usage(tokens, 5, 0.01), stopReason: 'stop', ...extra },
  }) as unknown as AgentSessionEvent

let seen: InferenceUsageEvent[]
let emit: (event: AgentSessionEvent) => void
let userId: string | undefined
let context: SessionUsageContext

beforeEach(() => {
  seen = []
  setInferenceUsageSinkForTest((event) => void seen.push(event))
  userId = 'u1'
  context = {
    feature: 'agent-turn',
    attribution: () => ({ agentId: 'a1', userId }),
    getAccountId: (provider) => (provider === 'anthropic' ? 'acc_1' : undefined),
    getModel: () => ({ provider: 'anthropic', id: 'claude-sonnet-4-5' }),
  }
  attachInferenceUsageRecorder(
    {
      subscribe: (listener) => {
        emit = listener
        return () => {}
      },
    },
    context
  )
})

afterEach(() => setInferenceUsageSinkForTest(undefined))

describe('session usage hook', () => {
  test('records every assistant message with its own model and the current attribution', async () => {
    emit(assistant('anthropic', 'claude-sonnet-4-5', 100))
    userId = 'u2'
    emit(assistant('openai-codex', 'gpt-5.5', 50, { responseId: 'resp_1' }))
    await flushInferenceUsage()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({
      feature: 'agent-turn',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      accountId: 'acc_1',
      tokens: { input: 100, output: 5 },
      listCostUsd: 0.01,
      attribution: { agentId: 'a1', userId: 'u1' },
    })
    expect(seen[1]).toMatchObject({ provider: 'openai-codex', accountId: undefined, attribution: { userId: 'u2' } })
    expect(seen[1]!.source).toMatchObject({ responseId: 'resp_1', stopReason: 'stop' })
  })

  test('ignores user messages and records failed calls that used tokens', async () => {
    emit({ type: 'message_end', message: { role: 'user', content: 'hi' } } as unknown as AgentSessionEvent)
    emit(assistant('anthropic', 'claude-sonnet-4-5', 30, { stopReason: 'error' }))
    await flushInferenceUsage()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.source).toMatchObject({ stopReason: 'error' })
  })

  test('an unpriced message (cost 0) leaves the list price to the ledger lookup', async () => {
    emit({
      type: 'message_end',
      message: { role: 'assistant', provider: 'anthropic', model: 'm', usage: usage(10), stopReason: 'stop' },
    } as unknown as AgentSessionEvent)
    await flushInferenceUsage()
    expect(seen[0]!.listCostUsd).toBeUndefined()
  })

  test('records pi compaction summaries with the session model', async () => {
    emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 1, usage: usage(400, 20) },
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent)
    await flushInferenceUsage()
    expect(seen).toEqual([
      expect.objectContaining({
        feature: 'compaction',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        tokens: { input: 400, output: 20, cacheRead: 0, cacheWrite: 0 },
        source: { reason: 'threshold' },
      }),
    ])
  })

  test('a summary already recorded as a bake is not counted again when pi uses it', async () => {
    const baked = usage(900, 40)
    recordCompactionSummary(context, {
      kind: 'precompaction',
      model: { provider: 'anthropic', id: 'claude-haiku-4-5' },
      usage: baked,
    })
    emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 's', firstKeptEntryId: 'e', tokensBefore: 1, usage: baked },
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent)
    await flushInferenceUsage()
    expect(seen.map((event) => [event.feature, event.model])).toEqual([['precompaction', 'claude-haiku-4-5']])
  })

  test('compaction without usage records nothing', async () => {
    emit({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: true, willRetry: false })
    await flushInferenceUsage()
    expect(seen).toHaveLength(0)
  })
})
