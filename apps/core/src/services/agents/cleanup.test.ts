import { storedLegacyWorkStream } from '../../test-utils/stored-legacy-work-stream'
import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, it, expect, beforeEach, spyOn } from 'bun:test'
import { Agent } from '../../entities/Agent'
import { Execution } from '../../entities/Execution'
import { Squad } from '../../entities/Squad'
import { db } from '../../db'
import { agents, squads, workStreams, executions, sandboxProvisionRecoveries, chatSendReceipts } from '../../db/schema'
import { eq, sql } from 'drizzle-orm'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  handleWorkStreamTerminal,
  reclaimPersonalSandbox,
  registerCleanupHandlers,
  runDormantAgentSweep,
  runFinalAgentCleanupSweep,
  stopAndArchivePersonalSandbox,
  stopPersonalSandbox,
} from './cleanup'
import {
  agentLifecycleDbTimestampSql,
  completeDormancyIfPending,
  completeFinalization,
  makeDormant,
  setFinalizationBeforeCasHookForTest,
  setFinalizationEffectHookForTest,
  terminate,
} from '../agent/lifecycle'
import {
  getPrivateArchiveRoot,
  purgeExpiredAgentPrivateArchives,
  runAgentLifecycleConvergenceOnce,
} from '../sandbox/private-archive'
import { getSettingsStore } from '../settings'

async function seedAgentLifecycleForTest(agent: Agent, updates: Partial<typeof agents.$inferInsert>): Promise<void> {
  const set = updates.metadata ? { ...updates, metadata: { ...(agent.metadata ?? {}), ...updates.metadata } } : updates
  await db.update(agents).set(set).where(eq(agents.id, agent.id))
  await agent.reload()
}

