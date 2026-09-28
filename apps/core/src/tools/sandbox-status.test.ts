import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents, squads } from '../db/schema'
import * as factory from '../services/sandbox/factory'
import { Agent } from '../entities/Agent'
import { createSandboxStatusTool, type SandboxStatusDeps } from './sandbox-status'

function makeDeps(
  statusBySandboxId: Record<
    string,
    {
      status: string
      reason?: string
      devboxReady?: boolean
      readiness?: 'ready' | 'ready_degraded'
      degradation?: { reasons: string[]; attemptCount: number; nextAttemptAt?: string }
      toolchain?: { status: string; reason?: string }
    }
  >,
  opts: { watched?: boolean } = {}
) {
  const queried: string[] = []
  const deps: SandboxStatusDeps = {
    getLiveStatus: async (sandboxId) => {
      queried.push(sandboxId)
      return statusBySandboxId[sandboxId] ?? { status: 'not_found' }
    },
    isWatched: async () => opts.watched ?? false,
  }
  return { deps, queried }
}

async function run(tool: ReturnType<typeof createSandboxStatusTool>) {
  const result = await tool.execute('call-1', {}, undefined as never, undefined as never, undefined as never)
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n')
  return { result, text }
}

describe('createSandboxStatusTool', () => {
  it('reports the private box as ready when running and devbox-ready', async () => {
    const { deps, queried } = makeDeps({ agent_a1: { status: 'running', devboxReady: true } })
    const tool = createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps)

    const { text } = await run(tool)

    expect(queried).toEqual(['agent_a1'])
    expect(text).toContain('agent_a1')
    expect(text).toContain('ready')
  })

  it('checks both boxes for squad members and reports a dead squad box with its reason', async () => {
    const { deps, queried } = makeDeps({
      agent_a1: { status: 'running', devboxReady: true },
      squad_s1: { status: 'failed', reason: 'OOMKilled' },
    })
    const tool = createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1', squadId: 's1' }, deps)

    const { text } = await run(tool)

    expect(queried.sort()).toEqual(['agent_a1', 'squad_s1'])
    expect(text).toContain('squad_s1')
    expect(text).toContain('down')
    expect(text).toContain('OOMKilled')
  })

  it('reports durable degraded setup with a safe reason', async () => {
    const { deps } = makeDeps({
      agent_a1: {
        status: 'running',
        devboxReady: false,
        readiness: 'ready_degraded',
        degradation: { reasons: ['devbox_unavailable'], attemptCount: 3 },
      },
    })
    const { text } = await run(createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps))
    expect(text).toContain('running — setup degraded')
    expect(text).toContain('Devbox comfort tools unavailable')
  })

  it('reports a running-but-installing box distinctly', async () => {
    const { deps } = makeDeps({ agent_a1: { status: 'running', devboxReady: false } })
    const tool = createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps)

    const { text } = await run(tool)

    expect(text).toContain('installing packages')
  })

  it('reports managed toolchain progress and safe failures distinctly', async () => {
    for (const [status, wording] of [
      ['pending', 'toolchain pending'],
      ['running_setup', 'running setup'],
      ['failed', 'toolchain failed (Package installation failed)'],
    ] as const) {
      const { deps } = makeDeps({
        agent_a1: {
          status: 'running',
          devboxReady: false,
          toolchain: { status, ...(status === 'failed' ? { reason: 'Package installation failed' } : {}) },
        },
      })
      const { text } = await run(createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps))
      expect(text).toContain(wording)
    }
  })

  it.each([
    [
      { status: 'not_found', reason: 'sandbox missing', toolchain: { status: 'pending' } },
      'down (not_found, reason: sandbox missing); toolchain pending',
    ],
    [
      { status: 'failed', reason: 'OOMKilled', toolchain: { status: 'installing' } },
      'down (failed, reason: OOMKilled); installing packages',
    ],
    [
      { status: 'starting', reason: 'box is provisioning', toolchain: { status: 'failed', reason: 'install failed' } },
      'starting (box is provisioning); toolchain failed (install failed)',
    ],
  ])('keeps physical lifecycle primary while retaining toolchain diagnostics', async (status, wording) => {
    const { deps } = makeDeps({ agent_a1: status })
    const { text } = await run(createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps))
    expect(text).toContain(wording)
  })

  it('covers physical not_found, failed, starting, and running against every durable toolchain state', async () => {
    const toolchains = [
      ['pending', 'toolchain pending'],
      ['installing', 'installing packages'],
      ['failed', 'toolchain failed (install failed)'],
      ['ready', ''],
    ] as const
    for (const [physical, primary] of [
      ['not_found', 'down (not_found, reason: physical reason)'],
      ['failed', 'down (failed, reason: physical reason)'],
      ['starting', 'starting (physical reason)'],
    ] as const) {
      for (const [toolchain, detail] of toolchains) {
        const { deps } = makeDeps({
          agent_a1: {
            status: physical,
            reason: 'physical reason',
            toolchain: { status: toolchain, ...(toolchain === 'failed' ? { reason: 'install failed' } : {}) },
          },
        })
        const { text } = await run(createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps))
        expect(text).toContain(detail ? `${primary}; ${detail}` : primary)
      }
    }
    for (const [toolchain, primary] of toolchains) {
      const { deps } = makeDeps({
        agent_a1: {
          status: 'running',
          devboxReady: true,
          toolchain: { status: toolchain, ...(toolchain === 'failed' ? { reason: 'install failed' } : {}) },
        },
      })
      const { text } = await run(createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps))
      expect(text).toContain(toolchain === 'ready' ? 'ready' : primary)
    }
  })

  it('mentions the pending recovery notification when a watch is active', async () => {
    const { deps } = makeDeps({ agent_a1: { status: 'failed', reason: 'OOMKilled' } }, { watched: true })
    const tool = createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' }, deps)

    const { text } = await run(tool)

    expect(text).toContain('notified')
  })
})

