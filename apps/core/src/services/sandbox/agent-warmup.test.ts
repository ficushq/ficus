import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as ensureModule from './ensure'
import * as skillModule from '../agent/skill-materializer'
import * as identityModule from '../amtp/agent-identity'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { Agent } from '../../entities/Agent'
import { makeDormant } from '../agent/lifecycle'
import { agents, db } from '../../db'
import { eq } from 'drizzle-orm'
import type { AgentStatus } from '@ficus/shared'
import { ensureAgentSandbox, setAgentWarmupLifecycleLoaderForTest } from './agent-warmup'
import * as factory from './factory'

const restores: Array<{ mockRestore: () => void }> = []
beforeEach(() => {
  setAgentWarmupLifecycleLoaderForTest(async () => ({
    status: 'idle',
    metadata: { resourceGeneration: 'test-generation' },
  }))
})
afterEach(() => {
  setAgentWarmupLifecycleLoaderForTest(undefined)
  while (restores.length) restores.pop()!.mockRestore()
})

function stubSkills() {
  const s = spyOn(skillModule, 'materializeSandboxSkills').mockResolvedValue([])
  restores.push(s)
}

function sharedSystemManagerAgent(id: string, userId: string) {
  return {
    id,
    parentAgentId: null,
    squadId: null,
    ownerUserId: userId,
    agentTypeId: 'system-manager',
    getSandboxId: async () => `system_manager_${userId}`,
    getAgentType: async () => ({ skills: [] }),
  } as any
}

function soloAgent(id: string) {
  return {
    id,
    parentAgentId: null,
    squadId: null,
    agentTypeId: 'system-manager',
    getSandboxId: async () => `agent_${id}`,
    getAgentType: async () => ({ skills: [] }),
  } as any
}

function squadAgent(id: string, squadId: string) {
  return {
    id,
    parentAgentId: null,
    squadId,
    agentTypeId: 'flex',
    getSandboxId: async () => `agent_${id}`,
    getAgentType: async () => ({ skills: [] }),
  } as any
}

function soloNonSystemManagerAgent(id: string) {
  return {
    id,
    parentAgentId: null,
    squadId: null,
    agentTypeId: 'flex',
    getSandboxId: async () => `agent_${id}`,
    getAgentType: async () => ({ skills: [] }),
  } as any
}

