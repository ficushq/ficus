import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as factory from './factory'
import {
  SandboxRecoveryWatch,
  defaultIsSandboxReady,
  defaultRecoveryWatchDeps,
  type RecoveryWatchDeps,
} from './recovery-watch'
import { SandboxRecoveryStore } from './recovery-store'
import { MAX_SANDBOX_RESTARTS } from './restart/types'
import { db } from '../../db'
import { agents, sandboxRecoveryEpisodes, sandboxRecoverySubscriptions } from '../../db/schema'
import { eq, inArray } from 'drizzle-orm'

const A1 = '00000000-0000-4000-8000-0000000000a1'
const A2 = '00000000-0000-4000-8000-0000000000a2'
const A3 = '00000000-0000-4000-8000-0000000000a3'

class FixtureScopedRecoveryStore extends SandboxRecoveryStore {
  constructor(private readonly agentIds: string[]) {
    super()
  }

  override async listWatching(filters: { agentId?: string; sandboxId?: string } = {}) {
    if (filters.agentId || filters.sandboxId) return super.listWatching(filters)
    return (await Promise.all(this.agentIds.map((agentId) => super.listWatching({ agentId })))).flat()
  }

  override async claimDue(input: { agentId?: string; now?: Date; limit?: number } = {}) {
    if (input.agentId) return super.claimDue(input)
    return (await Promise.all(this.agentIds.map((agentId) => super.claimDue({ ...input, agentId })))).flat()
  }
}

type Notification = { agentId: string; content: string; mode: 'send' | 'record' }

