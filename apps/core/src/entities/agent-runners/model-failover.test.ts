import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { ModelFailoverCoordinator, type ModelFailoverDeps } from './model-failover'
import { providerHealth, resetProviderHealthForTests } from '../../services/provider-health/registry'
import * as modelSelection from '../../services/model-selection'

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