describe('ensureAgentSandbox', () => {
  test('subagent: no ensure, returns skipped-subagent', async () => {
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(ws)
    const result = await ensureAgentSandbox({ parentAgentId: 'parent' } as any)
    expect(result).toBe('skipped-subagent')
    expect(ws).not.toHaveBeenCalled()
  })

  test('dormant owner: rejects before any constructive ensure', async () => {
    setAgentWarmupLifecycleLoaderForTest(async () => ({
      status: 'dormant',
      metadata: { resourceGeneration: 'dormant-generation' },
    }))
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(ws)

    await expect(ensureAgentSandbox(soloAgent('dormant-owner'))).resolves.toBe('skipped-agent-unavailable')
    expect(ws).not.toHaveBeenCalled()
  })

  test('solo agent: ensures the per-agent box without squadId', async () => {
    stubSkills()
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(ws)
    const result = await ensureAgentSandbox(soloAgent('s1'))
    expect(result).toBe('ensured')
    expect(ws).toHaveBeenCalledTimes(1)
    expect((ws.mock.calls[0][0] as any).squadId).toBeUndefined()
    expect((ws.mock.calls[0][0] as any).sandboxId).toBe('agent_s1')
  })

  test('shared system-manager ensure ignores per-agent generation while keeping the owner live guard', async () => {
    stubSkills()
    setAgentWarmupLifecycleLoaderForTest(async () => ({
      status: 'idle',
      metadata: { resourceGeneration: 'owner-generation' },
    }))
    let tracked = false
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async (input) => {
      input.onLifecycleGenerationResolved?.(undefined)
      tracked = true
      return '/private'
    })
    const manager = {
      stopSandbox: async () => {
        tracked = false
      },
      execStatus: async () => (tracked ? 0 : 1),
    }
    const stop = spyOn(manager, 'stopSandbox')
    const getManager = spyOn(factory, 'getSandboxManager').mockReturnValue(manager as any)
    restores.push(ws, stop, getManager)

    await expect(ensureAgentSandbox(sharedSystemManagerAgent('manager-id', 'user-id'))).resolves.toBe('ensured')
    expect(stop).not.toHaveBeenCalled()
    expect(await manager.execStatus()).toBe(0)
  })

  test('solo NON-system-manager agent: ensures per-agent box AND federation identity, identity FIRST', async () => {
    // Regression coverage gap: soloAgent() above is agentTypeId: 'system-manager',
    // which skips identity entirely — there was no case covering a solo agent
    // that actually gets one. Also asserts ORDER: identity must be generated on
    // the host BEFORE ensureWorkspaceSandbox runs the manifest sync, so the vm
    // push transport never misses a freshly-generated identity.pem on its first
    // sync (the root cause of #788 was identity never being generated at all
    // for agents that never hit a warmup trigger; this call order is the
    // secondary ordering fix on the warmup path itself).
    stubSkills()
    const order: string[] = []
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async () => {
      order.push('ensureWorkspaceSandbox')
      return '/w'
    })
    const identity = spyOn(identityModule, 'ensureAgentIdentity').mockImplementation(async () => {
      order.push('ensureAgentIdentity')
      return 'pub' as any
    })
    restores.push(ws, identity)
    const result = await ensureAgentSandbox(soloNonSystemManagerAgent('s3'))
    expect(result).toBe('ensured')
    expect(identity).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['ensureAgentIdentity', 'ensureWorkspaceSandbox'])
  })

  test('squad agent on active squad: ensures squad + per-agent box + federation identity, identity FIRST', async () => {
    stubSkills()
    const find = spyOn(Squad, 'find').mockResolvedValue({ id: 'sq', status: 'active', metadata: {} } as any)
    restores.push(find)
    const sq = spyOn(ensureModule, 'ensureSquadSandbox').mockResolvedValue('/sq')
    const order: string[] = []
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async () => {
      order.push('ensureWorkspaceSandbox')
      return '/w'
    })
    const identity = spyOn(identityModule, 'ensureAgentIdentity').mockImplementation(async () => {
      order.push('ensureAgentIdentity')
      return 'pub' as any
    })
    restores.push(sq, ws, identity)
    const result = await ensureAgentSandbox(squadAgent('a1', 'sq'))
    expect(result).toBe('ensured')
    expect(sq).toHaveBeenCalledTimes(1)
    expect((ws.mock.calls[0][0] as any).squadId).toBe('sq')
    // Non-system-manager squad agents get a per-agent federation identity,
    // generated on the host BEFORE ensureWorkspaceSandbox runs the manifest
    // sync (so the vm push transport never misses it on the first sync).
    expect(identity).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['ensureAgentIdentity', 'ensureWorkspaceSandbox'])
  })

  test('system-manager on active squad: ensures box but skips federation identity', async () => {
    stubSkills()
    const find = spyOn(Squad, 'find').mockResolvedValue({ id: 'sq', status: 'active', metadata: {} } as any)
    const sq = spyOn(ensureModule, 'ensureSquadSandbox').mockResolvedValue('/sq')
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    const identity = spyOn(identityModule, 'ensureAgentIdentity').mockResolvedValue('pub' as any)
    restores.push(find, sq, ws, identity)
    const smSquad = {
      id: 'm1',
      parentAgentId: null,
      squadId: 'sq',
      agentTypeId: 'system-manager',
      getSandboxId: async () => 'agent_m1',
      getAgentType: async () => ({ skills: [] }),
    } as any
    const result = await ensureAgentSandbox(smSquad)
    expect(result).toBe('ensured')
    expect(sq).toHaveBeenCalledTimes(1)
    // System-managers share one /private per user → no per-agent identity, even with a squadId.
    expect(identity).not.toHaveBeenCalled()
  })

  test('squad agent on inactive squad: returns skipped-squad-inactive, no ensure', async () => {
    stubSkills()
    const find = spyOn(Squad, 'find').mockResolvedValue({ id: 'sq', status: 'archived', metadata: {} } as any)
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(find, ws)
    const result = await ensureAgentSandbox(squadAgent('a2', 'sq'))
    expect(result).toBe('skipped-squad-inactive')
    expect(ws).not.toHaveBeenCalled()
  })

  test('all bound work streams queued: no ensure, returns skipped-work-stream-queued', async () => {
    stubSkills()
    const list = spyOn(WorkStream, 'listForAgent').mockResolvedValue([{ status: 'queued' } as any])
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(list, ws)
    const result = await ensureAgentSandbox(soloAgent('gated1'))
    expect(result).toBe('skipped-work-stream-queued')
    expect(ws).not.toHaveBeenCalled()
    // The gate queried both admitted and queued statuses for the agent.
    expect(list.mock.calls[0][0]).toBe('gated1')
    expect(list.mock.calls[0][1]).toContain('queued')
    expect(list.mock.calls[0][1]).toContain('active')
  })

  test('one admitted + one queued stream: box is still ensured (dual-bound agent keeps its sandbox)', async () => {
    stubSkills()
    const list = spyOn(WorkStream, 'listForAgent').mockResolvedValue([
      { status: 'queued' } as any,
      { status: 'in_progress' } as any,
    ])
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(list, ws)
    const result = await ensureAgentSandbox(soloAgent('gated2'))
    expect(result).toBe('ensured')
    expect(ws).toHaveBeenCalledTimes(1)
  })

  test('cleans only its provisioned generation when dormancy wins during ensure', async () => {
    stubSkills()
    let status: AgentStatus = 'idle'
    setAgentWarmupLifecycleLoaderForTest(async () => ({
      status,
      metadata: { resourceGeneration: 'generation-a' },
    }))
    const ensureEntered = Promise.withResolvers<void>()
    const releaseEnsure = Promise.withResolvers<void>()
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async () => {
      ensureEntered.resolve()
      await releaseEnsure.promise
      return '/w'
    })
    const stopSandbox = spyOn({ stopSandbox: async () => ({ kind: 'stopped' as const }) }, 'stopSandbox')
    const manager = { stopSandbox }
    const getManager = spyOn(factory, 'getSandboxManager').mockReturnValue(manager as any)
    restores.push(ws, stopSandbox, getManager)

    const ensuring = ensureAgentSandbox(soloAgent('stale-warmup'))
    await ensureEntered.promise
    status = 'dormant'
    releaseEnsure.resolve()

    await expect(ensuring).resolves.toBe('skipped-agent-unavailable')
    expect(stopSandbox).toHaveBeenCalledWith('agent_stale-warmup', { lifecycleGeneration: 'generation-a' })
  })

  test('preserves a newly live generation selected authoritatively inside ensure', async () => {
    stubSkills()
    let generation = 'generation-a'
    setAgentWarmupLifecycleLoaderForTest(async () => ({ status: 'idle', metadata: { resourceGeneration: generation } }))
    const ensureEntered = Promise.withResolvers<void>()
    const releaseEnsure = Promise.withResolvers<void>()
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async (input) => {
      ensureEntered.resolve()
      await releaseEnsure.promise
      input.onLifecycleGenerationResolved?.('generation-b')
      return '/w'
    })
    const stopSandbox = spyOn({ stopSandbox: async () => ({ kind: 'stopped' as const }) }, 'stopSandbox')
    const getManager = spyOn(factory, 'getSandboxManager').mockReturnValue({ stopSandbox } as any)
    restores.push(ws, stopSandbox, getManager)

    const ensuring = ensureAgentSandbox(soloAgent('wake-wins'))
    await ensureEntered.promise
    generation = 'generation-b'
    releaseEnsure.resolve()

    await expect(ensuring).resolves.toBe('ensured')
    expect(stopSandbox).not.toHaveBeenCalled()
  })

  test('a dormancy teardown that wins during warmup leaves the real row dormant and the box stopped', async () => {
    setAgentWarmupLifecycleLoaderForTest(undefined)
    stubSkills()
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    const generation = (agent.metadata as Record<string, unknown>).resourceGeneration as string
    let provisionedGeneration: string | null = null
    const ensureEntered = Promise.withResolvers<void>()
    const releaseEnsure = Promise.withResolvers<void>()
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockImplementation(async () => {
      ensureEntered.resolve()
      await releaseEnsure.promise
      provisionedGeneration = generation
      return '/w'
    })
    const identity = spyOn(identityModule, 'ensureAgentIdentity').mockResolvedValue('pub' as any)
    const manager = {
      stopSandbox: async (_sandboxId: string, options?: { lifecycleGeneration?: string | null }) => {
        if (provisionedGeneration === null) return { kind: 'not-found' as const }
        if (options?.lifecycleGeneration === provisionedGeneration) {
          provisionedGeneration = null
          return { kind: 'stopped' as const }
        }
        return {
          kind: 'generation-mismatch' as const,
          actualLifecycleGeneration: provisionedGeneration,
        }
      },
    }
    const stop = spyOn(manager, 'stopSandbox')
    const getManager = spyOn(factory, 'getSandboxManager').mockReturnValue(manager as any)
    restores.push(ws, identity, stop, getManager)

    try {
      const ensuring = ensureAgentSandbox(agent)
      await ensureEntered.promise
      await makeDormant(agent)
      releaseEnsure.resolve()

      await expect(ensuring).resolves.toBe('skipped-agent-unavailable')
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(provisionedGeneration).toBeNull()
      expect(stop).toHaveBeenLastCalledWith(`agent_${agent.id}`, { lifecycleGeneration: generation })
    } finally {
      releaseEnsure.resolve()
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })

  test('gate read failure fails OPEN: warmup proceeds', async () => {
    stubSkills()
    const list = spyOn(WorkStream, 'listForAgent').mockRejectedValue(new Error('db down'))
    const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
    restores.push(list, ws)
    const result = await ensureAgentSandbox(soloAgent('gated4'))
    expect(result).toBe('ensured')
    expect(ws).toHaveBeenCalledTimes(1)
  })
})