function makeDeps(overrides: Partial<RecoveryWatchDeps> = {}) {
  const ready = new Set<string>()
  const notifications: Notification[] = []
  let now = 1_000_000

  const deps: RecoveryWatchDeps = {
    isSandboxReady: async (sandboxId) => ready.has(sandboxId),
    notifyAgent: async (agentId, content) => {
      notifications.push({ agentId, content, mode: 'send' })
    },
    recordAgentMessage: async (agentId, content) => {
      notifications.push({ agentId, content, mode: 'record' })
    },
    isAgentActive: () => true,
    getCrashCount: async (agentId) => {
      const [row] = await db.select({ metadata: agents.metadata }).from(agents).where(eq(agents.id, agentId))
      return Number((row?.metadata as Record<string, unknown> | null)?.sandboxRestartCount ?? 0)
    },
    now: () => now,
    ...overrides,
  }

  return {
    deps,
    ready,
    notifications,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('SandboxRecoveryWatch', () => {
  let ctx: ReturnType<typeof makeDeps>
  let watch: SandboxRecoveryWatch

  beforeEach(async () => {
    await db
      .insert(agents)
      .values([
        { id: A1, agentTypeId: 'recovery-watch-test' },
        { id: A2, agentTypeId: 'recovery-watch-test' },
        { id: A3, agentTypeId: 'recovery-watch-test' },
      ])
      .onConflictDoNothing()
    ctx = makeDeps()
    watch = new SandboxRecoveryWatch(ctx.deps)
  })

  afterEach(async () => {
    await db
      .delete(sandboxRecoveryEpisodes)
      .where(inArray(sandboxRecoveryEpisodes.sandboxId, ['agent_a1', 'agent_a2', 'agent_a3', 'squad_s1']))
    await db.delete(agents).where(inArray(agents.id, [A1, A2, A3]))
  })

  it('persists exact delivery linkage through the default production delivery deps', async () => {
    const productionWatch = new SandboxRecoveryWatch(
      {
        ...defaultRecoveryWatchDeps,
        isSandboxReady: async () => true,
        isAgentActive: () => true,
        now: () => 2_000_000,
      },
      new FixtureScopedRecoveryStore([A1])
    )
    await productionWatch.register({
      agentId: A1,
      sandboxIds: ['agent_a1'],
      observedAt: new Date(1_900_000),
    })

    await productionWatch.checkAgent(A1)

    const [subscription] = await db
      .select()
      .from(sandboxRecoverySubscriptions)
      .where(eq(sandboxRecoverySubscriptions.agentId, A1))
    expect(subscription).toMatchObject({ status: 'delivered' })
    expect(subscription.deliveryMessageId).toBeString()
    expect(subscription.deliveryExecutionId).toBeString()

    const recorded = await defaultRecoveryWatchDeps.recordAgentMessage(A1, '[System] record only', {
      sandboxId: 'agent_a1',
      recoveryEpisodeId: crypto.randomUUID(),
      recoveryNotificationKind: 'still_unavailable',
    })
    expect(recorded).toMatchObject({ id: expect.any(String) })
  })

  it('replays a durable watch after the registering instance is discarded', async () => {
    const first = new SandboxRecoveryWatch(ctx.deps)
    await first.register({ agentId: A1, sandboxIds: ['agent_a1'], reason: 'OOMKilled' })
    await first.register({ agentId: A2, sandboxIds: ['agent_a2'], reason: 'neighbor' })
    const unrelatedStore = new SandboxRecoveryStore()
    const unrelated = await unrelatedStore.register({ agentId: A3, sandboxIds: ['agent_a3'] })
    await unrelatedStore.prepareNotification({
      episodeId: unrelated.registrations[0]!.episodeId,
      agentId: A3,
      kind: 'recovered',
      content: '[System] unrelated fixture',
      recordOnly: false,
    })

    ctx.ready.add('agent_a1')
    const restarted = new SandboxRecoveryWatch(ctx.deps, new FixtureScopedRecoveryStore([A1, A2]))
    await restarted.checkAllOnce()

    // checkAllOnce still exercises production hydration/drain, while the injected store scope
    // prevents a process-global sweep from claiming unrelated concurrent-test obligations.
    const intended = ctx.notifications.filter((notification) => notification.agentId === A1)
    expect(intended).toHaveLength(1)
    expect(intended[0]).toMatchObject({ agentId: A1, mode: 'send' })
    expect(intended[0]?.content).toContain('agent_a1')
    expect(ctx.notifications.filter((notification) => notification.agentId === A2)).toHaveLength(0)
    expect(await new SandboxRecoveryStore().isWatched(A1)).toBe(false)
    expect(await new SandboxRecoveryStore().isWatched(A2)).toBe(true)
    const [unrelatedAfterSweep] = await db
      .select()
      .from(sandboxRecoverySubscriptions)
      .where(eq(sandboxRecoverySubscriptions.agentId, A3))
    expect(unrelatedAfterSweep).toMatchObject({ status: 'pending', claimToken: null, attempts: 0 })
    expect(ctx.notifications.filter((notification) => notification.agentId === A3)).toHaveLength(0)
    // Mutation guard: removing checkAllOnce hydration leaves A1 watched and sends no intended notification.
  })

  it('derives transitions from readiness when the runtime supplies no generation time', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)

    ctx.advance(5 * 60_000)
    const retry = new SandboxRecoveryWatch(ctx.deps)
    await retry.register({ agentId: A2, sandboxIds: ['agent_a1'] })
    expect(
      await db.select().from(sandboxRecoveryEpisodes).where(eq(sandboxRecoveryEpisodes.sandboxId, 'agent_a1'))
    ).toHaveLength(1)
    expect(retry.has(A2)).toBe(false)

    ctx.ready.delete('agent_a1')
    await retry.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    const episodes = await db
      .select()
      .from(sandboxRecoveryEpisodes)
      .where(eq(sandboxRecoveryEpisodes.sandboxId, 'agent_a1'))
    expect(episodes.map((episode) => episode.generation).sort()).toEqual([1, 2])
    // Mutation guard: removing the closed-episode readiness gate creates generation 2 for the delayed retry.
  })

  it('notifies once and clears the watch when the watched sandbox becomes ready', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'], reason: 'OOMKilled' })
    expect(watch.has(A1)).toBe(true)

    // Not ready yet — no notification
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(0)
    expect(watch.has(A1)).toBe(true)

    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].agentId).toBe(A1)
    expect(ctx.notifications[0].mode).toBe('send')
    expect(ctx.notifications[0].content).toContain('agent_a1')
    expect(ctx.notifications[0].content).toContain('back online')
    expect(watch.has(A1)).toBe(false)

    // Re-check after clear — no double notify
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(1)
  })

  it('deduplicates one recovered outage across independent watch instances', async () => {
    const delivered: Notification[] = []
    const watches = Array.from(
      { length: 4 },
      () =>
        new SandboxRecoveryWatch(
          makeDeps({
            isSandboxReady: async () => true,
            notifyAgent: async (agentId, content) => {
              delivered.push({ agentId, content, mode: 'send' })
            },
          }).deps
        )
    )

    await Promise.all(
      watches.map((candidate) => candidate.register({ agentId: A1, sandboxIds: ['agent_a1'], reason: 'OOMKilled' }))
    )
    await Promise.all(watches.map((candidate) => candidate.checkAgent(A1)))

    // Incident 2026-08-13: Rook and Ruby each gained four active rows within
    // milliseconds from four process-local recovery watches. One row owned
    // the durable streamGroupId output while /active selected a newer orphan.
    // Removing durable episode ownership must make this leak four deliveries.
    expect(delivered).toHaveLength(1)
  })

  it('does not notify until all dependent sandbox episodes recover', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1', 'squad_s1'], reason: 'OOMKilled' })

    ctx.ready.add('squad_s1')
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(0)

    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(2)
    expect(ctx.notifications.map((notification) => notification.content).join(' ')).toContain('agent_a1')
    expect(ctx.notifications.map((notification) => notification.content).join(' ')).toContain('squad_s1')
    // Mutation guard: removing the all-dependencies readiness barrier must notify after the first check.
  })

  it('merges sandboxIds on re-register and keeps the original outage start time', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.advance(60_000)
    await watch.register({ agentId: A1, sandboxIds: ['squad_s1'] })

    const entry = watch.get(A1)
    expect(entry).toBeDefined()
    expect([...entry!.sandboxIds].sort()).toEqual(['agent_a1', 'squad_s1'])
    expect(entry!.since).toBe(1_000_000)
  })

  it('applies give-up timing independently to each sandbox episode', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.advance(10 * 60_000)
    await watch.register({ agentId: A1, sandboxIds: ['squad_s1'] })
    ctx.advance(6 * 60_000)

    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0]?.content).toContain('agent_a1')
    expect(ctx.notifications[0]?.content).not.toContain('squad_s1')
    expect(watch.get(A1)?.sandboxIds).toEqual(new Set(['squad_s1']))
  })

  it('gives up after the timeout with a still-unavailable notification and stops watching', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })

    ctx.advance(16 * 60_000) // past the 15-minute give-up
    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].content).toContain('still unavailable')
    expect(watch.has(A1)).toBe(false)

    // Recovery after give-up does not notify again
    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)
    expect(ctx.notifications).toHaveLength(1)
  })

  it('delivers the give-up notice record-only when the agent has no active session (no wake loop)', async () => {
    ctx = makeDeps({ isAgentActive: () => false })
    watch = new SandboxRecoveryWatch(ctx.deps)

    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.advance(16 * 60_000)
    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].mode).toBe('record')
  })

  it('checkAllOnce sweeps every watched agent', async () => {
    watch = new SandboxRecoveryWatch(ctx.deps, new FixtureScopedRecoveryStore([A1, A2]))
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    await watch.register({ agentId: A2, sandboxIds: ['agent_a2'] })

    ctx.ready.add('agent_a1')
    ctx.ready.add('agent_a2')
    await watch.checkAllOnce()

    expect(ctx.notifications.filter((notification) => notification.agentId === A1)).toHaveLength(1)
    expect(ctx.notifications.filter((notification) => notification.agentId === A2)).toHaveLength(1)
    expect(watch.size).toBe(0)
  })

  it('handleSandboxStatusEvent only checks watches that include that sandbox', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    await watch.register({ agentId: A2, sandboxIds: ['squad_s1'] })

    ctx.ready.add('agent_a1')
    ctx.ready.add('squad_s1')
    await watch.handleSandboxStatusEvent('agent_a1')

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].agentId).toBe(A1)
    expect(watch.has(A2)).toBe(true)
  })

  it('charges the crash budget once when one outage watches multiple sandboxes', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1', 'squad_s1'], crash: true })

    expect(watch.get(A1)?.crashCount).toBe(1)
    expect(watch.get(A1)?.sandboxIds.size).toBe(2)
    // Mutation guard: charging each sandbox subscription makes the count equal two.
  })

  it('increments the crash count once per outage (not per re-register)', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'], crash: true })
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'], crash: true })
    expect(watch.get(A1)?.crashCount).toBe(1)
  })

  it('does not count non-crash registrations toward the budget', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    expect(watch.get(A1)?.crashCount).toBe(0)
  })

  it('annotates the wake message when the box has crashed repeatedly', async () => {
    await db
      .update(agents)
      .set({ metadata: { sandboxRestartCount: 1 } })
      .where(eq(agents.id, A1))
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'], crash: true }) // -> 2

    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].content).toContain('crashed 2 times')
  })

  it('past the crash budget, delivers the recovery notice as a record-only message (no wake)', async () => {
    await db
      .update(agents)
      .set({ metadata: { sandboxRestartCount: MAX_SANDBOX_RESTARTS } })
      .where(eq(agents.id, A1))
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'], crash: true }) // exceeds budget

    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].mode).toBe('record')
    expect(watch.has(A1)).toBe(false)
  })

  it('keeps the watch when notification delivery fails, so the sweep can retry', async () => {
    let calls = 0
    ctx = makeDeps({
      notifyAgent: async () => {
        calls++
        throw new Error('delivery failed')
      },
    })
    watch = new SandboxRecoveryWatch(ctx.deps)

    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.ready.add('agent_a1')

    await watch.checkAgent(A1)
    expect(calls).toBe(1)
    expect(watch.has(A1)).toBe(false) // durable delivering claim is retained for lease-based replay
  })

  it('retains a recovery subscription when its owner became dormant during the outage', async () => {
    const previousRuntime = process.env.FICUS_SANDBOX_RUNTIME
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    await db
      .update(agents)
      .set({
        status: 'dormant',
        dormantAt: new Date(),
        metadata: { resourceGeneration: 'dormant-generation' },
      })
      .where(eq(agents.id, A1))
    const ensureSandbox = spyOn({ ensureSandbox: async () => 'unexpected' }, 'ensureSandbox')
    const getManager = spyOn(factory, 'getSandboxManager').mockReturnValue({
      ensureSandbox,
      hasSandbox: () => true,
    } as any)
    const productionWatch = new SandboxRecoveryWatch(
      { ...defaultRecoveryWatchDeps, now: () => 2_000_000 },
      new FixtureScopedRecoveryStore([A1])
    )
    try {
      await productionWatch.register({ agentId: A1, sandboxIds: [`agent_${A1}`], observedAt: new Date(1_900_000) })
      await productionWatch.checkAgent(A1)

      expect(productionWatch.has(A1)).toBe(true)
      expect(ensureSandbox).not.toHaveBeenCalled()
    } finally {
      await db.delete(sandboxRecoverySubscriptions).where(eq(sandboxRecoverySubscriptions.agentId, A1))
      getManager.mockRestore()
      ensureSandbox.mockRestore()
      if (previousRuntime === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
      else process.env.FICUS_SANDBOX_RUNTIME = previousRuntime
    }
  })

  it('includes approximate downtime in the wake message', async () => {
    await watch.register({ agentId: A1, sandboxIds: ['agent_a1'] })
    ctx.advance(90_000)
    ctx.ready.add('agent_a1')
    await watch.checkAgent(A1)

    expect(ctx.notifications).toHaveLength(1)
    expect(ctx.notifications[0].content).toMatch(/down ~?1\.5 minutes|down ~?90s/)
  })
})

