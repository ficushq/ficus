import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Credential } from '@earendil-works/pi-ai'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { AccountScopedCredentialStore } from '../agent/account-auth-backend'
import type { AccountStoreV1 } from '../agent/account-store'
import type { PricedModel } from './pricing'
import { buildInferenceUsageRow, flushInferenceUsage, setInferenceUsageSinkForTest } from './record'
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

/**
 * The path AgentSession wires: the hook reads the serving account from the session's account-scoped
 * credential store (the same selection its requests authenticate with), and the ledger classifies billing
 * from that account.
 */
describe('live agent turns are billed by the account that served them', () => {
  const oauth = { type: 'oauth', access: 'a', refresh: 'r', expires: 0 } as unknown as Credential
  const apiKey = (key: string) => ({ type: 'api_key', key }) as unknown as Credential
  const accounts: AccountStoreV1 = {
    version: 1,
    accounts: {
      'openai-codex': [{ id: 'chatgpt', enabled: true, credential: oauth }],
      anthropic: [
        { id: 'claude-code', enabled: true, kind: 'claude-code', credential: apiKey('claude-code') },
        { id: 'console', enabled: true, credential: apiKey('sk-ant') },
      ],
      custom: [{ id: 'odd', enabled: true, credential: { type: 'other' } as unknown as Credential }],
    },
  }
  const sonnet = {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  } as unknown as PricedModel
  const deps = {
    store: accounts,
    lookupModel: (provider: string, model: string) =>
      provider === 'anthropic' && model === sonnet.id ? sonnet : undefined,
  }
  let selection: AccountScopedCredentialStore
  let live: SessionUsageContext
  const rows = () => seen.map((event) => buildInferenceUsageRow(event, deps))
  // pi prices Codex and Anthropic API calls itself; the Claude Code bridge reports $0 (left to the lookup).
  const turn = (provider: string, model: string, listUsd: number) =>
    ({
      type: 'message_end',
      message: { role: 'assistant', provider, model, usage: usage(1_000_000, 0, listUsd), stopReason: 'stop' },
    }) as unknown as AgentSessionEvent

  beforeEach(() => {
    selection = new AccountScopedCredentialStore()
    live = {
      feature: 'agent-turn',
      attribution: () => ({ agentId: 'a1' }),
      getAccountId: (provider) => selection.getSelectedAccountId(provider),
      getModel: () => undefined,
    }
    attachInferenceUsageRecorder({ subscribe: (listener) => ((emit = listener), () => {}) }, live)
  })

  test('a ChatGPT/Codex sign-in bills $0 and keeps the list price', async () => {
    selection.selectAccount('openai-codex', 'chatgpt')
    emit(turn('openai-codex', 'gpt-5.5', 1.25))
    await flushInferenceUsage()
    expect(rows()).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        model: 'gpt-5.5',
        accountId: 'chatgpt',
        billing: 'subscription',
        costNanodollars: 0,
        listCostNanodollars: 1_250_000_000,
      }),
    ])
  })

  test('Claude Code bills $0 and is priced as the Anthropic model', async () => {
    selection.selectAccount('anthropic', 'claude-code')
    emit(turn('anthropic', sonnet.id, 0))
    await flushInferenceUsage()
    expect(rows()).toEqual([
      expect.objectContaining({
        accountId: 'claude-code',
        billing: 'subscription',
        costNanodollars: 0,
        listCostNanodollars: 3_000_000_000,
      }),
    ])
  })

  test('an API key bills the list price', async () => {
    selection.selectAccount('anthropic', 'console')
    emit(turn('anthropic', sonnet.id, 3))
    await flushInferenceUsage()
    expect(rows()).toEqual([
      expect.objectContaining({
        accountId: 'console',
        billing: 'api',
        costNanodollars: 3_000_000_000,
        listCostNanodollars: 3_000_000_000,
      }),
    ])
  })

  test('an account of unknown type, or no account with no price, is unknown and bills nothing', async () => {
    selection.selectAccount('custom', 'odd')
    emit(turn('custom', 'mystery', 0))
    emit(turn('elsewhere', 'mystery', 0))
    await flushInferenceUsage()
    expect(rows()).toEqual([
      expect.objectContaining({ accountId: 'odd', billing: 'unknown', costNanodollars: 0, listCostNanodollars: null }),
      expect.objectContaining({ accountId: null, billing: 'unknown', costNanodollars: 0, listCostNanodollars: null }),
    ])
  })

  test('after account failover, each turn is billed to the account that answered it', async () => {
    selection.selectAccount('anthropic', 'claude-code')
    emit(turn('anthropic', sonnet.id, 0))
    // The failover controller rotates the session's selected account (model-failover.ts).
    selection.selectAccount('anthropic', 'console')
    emit(turn('anthropic', sonnet.id, 3))
    // Provider failover selects the next provider's account the same way.
    selection.selectAccount('openai-codex', 'chatgpt')
    emit(turn('openai-codex', 'gpt-5.5', 1))
    await flushInferenceUsage()
    expect(rows().map((row) => [row.provider, row.accountId, row.billing, row.costNanodollars])).toEqual([
      ['anthropic', 'claude-code', 'subscription', 0],
      ['anthropic', 'console', 'api', 3_000_000_000],
      ['openai-codex', 'chatgpt', 'subscription', 0],
    ])
  })
})