test('consultant warmup shares a squad runtime without installing an agent key or using an individual machine pin', async () => {
  stubSkills()
  const owner = await Squad.create({ name: `shared-warmup-${crypto.randomUUID()}`, purpose: 'test' })
  const ws = spyOn(ensureModule, 'ensureWorkspaceSandbox').mockResolvedValue('/w')
  const sq = spyOn(ensureModule, 'ensureSquadSandbox').mockResolvedValue('/w')
  const identity = spyOn(identityModule, 'ensureAgentIdentity').mockResolvedValue('/identity')
  restores.push(ws, sq, identity)
  const agent = {
    ...squadAgent(crypto.randomUUID(), owner.id),
    agentTypeId: 'consultant',
    machineId: 'individual-machine',
    getSandboxId: async () => `consultants_${owner.id}`,
  }
  try {
    expect(await ensureAgentSandbox(agent)).toBe('ensured')
    expect(ws.mock.calls[0]?.[0]).toMatchObject({ sandboxId: `consultants_${owner.id}`, squadId: owner.id })
    expect(ws.mock.calls[0]?.[0].machineId).toBeUndefined()
    expect(identity).not.toHaveBeenCalled()
  } finally {
    const { squads } = await import('../../db')
    await db.delete(squads).where(eq(squads.id, owner.id))
  }
})