describe('agent-cleanup', () => {
  let testSquadId: string

  beforeEach(async () => {
    await db.delete(chatSendReceipts)
    await db.delete(executions)
    await db.delete(workStreams)
    await db.delete(agents)
    await db.delete(squads)

    const squad = await Squad.create({ name: 'Test Squad', purpose: 'Testing' })
    testSquadId = squad.id
  })

  it('runs all production lifecycle convergence defaults in order with archive budgets', async () => {
    const lifecycleModule = await import('../agent/lifecycle')
    const cleanupModule = await import('./cleanup')
    const calls: string[] = []
    const spies = [
      spyOn(lifecycleModule, 'runLegacyTerminatedAgentSweep').mockImplementation(async (options) => {
        calls.push(`legacy:${options?.maxCandidates}`)
        return 0
      }),
      spyOn(lifecycleModule, 'runPendingAgentLifecycleSweep').mockImplementation(async () => {
        calls.push('pending')
        return 0
      }),
      spyOn(lifecycleModule, 'runDormancyCompletionSweep').mockImplementation(async () => {
        calls.push('dormancy')
        return 0
      }),
      spyOn(cleanupModule, 'runDormantAgentSweep').mockImplementation(async (options) => {
        calls.push(`retention:${options?.maxCandidates}`)
        return 0
      }),
      spyOn(cleanupModule, 'runFinalAgentCleanupSweep').mockImplementation(async (options) => {
        calls.push(`cleanup:${options?.maxCandidates}:${options?.maxWorkItems}`)
        return 0
      }),
    ]
    try {
      await runAgentLifecycleConvergenceOnce()
      expect(calls).toEqual(['legacy:5', 'pending', 'dormancy', 'retention:5', 'cleanup:5:5'])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('reconciles a settled execution lifecycle request without a 30-second wait', async () => {
    const lifecycleModule = await import('../agent/lifecycle')
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    await seedAgentLifecycleForTest(agent, {
      pendingDormancyAt: new Date(),
      metadata: { pendingLifecycleTarget: 'dormant' },
    })
    let resolveCalled: (() => void) | undefined
    const reconcile = spyOn(lifecycleModule, 'reconcileAgentLifecycleRequest').mockImplementation(async () => {
      resolveCalled?.()
      return false
    })
    type TerminalCase =
      | { event: 'execution.completed'; status: 'completed' }
      | { event: 'execution.failed'; status: 'failed' }
      | { event: 'execution.stopped'; status: 'stopped' }
    const terminalCases: readonly TerminalCase[] = [
      { event: 'execution.completed', status: 'completed' },
      { event: 'execution.failed', status: 'failed' },
      { event: 'execution.stopped', status: 'stopped' },
    ]
    const unregister = registerCleanupHandlers()
    try {
      for (const terminal of terminalCases) {
        const called = new Promise<void>((resolve) => {
          resolveCalled = resolve
        })
        const payload = { executionId: crypto.randomUUID(), agentId: agent.id }
        switch (terminal.event) {
          case 'execution.completed':
            eventEmitter.emit(terminal.event, { ...payload, status: terminal.status })
            break
          case 'execution.failed':
            eventEmitter.emit(terminal.event, { ...payload, status: terminal.status })
            break
          case 'execution.stopped':
            eventEmitter.emit(terminal.event, { ...payload, status: terminal.status })
            break
        }
        await called
      }
      expect(reconcile).toHaveBeenCalledWith(agent.id, { dormancyTimeoutMs: 0 })
      expect(reconcile).toHaveBeenCalledTimes(3)
    } finally {
      unregister()
      reconcile.mockRestore()
    }
  })

  it("terminal-settles a terminated agent's surviving never-started executions on agent.terminated", async () => {
    // The incident shape: an execution queued for an agent that was then
    // unspawned/terminated survives in a demand state forever. The cleanup
    // handler must settle it terminally so fleet demand stops counting it.
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const execution = await agent.queueExecution({ message: 'queued moments after termination' })
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))

    const unregister = registerCleanupHandlers()
    try {
      const settled = new Promise<void>((resolve) => {
        const unsubscribe = eventEmitter.on('execution.failed', ({ executionId }) => {
          if (executionId !== execution.id) return
          unsubscribe()
          resolve()
        })
      })
      eventEmitter.emit('agent.terminated', { agentId: agent.id, squadId: testSquadId })
      await settled

      const [row] = await db.select().from(executions).where(eq(executions.id, execution.id)).limit(1)
      expect(row).toMatchObject({
        status: 'failed',
        failureClass: 'execution_failure',
        failureReason: 'agent_removed',
      })
      // The settle never writes the agent row.
      expect((await Agent.mustFind(agent.id, { eager: false })).status).toBe('terminated')
    } finally {
      unregister()
    }
  })

  describe('dormant retention', () => {
    it('does not shift the UTC retention boundary under a non-UTC database session', async () => {
      const now = new Date()
      const [agent] = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`)
        return tx
          .insert(agents)
          .values({
            agentTypeId: 'engineer',
            squadId: testSquadId,
            status: 'dormant',
            dormantAt: agentLifecycleDbTimestampSql,
          })
          .returning()
      })
      await db.execute(sql`
        UPDATE agents
        SET dormant_at = dormant_at - interval '7 days' + interval '2 hours'
        WHERE id = ${agent!.id}
      `)

      expect(await runDormantAgentSweep({ maxCandidates: 1, now })).toBe(0)
      expect((await Agent.mustFind(agent!.id, { eager: false })).status).toBe('dormant')
    })

    it('finalizes a real DB-clock dormancy after its retention age elapses', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await makeDormant(agent)
      await db.execute(sql`
        UPDATE agents
        SET dormant_at = dormant_at - interval '400 days'
        WHERE id = ${agent.id}
      `)

      expect(await runDormantAgentSweep({ maxCandidates: 1 })).toBe(1)
      expect((await Agent.mustFind(agent.id, { eager: false })).status).toBe('terminated')
    })

    it('uses the dormant budget rather than the terminated-private archive budget', async () => {
      const store = getSettingsStore()
      await store.initialize()
      const now = new Date('2026-09-02T00:00:00.000Z')
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      })
      const finalized: string[] = []
      try {
        await store.set('AGENT_DORMANT_RETENTION_DAYS', '2')
        await store.set('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS', '9')
        expect(
          await runDormantAgentSweep({
            now,
            listDormant: async () => [agent],
            completePending: async () => true,
            finalize: async (candidate) => {
              finalized.push(candidate.id)
              await db
                .update(agents)
                .set({ status: 'terminated', terminatedAt: now })
                .where(eq(agents.id, candidate.id))
            },
          })
        ).toBe(1)
        expect(finalized).toEqual([agent.id])
      } finally {
        await store.delete('AGENT_DORMANT_RETENTION_DAYS')
        await store.delete('AGENT_PRIVATE_ARCHIVE_RETENTION_DAYS')
      }
    })

    it('finalizes only dormant agents whose seven-day recovery window expired', async () => {
      const now = new Date('2026-08-31T12:00:00Z')
      const expired = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const recoverable = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(expired, {
        status: 'dormant',
        dormantAt: new Date('2026-08-24T12:00:00Z'),
      })
      await seedAgentLifecycleForTest(recoverable, {
        status: 'dormant',
        dormantAt: new Date('2026-08-24T12:00:01Z'),
      })

      const finalized: string[] = []
      await runDormantAgentSweep({
        now,
        getRetentionDays: () => 7,
        finalize: async (agent) => {
          finalized.push(agent.id)
        },
      })

      expect(finalized).toEqual([expired.id])
    })

    it.each(['preflight', 'finalization'] as const)(
      'isolates a poisoned first candidate during %s so a later expired agent still finalizes',
      async (failedPhase) => {
        const now = new Date()
        const first = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
        const second = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
        const dormantAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
        await seedAgentLifecycleForTest(first, { status: 'dormant', dormantAt })
        await seedAgentLifecycleForTest(second, { status: 'dormant', dormantAt })

        expect(
          await runDormantAgentSweep({
            now,
            getRetentionDays: () => 7,
            listDormant: async () => [first, second],
            completePending: async (id) => {
              if (failedPhase === 'preflight' && id === first.id) throw new Error('poisoned preflight')
              return true
            },
            finalize: async (candidate) => {
              if (failedPhase === 'finalization' && candidate.id === first.id) {
                throw new Error('poisoned finalization')
              }
              await terminate(candidate, {
                completeDormancy: async () => true,
                finalCleanup: async () => true,
              })
            },
          })
        ).toBe(1)
        expect((await Agent.mustFind(first.id)).status).toBe('dormant')
        expect((await Agent.mustFind(second.id)).status).toBe('terminated')
      }
    )

    it('skips a listed candidate that wakes before authoritative reload and continues the batch', async () => {
      const agentWarmup = await import('../sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const now = new Date()
      const first = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const second = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const dormantAt = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
      await seedAgentLifecycleForTest(first, { status: 'dormant', dormantAt })
      await seedAgentLifecycleForTest(second, { status: 'dormant', dormantAt })
      const finalizationAttempts: string[] = []
      try {
        expect(
          await runDormantAgentSweep({
            now,
            getRetentionDays: () => 7,
            listDormant: async () => [first, second],
            completePending: async (id) => {
              if (id === first.id) await (await Agent.mustFind(first.id)).wake()
              return true
            },
            finalize: async (candidate) => {
              finalizationAttempts.push(candidate.id)
              await terminate(candidate, {
                completeDormancy: async () => true,
                finalCleanup: async () => true,
              })
            },
          })
        ).toBe(1)
      } finally {
        ensure.mockRestore()
        mint.mockRestore()
      }
      expect((await Agent.mustFind(first.id)).status).toBe('idle')
      expect((await Agent.mustFind(second.id)).status).toBe('terminated')
      expect(finalizationAttempts).toEqual([second.id])
    })

    it('does not finalize while a valid dormancy completion claim is busy, then converges exactly once', async () => {
      const now = new Date()
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
        metadata: {
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: now.toISOString(),
        },
      })
      const cleanup: string[] = []
      const finalizationAttempts: string[] = []
      const sweep = () =>
        runDormantAgentSweep({
          now,
          getRetentionDays: () => 7,
          listDormant: async () => [agent],
          completePending: (id) => completeDormancyIfPending(id, { timeoutMs: 0 }),
          finalize: (candidate) => {
            finalizationAttempts.push(candidate.id)
            return terminate(candidate, {
              completeDormancy: (id) => completeDormancyIfPending(id, { timeoutMs: 0 }),
              finalCleanup: async (id) => void cleanup.push(id),
            })
          },
        })

      expect(await sweep()).toBe(0)
      expect(await Agent.mustFind(agent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
        }),
      })
      expect(cleanup).toEqual([])
      expect(finalizationAttempts).toEqual([])
      await terminate(agent, {
        completeDormancy: async () => false,
        finalCleanup: async (id) => void cleanup.push(id),
      })
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(cleanup).toEqual([])

      await db
        .update(agents)
        .set({
          metadata: {
            ...(agent.metadata ?? {}),
            dormancyCompletionPending: true,
            dormancyCompletionId: episodeId,
            dormancyCompletionClaimId: crypto.randomUUID(),
            dormancyCompletionClaimedAt: '2000-01-01T00:00:00.000Z',
          },
        })
        .where(eq(agents.id, agent.id))
      await agent.reload()

      expect(await sweep()).toBe(1)
      expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
      expect(finalizationAttempts).toEqual([agent.id])
      expect(cleanup).toEqual([agent.id])
    })

    it('does not enter final status when dormancy completion reports busy', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })
      const cleanup: string[] = []

      await terminate(agent, {
        completeDormancy: async () => false,
        finalCleanup: async (id) => void cleanup.push(id),
      })

      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(cleanup).toEqual([])
    })

    it('durably retries final cleanup until it succeeds', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })
      await terminate(agent, { finalCleanup: async () => false })

      let final = await Agent.mustFind(agent.id)
      expect(final.status).toBe('terminated')
      expect((final.metadata as Record<string, unknown>).finalCleanupPending).toBe(true)

      const attempts: string[] = []
      expect(
        await runFinalAgentCleanupSweep({
          listTerminated: async () => [final],
          cleanup: async (id) => void attempts.push(id),
        })
      ).toBe(1)
      final = await Agent.mustFind(agent.id)
      expect((final.metadata as Record<string, unknown>).finalCleanupPending).toBeUndefined()
      expect(attempts).toEqual([agent.id])
      expect(await runFinalAgentCleanupSweep({ listTerminated: async () => [final] })).toBe(0)
    })

    it('rotates a failed final-cleanup candidate so a later row is reached on the next capped tick', async () => {
      const stuck = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const later = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      for (const [agent, sweepAt] of [
        [stuck, 0],
        [later, 1],
      ] as const) {
        await seedAgentLifecycleForTest(agent, {
          status: 'terminated',
          terminatedAt: new Date(),
          metadata: { finalCleanupPending: true, finalCleanupId: crypto.randomUUID(), finalCleanupSweepAt: sweepAt },
        })
      }
      const attempts: string[] = []
      const cleanup = async (id: string) => (attempts.push(id), id === later.id)

      expect(await runFinalAgentCleanupSweep({ maxCandidates: 1, cleanup })).toBe(0)
      expect(attempts).toEqual([stuck.id])
      expect(await runFinalAgentCleanupSweep({ maxCandidates: 1, cleanup })).toBe(1)
      expect(attempts).toEqual([stuck.id, later.id])
      expect((await Agent.mustFind(stuck.id)).metadata).toHaveProperty('finalCleanupPending', true)
      expect((await Agent.mustFind(later.id)).metadata).not.toHaveProperty('finalCleanupPending')
    })

    it('reclaims a stale finalization claim after a crashed completer', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(agent, {
        status: 'terminated',
        terminatedAt: new Date(),
        metadata: {
          finalCleanupPending: true,
          finalizationClaimId: crypto.randomUUID(),
          finalizationClaimedAt: '2000-01-01T00:00:00.000Z',
        },
      })
      const final = await Agent.mustFind(agent.id)

      expect(await runFinalAgentCleanupSweep({ listTerminated: async () => [final], cleanup: async () => true })).toBe(
        1
      )
      expect((await Agent.mustFind(agent.id)).metadata).not.toHaveProperty('finalCleanupPending')
      expect((await Agent.mustFind(agent.id)).metadata).not.toHaveProperty('finalizationClaimId')
    })

    it('records an expired-finalization stage exactly once across takeover', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'terminated',
        terminatedAt: new Date(),
        metadata: { finalCleanupPending: true, finalCleanupId: episodeId },
      })
      const storageEntered = Promise.withResolvers<void>()
      const releaseStorage = Promise.withResolvers<void>()
      let storageCalls = 0
      const cleanup = async () => {
        storageCalls++
        if (storageCalls === 1) {
          storageEntered.resolve()
          await releaseStorage.promise
        }
        return true
      }
      try {
        const stale = completeFinalization(agent.id, { finalCleanup: cleanup })
        await storageEntered.promise
        const claimed = await Agent.mustFind(agent.id)
        const staleClaimId = (claimed.metadata as Record<string, unknown>).finalizationClaimId
        await seedAgentLifecycleForTest(claimed, {
          metadata: {
            ...(claimed.metadata ?? {}),
            finalizationClaimedAt: '2000-01-01T00:00:00.000Z',
          },
        })
        const takeover = completeFinalization(agent.id, { finalCleanup: cleanup })
        for (let attempt = 0; attempt < 100; attempt++) {
          const currentClaimId = ((await Agent.mustFind(agent.id)).metadata as Record<string, unknown>)
            .finalizationClaimId
          if (currentClaimId !== staleClaimId) break
          if (attempt === 99) throw new Error('finalization takeover did not acquire the expired claim')
          await Bun.sleep(10)
        }
        releaseStorage.resolve()
        const results = await Promise.all([stale, takeover])
        expect(results.some(Boolean)).toBe(true)
        expect(storageCalls).toBe(1)
        expect((await Agent.mustFind(agent.id)).metadata).not.toHaveProperty('finalCleanupPending')
      } finally {
        releaseStorage.resolve()
      }
    })

    it.each(['tokens', 'descendants', 'questions', 'schedules', 'storage'] as const)(
      'retries every required finalization stage after a %s failure',
      async (failedStage) => {
        const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
        await agent.update({ status: 'dormant', dormantAt: new Date() })
        const visited: string[] = []
        let fail = true
        const terminatedEvents: string[] = []
        const onTerminated = ({ agentId }: { agentId: string }) => terminatedEvents.push(agentId)
        const unsubscribe = eventEmitter.on('agent.terminated', onTerminated)
        setFinalizationEffectHookForTest(async (stage) => {
          visited.push(stage)
          if (stage === failedStage && fail) throw new Error(`injected ${stage} failure`)
        })
        try {
          await terminate(agent, { finalCleanup: async () => true })
          let final = await Agent.mustFind(agent.id)
          expect(final.metadata).toMatchObject({ finalCleanupPending: true })
          expect(terminatedEvents).toEqual([agent.id])

          fail = false
          expect(
            await runFinalAgentCleanupSweep({ listTerminated: async () => [final], cleanup: async () => true })
          ).toBe(1)
          final = await Agent.mustFind(agent.id)
          expect(final.metadata).not.toHaveProperty('finalCleanupPending')
          expect(visited.filter((stage) => stage === failedStage)).toHaveLength(1)
        } finally {
          setFinalizationEffectHookForTest(undefined)
          unsubscribe()
        }
      }
    )

    it('recursively retries failed child and grandchild finalization before clearing the parent marker', async () => {
      const parent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const child = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, parentAgentId: parent.id })
      const grandchild = await Agent.create({
        agentTypeId: 'engineer',
        squadId: testSquadId,
        parentAgentId: child.id,
      })
      await seedAgentLifecycleForTest(parent, { status: 'dormant', dormantAt: new Date() })
      const originalRevoke = Agent.prototype.revokeTokensForAgent
      let failGrandchild = true
      const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (this: Agent) {
        if (this.id === grandchild.id && failGrandchild) throw new Error('injected grandchild token failure')
        return originalRevoke.call(this)
      })
      try {
        await terminate(parent, { finalCleanup: async () => true })
        expect(await Agent.mustFind(parent.id)).toMatchObject({
          status: 'terminated',
          metadata: expect.objectContaining({ finalCleanupPending: true }),
        })
        expect(await Agent.mustFind(child.id)).toMatchObject({ status: 'idle' })
        expect(await Agent.mustFind(grandchild.id)).toMatchObject({
          status: 'dormant',
          metadata: expect.objectContaining({ dormancyCompletionPending: true }),
        })

        failGrandchild = false
        let completed = 0
        for (let tick = 0; tick < 10 && completed === 0; tick++) {
          const finalParent = await Agent.mustFind(parent.id)
          completed = await runFinalAgentCleanupSweep({
            listTerminated: async () => [finalParent],
            cleanup: async () => true,
            maxWorkItems: 1,
          })
        }
        expect(completed).toBe(1)
        for (const id of [parent.id, child.id, grandchild.id]) {
          expect((await Agent.mustFind(id)).metadata).not.toHaveProperty('finalCleanupPending')
        }
      } finally {
        revoke.mockRestore()
      }
    })

    it('bounds a root larger than the work budget and durably converges it across ticks', async () => {
      const root = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const rootEpisode = crypto.randomUUID()
      await seedAgentLifecycleForTest(root, {
        status: 'terminated',
        terminatedAt: new Date(),
        metadata: {
          finalCleanupPending: true,
          finalCleanupId: rootEpisode,
          finalizationStageEpisode: rootEpisode,
          finalizationCompletedStages: ['tokens'],
        },
      })
      const descendants: Agent[] = []
      for (let index = 0; index < 6; index++) {
        const descendant = await Agent.create({
          agentTypeId: 'engineer',
          squadId: testSquadId,
          parentAgentId: root.id,
        })
        await seedAgentLifecycleForTest(descendant, {
          status: 'terminated',
          terminatedAt: new Date(),
          metadata: { finalCleanupPending: true, finalCleanupId: crypto.randomUUID() },
        })
        descendants.push(descendant)
      }
      const originalRevoke = Agent.prototype.revokeTokensForAgent
      const attempts: string[] = []
      const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (
        this: Agent,
        options
      ) {
        if (this.id !== root.id) attempts.push(this.id)
        return originalRevoke.call(this, options)
      })
      try {
        expect(
          await runFinalAgentCleanupSweep({
            listTerminated: async () => [await Agent.mustFind(root.id)],
            cleanup: async () => true,
            maxWorkItems: 2,
          })
        ).toBe(0)
        expect(attempts.length).toBeLessThanOrEqual(2)
        let pendingRoot = await Agent.mustFind(root.id)
        expect(pendingRoot.metadata).toMatchObject({ finalCleanupPending: true })
        expect((pendingRoot.metadata as Record<string, unknown>).finalizationCompletedStages).not.toContain(
          'descendants'
        )

        let completed = 0
        for (let tick = 0; tick < 20 && completed === 0; tick++) {
          pendingRoot = await Agent.mustFind(root.id)
          const before = attempts.length
          completed = await runFinalAgentCleanupSweep({
            listTerminated: async () => [pendingRoot],
            cleanup: async () => true,
            maxWorkItems: 2,
          })
          expect(attempts.length - before).toBeLessThanOrEqual(2)
        }
        expect(completed).toBe(1)
        expect((await Agent.mustFind(root.id)).metadata).not.toHaveProperty('finalCleanupPending')
        for (const descendant of descendants) {
          expect((await Agent.mustFind(descendant.id)).metadata).not.toHaveProperty('finalCleanupPending')
        }
      } finally {
        revoke.mockRestore()
      }
    })

    it('finalizes a chain deeper than the DB pool under concurrent completion without deadlock', async () => {
      const chain: Agent[] = []
      let parentAgentId: string | undefined
      for (let index = 0; index < 7; index++) {
        const member = await Agent.create({
          agentTypeId: 'engineer',
          squadId: testSquadId,
          ...(parentAgentId ? { parentAgentId } : {}),
        })
        await member.update({ status: 'dormant', dormantAt: new Date() })
        chain.push(member)
        parentAgentId = member.id
      }

      let resolveFinal!: () => void
      const finalCommitted = new Promise<void>((resolve) => (resolveFinal = resolve))
      const unsubscribe = eventEmitter.on('agent.terminated', ({ agentId }) => {
        if (agentId === chain[0].id) resolveFinal()
      })
      const cleanup = async () => true
      const first = terminate(chain[0], { finalCleanup: cleanup })
      await finalCommitted
      const completions = [
        first,
        completeFinalization(chain[0].id, { finalCleanup: cleanup }),
        completeFinalization(chain[0].id, { finalCleanup: cleanup }),
      ]
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all(completions),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('deep finalization deadlocked')), 5000)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
        unsubscribe()
      }

      for (const member of chain) {
        const final = await Agent.mustFind(member.id)
        expect(final.status).toBe('terminated')
        expect(final.metadata).not.toHaveProperty('finalCleanupPending')
      }
    })

    it('bounds dormant retention candidates and uses a single completion attempt', async () => {
      const now = new Date('2026-09-02T00:00:00.000Z')
      const candidates = await Promise.all(
        Array.from({ length: 3 }, async () => {
          const candidate = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
          await seedAgentLifecycleForTest(candidate, {
            status: 'dormant',
            dormantAt: new Date('2026-08-01T00:00:00.000Z'),
          })
          return candidate
        })
      )
      const completed: string[] = []
      const finalized: string[] = []

      await runDormantAgentSweep({
        now,
        getRetentionDays: () => 7,
        maxCandidates: 1,
        listDormant: async () => candidates,
        completePending: async (id) => (completed.push(id), true),
        finalize: async (candidate) => void finalized.push(candidate.id),
      })

      expect(completed).toHaveLength(1)
      expect(finalized).toHaveLength(1)
    })

    it('rotates a busy dormant candidate so a later expired row is reached on the next capped tick', async () => {
      const now = new Date('2026-09-02T00:00:00.000Z')
      const stuck = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const later = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      for (const [agent, sweepAt] of [
        [stuck, 0],
        [later, 1],
      ] as const) {
        await seedAgentLifecycleForTest(agent, {
          status: 'dormant',
          dormantAt: new Date('2026-08-01T00:00:00.000Z'),
          metadata: { dormantSweepAt: sweepAt },
        })
      }
      const attempted: string[] = []
      const finalize = async (candidate: Agent) => {
        await seedAgentLifecycleForTest(candidate, { status: 'terminated', terminatedAt: now })
      }

      expect(
        await runDormantAgentSweep({
          now,
          getRetentionDays: () => 7,
          maxCandidates: 1,
          completePending: async (id) => (attempted.push(id), id !== stuck.id),
          finalize,
        })
      ).toBe(0)
      expect(attempted).toEqual([stuck.id])
      expect(
        await runDormantAgentSweep({
          now,
          getRetentionDays: () => 7,
          maxCandidates: 1,
          completePending: async (id) => (attempted.push(id), id !== stuck.id),
          finalize,
        })
      ).toBe(1)
      expect(attempted).toEqual([stuck.id, later.id])
    })

    it('applies the dormant cutoff before the cap', async () => {
      const now = new Date('2026-09-02T00:00:00.000Z')
      for (let index = 0; index < 2; index++) {
        const fresh = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
        await seedAgentLifecycleForTest(fresh, {
          status: 'dormant',
          dormantAt: new Date('2026-09-01T00:00:00.000Z'),
          metadata: { dormantSweepAt: index },
        })
      }
      const expired = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(expired, {
        status: 'dormant',
        dormantAt: new Date('2026-08-01T00:00:00.000Z'),
      })
      const attempted: string[] = []

      await runDormantAgentSweep({
        now,
        getRetentionDays: () => 7,
        maxCandidates: 1,
        completePending: async (id) => (attempted.push(id), false),
      })

      expect(attempted).toEqual([expired.id])
    })

    it('uses independent dormant and terminated-private retention cutoffs', async () => {
      const previousHome = process.env.HOME_DIR
      const home = join(tmpdir(), `ficus-final-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      process.env.HOME_DIR = home
      try {
        const now = new Date('2026-09-02T00:00:00.000Z')
        const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
        await seedAgentLifecycleForTest(agent, {
          status: 'dormant',
          dormantAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
        })
        const source = join(home, 'private', `agent_${agent.id}`)
        mkdirSync(source, { recursive: true })
        writeFileSync(join(source, 'state.txt'), 'retain after termination')

        expect(
          await runDormantAgentSweep({
            now,
            getRetentionDays: () => 2,
            listDormant: async () => [agent],
            finalize: (candidate) =>
              terminate(candidate, {
                finalCleanup: (id) =>
                  reclaimPersonalSandbox(id, `agent_${id}`, {
                    getManager: () => ({ removeSandbox: async () => {} }),
                  }),
              }),
          })
        ).toBe(1)
        expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
        const [archiveName] = readdirSync(getPrivateArchiveRoot())
        const archivedAt = Number(archiveName.match(/-(\d+)$/)?.[1])
        const archivedState = join(getPrivateArchiveRoot(), archiveName, 'state.txt')
        expect(existsSync(archivedState)).toBe(true)
        expect(purgeExpiredAgentPrivateArchives(9, new Date(archivedAt + 9 * 24 * 60 * 60 * 1000))).toBe(0)
        expect(existsSync(archivedState)).toBe(true)
        expect(purgeExpiredAgentPrivateArchives(9, new Date(archivedAt + 9 * 24 * 60 * 60 * 1000 + 1))).toBe(1)
        expect(existsSync(archivedState)).toBe(false)
      } finally {
        if (previousHome === undefined) delete process.env.HOME_DIR
        else process.env.HOME_DIR = previousHome
        rmSync(home, { recursive: true, force: true })
      }
    })

    it('does not terminate a fresh dormancy episode through a stale retention cutoff', async () => {
      const oldDormantAt = new Date('2026-08-01T00:00:00.000Z')
      const freshDormantAt = new Date('2026-09-01T00:00:00.000Z')
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(agent, { status: 'dormant', dormantAt: oldDormantAt })
      setFinalizationBeforeCasHookForTest(async () => {
        setFinalizationBeforeCasHookForTest(undefined)
        await db.update(agents).set({ dormantAt: freshDormantAt }).where(eq(agents.id, agent.id))
      })
      try {
        await terminate(agent, { expectedDormantAt: oldDormantAt, finalCleanup: async () => true })
      } finally {
        setFinalizationBeforeCasHookForTest(undefined)
      }

      expect(await Agent.mustFind(agent.id)).toMatchObject({ status: 'dormant', dormantAt: freshDormantAt })
    })

    it('does not revoke a re-woken agent when a stale finalization loses its CAS', async () => {
      const agentWarmup = await import('../sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockResolvedValue(0)
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })
      setFinalizationBeforeCasHookForTest(async () => {
        setFinalizationBeforeCasHookForTest(undefined)
        await agent.wake()
        revoke.mockClear()
      })
      try {
        await terminate(agent, { finalCleanup: async () => true })
      } finally {
        setFinalizationBeforeCasHookForTest(undefined)
        ensure.mockRestore()
        mint.mockRestore()
        revoke.mockRestore()
      }
      expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      expect(revoke).not.toHaveBeenCalled()
    })

    it('reports zero when a new dormancy marker makes the final CAS lose', async () => {
      const now = new Date()
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      })
      const episodeId = crypto.randomUUID()
      const cleanup: string[] = []
      setFinalizationBeforeCasHookForTest(async () => {
        setFinalizationBeforeCasHookForTest(undefined)
        await db
          .update(agents)
          .set({ metadata: { dormancyCompletionPending: true, dormancyCompletionId: episodeId } })
          .where(eq(agents.id, agent.id))
      })
      try {
        expect(
          await runDormantAgentSweep({
            now,
            getRetentionDays: () => 7,
            listDormant: async () => [agent],
            completePending: async () => true,
            finalize: (candidate) => terminate(candidate, { finalCleanup: async (id) => void cleanup.push(id) }),
          })
        ).toBe(0)
      } finally {
        setFinalizationBeforeCasHookForTest(undefined)
      }

      expect(await Agent.mustFind(agent.id)).toMatchObject({
        status: 'dormant',
        metadata: expect.objectContaining({
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
        }),
      })
      expect(cleanup).toEqual([])
    })

    it('performs final private cleanup exactly once at dormant to terminated', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })
      const stale = await Agent.mustFind(agent.id)
      const cleaned: string[] = []

      const finalCleanup = async (agentId: string) => {
        cleaned.push(agentId)
      }
      await Promise.all([terminate(agent, { finalCleanup }), terminate(stale, { finalCleanup })])
      await terminate(agent, { finalCleanup })

      expect(cleaned).toEqual([agent.id])
      const final = await Agent.mustFind(agent.id)
      expect(final.status).toBe('terminated')
      expect(final.terminatedAt).toBeInstanceOf(Date)
    })
  })

  describe('Agent.tryTerminate', () => {
    it('emits agent.updated for dormancy without emitting final termination', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })

      const events: Array<{ event: string; data: unknown }> = []
      const unsubscribe = eventEmitter.onAny((event, data) => events.push({ event, data }))
      try {
        await agent.tryTerminate()
      } finally {
        unsubscribe()
      }

      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(events).toContainEqual({ event: 'agent.updated', data: { agentId: agent.id, squadId: testSquadId } })
      expect(events.some(({ event }) => event === 'agent.terminated')).toBe(false)
    })

    it('makes an agent dormant when all work streams are terminal', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test', agentIds: [agent.id] })

      await ws.cancel()

      const terminated = await agent
        .tryTerminate()
        .then(() => true)
        .catch(() => false)

      expect(terminated).toBe(true)

      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(agent.terminatedAt).toBeNull()
    })

    it('cleanup handler makes agents dormant when work streams are canceled', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test', agentIds: [agent.id] })

      await ws.cancel()
      await handleWorkStreamTerminal([agent.id])

      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(agent.terminatedAt).toBeNull()
    })

    it('defers dormancy while the agent is mid-turn, then makes it dormant once idle', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })

      // Agent is mid-turn (a running execution); no active work streams so canTerminate passes.
      const exec = await agent.queueExecution({ message: 'working' })
      await Execution.update(exec.id, { status: 'running' })

      // Terminate is DEFERRED: token not revoked, flag set, agent not terminated.
      await agent.tryTerminate()
      await agent.reload()
      expect(agent.terminatedAt).toBeNull()
      expect(agent.pendingDormancyAt).not.toBeNull()

      // Turn ends → the now-idle agent becomes dormant (what the completion listener performs).
      await Execution.update(exec.id, { status: 'completed' })
      await agent.reload()
      await agent.tryTerminate()
      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(agent.terminatedAt).toBeNull()
    })

    it('captures the exact in-progress work-stream assignment when suspending', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const workStream = await storedLegacyWorkStream({
        squadId: testSquadId,
        title: 'Assigned recovery',
        agentIds: [agent.id],
      })
      await workStream.update({ status: 'active', assigneeAgentId: agent.id })
      const execution = (await agent.getActiveExecution()) ?? (await agent.queueExecution({ message: 'waiting' }))
      await execution.start()
      await execution.transitionTo({
        kind: 'waiting-sandbox',
        recovery: {
          scope: 'scope',
          sandboxKey: 'box',
          refusalId: crypto.randomUUID(),
          errorCode: 'SANDBOX_PROVISION_BUSY',
          nextAttemptAt: new Date(Date.now() + 5_000),
          deadlineAt: new Date(Date.now() + 60_000),
        },
      })

      const [recovery] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(recovery.workStreamId).toBe(workStream.id)
    })

    it('cancels a sandbox recovery wait before terminating the agent', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const execution = await agent.queueExecution({ message: 'waiting' })
      await execution.start()
      await execution.transitionTo({
        kind: 'waiting-sandbox',
        recovery: {
          scope: 'scope',
          sandboxKey: 'box',
          refusalId: crypto.randomUUID(),
          errorCode: 'SANDBOX_PROVISION_BUSY',
          nextAttemptAt: new Date(Date.now() + 5_000),
          deadlineAt: new Date(Date.now() + 60_000),
        },
      })

      await agent.tryTerminate()

      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(agent.terminatedAt).toBeNull()
      const [recovery] = await db
        .select()
        .from(sandboxProvisionRecoveries)
        .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
      expect(recovery.status).toBe('cancelled')
    })

    it('makes agent dormant when all work streams are done', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test', agentIds: [agent.id] })

      // Mark work stream as done
      await ws.update({ status: 'done' })

      const terminated = await agent
        .tryTerminate()
        .then(() => true)
        .catch(() => false)

      expect(terminated).toBe(true)

      await agent.reload()
      expect(agent.status).toBe('dormant')
      expect(agent.terminatedAt).toBeNull()
    })

    it('does not terminate manager agents', async () => {
      const manager = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId, persist: false })

      const terminated = await manager
        .tryTerminate()
        .then(() => true)
        .catch(() => false)

      expect(terminated).toBe(false)

      await manager.reload()
      expect(manager.terminatedAt).toBeNull()
    })

    it('does not terminate persist=true agents', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: true })
      const ws = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test', agentIds: [agent.id] })

      await ws.update({ status: 'done' })

      const terminated = await agent
        .tryTerminate()
        .then(() => true)
        .catch(() => false)

      expect(terminated).toBe(false)

      await agent.reload()
      expect(agent.terminatedAt).toBeNull()
    })

    it('does not terminate when work streams still active', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId, persist: false })
      const ws1 = await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test 1', agentIds: [agent.id] })
      await storedLegacyWorkStream({ squadId: testSquadId, title: 'Test 2', agentIds: [agent.id] })

      await ws1.update({ status: 'done' })
      // ws2 still pending

      const terminated = await agent
        .tryTerminate()
        .then(() => true)
        .catch(() => false)

      expect(terminated).toBe(false)

      await agent.reload()
      expect(agent.terminatedAt).toBeNull()
    })
  })

  describe('terminal work-stream sweep of already-terminated members', () => {
    it('reclaims the sandbox of a member that was already terminated mid-stream', async () => {
      const sweeps: string[] = []
      const terminations: string[] = []
      await handleWorkStreamTerminal(['dead', 'alive'], {
        loadAgent: async (id: string) =>
          ({
            id,
            status: id === 'dead' ? 'terminated' : 'idle',
            tryTerminate: async () => void terminations.push(id),
          }) as any,
        stopAndArchive: async (id: string) => void sweeps.push(id),
      })

      // The dead member's termination-time cleanup may have been missed; the
      // stream end retries it. The live member goes through normal termination
      // (whose event handler performs its own reclamation).
      expect(sweeps).toEqual(['dead'])
      expect(terminations).toEqual(['alive'])
    })

    it('sweeps a removed work-stream agent that was already terminated', async () => {
      const sweeps: string[] = []
      const { cleanupRemovedAgent } = await import('./cleanup')
      await cleanupRemovedAgent('dead', {
        loadAgent: async (id: string) => ({ id, status: 'terminated', tryTerminate: async () => {} }) as any,
        stopAndArchive: async (id: string) => void sweeps.push(id),
      })
      expect(sweeps).toEqual(['dead'])
    })

    it('missing agents are skipped without sweeping', async () => {
      const sweeps: string[] = []
      await handleWorkStreamTerminal(['ghost'], {
        loadAgent: async () => null,
        stopAndArchive: async (id: string) => void sweeps.push(id),
      })
      expect(sweeps).toEqual([])
    })
  })

  describe('stopPersonalSandbox', () => {
    it('parks dormant compute without removing recoverable runtime storage', async () => {
      const stopped: string[] = []
      const removed: string[] = []
      expect(
        await stopPersonalSandbox('parked', {
          loadAgent: async () => ({ status: 'dormant', getPersonalSandboxIdForCleanup: () => 'agent_parked' }),
          getManager: () => ({
            stopSandbox: async (id) => {
              stopped.push(id)
              return { kind: 'stopped' as const }
            },
            removeSandbox: async (id) => void removed.push(id),
          }),
        })
      ).toEqual({ kind: 'stopped' })
      expect(stopped).toEqual(['agent_parked'])
      expect(removed).toEqual([])
    })

    it('reports a failed dormant compute stop for durable retry', async () => {
      expect(
        await stopPersonalSandbox('parked', {
          loadAgent: async () => ({ status: 'dormant', getPersonalSandboxIdForCleanup: () => 'agent_parked' }),
          getManager: () => ({
            stopSandbox: async () => {
              throw new Error('injected stop failure')
            },
            removeSandbox: async () => {},
          }),
          warn: () => {},
        })
      ).toBe(false)
    })
  })

  describe('stopAndArchivePersonalSandbox', () => {
    function agentStub(id: string, sandboxId: string) {
      return {
        id,
        getPersonalSandboxIdForCleanup: () => (sandboxId === `agent_${id}` ? sandboxId : null),
      } as any
    }

    it('stops and archives the real personal box of an already-terminated top-level agent', async () => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      await agent.update({ terminatedAt: new Date() })
      const operations: string[] = []

      await stopAndArchivePersonalSandbox(agent.id, {
        getManager: () => ({
          removeSandbox: async (id: string) => void operations.push(`remove:${id}`),
          reclaimSandboxStorage: async (id: string) => void operations.push(`storage:${id}`),
        }),
        archive: (id: string) => {
          operations.push(`archive:${id}`)
          return null
        },
      })

      expect(operations).toEqual([`remove:agent_${agent.id}`, `storage:agent_${agent.id}`, `archive:agent_${agent.id}`])
    })

    it('stops the pod and archives /private for a personal box', async () => {
      const removed: string[] = []
      const archived: string[] = []
      await stopAndArchivePersonalSandbox('p1', {
        loadAgent: async () => agentStub('p1', 'agent_p1'),
        getManager: () => ({ removeSandbox: async (id: string) => void removed.push(id) }) as any,
        archive: (id: string) => {
          archived.push(id)
          return null
        },
      })
      expect(removed).toEqual(['agent_p1'])
      expect(archived).toEqual(['agent_p1'])
    })

    it('is a no-op for a non-personal (subagent/system-manager) box', async () => {
      const removed: string[] = []
      const archived: string[] = []
      await stopAndArchivePersonalSandbox('s1', {
        loadAgent: async () => agentStub('s1', 'system_manager_u1'),
        getManager: () => ({ removeSandbox: async (id: string) => void removed.push(id) }) as any,
        archive: (id: string) => {
          archived.push(id)
          return null
        },
      })
      expect(removed).toEqual([])
      expect(archived).toEqual([])
    })

    it.each([
      ['a subagent parent box', crypto.randomUUID(), `agent_${crypto.randomUUID()}`],
      ['a system-manager box', crypto.randomUUID(), `system_manager_${crypto.randomUUID()}`],
      ['a squad box', crypto.randomUUID(), `squad_${crypto.randomUUID()}`],
    ])('does not touch %s', async (_label, agentId, sandboxId) => {
      const operations: string[] = []
      await reclaimPersonalSandbox(agentId, sandboxId, {
        getManager: () => ({
          removeSandbox: async () => void operations.push('remove'),
          reclaimSandboxStorage: async () => void operations.push('storage'),
        }),
        archive: () => {
          operations.push('archive')
          return null
        },
      })
      expect(operations).toEqual([])
    })

    it('reclaims storage after removing a personal container and before archiving', async () => {
      const id = crypto.randomUUID()
      const operations: string[] = []
      await stopAndArchivePersonalSandbox(id, {
        loadAgent: async () => agentStub(id, `agent_${id}`),
        getManager: () => ({
          removeSandbox: async (sandboxId: string) => void operations.push(`remove:${sandboxId}`),
          reclaimSandboxStorage: async (sandboxId: string) => void operations.push(`storage:${sandboxId}`),
        }),
        archive: (sandboxId: string) => {
          operations.push(`archive:${sandboxId}`)
          return null
        },
      })
      expect(operations).toEqual([`remove:agent_${id}`, `storage:agent_${id}`, `archive:agent_${id}`])
    })

    // Neither storage reclaim NOR archive may run when removal failed: the box
    // is still live. Archiving it here is what filled a tenant's disk (see the
    // regression test below).
    it('does neither storage reclaim nor archive when container removal fails', async () => {
      const id = crypto.randomUUID()
      const operations: string[] = []
      const warnings: string[] = []
      await stopAndArchivePersonalSandbox(id, {
        loadAgent: async () => agentStub(id, `agent_${id}`),
        warn: (message) => warnings.push(message),
        getManager: () => ({
          removeSandbox: async () => {
            throw new Error('Docker unavailable')
          },
          reclaimSandboxStorage: async () => void operations.push('storage'),
        }),
        archive: () => {
          operations.push('archive')
          return null
        },
      })
      expect(operations).toEqual([])
      expect(warnings).toEqual([`Failed to remove personal sandbox agent_${id} for agent ${id}`])
    })

    it('swallows storage cleanup errors and still archives', async () => {
      const id = crypto.randomUUID()
      const operations: string[] = []
      const warnings: string[] = []
      await stopAndArchivePersonalSandbox(id, {
        loadAgent: async () => agentStub(id, `agent_${id}`),
        warn: (message) => warnings.push(message),
        getManager: () => ({
          removeSandbox: async () => void operations.push('remove'),
          reclaimSandboxStorage: async () => {
            throw new Error('cleanup failed')
          },
        }),
        archive: () => {
          operations.push('archive')
          return null
        },
      })
      expect(operations).toEqual(['remove', 'archive'])
      expect(warnings).toEqual([`Failed to reclaim sandbox storage agent_${id} for agent ${id}`])
    })

    it('reports incomplete final private archival for durable retry', async () => {
      expect(
        await reclaimPersonalSandbox('partial', 'agent_partial', {
          getManager: () => ({ removeSandbox: async () => {} }),
          archive: () => {
            throw new Error('archive unavailable')
          },
        })
      ).toBe(false)
    })

    // This test used to assert the opposite — "swallows removeSandbox errors and
    // still archives" — and that assertion was protecting a disk-filling loop.
    // Archiving renames the private dir out from under a box that is still
    // LIVE, so the box recreates it and the next sweep archives it again. On a
    // tenant whose removeSandbox started timing out, three agents produced 728
    // archives and 67GB in five and a half hours and filled the disk to 100%.
    it('does NOT archive when removeSandbox failed — the box is still live', async () => {
      const archived: string[] = []
      const complete = await stopAndArchivePersonalSandbox('p2', {
        loadAgent: async () => agentStub('p2', 'agent_p2'),
        getManager: () =>
          ({
            removeSandbox: async () => {
              throw new Error('ssh command timed out after 30000ms')
            },
          }) as any,
        archive: (id: string) => {
          archived.push(id)
          return null
        },
      })
      expect(archived).toEqual([])
      // False keeps the durable retry: the archive happens on the pass where
      // removal actually succeeds, not never.
      expect(complete).toBe(false)
    })

    it('archives once removal succeeds', async () => {
      const archived: string[] = []
      const complete = await stopAndArchivePersonalSandbox('p3', {
        loadAgent: async () => agentStub('p3', 'agent_p3'),
        getManager: () => ({ removeSandbox: async () => {} }) as any,
        archive: (id: string) => {
          archived.push(id)
          return null
        },
      })
      expect(archived).toEqual(['agent_p3'])
      expect(complete).toBe(true)
    })

    // The regression itself: a persistently failing removal must not accumulate
    // one archive per sweep. Ten sweeps, zero archives.
    it('a persistently failing removal never accumulates archives across sweeps', async () => {
      const archived: string[] = []
      for (let sweep = 0; sweep < 10; sweep++) {
        await stopAndArchivePersonalSandbox('p4', {
          loadAgent: async () => agentStub('p4', 'agent_p4'),
          getManager: () =>
            ({
              removeSandbox: async () => {
                throw new Error('ssh command timed out after 30000ms')
              },
            }) as any,
          archive: (id: string) => {
            archived.push(id)
            return null
          },
        })
      }
      expect(archived).toHaveLength(0)
    })
  })
})
