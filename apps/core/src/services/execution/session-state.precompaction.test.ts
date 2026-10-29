import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test'
import {
  registerSession,
  removeSession,
  isSessionActive,
  shutdownActiveSessions,
  resetWorkerShuttingDownForTests,
  precompactionLifecycleSink,
  type ActiveSession,
} from './session-state'
import { StreamBuffer } from '../streaming/buffer'
import { AgentSession } from '../../entities/AgentSession'
import {
  bindPrecompactionController,
  getPrecompactionController,
  __resetPrecompactionRegistryForTests,
} from '../agent/precompaction/registry'
import type { PrecompactionDeps } from '../agent/precompaction/controller'

const registeredAgents: string[] = []

beforeEach(() => {
  __resetPrecompactionRegistryForTests()
})

afterEach(() => {
  for (const agentId of registeredAgents.splice(0)) removeSession(agentId)
  resetWorkerShuttingDownForTests()
})

// StreamBuffer takes no constructor arg; reads happen via subscribe() (which
// also returns catch-up events). Subscribe BEFORE pushing so the collector sees it.
function activeWithBuffer(agentId: string) {
  const buffer = new StreamBuffer()
  const events: any[] = []
  buffer.subscribe((e) => events.push(e))
  registerSession(agentId, {
    session: { dispose() {} } as any,
    collector: {} as any,
    buffer,
    agentId,
    executionId: 'exec',
  })
  return events
}

// Fake PrecompactionDeps for testing controller lifecycle.
function createFakeDeps(): PrecompactionDeps {
  return {
    getContextUsage: () => undefined,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 1, keepRecentTokens: 1 }),
    isCompacting: () => false,
    snapshot: () => ({ entries: [], latestCompactionEntryId: null }),
    getModelKey: () => 'm',
    bake: async () => null,
    marginTokens: 1,
    inFlightMarginTokens: 1,
  }
}

describe('precompactionLifecycleSink', () => {
  afterEach(() => {
    removeSession('agent-1')
    removeSession('agent-2')
  })

  it('pushes lifecycle outcomes so a failed start does not appear to stay in flight', () => {
    const events = activeWithBuffer('agent-1')
    const stats = {
      contextTokens: 1,
      contextWindow: 2,
      reserveTokens: 1,
      earlyMarginTokens: 1,
    }

    precompactionLifecycleSink('agent-1', { kind: 'started', ...stats })
    precompactionLifecycleSink('agent-1', { kind: 'succeeded', ...stats, elapsedMs: 2 })
    precompactionLifecycleSink('agent-1', { kind: 'failed', ...stats, elapsedMs: 3, error: 'boom' })
    precompactionLifecycleSink('agent-1', { kind: 'aborted', ...stats, elapsedMs: 4 })
    precompactionLifecycleSink('agent-1', { kind: 'superseded', ...stats, elapsedMs: 5 })
    precompactionLifecycleSink('agent-1', { kind: 'consumed', firstKeptEntryId: 'keep' })
    precompactionLifecycleSink('agent-1', { kind: 'rejected', reason: 'prefix' })

    expect(events).toEqual([
      { type: 'system_message', text: 'Precompaction started' },
      { type: 'system_message', text: 'Precompaction finished' },
      { type: 'system_message', text: 'Precompaction failed' },
      { type: 'system_message', text: 'Precompaction cancelled' },
      { type: 'system_message', text: 'Precompaction stopped — compacting now' },
    ])
  })

  it('is a no-op (log only) when the agent has no active session', () => {
    expect(() =>
      precompactionLifecycleSink('absent-agent', { kind: 'consumed', firstKeptEntryId: 'keep' })
    ).not.toThrow()
  })

  it('does not push log-only kinds even when a session is live', () => {
    const events = activeWithBuffer('agent-2')
    precompactionLifecycleSink('agent-2', { kind: 'rejected', reason: 'prefix' })
    expect(events.length).toBe(0)
  })
})

describe('removeSession disposes pre-compaction resources', () => {
  it('calls dispose() on the active session wrapper before deleting it', () => {
    const agentId = 'agent-precompaction-dispose'
    const dispose = mock(() => {})

    registeredAgents.push(agentId)
    registerSession(agentId, {
      session: { dispose },
      agentId,
      executionId: 'execution-precompaction-dispose',
      collector: {},
      buffer: {},
    } as unknown as ActiveSession)

    removeSession(agentId)

    expect(dispose).toHaveBeenCalledTimes(1)
    expect(isSessionActive(agentId)).toBe(false)
  })

  it('calls dispose() on active session wrappers during worker shutdown teardown', async () => {
    const agentId = 'agent-precompaction-shutdown-dispose'
    const unrelatedAgentId = 'agent-precompaction-unrelated-active'
    const dispose = mock(() => {})
    const abort = mock(async () => {})
    const unrelatedDispose = mock(() => {})
    const unrelatedAbort = mock(async () => {})

    registeredAgents.push(agentId, unrelatedAgentId)
    registerSession(agentId, {
      session: { dispose, pi: { abort } },
      agentId,
      executionId: 'execution-precompaction-shutdown-dispose',
      collector: {},
      buffer: {},
    } as unknown as ActiveSession)
    registerSession(unrelatedAgentId, {
      session: { dispose: unrelatedDispose, pi: { abort: unrelatedAbort } },
      agentId: unrelatedAgentId,
      executionId: 'execution-precompaction-unrelated-active',
      collector: {},
      buffer: {},
    } as unknown as ActiveSession)

    const executionIds = await shutdownActiveSessions({ settleDelayMs: 0, agentIds: [agentId] })

    expect(executionIds).toEqual(['execution-precompaction-shutdown-dispose'])
    expect(abort).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(isSessionActive(agentId)).toBe(false)
    expect(unrelatedAbort).not.toHaveBeenCalled()
    expect(unrelatedDispose).not.toHaveBeenCalled()
    expect(isSessionActive(unrelatedAgentId)).toBe(true)
  })
})

describe('removeSession disposes AgentSession but NOT the precompaction controller', () => {
  it('removes the session wrapper while preserving the registry controller through teardown', () => {
    const agentId = 'agent-removesession'
    const fakeDeps = createFakeDeps()
    const controller = bindPrecompactionController(agentId, fakeDeps)!
    const wrapper = new AgentSession({} as never)
    wrapper.attachPrecompaction(controller)

    registeredAgents.push(agentId)
    registerSession(agentId, {
      session: wrapper,
      collector: {} as any,
      buffer: new StreamBuffer(),
      agentId,
      executionId: 'exec-rm',
    })

    removeSession(agentId) // → wrapper.dispose() → must NOT dispose the controller

    const survived = getPrecompactionController(agentId)
    expect(survived).toBe(controller)
    expect(survived?.isDisposed()).toBe(false)
    expect(wrapper.precompaction).toBeUndefined()
  })
})
