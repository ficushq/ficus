import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { ModelFailoverCoordinator, type ModelFailoverDeps } from './model-failover'
import { providerHealth, resetProviderHealthForTests } from '../../services/provider-health/registry'
import * as modelSelection from '../../services/model-selection'
import * as accountStore from '../../services/agent/account-store'
import * as accountSelection from '../../services/agent/account-selection'
import { CLAUDE_CODE_ACCOUNT_ID } from '../../services/agent/claude-code/account'
import { describeClaudeCodeFailure } from '../../services/agent/claude-code/failures'
import { routeFailure } from '../../services/execution/failure-routing'

function makeDeps(overrides: Partial<ModelFailoverDeps> = {}): ModelFailoverDeps {
  return {
    agentId: 'agent-1',
    executionId: 'exec-1',
    getSession: () => {
      throw new Error('session not needed in this test')
    },
    getBuffer: () => {
      throw new Error('buffer not needed in this test')
    },
    getCollector: () => {
      throw new Error('collector not needed in this test')
    },
    resendPrompt: async () => {},
    isTransportReplaySafe: () => true,
    ...overrides,
  }
}

describe('ModelFailoverCoordinator', () => {
  beforeEach(() => resetProviderHealthForTests())

  it('beginTurn captures the list and selected spec', async () => {
    const c = new ModelFailoverCoordinator(makeDeps())
    await c.beginTurn('anthropic:claude-sonnet-4-5,zai:glm-5-turbo', 'anthropic:claude-sonnet-4-5')
    expect(c.priorityList).toBe('anthropic:claude-sonnet-4-5,zai:glm-5-turbo')
    expect(c.currentSelectedSpec).toBe('anthropic:claude-sonnet-4-5')
  })

  it('attempt returns false for an unclassified error', async () => {
    const c = new ModelFailoverCoordinator(makeDeps())
    await c.beginTurn('anthropic:claude-sonnet-4-5', 'anthropic:claude-sonnet-4-5')
    expect(await c.attempt('some random unrelated failure')).toBe(false)
  })

  it('guards Ficus internal errors at the failover site before session access or mutation', async () => {
    let sessionRead = false
    const c = new ModelFailoverCoordinator(
      makeDeps({
        getSession: () => {
          sessionRead = true
          throw new Error('must not read session')
        },
        classifyError: () => ({ kind: 'capacity' }),
      })
    )
    await c.beginTurn('anthropic:claude-sonnet-4-5', 'anthropic:claude-sonnet-4-5')

    for (const message of [
      'Execution session capacity reservation was refused',
      'Admission effect was refused by the durable fence',
      'Admission effect fence was revoked',
      'Admission effect was revoked or superseded',
      'Sandbox provisioning failed',
      'Sandbox provisioning was cancelled',
      'Sandbox provisioning result expired',
    ]) {
      expect(await c.attempt(new Error(message))).toBe(false)
    }
    expect(sessionRead).toBe(false)
    expect(providerHealth.snapshotRecords()).toEqual([])
  })

  it('attempt returns false before beginTurn (no list/spec captured)', async () => {
    const c = new ModelFailoverCoordinator(makeDeps())
    expect(await c.attempt('rate limit exceeded')).toBe(false)
  })

  it('fails over a replay-safe transport failure exactly once', async () => {
    const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
      selected: 'zai:glm-5-turbo',
      candidates: [],
    })
    const setModelCalls: unknown[] = []
    let resendCount = 0
    const session = {
      accountId: undefined,
      authBackend: undefined,
      pi: {
        getContextUsage: () => undefined,
        setModel: async (model: unknown) => setModelCalls.push(model),
        setThinkingLevel: () => {},
      },
    }
    const c = new ModelFailoverCoordinator(
      makeDeps({
        getSession: () => session as never,
        getBuffer: () => ({ push: () => {} }) as never,
        getCollector: () => ({ reset: () => {} }) as never,
        resendPrompt: async () => {
          resendCount += 1
        },
        isTransportReplaySafe: () => true,
      })
    )
    await c.beginTurn('anthropic:claude-sonnet-4-5,zai:glm-5-turbo', 'anthropic:claude-sonnet-4-5')

    expect(await c.attempt('The socket connection was closed unexpectedly')).toBe(true)
    expect(setModelCalls).toHaveLength(1)
    expect(resendCount).toBe(1)
    selection.mockRestore()
  })

  it('defers an unsafe transport failure without mutating the live session', async () => {
    let sessionRead = false
    let resent = false
    const c = new ModelFailoverCoordinator(
      makeDeps({
        getSession: () => {
          sessionRead = true
          throw new Error('must not read session')
        },
        resendPrompt: async () => {
          resent = true
        },
        isTransportReplaySafe: () => false,
      })
    )
    await c.beginTurn('anthropic:claude-sonnet-4-5,zai:glm-5-turbo', 'anthropic:claude-sonnet-4-5')

    expect(await c.attempt('The socket connection was closed unexpectedly')).toBe(false)
    expect(sessionRead).toBe(false)
    expect(resent).toBe(false)
  })
})