describe('sandbox_status defaultDeps runtime gate', () => {
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  it('(vm runtime) combines the live VM status with toolchain state without ambient prefix lookup', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const squadId = randomUUID()
    const agentId = randomUUID()
    const sandboxId = `agent_${agentId}`
    await db.insert(squads).values({
      id: squadId,
      name: 'Sandbox status isolation',
      purpose: 'test',
      metadata: { sandbox: { toolchain: { packages: ['python3@latest'] } } },
    })
    await db.insert(agents).values({ id: agentId, agentTypeId: 'engineer', squadId })
    try {
      const fakeVmManager = {
        getSandboxStatus: async (_id: string) => ({ status: 'starting', reason: 'box is provisioning' }),
        hasSandbox: () => true,
      }
      spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeVmManager as any))

      const result = await createSandboxStatusTool({ agentId, sandboxId }).execute(
        'call-1',
        {},
        undefined as never,
        undefined as never,
        undefined as never
      )
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n')

      expect(result.details).toMatchObject({
        [sandboxId]: { status: 'starting', reason: 'box is provisioning', toolchain: { status: 'pending' } },
      })
      expect(text).toContain('toolchain pending')
    } finally {
      await db.delete(agents).where(eq(agents.id, agentId))
      await db.delete(squads).where(eq(squads.id, squadId))
    }
  })

  it('(toolchain lookup fails) still reports the live physical status, not "down (unknown)"', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const fakeVmManager = {
      getSandboxStatus: async (_id: string) => ({ status: 'starting', reason: 'box is provisioning' }),
      hasSandbox: () => true,
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeVmManager as any))
    // Agent.find prefix-matches, so a populated database can raise
    // AmbiguousPrefixError for a short sandbox id. The managed-toolchain
    // decoration must never be able to destroy the physical answer.
    spies.push(
      spyOn(Agent, 'find').mockImplementation(async () => {
        throw new Error('Ambiguous agent prefix')
      })
    )

    const tool = createSandboxStatusTool({ agentId: 'a1', sandboxId: 'agent_a1' })
    const result = await tool.execute('call-1', {}, undefined as never, undefined as never, undefined as never)
    const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n')

    expect(text).toContain('starting')
    expect(text).toContain('box is provisioning')
    expect(text).not.toContain('unknown')
  })
})