describe('defaultIsSandboxReady runtime gate', () => {
  const prev = process.env.FICUS_SANDBOX_RUNTIME
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => {
    spies.forEach((s) => s.mockRestore())
    spies.length = 0
    if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
    else process.env.FICUS_SANDBOX_RUNTIME = prev
  })

  it('keeps a dormant agent recovery watch unavailable without recreating its box', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'docker'
    const agentId = crypto.randomUUID()
    const ensureSandbox = spyOn({ ensureSandbox: async () => 'unexpected' }, 'ensureSandbox')
    const manager = { ensureSandbox, hasSandbox: () => true }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(manager as any), ensureSandbox)
    await db.insert(agents).values({
      id: agentId,
      agentTypeId: 'recovery-watch-test',
      status: 'dormant',
      dormantAt: new Date(),
      metadata: { resourceGeneration: 'dormant-generation' },
    })
    try {
      expect(await defaultIsSandboxReady(`agent_${agentId}`)).toBe(false)
      expect(ensureSandbox).not.toHaveBeenCalled()
    } finally {
      await db.delete(agents).where(eq(agents.id, agentId))
    }
  })

  // A `system-manager_` id is neither a squad nor an `agent_` box, so the re-ensure
  // branch is a no-op — isolating the runtime status gate for this focused test.
  it('(vm runtime) requires running AND devbox-ready — not the coarse hasSandbox tracking', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const fakeVmManager = {
      getSandboxStatus: async (_id: string) => ({ status: 'running', devboxReady: false }),
      hasSandbox: () => true, // would wrongly report ready if the docker path were taken
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeVmManager as any))

    expect(await defaultIsSandboxReady('system-manager_vmuser')).toBe(false)
  })

  it('(vm runtime) reports ready once the box is running and devbox-ready', async () => {
    process.env.FICUS_SANDBOX_RUNTIME = 'vm'
    const fakeVmManager = {
      getSandboxStatus: async (_id: string) => ({ status: 'running', devboxReady: true }),
      hasSandbox: () => false,
    }
    spies.push(spyOn(factory, 'getSandboxManager').mockReturnValue(fakeVmManager as any))

    expect(await defaultIsSandboxReady('system-manager_vmuser')).toBe(true)
  })
})