it('moves a Claude Code session-limit failure to the next Codex model and cools only that account', async () => {
  resetProviderHealthForTests()
  const next = 'openai-codex:gpt-6-sol'
  const codex = { id: 'codex-test', enabled: true, credential: { type: 'api_key' as const, key: 'test' } }
  const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
    selected: next,
    candidates: [],
  })
  const read = spyOn(accountStore, 'readAccountStore').mockReturnValue({ version: 1, accounts: {} })
  const mutate = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
  const selectAccount = spyOn(accountSelection, 'selectAccount').mockImplementation((provider) =>
    provider === 'openai-codex' ? codex : null
  )
  const modelCalls: unknown[] = []
  const authCalls: string[] = []
  const events: any[] = []
  let resent = 0
  const session = {
    accountId: CLAUDE_CODE_ACCOUNT_ID,
    authBackend: { selectAccount: (provider: string, id: string) => authCalls.push(`${provider}:${id}`) },
    pi: {
      getContextUsage: () => undefined,
      setModel: async (model: unknown) => {
        modelCalls.push(model)
      },
      setThinkingLevel: () => {},
    },
  }
  const coordinator = new ModelFailoverCoordinator(
    makeDeps({
      getSession: () => session as never,
      getBuffer: () => ({ push: (event: unknown) => events.push(event) }) as never,
      getCollector: () => ({ reset: () => {} }) as never,
      resendPrompt: async () => {
        resent++
      },
    })
  )
  try {
    await coordinator.beginTurn(`anthropic:claude-sonnet-5,${next}`, 'anthropic:claude-sonnet-5')
    expect(await coordinator.attempt("You've hit your session limit · resets 2:20am (UTC)")).toBe(true)
    expect(coordinator.currentSelectedSpec).toBe(next)
    expect(modelCalls).toHaveLength(1)
    expect(resent).toBe(1)
    expect(session.accountId).toBe('codex-test')
    expect(authCalls).toEqual(['openai-codex:codex-test'])
    expect(providerHealth.getRecord('anthropic', CLAUDE_CODE_ACCOUNT_ID)?.kind).toBe('plan-credit')
    expect(providerHealth.getRecord('anthropic', CLAUDE_CODE_ACCOUNT_ID)?.retryAt).toBeGreaterThan(Date.now())
    expect(providerHealth.getRecord('anthropic')).toBeUndefined()
    expect(
      events.some((event) => event.type === 'system_message' && event.text.includes(`failed over to ${next}`))
    ).toBe(true)
  } finally {
    selection.mockRestore()
    read.mockRestore()
    mutate.mockRestore()
    selectAccount.mockRestore()
    resetProviderHealthForTests()
  }
})

it('moves a revoked ChatGPT sign-in to the next model and parks only that account until re-authorized', async () => {
  resetProviderHealthForTests()
  const next = 'anthropic:claude-opus-5-5'
  const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockReturnValue({
    selected: next,
    candidates: [],
  })
  const read = spyOn(accountStore, 'readAccountStore').mockReturnValue({ version: 1, accounts: {} })
  const mutate = spyOn(accountStore, 'mutateAccountStore').mockResolvedValue(undefined)
  const selectAccount = spyOn(accountSelection, 'selectAccount').mockReturnValue(null)
  const events: any[] = []
  let resent = 0
  const session = {
    accountId: 'acc_chatgpt',
    authBackend: { selectAccount: () => {} },
    pi: { getContextUsage: () => undefined, setModel: async () => {}, setThinkingLevel: () => {} },
  }
  const coordinator = new ModelFailoverCoordinator(
    makeDeps({
      getSession: () => session as never,
      getBuffer: () => ({ push: (event: unknown) => events.push(event) }) as never,
      getCollector: () => ({ reset: () => {} }) as never,
      resendPrompt: async () => {
        resent++
      },
    })
  )
  try {
    await coordinator.beginTurn(`openai-codex:gpt-6-astra,${next}`, 'openai-codex:gpt-6-astra')
    expect(
      await coordinator.attempt('Your authentication token has been invalidated. Please try signing in again.')
    ).toBe(true)
    expect(coordinator.currentSelectedSpec).toBe(next)
    expect(resent).toBe(1)
    expect(providerHealth.getRecord('openai-codex', 'acc_chatgpt')?.kind).toBe('expired-oauth')
    expect(providerHealth.getRecord('openai-codex')).toBeUndefined()
    const notice = events.find((event) => event.type === 'system_message')?.text
    expect(notice).toBe(
      `openai-codex sign-in expired or was revoked — failed over to ${next}. Re-authorize it in Settings → AI Providers.`
    )
  } finally {
    selection.mockRestore()
    read.mockRestore()
    mutate.mockRestore()
    selectAccount.mockRestore()
    resetProviderHealthForTests()
  }
})

for (const fallback of [true, false]) {
  it(`weekly Claude Code exhaustion ${fallback ? 'fails over once' : 'stops without fallback'} and preserves account reset`, async () => {
    resetProviderHealthForTests()
    // The singleton health registry owns its real clock. Keep this reset in the
    // future; the classifier/bridge tests pin the exact reported Oct 6 fixture.
    const now = Date.now()
    const reset = new Date(now + 5 * 24 * 60 * 60_000)
    reset.setUTCHours(6, 0, 0, 0)
    const date = reset.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    const clock = spyOn(Date, 'now').mockReturnValue(now)
    const next = 'openai-codex:gpt-6-astra:high'
    const current = 'anthropic:claude-sonnet-5'
    const selection = spyOn(modelSelection, 'selectModelSpecForCurrentEnv').mockImplementation(() => {
      if (!fallback) throw new Error('No usable model: provider exhausted')
      return { selected: next, candidates: [] }
    })
    const read = spyOn(accountStore, 'readAccountStore').mockReturnValue({ version: 1, accounts: {} })
    const selectAccount = spyOn(accountSelection, 'selectAccount').mockReturnValue(null)
    const modelCalls: unknown[] = []
    const events: any[] = []
    let resent = 0
    const session = {
      accountId: CLAUDE_CODE_ACCOUNT_ID as string | undefined,
      authBackend: { selectAccount: () => {} },
      pi: {
        getContextUsage: () => undefined,
        setModel: async (model: unknown) => {
          modelCalls.push(model)
        },
        setThinkingLevel: () => {},
      },
    }
    const coordinator = new ModelFailoverCoordinator(
      makeDeps({
        getSession: () => session as never,
        getBuffer: () => ({ push: (event: unknown) => events.push(event) }) as never,
        getCollector: () => ({ reset: () => {} }) as never,
        resendPrompt: async () => {
          resent++
        },
      })
    )
    try {
      await coordinator.beginTurn(fallback ? `${current},${next}` : current, current)
      const error = describeClaudeCodeFailure(`You've hit your weekly limit · resets ${date}, 6am (UTC)`, 'rate_limit')
      expect(await coordinator.attempt(error)).toBe(fallback)
      expect(coordinator.currentSelectedSpec).toBe(fallback ? next : current)
      expect(modelCalls).toHaveLength(fallback ? 1 : 0)
      expect(resent).toBe(fallback ? 1 : 0)
      expect(providerHealth.getRecord('anthropic', CLAUDE_CODE_ACCOUNT_ID)).toMatchObject({
        kind: 'plan-credit',
        retryAt: reset.getTime(),
      })
      expect(providerHealth.isAccountHealthy('anthropic', CLAUDE_CODE_ACCOUNT_ID)).toBe(false)
      expect(providerHealth.getRecord('anthropic')).toBeUndefined()
      if (fallback) {
        const mins = Math.round((reset.getTime() - now) / 60_000)
        expect(events[0]?.text).toBe(`Provider anthropic exhausted — failed over to ${next}. (retry in ~${mins}m)`)
      } else {
        expect(events).toHaveLength(0)
        expect(routeFailure(error).disposition).toMatchObject({ status: 'waiting-input' })
      }
    } finally {
      clock.mockRestore()
      selection.mockRestore()
      read.mockRestore()
      selectAccount.mockRestore()
      resetProviderHealthForTests()
    }
  })
}
