import { afterAll, afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test, beforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'

// Mirrors concurrency-limits.pickup.test.ts's timeout rationale: real
// execution-lifecycle transitions with waitFor budgets up to 15s.
setDefaultTimeout(30000)
import { and, eq, inArray, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'node:url'
import { db } from '../../db'
import {
  agents,
  agentTypes,
  executions,
  executionAdmissionReservations,
  instanceMaintenanceState,
  machineBoxes,
  messages,
  squads,
  workStreams,
  workStreamWorktrees,
  worktreeCleanupJobs,
} from '../../db/schema'
import { Agent } from '../../entities/Agent'
import { AgentType } from '../../entities/AgentType'
import { Execution } from '../../entities/Execution'
import { SquadWorkerRunner } from '../../entities/agent-runners/squad-worker-runner'
import { PROVIDERS_WITHOUT_AUTH } from '../model-selection/select-model'
import {
  isSessionActive,
  registerSession,
  releaseSessionReservation,
  removeSession,
  reserveSession,
  resetWorkerShuttingDownForTests,
  shutdownActiveSessions,
} from './session-state'
import * as sessionState from './session-state'
import { MockAgentSession } from './test-helpers'
import { concurrencyLimiter } from './concurrency-limiter-instance'
import { executionLifecycleRegistry } from './lifecycle-registry'
import {
  attemptPickup,
  setBoxMigratingLockedCheckForTests,
  setPickupAdmissionVerifiedHookForTests,
  setPickupExecutionLockedHookForTests,
} from './pickup'
import {
  recoverInterruptedExecutionsForStartup,
  requeueAbandonedLeaseExecutions,
  requeueOwnedExecutionsForShutdown,
} from './startup-recovery'
import { reconcileDuplicateActiveExecutions } from './admission-reconciliation'
import {
  areBoxesMigratingLocked,
  bindMachineBox,
  clearBoxMigrating,
  deleteMachine,
  fenceBoxForMigration,
  insertMachine,
} from '../machines/queries'
import { sandboxHasActiveExecution } from '../machines/box-migrate'
import type postgres from 'postgres'
import { createPostgresConnection, getConnectionString } from '../../db/connection'
import { maintenanceStore } from '../maintenance'
import { MaintenanceStore } from '../maintenance/store'
import { runQueueWatchdogOnce, WATCHDOG_INTERVAL_MS } from './queue-watchdog'
import { turnHooks } from '../turn-hooks'
import { AdmissionReservationStore, setAdmissionHeartbeatIntervalForTests } from '../maintenance/admission-reservation'
import { MaintenanceWorkerController } from '../maintenance/worker-controller'
import { eventEmitter } from '../../lib/infra/event-emitter'
import {
  ADMISSION_LIVENESS_HASH_SEED,
  ADMISSION_LIVENESS_LOCK_VERSION,
  admissionProcessIncarnation,
} from '../maintenance/process-liveness'

// This file's suite spawns real bun subprocesses (fence-interleaving workers,
// admission-lock holders) and drives real execution-lifecycle timing under
// waitFor budgets — too jitter-prone for the shared CI runner. It runs only
// in the dedicated `subprocess-tests` CI job (see ci.yml); the main sweep
// sets FICUS_TEST_SKIP_SUBPROCESS=1 to skip it here.
const describeSubprocess = describe.skipIf(process.env.FICUS_TEST_SKIP_SUBPROCESS === '1')

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
beforeAll(async () => {
  if (process.env.FICUS_TEST_SKIP_SUBPROCESS === '1') return
  releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()
})
afterAll(() => {
  if (process.env.FICUS_TEST_SKIP_SUBPROCESS === '1') return
  return releaseMaintenanceIsolation?.()
})

// A genuinely SEPARATE Postgres connection (not another handle on `db`'s
// pool), for driving fence interleavings from the outside: holding the box
// row's `FOR UPDATE` lock in an open transaction while attemptPickup runs,
// and probing with `FOR UPDATE NOWAIT` (SQLSTATE 55P03 = lock held
// elsewhere) — same harness pattern as machines/queries.test.ts.
const secondConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })

// Dedicated max:1 connection for ADMISSION-LIVENESS release proofs: taking
// the killed worker's advisory lock (and immediately releasing it) is the
// only way to observe that Postgres has actually reaped its sessions. See
// ManagedRestartWorker.close() for why close() must WAIT for that proof.
const livenessProofConnection = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  if (process.env.FICUS_TEST_SKIP_SUBPROCESS === '1') return
  await Promise.all([secondConnection.end(), livenessProofConnection.end()])
})

async function holdAdmissionLockInChild(incarnation: string): Promise<ManagedRestartWorker> {
  const script = `
    import postgres from 'postgres'
    const sql = postgres(process.env.TEST_DATABASE_URL, { max: 1 })
    await sql\`SELECT pg_advisory_lock(hashtextextended(\${process.env.LOCK_VERSION} || \${process.env.INCARNATION}, \${Number(process.env.LOCK_SEED)}))\`
    console.log(JSON.stringify({ type: 'locked' }))
    await new Promise(() => {})
  `
  const child = new ManagedRestartWorker(
    Bun.spawn(['bun', '-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TEST_DATABASE_URL: getConnectionString(),
        LOCK_VERSION: ADMISSION_LIVENESS_LOCK_VERSION,
        LOCK_SEED: String(ADMISSION_LIVENESS_HASH_SEED),
        INCARNATION: incarnation,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
    incarnation
  )
  restartWorkers.add(child)
  try {
    await child.waitForEvent('locked')
    return child
  } catch (error) {
    await child.close()
    throw error
  }
}

type RestartWorkerProcess = ReturnType<typeof Bun.spawn>
type RestartWorkerEvent = Record<string, unknown>

class ManagedRestartWorker {
  private readonly waiters = new Map<string, Array<(event: RestartWorkerEvent) => void>>()
  private readonly events = new Map<string, RestartWorkerEvent[]>()
  private readonly stderrChunks: string[] = []
  /** The worker's admission-liveness incarnation, learned from its first event that carries one. */
  private livenessIncarnation: string | undefined
  private resolveLivenessProofBlocked!: () => void
  private readonly livenessProofBlocked = new Promise<void>((resolve) => {
    this.resolveLivenessProofBlocked = resolve
  })
  readonly stdoutTask: Promise<void>
  readonly stderrTask: Promise<void>

  constructor(
    readonly process: RestartWorkerProcess,
    livenessIncarnation?: string
  ) {
    this.livenessIncarnation = livenessIncarnation
    this.stdoutTask = this.drainStdout()
    this.stderrTask = this.drainStderr()
  }

  private async drainStdout(): Promise<void> {
    const decoder = new TextDecoder()
    let pending = ''
    const reader = (this.process.stdout as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as RestartWorkerEvent
          const type = String(event.type)
          if (this.livenessIncarnation === undefined && typeof event.incarnation === 'string') {
            this.livenessIncarnation = event.incarnation
          }
          const waiter = this.waiters.get(type)?.shift()
          if (waiter) waiter(event)
          else this.events.set(type, [...(this.events.get(type) ?? []), event])
        } catch {
          // Production logs are intentionally ignored; structured fixture JSON is retained.
        }
      }
    }
  }

  /** Test synchronization: resolves after close()'s proof observes the server-side lock still held. */
  waitForBlockedLivenessProof(): Promise<void> {
    return this.livenessProofBlocked
  }

  private async drainStderr(): Promise<void> {
    const decoder = new TextDecoder()
    const reader = (this.process.stderr as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      this.stderrChunks.push(decoder.decode(chunk, { stream: true }))
    }
  }

  /**
   * Every wait on a child is deadline-bounded so a silently wedged worker
   * fails THIS phase with a message naming what was awaited, instead of
   * consuming the whole test budget and dying as an anonymous "timed out
   * after 60000ms" (the shape of the 2026-08-20/21 CI failures, where a
   * worker's first DB query hung forever in an unbounded socket connect).
   */
  private describeWorker(): string {
    const status = this.process.exitCode === null ? 'still running' : `exited ${this.process.exitCode}`
    return `pid ${this.process.pid} (${status}); stderr so far: ${this.stderrChunks.join('') || '(empty)'}`
  }

  async waitForEvent(type: string, timeoutMs = 45_000): Promise<RestartWorkerEvent> {
    const queued = this.events.get(type)?.shift()
    if (queued) return queued
    const event = new Promise<RestartWorkerEvent>((resolve) => {
      this.waiters.set(type, [...(this.waiters.get(type) ?? []), resolve])
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        event,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for restart worker event '${type}': ${this.describeWorker()}`
              )
            )
          }, timeoutMs)
        }),
        this.process.exited.then(async (code) => {
          await Promise.all([this.stdoutTask, this.stderrTask])
          const arrived = this.events.get(type)?.shift()
          if (arrived) return arrived
          throw new Error(`Restart worker exited ${code} before ${type}: ${this.stderrChunks.join('')}`)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
  }

  async awaitExit(timeoutMs = 45_000): Promise<number> {
    let deadline: ReturnType<typeof setTimeout> | undefined
    let code: number
    try {
      code = await Promise.race([
        this.process.exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            reject(
              new Error(`Timed out after ${timeoutMs}ms waiting for restart worker exit: ${this.describeWorker()}`)
            )
          }, timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(deadline)
    }
    await Promise.all([this.stdoutTask, this.stderrTask])
    restartWorkers.delete(this)
    return code
  }

  async close(): Promise<void> {
    if (this.process.exitCode === null) this.process.kill('SIGKILL')
    await this.awaitExit()
    const incarnation = this.livenessIncarnation
    if (incarnation === undefined) return
    // The SIGKILL is only half the death. Postgres keeps the killed worker's
    // sessions — and their locks — until each backend notices the closed
    // socket, which is asynchronous and unbounded in principle (measured on
    // this harness: p50 ≈ 1.5ms, p99 ≈ 30ms, never zero). Startup recovery's
    // dead-owner proof is a single un-retried pg_try_advisory_xact_lock, so a
    // caller that recovers immediately after close() used to race that reap
    // window and see a live owner (the startup-recovery flake family). close()
    // therefore does not resolve until the server has ACTUALLY released the
    // worker's admission-liveness lock: it polls the exact proof recovery uses
    // (try-lock), and immediately re-releases so nothing here holds the key.
    await waitFor(
      async () => {
        const [proof] = await livenessProofConnection<{ released: boolean }[]>`
          SELECT pg_try_advisory_lock(
            hashtextextended(
              ${ADMISSION_LIVENESS_LOCK_VERSION} || ${incarnation},
              ${ADMISSION_LIVENESS_HASH_SEED}
            )
          ) AS released
        `
        if (!proof?.released) {
          this.resolveLivenessProofBlocked()
          return false
        }
        await livenessProofConnection`
          SELECT pg_advisory_unlock(
            hashtextextended(
              ${ADMISSION_LIVENESS_LOCK_VERSION} || ${incarnation},
              ${ADMISSION_LIVENESS_HASH_SEED}
            )
          )
        `
        return true
      },
      {
        timeoutMs: 5_000,
        intervalMs: 2,
        description: `server-side release of restart worker (${this.process.pid ?? 'unknown pid'}) admission liveness lock`,
      }
    )
  }
}

const restartWorkers = new Set<ManagedRestartWorker>()

// Mutation: restoring the repository-relative fixture path passes from the
// repository root but fails from apps/core with Module not found.
function spawnRestartWorker(mode: 'owner' | 'successor', executionId: string, target?: string) {
  const managed = new ManagedRestartWorker(
    Bun.spawn(
      [
        'bun',
        fileURLToPath(new URL('../maintenance/fixtures/admission-restart-worker.ts', import.meta.url)),
        mode,
        executionId,
        ...(target ? [target] : []),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: getConnectionString() },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )
  )
  restartWorkers.add(managed)
  return managed
}

async function cleanupRestartWorkers(): Promise<void> {
  await Promise.all([...restartWorkers].map((child) => child.close()))
  if (restartWorkers.size !== 0) throw new Error(`Failed to join ${restartWorkers.size} restart worker(s)`)
}

/**
 * Force a killed worker's liveness lock to remain held after its process exits,
 * then prove close() does not return until that server-side hold is released.
 * The holder must be a distinct session because advisory locks are re-entrant
 * per session.
 */
async function expectCloseWaitsForLivenessLockRelease(
  worker: ManagedRestartWorker,
  incarnation: string
): Promise<void> {
  const forcedHolder = createPostgresConnection(getConnectionString(), { max: 1, onnotice: () => {} })
  let closeResolved = false
  let closing: Promise<void> | undefined
  try {
    worker.process.kill('SIGKILL')
    // postgres.js queries are lazy: awaiting this blocking acquire executes it.
    // Whether it waits briefly for the killed worker's backend to reap or finds
    // the key already free, forcedHolder owns the key before close() begins.
    await forcedHolder`
      SELECT pg_advisory_lock(
        hashtextextended(
          ${ADMISSION_LIVENESS_LOCK_VERSION} || ${incarnation},
          ${ADMISSION_LIVENESS_HASH_SEED}
        )
      )
    `
    closing = worker.close().then(() => {
      closeResolved = true
    })
    const first = await Promise.race([
      worker.waitForBlockedLivenessProof().then(() => 'proof-blocked' as const),
      closing.then(() => 'closed' as const),
    ])
    expect(first).toBe('proof-blocked')
    expect(closeResolved).toBe(false)
    await forcedHolder`
      SELECT pg_advisory_unlock(
        hashtextextended(
          ${ADMISSION_LIVENESS_LOCK_VERSION} || ${incarnation},
          ${ADMISSION_LIVENESS_HASH_SEED}
        )
      )
    `
    await closing
    expect(closeResolved).toBe(true)
  } finally {
    // Ending the holder releases the lock if an assertion failed before the
    // explicit unlock, allowing a pending fixed close() to finish cleanly.
    await forcedHolder.end()
    await closing
    if (restartWorkers.has(worker)) await worker.close()
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50, description = 'condition' } = options
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

describeSubprocess('attemptPickup result matrix', () => {
  const createdAgentIds: string[] = []
  const createdExecutionIds: string[] = []
  const createdSquadIds: string[] = []
  const createdAgentTypeIds: string[] = []
  const createdMachineIds: string[] = []
  let originalZaiLimit: number | undefined
  let createSessionSpy: ReturnType<typeof spyOn> | undefined
  let soakPendingMessagesSpy: ReturnType<typeof spyOn> | undefined
  let createdSessions: MockAgentSession[]
  let sessionCreated: Promise<void>
  let markSessionCreated: () => void

  beforeEach(() => {
    concurrencyLimiter.reset()
    originalZaiLimit = (concurrencyLimiter as any).limits.zai
    ;(concurrencyLimiter as any).limits.zai = 1
    PROVIDERS_WITHOUT_AUTH.add('zai')
    createdSessions = []
    sessionCreated = new Promise<void>((resolve) => (markSessionCreated = resolve))
    createSessionSpy = spyOn(SquadWorkerRunner.prototype as any, 'createSession').mockImplementation(async function (
      this: any,
      scope: any
    ) {
      return this.createPiSession(scope, async () => {
        const session = new MockAgentSession()
        ;(session as any).selectedSpec = await this.agent.getEffectiveModelSpec(this.agentType.model)
        createdSessions.push(session)
        markSessionCreated()
        return session as any
      })
    })
  })

  afterEach(async () => {
    resetWorkerShuttingDownForTests()
    setPickupExecutionLockedHookForTests()
    await cleanupRestartWorkers()
    soakPendingMessagesSpy?.mockRestore()
    soakPendingMessagesSpy = undefined
    for (const session of createdSessions) session.pi.simulateNormalEnd('test cleanup')
    const settlementResults = await Promise.allSettled(
      createdExecutionIds.map(async (executionId) => {
        const lifecycle = executionLifecycleRegistry.get(executionId)
        if (lifecycle) {
          await lifecycle.requestMaintenanceInterrupt()
          await lifecycle.runnerFinished
          lifecycle.settle()
          await lifecycle.settled
        }
        const execution = await Execution.find(executionId)
        if (execution?.status === 'running') await execution.stop()
        const settled = await Execution.find(executionId)
        if (settled?.status === 'running')
          throw new Error(`Owned execution ${executionId} remained running after cleanup`)
      })
    )
    const settlementErrors = settlementResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )

    if (createdExecutionIds.length > 0) {
      await db
        .delete(executionAdmissionReservations)
        .where(inArray(executionAdmissionReservations.executionId, createdExecutionIds))
    }

    createSessionSpy?.mockRestore()
    createSessionSpy = undefined
    if (originalZaiLimit === undefined) delete (concurrencyLimiter as any).limits.zai
    else (concurrencyLimiter as any).limits.zai = originalZaiLimit
    PROVIDERS_WITHOUT_AUTH.delete('zai')

    for (const executionId of createdExecutionIds.splice(0)) {
      concurrencyLimiter.release(executionId)
    }
    concurrencyLimiter.reset()
    const ownedAgentIds = createdAgentIds.splice(0)
    for (const agentId of ownedAgentIds) {
      removeSession(agentId)
      await db.delete(messages).where(eq(messages.agentId, agentId))
      await db.delete(executions).where(eq(executions.agentId, agentId))
      await db.delete(agents).where(eq(agents.id, agentId))
    }
    for (const squadId of createdSquadIds.splice(0)) {
      await db.delete(squads).where(eq(squads.id, squadId))
    }
    const activeOwnedAgents = ownedAgentIds.filter((agentId) => isSessionActive(agentId))
    if (activeOwnedAgents.length > 0)
      settlementErrors.push(new Error(`Owned sessions remained active: ${activeOwnedAgents.join(', ')}`))

    for (const agentTypeId of createdAgentTypeIds.splice(0)) {
      await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
    }

    // machine_boxes cascade off machines, so deleting the machine is enough.
    for (const machineId of createdMachineIds.splice(0)) {
      await deleteMachine(machineId)
    }
    if (settlementErrors.length > 0) throw new AggregateError(settlementErrors, 'Owned pickup cleanup failed')
  })

  async function createSquadAgent(model: string): Promise<Agent> {
    const agentTypeId = `pickup-matrix-${randomUUID()}`
    createdAgentTypeIds.push(agentTypeId)
    await AgentType.create({
      id: agentTypeId,
      name: 'Pickup Matrix Worker',
      model,
      systemPrompt: 'You are an attemptPickup result-matrix test worker.',
    })

    const [squad] = await db
      .insert(squads)
      .values({ name: 'Pickup Matrix Squad', purpose: 'Exercise attemptPickup outcomes' })
      .returning()
    createdSquadIds.push(squad.id)

    const agent = await Agent.create({ agentTypeId, squadId: squad.id })
    createdAgentIds.push(agent.id)
    return agent
  }

  async function seedStrandedQueuedAdmission(agent: Agent, execution: Execution, ownerIncarnation: string) {
    const lease = {
      token: randomUUID(),
      claimEpoch: 71n,
      ownerId: 'stranded-owner',
      ownerIncarnation,
      admittedGeneration: 73,
      admittedHolderRevision: 79n,
    }
    await db
      .update(executionAdmissionReservations)
      .set({
        agentId: agent.id,
        state: 'running',
        phase: 'none',
        phaseSequence: 8,
        operationId: randomUUID(),
        resourceKey: 'stranded-resource',
        leaseExpiresAt: new Date(0),
        lastHeartbeatAt: new Date(0),
        revokeGeneration: 83,
        revokeHolderRevision: 89n,
        revokeAdminHold: true,
        revokeLeaseId: randomUUID(),
        revokeLeaseOwnerTokenId: randomUUID(),
        revokeRequestedAt: new Date(0),
        recoveryOwnerId: 'old-recovery-owner',
        recoveryOwnerIncarnation: randomUUID(),
        ...lease,
      })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    return lease
  }

  async function expectCanonicalQueuedAdmission(executionId: string, agentId: string) {
    const [row] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, executionId))
    expect(row).toMatchObject({
      executionId,
      agentId,
      state: 'queued',
      token: null,
      claimEpoch: null,
      ownerId: null,
      ownerIncarnation: null,
      admittedGeneration: null,
      admittedHolderRevision: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      phase: 'none',
      phaseSequence: 0,
      operationId: null,
      resourceKey: null,
      revokeGeneration: null,
      revokeHolderRevision: null,
      revokeAdminHold: null,
      revokeLeaseId: null,
      revokeLeaseOwnerTokenId: null,
      revokeRequestedAt: null,
      recoveryOwnerId: null,
      recoveryOwnerIncarnation: null,
    })
    return row
  }

  for (const concurrent of [false, true]) {
    test(`cleanup claim and actual queued pickup serialize (${concurrent ? 'concurrent' : 'cleanup first'})`, async () => {
      const { claimWorktreeCleanup } = await import('../work-streams/worktree-cleanup-store')
      const agent = await createSquadAgent('zai:glm-5.2')
      const ownership = {
        workspace: '/fixture',
        repository: '/fixture/repo',
        commonDirectory: '/fixture/repo/.git',
        gitDirectory: '/fixture/repo/.git/worktrees/feature',
        worktree: '/fixture/feature',
        directoryIdentity: '1:2',
        branch: 'feature',
      }
      const metadata = {
        git: { repository: ownership.repository, worktree: ownership.worktree, branch: ownership.branch },
      }
      const head = 'a'.repeat(40)
      const [stream] = await db
        .insert(workStreams)
        .values({
          squadId: agent.squadId!,
          title: 'cleanup pickup race',
          status: 'done',
          autoCleanupWorktree: true,
          agentIds: [agent.id],
          metadata,
        })
        .returning()
      try {
        await db.insert(workStreamWorktrees).values({ workStreamId: stream.id, squadId: agent.squadId!, ownership })
        await db
          .insert(worktreeCleanupJobs)
          .values({ workStreamId: stream.id, deliveredHead: head, deliveryMetadata: metadata })
        const claim = async () =>
          claimWorktreeCleanup(stream.id, {
            generation: (
              await db.select().from(worktreeCleanupJobs).where(eq(worktreeCleanupJobs.workStreamId, stream.id))
            )[0]!.generation,
            ownership,
            metadata,
            head,
          })
        const queue = () => agent.queueExecution({ message: 'late associated inbox work' })
        const [removal, execution] = concurrent ? await Promise.all([claim(), queue()]) : [await claim(), await queue()]
        createdExecutionIds.push(execution.id)
        if (!concurrent) expect(removal).not.toBeNull()
        if (removal) {
          expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('lost-race')
          expect(createdSessions).toHaveLength(0)
        } else {
          const [job] = await db
            .select()
            .from(worktreeCleanupJobs)
            .where(eq(worktreeCleanupJobs.workStreamId, stream.id))
          expect(job.status).toBe('deferred')
        }
        expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      } finally {
        await db.delete(workStreams).where(eq(workStreams.id, stream.id))
      }
    })
  }

  test('an execution whose agent was terminated is settled, not deferred forever', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'queued moments after termination' })
    createdExecutionIds.push(execution.id)

    // The production race: termination lands, then an enqueue for the same agent
    // slips in ~1s later. Nothing cancels the already-queued row today, so pickup
    // is the only thing standing between that row and an endless retry loop.
    await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))

    // Re-read so pickup resolves the agent from the DB rather than a stale handle.
    const pickupExecution = await Execution.mustFind(execution.id)
    expect(await attemptPickup(pickupExecution)).toBe('not-queued')

    // Terminal, not queued: a deferred row here churns forever, because a
    // terminated agent fails resolveLiveSandboxOwner identically on every tick.
    const settled = await Execution.mustFind(execution.id)
    expect(settled.status).toBe('failed')
    // Machine-readable outcome for the removed agent, and — critically — the
    // settle must not write the agent row: the generic failure disposition
    // (status -> idle) would resurrect the terminated agent.
    expect(settled.failureClass).toBe('execution_failure')
    expect(settled.failureReason).toBe('agent_removed')
    expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
  })

  test('an execution whose agent row no longer exists is settled, not deferred forever', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'orphaned by a hard agent delete' })
    createdExecutionIds.push(execution.id)

    // FK-bypassed removal: the executions row survives its agent's delete
    // (the production orphans were left behind exactly this way during the
    // 2026-09-02/03 consolidation).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`)
      await tx.delete(agents).where(eq(agents.id, agent.id))
    })

    expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('not-queued')

    const settled = await Execution.mustFind(execution.id)
    expect(settled.status).toBe('failed')
    expect(settled.failureReason).toBe('agent_removed')
  })

  test('a wake-eligible queued execution wakes a dormant agent before pickup', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    try {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({
        message: 'genuine inbound work',
        metadata: { wakeEligible: true },
      })
      createdExecutionIds.push(execution.id)
      await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))

      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('started')
      const refreshed = await Agent.mustFind(agent.id)
      expect(refreshed.status).toBe('active')
      expect(refreshed.dormantAt).toBeNull()
      expect((refreshed.metadata as Record<string, unknown>).wakeCompletionPending).toBeUndefined()
      expect(ensure).toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
    }
  })

  test('does not start a runner when wake completion loses its final lifecycle clear', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const { setCompleteWakeBeforeClearHookForTest } = await import('../agent/lifecycle')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'genuine inbound work', metadata: { wakeEligible: true } })
    createdExecutionIds.push(execution.id)
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
    setCompleteWakeBeforeClearHookForTest(async () => {
      setCompleteWakeBeforeClearHookForTest(undefined)
      await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
    })
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('no-capacity')
    } finally {
      setCompleteWakeBeforeClearHookForTest(undefined)
      ensure.mockRestore()
      mint.mockRestore()
    }
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
  })

  test('makes only one nonblocking dormancy-completion attempt during pickup', async () => {
    const lifecycle = await import('../agent/lifecycle')
    const completion = spyOn(lifecycle, 'completeDormancyIfPending').mockResolvedValue(false)
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'blocked dormancy completion' })
    createdExecutionIds.push(execution.id)
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('no-capacity')
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(completion).toHaveBeenCalledTimes(1)
      expect(completion).toHaveBeenCalledWith(agent.id, { timeoutMs: 0 })
    } finally {
      completion.mockRestore()
    }
  })

  test('a non-waking queued execution cannot pick up while its agent is dormant', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'housekeeping', metadata: { wakeEligible: false } })
    createdExecutionIds.push(execution.id)
    await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))

    expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('no-capacity')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
  })

  test('the locked start guard rejects pickup after dormancy has been requested', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'queued work' })
    createdExecutionIds.push(execution.id)
    await db.update(agents).set({ pendingDormancyAt: new Date() }).where(eq(agents.id, agent.id))

    expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('lost-race')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
  })

  test('the locked start guard rejects an execution when final termination wins the pickup race', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'queued work' })
    createdExecutionIds.push(execution.id)
    const original = Agent.prototype.getExecutionSandboxIds
    let changed = false
    const resolveSandbox = spyOn(Agent.prototype, 'getExecutionSandboxIds').mockImplementation(async function (
      this: Agent
    ) {
      if (this.id === agent.id && !changed) {
        changed = true
        await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))
      }
      return original.call(this)
    })
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('lost-race')
    } finally {
      resolveSandbox.mockRestore()
    }
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
  })

  test('the locked start guard completes wake side effects when eligible work wins a dormancy race', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'genuine work', metadata: { wakeEligible: true } })
    createdExecutionIds.push(execution.id)
    const original = Agent.prototype.getExecutionSandboxIds
    let changed = false
    const resolveSandbox = spyOn(Agent.prototype, 'getExecutionSandboxIds').mockImplementation(async function (
      this: Agent
    ) {
      if (this.id === agent.id && !changed) {
        changed = true
        await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
      }
      return original.call(this)
    })
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('started')
      const refreshed = await Agent.mustFind(agent.id)
      expect(refreshed.status).toBe('active')
      expect((refreshed.metadata as Record<string, unknown>).wakeCompletionPending).toBeUndefined()
      expect(ensure).toHaveBeenCalled()
    } finally {
      resolveSandbox.mockRestore()
      ensure.mockRestore()
    }
  })

  test('requeues a locked pickup when wake completion loses its final lifecycle clear', async () => {
    const agentWarmup = await import('../sandbox/agent-warmup')
    const { setCompleteWakeBeforeClearHookForTest } = await import('../agent/lifecycle')
    const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'genuine work', metadata: { wakeEligible: true } })
    createdExecutionIds.push(execution.id)
    const original = Agent.prototype.getExecutionSandboxIds
    let changed = false
    const resolveSandbox = spyOn(Agent.prototype, 'getExecutionSandboxIds').mockImplementation(async function (
      this: Agent
    ) {
      if (this.id === agent.id && !changed) {
        changed = true
        await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
      }
      return original.call(this)
    })
    setCompleteWakeBeforeClearHookForTest(async () => {
      setCompleteWakeBeforeClearHookForTest(undefined)
      await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
    })
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('no-capacity')
    } finally {
      setCompleteWakeBeforeClearHookForTest(undefined)
      resolveSandbox.mockRestore()
      ensure.mockRestore()
      mint.mockRestore()
    }
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect(isSessionActive(agent.id)).toBe(false)
  })

  test('the locked start guard rejects a non-waking execution when dormancy wins the pickup race', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'housekeeping', metadata: { wakeEligible: false } })
    createdExecutionIds.push(execution.id)
    const original = Agent.prototype.getExecutionSandboxIds
    let changed = false
    const resolveSandbox = spyOn(Agent.prototype, 'getExecutionSandboxIds').mockImplementation(async function (
      this: Agent
    ) {
      if (this.id === agent.id && !changed) {
        changed = true
        await db.update(agents).set({ status: 'dormant', dormantAt: new Date() }).where(eq(agents.id, agent.id))
      }
      return original.call(this)
    })
    try {
      expect(await attemptPickup(await Execution.mustFind(execution.id))).toBe('lost-race')
    } finally {
      resolveSandbox.mockRestore()
    }
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
  })

  test('runtime reconciliation restores the exact stranded queued admission and pickup starts once', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'stranded queued admission' })
    createdExecutionIds.push(execution.id)
    const ownerIncarnation = randomUUID()
    const owner = await holdAdmissionLockInChild(ownerIncarnation)
    const lease = await seedStrandedQueuedAdmission(agent, execution, ownerIncarnation)
    await owner.close()

    await new MaintenanceWorkerController().reconcileNow()

    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('started')
    const active = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.agentId, agent.id), inArray(executions.status, ['queued', 'running'])))
    expect(active).toEqual([{ id: execution.id }])
    const [claimed] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(claimed.token).not.toBeNull()
    expect(claimed.token).not.toBe(lease.token)
    await sessionCreated
    expect(createdSessions).toHaveLength(1)
  })

  test('runtime queued-admission recovery never steals from a live owner', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'live stranded admission owner' })
    createdExecutionIds.push(execution.id)
    const ownerIncarnation = randomUUID()
    const owner = await holdAdmissionLockInChild(ownerIncarnation)
    await seedStrandedQueuedAdmission(agent, execution, ownerIncarnation)
    const executionBefore = (await Execution.mustFind(execution.id)).toJson()
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await new MaintenanceWorkerController().reconcileNow()

    expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore)
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservationAfter).toEqual(reservationBefore)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('lost-race')

    await owner.close()
    await new MaintenanceWorkerController().reconcileNow()
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
  })

  test('runtime queued-admission recovery preserves a future lease from a dead owner', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'runtime future stranded lease' })
    createdExecutionIds.push(execution.id)
    await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const executionBefore = (await Execution.mustFind(execution.id)).toJson()
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    await new MaintenanceWorkerController().reconcileNow()

    expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore)
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservationAfter).toEqual(reservationBefore)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('lost-race')
  })

  test('startup recovery restores an expired dead-owner admission for an already queued execution', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'startup stranded admission' })
    createdExecutionIds.push(execution.id)
    const ownerIncarnation = randomUUID()
    const owner = await holdAdmissionLockInChild(ownerIncarnation)
    const lease = await seedStrandedQueuedAdmission(agent, execution, ownerIncarnation)
    await owner.close()

    expect(await recoverInterruptedExecutionsForStartup()).toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('started')
    const active = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.agentId, agent.id), inArray(executions.status, ['queued', 'running'])))
    expect(active).toEqual([{ id: execution.id }])
    const [claimed] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(claimed.token).not.toBeNull()
    expect(claimed.token).not.toBe(lease.token)
    await sessionCreated
    expect(createdSessions).toHaveLength(1)
  })

  test('the lease watchdog requeues a running execution whose lease expired under a LIVE owner', async () => {
    // The gap startup recovery cannot close: it requeues a foreign incarnation only
    // when pg_try_advisory_xact_lock proves the owner dead. Here the owner process is
    // still alive (holding its lock) but has stopped heartbeating, so that proof fails
    // and the row would sit `running` forever — the agent looks busy and does nothing.
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'abandoned lease' })
    createdExecutionIds.push(execution.id)
    const ownerIncarnation = randomUUID()
    const owner = await holdAdmissionLockInChild(ownerIncarnation)
    try {
      const lease = await seedStrandedQueuedAdmission(agent, execution, ownerIncarnation)
      await db
        .update(executions)
        .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
        .where(eq(executions.id, execution.id))

      // Startup recovery cannot touch it: the owner is demonstrably alive.
      expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).status).toBe('running')

      // The watchdog needs no liveness inference — the expired lease is the proof.
      expect(await requeueAbandonedLeaseExecutions()).toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      await expectCanonicalQueuedAdmission(execution.id, agent.id)
      // The notice must say what actually happened. This is a lapsed lease with
      // no process restart — labelling it "after a process restart" sent a live
      // debugging session hunting for a restart that never occurred.
      const notices = await db.select().from(messages).where(eq(messages.agentId, agent.id))
      expect(notices.map((m) => m.content)).toContain(
        '[System] Agent recovered after its execution was interrupted (admission lease lapsed).'
      )
      expect(notices.map((m) => m.content)).not.toContain('[System] Agent recovered after a process restart.')
    } finally {
      await owner.close()
    }
  })

  test('shutdown requeues a running execution this process owns whose session already died', async () => {
    // gracefulShutdown's session sweep only sees executions with a LIVE session.
    // A fence abort kills the session while leaving the row `running`, so without
    // this the row survives into the next boot as permanently running.
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'owned at shutdown' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, admissionProcessIncarnation)
    await db
      .update(executions)
      .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
      .where(eq(executions.id, execution.id))
    // A fresh lease: this must not depend on expiry, unlike the watchdog.
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000), lastHeartbeatAt: new Date() })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await requeueOwnedExecutionsForShutdown()).toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
    // Posted at SHUTDOWN, before any restart has happened — say so, rather than
    // claiming a recovery that is still in the future.
    const notices = (await db.select().from(messages).where(eq(messages.agentId, agent.id))).map((m) => m.content)
    expect(notices).toContain('[System] Agent paused for a worker restart; it will resume automatically.')
    expect(notices).not.toContain('[System] Agent recovered after a process restart.')
  })

  test('shutdown combines live and sessionless cohorts with one notice per affected agent', async () => {
    const liveAgent = await createSquadAgent('zai:glm-5.2')
    const liveExecution = await liveAgent.queueExecution({ message: 'live at shutdown' })
    createdExecutionIds.push(liveExecution.id)
    const liveLease = await seedStrandedQueuedAdmission(liveAgent, liveExecution, admissionProcessIncarnation)
    await db
      .update(executions)
      .set({
        status: 'running',
        runnerClaimToken: liveLease.token,
        runnerClaimGeneration: liveLease.admittedGeneration,
      })
      .where(eq(executions.id, liveExecution.id))

    // A second stale row may map to the same chat, but the partial unique index
    // permits only one current admission per agent. A released reservation is
    // schema-valid and must not create a second notice or displace the live row.
    const [staleRow] = await db.insert(executions).values({ agentId: liveAgent.id, status: 'running' }).returning()
    createdExecutionIds.push(staleRow.id)
    const staleToken = randomUUID()
    await db.insert(executionAdmissionReservations).values({
      executionId: staleRow.id,
      agentId: liveAgent.id,
      state: 'released',
      token: staleToken,
      claimEpoch: 91n,
      ownerId: 'stale-shutdown-owner',
      ownerIncarnation: admissionProcessIncarnation,
      admittedGeneration: 93,
      admittedHolderRevision: 95n,
      leaseExpiresAt: new Date(0),
      lastHeartbeatAt: new Date(0),
    })
    await db
      .update(executions)
      .set({ runnerClaimToken: staleToken, runnerClaimGeneration: 93 })
      .where(eq(executions.id, staleRow.id))

    const sessionlessAgent = await createSquadAgent('zai:glm-5.2')
    const sessionlessExecution = await sessionlessAgent.queueExecution({ message: 'sessionless at shutdown' })
    createdExecutionIds.push(sessionlessExecution.id)
    const sessionlessLease = await seedStrandedQueuedAdmission(
      sessionlessAgent,
      sessionlessExecution,
      admissionProcessIncarnation
    )
    await db
      .update(executions)
      .set({
        status: 'running',
        runnerClaimToken: sessionlessLease.token,
        runnerClaimGeneration: sessionlessLease.admittedGeneration,
      })
      .where(eq(executions.id, sessionlessExecution.id))

    registerSession(liveAgent.id, {
      agentId: liveAgent.id,
      executionId: liveExecution.id,
      session: { pi: { abort: async () => {} } },
    } as never)
    const liveExecutionIds = await shutdownActiveSessions({ settleDelayMs: 0, agentIds: [liveAgent.id] })
    expect(liveExecutionIds).toEqual([liveExecution.id])
    const recovered = await requeueOwnedExecutionsForShutdown(liveExecutionIds)

    expect(recovered).toEqual(expect.arrayContaining([liveExecution.id, sessionlessExecution.id]))
    expect(recovered).not.toContain(staleRow.id)
    expect((await Execution.mustFind(liveExecution.id)).status).toBe('queued')
    expect((await Execution.mustFind(sessionlessExecution.id)).status).toBe('queued')
    expect((await Execution.mustFind(staleRow.id)).status).toBe('running')
    await expectCanonicalQueuedAdmission(liveExecution.id, liveAgent.id)
    await expectCanonicalQueuedAdmission(sessionlessExecution.id, sessionlessAgent.id)

    for (const agent of [liveAgent, sessionlessAgent]) {
      const noticeContents = (await db.select().from(messages).where(eq(messages.agentId, agent.id))).map(
        ({ content }) => content
      )
      expect(
        noticeContents.filter(
          (content) => content === '[System] Agent paused for a worker restart; it will resume automatically.'
        )
      ).toHaveLength(1)
      expect(noticeContents).not.toContain('[System] Agent interrupted and will resume automatically.')
    }
  })

  test('shutdown requeues a live execution after its real runner handles agent_settled during abort', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'settles while shutting down' })
    createdExecutionIds.push(execution.id)
    expect(await attemptPickup(execution)).toBe('started')
    await sessionCreated
    await waitFor(async () => isSessionActive(agent.id), { description: 'runner to register its active session' })

    // Drive the real BaseAgentRunner agent_settled subscription from abort.
    // Because shutdownActiveSessions marks the worker as shutting down first,
    // handleAgentEnd skips normal completion and leaves the row running for the
    // shutdown recovery boundary.
    const session = createdSessions.at(-1)!
    session.pi.abort = async () => session.pi.simulateNormalEnd('settled during shutdown')

    const liveExecutionIds = await shutdownActiveSessions({ settleDelayMs: 0, agentIds: [agent.id] })
    expect(liveExecutionIds).toEqual([execution.id])
    expect((await Execution.mustFind(execution.id)).status).toBe('running')

    expect(await requeueOwnedExecutionsForShutdown(liveExecutionIds)).toEqual([execution.id])
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
    const notices = (await db.select().from(messages).where(eq(messages.agentId, agent.id))).map(
      ({ content }) => content
    )
    expect(
      notices.filter(
        (content) => content === '[System] Agent paused for a worker restart; it will resume automatically.'
      )
    ).toHaveLength(1)
  })

  test('shutdown rolls back its notice when the matching execution requeue fails', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'shutdown transaction failure' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, admissionProcessIncarnation)
    await db
      .update(executions)
      .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
      .where(eq(executions.id, execution.id))

    await expect(
      requeueOwnedExecutionsForShutdown([], {
        beforeExactCas: async () => {
          throw new Error('injected shutdown requeue failure')
        },
      })
    ).rejects.toThrow('injected shutdown requeue failure')
    expect((await Execution.mustFind(execution.id)).status).toBe('running')
    const notices = (await db.select().from(messages).where(eq(messages.agentId, agent.id))).map(
      ({ content }) => content
    )
    expect(notices).not.toContain('[System] Agent paused for a worker restart; it will resume automatically.')
  })

  test('shutdown never requeues an execution owned by a different process', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'owned elsewhere' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executions)
      .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
      .where(eq(executions.id, execution.id))

    expect(await requeueOwnedExecutionsForShutdown()).not.toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).status).toBe('running')
  })

  test('the lease watchdog does NOT requeue an execution this process is actively running', async () => {
    // The lease expiring does not mean the work stopped — a lagging heartbeat
    // under load looks identical. Requeuing a live execution starts a second
    // copy that collides with the first one's session reservation and dies as
    // "Execution session capacity reservation was refused".
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'live but lease expired' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executions)
      .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
      .where(eq(executions.id, execution.id))

    const { reserveSession, removeSession } = await import('./session-state')
    expect(reserveSession(agent.id, execution.id)).toBe(true)
    try {
      expect(await requeueAbandonedLeaseExecutions()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).status).toBe('running')
    } finally {
      removeSession(agent.id)
    }

    // Once this process is no longer running it, the sweep must reclaim it.
    expect(await requeueAbandonedLeaseExecutions()).toContain(execution.id)
  })

  test('the lease watchdog leaves a running execution with an unexpired lease alone', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'healthy lease' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executions)
      .set({ status: 'running', runnerClaimToken: lease.token, runnerClaimGeneration: lease.admittedGeneration })
      .where(eq(executions.id, execution.id))
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000), lastHeartbeatAt: new Date() })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await requeueAbandonedLeaseExecutions()).not.toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).status).toBe('running')
  })

  /** Start a pickup whose model turn hangs until the returned gate is released. */
  async function pickupWithHangingTurn(message: string) {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message })
    createdExecutionIds.push(execution.id)
    let releasePrompt!: () => void
    const promptGate = new Promise<void>((resolve) => (releasePrompt = resolve))
    createSessionSpy!.mockImplementationOnce(async function (this: any, scope: any) {
      return this.createPiSession(scope, async () => {
        const session = new MockAgentSession()
        ;(session as any).selectedSpec = await this.agent.getEffectiveModelSpec(this.agentType.model)
        const originalPrompt = session.pi.prompt.bind(session.pi)
        session.pi.prompt = async (text: string, options?: any) => {
          await promptGate
          return originalPrompt(text, options)
        }
        createdSessions.push(session)
        markSessionCreated()
        return session as any
      })
    })
    expect(await attemptPickup(execution)).toBe('started')
    // Wait until the runner is inside its agent-session write phase.
    const deadline = Date.now() + 10_000
    let reservation: typeof executionAdmissionReservations.$inferSelect | undefined
    while (Date.now() < deadline) {
      ;[reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      if (reservation?.state === 'starting' && reservation.phase === 'agent-session') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(reservation).toMatchObject({ state: 'starting', phase: 'agent-session' })
    return { agent, execution, releasePrompt, reservation: reservation! }
  }

  test('the agent-session phase is heartbeated, so the sweep never sees a live turn as abandoned', async () => {
    // Before this, only AdmissionScope.runEffect (sandbox/session-create phases)
    // heartbeated. The agent-session phase — the whole model turn — never
    // renewed its 30s lease, so any longer turn lapsed, was marked unknown, and
    // had its own finish/settlement refused; the row then sat running+unheld
    // and the abandoned-lease sweep re-queued a duplicate run.
    setAdmissionHeartbeatIntervalForTests(25)
    const heldSpy = spyOn(sessionState, 'isSessionHeldFor').mockReturnValue(false)
    try {
      const { execution, releasePrompt, reservation } = await pickupWithHangingTurn('heartbeated turn')
      const initialLease = reservation.leaseExpiresAt!.getTime()
      // Wait for at least one heartbeat renewal from the runner itself.
      const deadline = Date.now() + 5_000
      let renewed: Date | null = null
      while (Date.now() < deadline) {
        const [row] = await db
          .select({
            leaseExpiresAt: executionAdmissionReservations.leaseExpiresAt,
            state: executionAdmissionReservations.state,
          })
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        if (row?.leaseExpiresAt && row.leaseExpiresAt.getTime() > initialLease) {
          renewed = row.leaseExpiresAt
          expect(row.state).toBe('starting')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(renewed).not.toBeNull()

      // Even with the in-process hold ignored, a renewing lease is not abandoned.
      expect(await requeueAbandonedLeaseExecutions()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).status).toBe('running')

      const completed = new Promise<void>((resolve) => {
        const unsubscribe = eventEmitter.on('execution.completed', (payload) => {
          if (payload.executionId !== execution.id) return
          unsubscribe()
          resolve()
        })
      })
      const pendingSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
      try {
        releasePrompt()
        createdSessions.at(-1)!.pi.simulateNormalEnd('heartbeated turn done')
        await completed
      } finally {
        pendingSpy.mockRestore()
      }
      const [released] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(released.state).toBe('released')
    } finally {
      heldSpy.mockRestore()
      setAdmissionHeartbeatIntervalForTests(undefined)
    }
  })

  test('a turn whose lease lapsed to unknown mid-run still finishes and settles under its exact identity', async () => {
    const { agent, execution, releasePrompt } = await pickupWithHangingTurn('lapsed mid-turn')
    // Simulate the observed poison: no renewal for >30s, then the maintenance
    // controller's expiry classifier flips the open phase to unknown.
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(
      await new AdmissionReservationStore('maintenance-recovery', randomUUID()).markExpiredOpenEffectsUnknown()
    ).toBe(1)
    const [poisoned] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(poisoned).toMatchObject({ state: 'unknown', phase: 'agent-session' })

    const completed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.completed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })
    const pendingSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
    try {
      // Turn end: agent_settled fires and prompt() resolves back-to-back, so
      // settlement races the agent-session finish exactly as in production.
      releasePrompt()
      createdSessions.at(-1)!.pi.simulateNormalEnd('lapsed mid-turn done')
      await completed
    } finally {
      pendingSpy.mockRestore()
    }

    expect((await Execution.mustFind(execution.id)).status).toBe('completed')
    const [released] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(released.state).toBe('released')
    // Nothing for the sweep to re-queue, and no spurious recovery notice.
    expect(await requeueAbandonedLeaseExecutions()).not.toContain(execution.id)
    const notices = (await db.select().from(messages).where(eq(messages.agentId, agent.id))).map((m) => m.content)
    expect(notices).not.toContain(
      '[System] Agent recovered after its execution was interrupted (admission lease lapsed).'
    )
  })

  test('a settlement refused with the fence open fails the execution durably instead of leaving it running and unheld', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'settlement lost' })
    createdExecutionIds.push(execution.id)
    expect(await attemptPickup(execution)).toBe('started')
    const lifecycle = executionLifecycleRegistry.get(execution.id)!
    await lifecycle.runnerFinished
    // Someone else settled our reservation out from under us (identity intact,
    // maintenance NOT effective). Settlement must not be misread as a
    // maintenance pause: parking is a no-op then, and the row would sit
    // running + unheld until the abandoned-lease sweep re-queued a duplicate.
    await db
      .update(executionAdmissionReservations)
      .set({ state: 'revoked', phase: 'none' })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })
    const pendingSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
    try {
      createdSessions.at(-1)!.pi.simulateNormalEnd('settlement lost')
      await failed
    } finally {
      pendingSpy.mockRestore()
    }
    const settled = await Execution.mustFind(execution.id)
    expect(settled.status).toBe('failed')
    expect(settled.error).toContain('no longer authorizes phase settlement')
    expect(isSessionActive(agent.id)).toBe(false)
    expect(await requeueAbandonedLeaseExecutions()).not.toContain(execution.id)
  })

  test('startup queued recovery preserves a future lease from a dead owner', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'startup future stranded lease' })
    createdExecutionIds.push(execution.id)
    await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const executionBefore = (await Execution.mustFind(execution.id)).toJson()
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore)
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservationAfter).toEqual(reservationBefore)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('lost-race')
  })

  test('startup queued recovery preserves an expired admission owned by a live worker', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'startup live stranded owner' })
    createdExecutionIds.push(execution.id)
    const ownerIncarnation = randomUUID()
    const owner = await holdAdmissionLockInChild(ownerIncarnation)
    await seedStrandedQueuedAdmission(agent, execution, ownerIncarnation)
    const executionBefore = (await Execution.mustFind(execution.id)).toJson()
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore)
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservationAfter).toEqual(reservationBefore)

    await owner.close()
    expect(await recoverInterruptedExecutionsForStartup()).toContain(execution.id)
    await expectCanonicalQueuedAdmission(execution.id, agent.id)
  })

  test('duplicate reconciliation preserves a future lease from a dead owner', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'reconciliation future stranded lease' })
    createdExecutionIds.push(execution.id)
    await seedStrandedQueuedAdmission(agent, execution, randomUUID())
    await db
      .update(executionAdmissionReservations)
      .set({ leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    const executionBefore = (await Execution.mustFind(execution.id)).toJson()
    const [reservationBefore] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(0)
    expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore)
    const [reservationAfter] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservationAfter).toEqual(reservationBefore)
    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('lost-race')
  })

  test('duplicate reconciliation restores stranded admission before pickup', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'reconcile stranded admission' })
    createdExecutionIds.push(execution.id)
    const lease = await seedStrandedQueuedAdmission(agent, execution, randomUUID())

    expect(await reconcileDuplicateActiveExecutions({ agentIds: [agent.id] })).toBe(1)
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    await expectCanonicalQueuedAdmission(execution.id, agent.id)

    const pickupExecution = await Execution.mustFind(execution.id)
    pickupExecution.setAgent(agent)
    expect(await attemptPickup(pickupExecution)).toBe('started')
    const active = await db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.agentId, agent.id), inArray(executions.status, ['queued', 'running'])))
    expect(active).toEqual([{ id: execution.id }])
    const [claimed] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(claimed.token).not.toBeNull()
    expect(claimed.token).not.toBe(lease.token)
    await sessionCreated
    expect(createdSessions).toHaveLength(1)
  })

  async function createExcludedNeighbor(generation: number, holderRevision: bigint) {
    const neighborAgent = await createSquadAgent('zai:glm-5.2')
    const neighbor = await neighborAgent.queueExecution({ message: 'excluded reservation neighbor' })
    createdExecutionIds.push(neighbor.id)
    const now = new Date()
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, neighbor.id))
    await db.insert(executionAdmissionReservations).values({
      executionId: neighbor.id,
      token: randomUUID(),
      claimEpoch: 71n,
      ownerId: 'excluded-neighbor',
      ownerIncarnation: randomUUID(),
      admittedGeneration: generation,
      admittedHolderRevision: holderRevision,
      state: 'requested',
      phase: 'none',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    const [snapshot] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, neighbor.id))
    return { neighbor, snapshot }
  }

  async function expectNeighborUnchanged(
    neighborId: string,
    snapshot: typeof executionAdmissionReservations.$inferSelect
  ) {
    const [after] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, neighborId))
    expect(after).toEqual(snapshot)
  }

  test('not-queued: short-circuits without touching capacity or the DB row', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'already claimed' })
    createdExecutionIds.push(execution.id)

    // Fast-forward the execution past 'queued' directly (no runner spawned) —
    // attemptPickup must bail on the status guard before touching capacity.
    await execution.transitionTo({ kind: 'started' })
    expect(execution.status).toBe('running')

    const result = await attemptPickup(execution)

    expect(result).toBe('not-queued')
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)

    // Settle so cleanup doesn't wait out the running-execution timeout.
    await execution.stop()
  })

  test('started: claims the execution and runs it', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'pick me up' })
    createdExecutionIds.push(execution.id)

    const result = await attemptPickup(execution)

    expect(result).toBe('started')
    await waitFor(
      async () =>
        (await Execution.mustFind(execution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'execution to start and create a session' }
    )
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
  })

  test('revokes every durable session-start phase failure through the production pickup seam', async () => {
    const phases = [
      'sandbox-drift-recreate',
      'sandbox-ensure',
      'toolchain-reconcile',
      'workspace-watch-configure',
      'local-deployment-restart',
      'session-create',
    ] as const
    for (const phase of phases) {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: `fail during ${phase}` })
      createdExecutionIds.push(execution.id)
      createSessionSpy!.mockImplementationOnce(async function (this: any, scope: any) {
        return scope.runEffect({ phase, resourceKey: `test:${phase}` }, async () => {
          throw new Error(`deterministic ${phase} failure`)
        })
      })
      const failed = new Promise<void>((resolve) => {
        const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
          if (payload.executionId !== execution.id) return
          unsubscribe()
          resolve()
        })
      })

      expect(await attemptPickup(execution), phase).toBe('started')
      await failed
      await executionLifecycleRegistry.get(execution.id)?.runnerFinished
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executionAdmissionReservations)
        .where(
          sql`${executionAdmissionReservations.executionId} = ${execution.id} AND ${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      expect(count, `${phase} must leave zero active reservations`).toBe(0)
      concurrencyLimiter.release(execution.id)
    }
  })

  test('revokes admission on durable-phase cancel and graceful post-create abort', async () => {
    for (const stage of ['durable-phase-cancel', 'post-create-graceful-abort'] as const) {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: stage })
      createdExecutionIds.push(execution.id)
      let entered!: () => void
      const phaseEntered = new Promise<void>((resolve) => (entered = resolve))
      let release!: () => void
      const releaseCreate = new Promise<void>((resolve) => (release = resolve))
      createSessionSpy!.mockImplementationOnce(async function (this: any, scope: any) {
        return scope.runEffect({ phase: 'sandbox-ensure', resourceKey: `cancel:${stage}` }, async ({ signal }: any) => {
          entered()
          if (stage === 'durable-phase-cancel') {
            await new Promise<void>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            )
          } else {
            await releaseCreate
          }
          return new MockAgentSession() as any
        })
      })

      expect(await attemptPickup(execution), stage).toBe('started')
      await phaseEntered
      const lifecycle = executionLifecycleRegistry.get(execution.id)!
      await lifecycle.requestMaintenanceInterrupt()
      release()
      await lifecycle.runnerFinished
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executionAdmissionReservations)
        .where(
          sql`${executionAdmissionReservations.executionId} = ${execution.id} AND ${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      expect(count, `${stage} must leave zero active reservations`).toBe(0)
      concurrencyLimiter.release(execution.id)
    }
  })

  test('revokes admission on post-create setup and agent-session dispatch failures', async () => {
    for (const stage of ['post-create-setup', 'agent-session'] as const) {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: `fail during ${stage}` })
      createdExecutionIds.push(execution.id)
      let stageSpy: { mockRestore(): void }
      if (stage === 'post-create-setup') {
        let setupSpy: ReturnType<typeof spyOn> | undefined
        createSessionSpy!.mockImplementationOnce(async () => {
          setupSpy = spyOn(Agent.prototype, 'getEffectiveModelSpec').mockRejectedValueOnce(
            new Error('post-create setup failed')
          )
          return new MockAgentSession() as any
        })
        stageSpy = { mockRestore: () => setupSpy?.mockRestore() }
      } else {
        stageSpy = spyOn(SquadWorkerRunner.prototype as any, 'sendPrompt').mockRejectedValueOnce(
          new Error('agent-session dispatch failed')
        )
      }
      const failed = new Promise<void>((resolve) => {
        const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
          if (payload.executionId !== execution.id) return
          unsubscribe()
          resolve()
        })
      })
      try {
        expect(await attemptPickup(execution), stage).toBe('started')
        await failed
        await executionLifecycleRegistry.get(execution.id)?.runnerFinished
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executionAdmissionReservations)
          .where(
            sql`${executionAdmissionReservations.executionId} = ${execution.id} AND ${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
          )
        expect(count, `${stage} must leave zero active reservations`).toBe(0)
      } finally {
        stageSpy.mockRestore()
        concurrencyLimiter.release(execution.id)
      }
    }
  })

  test('preserves agent-type startup failure and leaves zero active reservations', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'agent type startup failure' })
    createdExecutionIds.push(execution.id)
    let agentTypeSpy: ReturnType<typeof spyOn> | undefined
    setBoxMigratingLockedCheckForTests(async () => {
      agentTypeSpy = spyOn(Agent.prototype, 'mustGetAgentType').mockRejectedValueOnce(
        new Error('deterministic agent-type startup failure')
      )
      return false
    })
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })
    try {
      expect(await attemptPickup(execution)).toBe('started')
      await failed
      await executionLifecycleRegistry.get(execution.id)?.runnerFinished
      const settled = await Execution.mustFind(execution.id)
      expect(settled.status).toBe('failed')
      expect(settled.error).toBe('deterministic agent-type startup failure')
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.executionId, execution.id),
            sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
          )
        )
      expect(count).toBe(0)
    } finally {
      agentTypeSpy?.mockRestore()
      setBoxMigratingLockedCheckForTests()
    }
  })

  test('revokes provisional admission when runner claim fails', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'claim refusal' })
    createdExecutionIds.push(execution.id)
    const claim = spyOn(AdmissionReservationStore.prototype, 'claimProvisionalLease').mockResolvedValueOnce(null)
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })
    try {
      expect(await attemptPickup(execution)).toBe('started')
      await failed
      await executionLifecycleRegistry.get(execution.id)?.runnerFinished
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executionAdmissionReservations)
        .where(
          sql`${executionAdmissionReservations.executionId} = ${execution.id} AND ${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      expect(count).toBe(0)
    } finally {
      claim.mockRestore()
    }
  })

  test('revokes provisional admission when session capacity reservation is refused', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'reserve refusal' })
    createdExecutionIds.push(execution.id)
    const reserve = spyOn(sessionState, 'reserveSession').mockReturnValueOnce(false)
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })
    try {
      expect(await attemptPickup(execution)).toBe('started')
      await failed
      await executionLifecycleRegistry.get(execution.id)?.runnerFinished
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(executionAdmissionReservations)
        .where(
          sql`${executionAdmissionReservations.executionId} = ${execution.id} AND ${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      expect(count).toBe(0)
    } finally {
      reserve.mockRestore()
    }
  })

  for (const terminalPath of ['stop', 'halt'] as const) {
    test(`current runner ${terminalPath} settles its exact lease`, async () => {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: `current ${terminalPath}` })
      createdExecutionIds.push(execution.id)
      expect(await attemptPickup(execution)).toBe('started')
      const lifecycle = executionLifecycleRegistry.get(execution.id)!
      await lifecycle.runnerFinished
      const hookSpy =
        terminalPath === 'halt'
          ? spyOn(turnHooks, 'run').mockResolvedValue({ action: 'halt', status: 'waiting-input' })
          : undefined
      const pendingSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
      const terminal = new Promise<void>((resolve) => {
        const event = terminalPath === 'stop' ? 'execution.stopped' : 'execution.completed'
        const unsubscribe = eventEmitter.on(event, (payload) => {
          if (payload.executionId !== execution.id) return
          unsubscribe()
          resolve()
        })
      })
      try {
        if (terminalPath === 'stop') {
          await db.update(executions).set({ status: 'stopping' }).where(eq(executions.id, execution.id))
        }
        createdSessions.at(-1)!.pi.simulateNormalEnd(`current ${terminalPath}`)
        await terminal
        await lifecycle.settled
        const settledExecution = await Execution.mustFind(execution.id)
        const [reservation] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        expect(settledExecution.status).toBe(terminalPath === 'stop' ? 'stopped' : 'completed')
        expect(reservation.state).toBe('released')
        if (terminalPath === 'halt') expect((await Agent.mustFind(agent.id)).status).toBe('waiting-input')
      } finally {
        hookSpy?.mockRestore()
        pendingSpy.mockRestore()
      }
    })
  }

  // Mutation evidence (2026-08-14): removing the admissionLease argument from
  // handleStop makes the stop case change successor B (byte-for-byte assertion);
  // removing the TransitionOptions admissionLease from the turn-hook halt branch
  // makes the halt case change successor B. Each mutation failed here and was
  // restored before commit.
  for (const terminalPath of ['stop', 'halt'] as const) {
    test(`stale runner ${terminalPath} cannot change an adopted successor`, async () => {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: `stale ${terminalPath}` })
      createdExecutionIds.push(execution.id)
      expect(await attemptPickup(execution)).toBe('started')
      const lifecycle = executionLifecycleRegistry.get(execution.id)!
      await lifecycle.runnerFinished
      const successorToken = randomUUID()
      const successorIncarnation = randomUUID()
      let executionBefore!: typeof executions.$inferSelect
      let reservationBefore!: typeof executionAdmissionReservations.$inferSelect
      const originalFinish = AdmissionReservationStore.prototype.finishWritePhase
      const finishSpy = spyOn(AdmissionReservationStore.prototype, 'finishWritePhase').mockImplementation(
        async function (this: AdmissionReservationStore, lease, phase, nextState) {
          const finished = await originalFinish.call(this, lease, phase, nextState)
          if (!finished || nextState !== 'settling') return finished
          const [leaseA] = await db
            .select()
            .from(executionAdmissionReservations)
            .where(eq(executionAdmissionReservations.executionId, execution.id))
          await db
            .update(executions)
            .set({
              status: terminalPath === 'stop' ? 'stopping' : 'running',
              runnerClaimToken: successorToken,
            })
            .where(eq(executions.id, execution.id))
          await db
            .update(executionAdmissionReservations)
            .set({
              token: successorToken,
              claimEpoch: leaseA.claimEpoch! + 1n,
              ownerId: 'runner-successor',
              ownerIncarnation: successorIncarnation,
            })
            .where(eq(executionAdmissionReservations.executionId, execution.id))
          ;[executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
          ;[reservationBefore] = await db
            .select()
            .from(executionAdmissionReservations)
            .where(eq(executionAdmissionReservations.executionId, execution.id))
          return true
        }
      )
      let terminalCalled!: () => void
      const called = new Promise<void>((resolve) => (terminalCalled = resolve))
      const originalStop = Execution.prototype.stop
      const stopSpy =
        terminalPath === 'stop'
          ? spyOn(Execution.prototype, 'stop').mockImplementation(async function (this: Execution, lease) {
              await originalStop.call(this, lease)
              terminalCalled()
            })
          : undefined
      const originalTransition = Execution.prototype.transitionTo
      const transitionSpy =
        terminalPath === 'halt'
          ? spyOn(Execution.prototype, 'transitionTo').mockImplementation(async function (
              this: Execution,
              outcome,
              options
            ) {
              const result = await originalTransition.call(this, outcome, options)
              if (outcome.kind === 'completed') terminalCalled()
              return result
            })
          : undefined
      const hookSpy =
        terminalPath === 'halt'
          ? spyOn(turnHooks, 'run').mockResolvedValue({ action: 'halt', status: 'waiting-input' })
          : undefined
      const pendingSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
      try {
        createdSessions.at(-1)!.pi.simulateNormalEnd(`stale ${terminalPath}`)
        await called
        const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
        const [reservationAfter] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        expect(executionAfter).toEqual(executionBefore)
        expect(reservationAfter).toEqual(reservationBefore)
      } finally {
        finishSpy.mockRestore()
        stopSpy?.mockRestore()
        transitionSpy?.mockRestore()
        hookSpy?.mockRestore()
        pendingSpy.mockRestore()
        removeSession(agent.id)
        lifecycle.settle()
        await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
      }
    })
  }

  // Mutation: returning a primitive unchanged from attachAdmissionLeaseToError
  // makes Execution.run use its operator path; successor B changes and the
  // byte-for-byte assertions fail.
  for (const [throwKind, thrown] of [
    ['string', 'primitive startup failure'],
    ['number', 17],
    ['null', null],
  ] as const) {
    test(`startup ${throwKind} failure cannot terminalize a replacement successor`, async () => {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: 'startup revoke takeover race' })
      createdExecutionIds.push(execution.id)
      createSessionSpy!.mockRejectedValueOnce(thrown as any)
      const successorToken = randomUUID()
      const successorIncarnation = randomUUID()
      let executionBefore!: typeof executions.$inferSelect
      let reservationBefore!: typeof executionAdmissionReservations.$inferSelect
      const originalRevoke = AdmissionReservationStore.prototype.revokeLease
      const revokeSpy = spyOn(AdmissionReservationStore.prototype, 'revokeLease').mockImplementation(async function (
        this: AdmissionReservationStore,
        lease,
        tx
      ) {
        const revoked = await originalRevoke.call(this, lease, tx)
        if (!revoked) return false
        await db.update(executions).set({ runnerClaimToken: successorToken }).where(eq(executions.id, execution.id))
        await db
          .update(executionAdmissionReservations)
          .set({
            token: successorToken,
            claimEpoch: lease.claimEpoch + 1n,
            ownerId: 'runner-successor',
            ownerIncarnation: successorIncarnation,
            state: 'requested',
          })
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        ;[executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
        ;[reservationBefore] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        return true
      })
      let failedCalled!: () => void
      const called = new Promise<void>((resolve) => (failedCalled = resolve))
      const originalFail = Execution.prototype.fail
      const failSpy = spyOn(Execution.prototype, 'fail').mockImplementation(async function (
        this: Execution,
        error,
        lease
      ) {
        const result = await originalFail.call(this, error, lease)
        failedCalled()
        return result
      })
      try {
        expect(await attemptPickup(execution)).toBe('started')
        await called
        const [executionAfter] = await db.select().from(executions).where(eq(executions.id, execution.id))
        const [reservationAfter] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        expect(executionAfter).toEqual(executionBefore)
        expect(reservationAfter).toEqual(reservationBefore)
      } finally {
        revokeSpy.mockRestore()
        failSpy.mockRestore()
        await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
      }
    })
  }
  test('releases the exact reservation when session creation fails', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'fail during session create' })
    createdExecutionIds.push(execution.id)
    createSessionSpy!.mockRejectedValueOnce(new Error('deterministic session create failure'))
    const failed = new Promise<void>((resolve) => {
      const unsubscribe = eventEmitter.on('execution.failed', (payload) => {
        if (payload.executionId !== execution.id) return
        unsubscribe()
        resolve()
      })
    })

    expect(await attemptPickup(execution)).toBe('started')
    await failed
    await executionLifecycleRegistry.get(execution.id)?.runnerFinished
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation.state).toBe('revoked')
    expect(reservation.phase).toBe('none')
  })

  test('refuses a queued candidate with a dead lease-bearing admission until startup recovery', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'reclaim dead reservation' })
    createdExecutionIds.push(execution.id)
    const deadIncarnation = randomUUID()
    const oldToken = randomUUID()
    const deadOwner = await holdAdmissionLockInChild(deadIncarnation)
    await deadOwner.close()
    const [maintenance] = await db
      .select()
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    const now = new Date()
    const excluded = await createExcludedNeighbor(maintenance!.generation, maintenance!.holderRevision)
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, execution.id))
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      token: oldToken,
      claimEpoch: 4n,
      ownerId: 'dead-worker',
      ownerIncarnation: deadIncarnation,
      admittedGeneration: maintenance!.generation,
      admittedHolderRevision: maintenance!.holderRevision,
      state: 'requested',
      phase: 'none',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    })

    expect(maintenance).toMatchObject({ adminHold: false, platformLeaseId: null })
    expect(await attemptPickup(execution)).toBe('lost-race')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation).toMatchObject({ token: oldToken, state: 'requested', ownerId: 'dead-worker' })
    await expectNeighborUnchanged(excluded.neighbor.id, excluded.snapshot)
  })

  test('refuses a queued candidate with a same-process nonqueue reservation', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'retry same owner' })
    createdExecutionIds.push(execution.id)
    const [maintenance] = await db
      .select()
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    const now = new Date()
    const excluded = await createExcludedNeighbor(maintenance!.generation, maintenance!.holderRevision)
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, execution.id))
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      token: randomUUID(),
      claimEpoch: 8n,
      ownerId: 'worker',
      ownerIncarnation: admissionProcessIncarnation,
      admittedGeneration: maintenance!.generation,
      admittedHolderRevision: maintenance!.holderRevision,
      state: 'requested',
      phase: 'none',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    })

    expect(await attemptPickup(execution)).toBe('lost-race')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    const [reservation] = await db
      .select()
      .from(executionAdmissionReservations)
      .where(eq(executionAdmissionReservations.executionId, execution.id))
    expect(reservation).toMatchObject({ state: 'requested', claimEpoch: 8n })
    await expectNeighborUnchanged(excluded.neighbor.id, excluded.snapshot)
  })

  test('rejects a reservation owned by a provably live different process', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'do not steal live owner' })
    createdExecutionIds.push(execution.id)
    const liveIncarnation = randomUUID()
    const liveToken = randomUUID()
    const [maintenance] = await db
      .select()
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    const now = new Date()
    const excluded = await createExcludedNeighbor(maintenance!.generation, maintenance!.holderRevision)
    await db.delete(executionAdmissionReservations).where(eq(executionAdmissionReservations.executionId, execution.id))
    await db.insert(executionAdmissionReservations).values({
      executionId: execution.id,
      token: liveToken,
      claimEpoch: 3n,
      ownerId: 'other-worker',
      ownerIncarnation: liveIncarnation,
      admittedGeneration: maintenance!.generation,
      admittedHolderRevision: maintenance!.holderRevision,
      state: 'requested',
      phase: 'none',
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    await secondConnection`SELECT pg_advisory_lock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${liveIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`
    try {
      expect(await attemptPickup(execution)).toBe('lost-race')
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      const [reservation] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(reservation).toMatchObject({
        token: liveToken,
        claimEpoch: 3n,
        ownerIncarnation: liveIncarnation,
        state: 'requested',
      })
      await expectNeighborUnchanged(excluded.neighbor.id, excluded.snapshot)
    } finally {
      await secondConnection`SELECT pg_advisory_unlock(hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${liveIncarnation}, ${ADMISSION_LIVENESS_HASH_SEED}))`
    }
  })

  test('pickup, terminal, and park serialize pause in maintenance-execution-reservation order', async () => {
    try {
      const assertNoLockWaiters = async () => {
        const [row] = await secondConnection<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `
        expect(row.count).toBe(0)
      }
      const makeGate = () => {
        let entered!: () => void
        let release!: () => void
        return {
          entered: new Promise<void>((resolve) => (entered = resolve)),
          release: () => release(),
          hook: async () => {
            entered()
            await new Promise<void>((resolve) => (release = resolve))
          },
        }
      }
      const assertMaintenanceLocked = async () => {
        let blocked = false
        try {
          await secondConnection`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR UPDATE NOWAIT`
        } catch (error: any) {
          blocked = error?.code === '55P03'
        }
        expect(blocked).toBe(true)
      }
      const probeReservation = async (executionId: string, expected = 1) => {
        expect(
          await secondConnection`
          SELECT execution_id FROM execution_admission_reservations
          WHERE execution_id = ${executionId} FOR UPDATE NOWAIT
        `
        ).toHaveLength(expected)
      }

      const assertReservationLocked = async (executionId: string) => {
        let blocked = false
        try {
          await secondConnection`
            SELECT execution_id FROM execution_admission_reservations
            WHERE execution_id = ${executionId} FOR UPDATE NOWAIT
          `
        } catch (error: any) {
          blocked = error?.code === '55P03'
        }
        expect(blocked).toBe(true)
      }

      // Pickup holds maintenance, the canonical admission, and execution; pause waits on maintenance.
      const pickupAgent = await createSquadAgent('zai:glm-5.2')
      const pickupExecution = await pickupAgent.queueExecution({ message: 'pickup hierarchy' })
      createdExecutionIds.push(pickupExecution.id)
      const pickupGate = makeGate()
      setPickupExecutionLockedHookForTests(async () => pickupGate.hook())
      const pickup = attemptPickup(pickupExecution)
      await pickupGate.entered
      let pauseAfterPickup: ReturnType<typeof maintenanceStore.setAdminHold> | undefined
      try {
        await assertMaintenanceLocked()
        await assertReservationLocked(pickupExecution.id)
        pauseAfterPickup = maintenanceStore.setAdminHold({ active: true, actor: 'lock-matrix' })
      } finally {
        setPickupExecutionLockedHookForTests()
        pickupGate.release()
      }
      expect(await pickup).toBe('started')
      await pauseAfterPickup
      await assertNoLockWaiters()
      removeSession(pickupAgent.id)
      const pickupLifecycle = executionLifecycleRegistry.get(pickupExecution.id)
      if (pickupLifecycle) {
        await pickupLifecycle.runnerFinished
        pickupLifecycle.settle()
        await pickupLifecycle.settled
      }
      await maintenanceStore.setAdminHold({ active: false, actor: 'lock-matrix' })
      await Promise.resolve()

      for (const owner of ['runner', 'operator'] as const) {
        const agent = await createSquadAgent('zai:glm-5.2')
        const execution = await agent.queueExecution({ message: `${owner} terminal hierarchy` })
        createdExecutionIds.push(execution.id)
        expect(await attemptPickup(execution)).toBe('started')
        await executionLifecycleRegistry.get(execution.id)!.runnerFinished
        const [reservation] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        const gate = makeGate()
        const terminal = execution.transitionTo(
          { kind: 'failed', error: 'lock matrix' },
          {
            admissionLease:
              owner === 'runner'
                ? {
                    executionId: reservation.executionId,
                    token: reservation.token!,
                    claimEpoch: reservation.claimEpoch!,
                    generation: reservation.admittedGeneration!,
                    holderRevision: reservation.admittedHolderRevision!,
                    ownerId: reservation.ownerId!,
                    ownerIncarnation: reservation.ownerIncarnation!,
                  }
                : undefined,
            afterExecutionLocked: async () => gate.hook(),
          }
        )
        await gate.entered
        let pause: ReturnType<typeof maintenanceStore.setAdminHold> | undefined
        try {
          await assertMaintenanceLocked()
          await probeReservation(execution.id)
          pause = maintenanceStore.setAdminHold({ active: true, actor: 'lock-matrix' })
        } finally {
          gate.release()
        }
        expect(await terminal).toBe(true)
        await pause
        await assertNoLockWaiters()
        removeSession(agent.id)
        executionLifecycleRegistry.get(execution.id)?.settle()
        await maintenanceStore.setAdminHold({ active: false, actor: 'lock-matrix' })
      }

      const parkAgent = await createSquadAgent('zai:glm-5.2')
      const parkExecution = await parkAgent.queueExecution({ message: 'park hierarchy' })
      createdExecutionIds.push(parkExecution.id)
      await new AdmissionReservationStore('park-lock-matrix', randomUUID()).createProvisional(parkExecution.id)
      const held = await maintenanceStore.setAdminHold({ active: true, actor: 'lock-matrix' })
      const parkGate = makeGate()
      const park = parkExecution.parkForMaintenance(held.generation, { afterExecutionLocked: parkGate.hook })
      await parkGate.entered
      let unpause: ReturnType<typeof maintenanceStore.setAdminHold> | undefined
      try {
        await assertMaintenanceLocked()
        await probeReservation(parkExecution.id)
        unpause = maintenanceStore.setAdminHold({ active: false, actor: 'lock-matrix' })
      } finally {
        parkGate.release()
      }
      expect(await park).toBe(true)
      await unpause
      await assertNoLockWaiters()
    } finally {
      setPickupExecutionLockedHookForTests()
      await maintenanceStore.setAdminHold({ active: false, actor: 'lock-matrix-finally' })
    }
  })

  // Mutation: moving the reservation FOR UPDATE before the execution lock makes
  // the NOWAIT reservation probe fail while recovery holds the wrong lock.
  test('startup recovery locks maintenance then execution before reservation', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'lock hierarchy' })
    createdExecutionIds.push(execution.id)
    expect(await attemptPickup(execution)).toBe('started')
    const lifecycle = executionLifecycleRegistry.get(execution.id)!
    await lifecycle.runnerFinished
    let locked!: () => void
    let release!: () => void
    const executionLocked = new Promise<void>((resolve) => (locked = resolve))
    const gate = new Promise<void>((resolve) => (release = resolve))
    const recovery = recoverInterruptedExecutionsForStartup({
      afterExecutionLocked: async (id) => {
        if (id !== execution.id) return
        locked()
        await gate
      },
    })
    await executionLocked
    let recoveryResult: string[] = []
    try {
      const reservationProbe = await secondConnection`
        SELECT execution_id FROM execution_admission_reservations
        WHERE execution_id = ${execution.id}
        FOR UPDATE NOWAIT
      `
      expect(reservationProbe).toHaveLength(1)
      let maintenanceBlocked = false
      try {
        await secondConnection`SELECT id FROM instance_maintenance_state WHERE id = 'global' FOR UPDATE NOWAIT`
      } catch (error: any) {
        maintenanceBlocked = error?.code === '55P03'
      }
      expect(maintenanceBlocked).toBe(true)
    } finally {
      release()
      recoveryResult = await recovery
    }
    expect(recoveryResult).toContain(execution.id)
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    const [waiters] = await secondConnection<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `
    expect(waiters.count).toBe(0)
    removeSession(agent.id)
    lifecycle.settle()
    await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
  })

  // Mutation: bypassing the advisory dead-owner proof requeues this live row;
  // the recovered-id and byte-for-byte snapshot assertions fail.
  test('startup recovery leaves a live foreign admission owner untouched', async () => {
    await maintenanceStore.initialize()
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'live rolling worker' })
    createdExecutionIds.push(execution.id)
    const owner = spawnRestartWorker('owner', execution.id, 'requested')
    try {
      const barrier = await owner.waitForEvent('barrier')
      const executionBefore = await Execution.mustFind(execution.id)
      const [reservationBefore] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore.toJson())
      const [reservationAfter] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(reservationAfter).toEqual(reservationBefore)
      expect(reservationAfter.ownerIncarnation!).toBe(String(barrier.incarnation))
    } finally {
      await owner.close()
      await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
    }
  })

  // Mutations: skipping liveness proof requeues the live revoked owner;
  // treating terminal/missing/mismatched rows as unfenced changes the exact
  // execution snapshot. Publishing queued outside the message transaction
  // fails the atomic recovery-message postcondition.
  test('startup recovery leaves a live revoked owner untouched and recovers it only after death', async () => {
    await maintenanceStore.initialize()
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'revoked owner window' })
    createdExecutionIds.push(execution.id)
    const messageEvents: unknown[] = []
    const agentEvents: unknown[] = []
    const eventOrder: string[] = []
    const offMessage = eventEmitter.on('message.created', (event) => {
      messageEvents.push(event)
      eventOrder.push('message.created')
    })
    const offAgent = eventEmitter.on('agent.updated', (event) => {
      agentEvents.push(event)
      eventOrder.push('agent.updated')
    })
    const owner = spawnRestartWorker('owner', execution.id, 'requested')
    try {
      await owner.waitForEvent('barrier')
      await db
        .update(executionAdmissionReservations)
        .set({ state: 'revoked' })
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      const executionBefore = await Execution.mustFind(execution.id)
      const [agentBefore] = await db.select().from(agents).where(eq(agents.id, agent.id))
      const [reservationBefore] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))

      expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).toJson()).toEqual(executionBefore.toJson())
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).not.toContainEqual(
        expect.objectContaining({ content: '[System] Agent recovered after a process restart.' })
      )
      expect(messageEvents).toEqual([])
      expect(agentEvents).toEqual([])
      expect(
        (
          await db
            .select()
            .from(executionAdmissionReservations)
            .where(eq(executionAdmissionReservations.executionId, execution.id))
        )[0]
      ).toEqual(reservationBefore)

      await owner.close()
      expect(await recoverInterruptedExecutionsForStartup()).toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toContainEqual(
        expect.objectContaining({ content: '[System] Agent recovered after a process restart.' })
      )
      expect(messageEvents).toEqual([expect.objectContaining({ agentId: agent.id, executionId: execution.id })])
      expect(agentEvents).toHaveLength(1)
      expect(eventOrder).toEqual(['message.created', 'agent.updated'])
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toContainEqual(
        expect.objectContaining({ metadata: expect.objectContaining({ executionId: execution.id }) })
      )
      const [agentAfter] = await db.select().from(agents).where(eq(agents.id, agent.id))
      expect(agentAfter.updatedAt.getTime()).toBeGreaterThan(agentBefore.updatedAt.getTime())
      expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
      expect(messageEvents).toHaveLength(1)
      expect(agentEvents).toHaveLength(1)
      expect(
        (await db.select().from(messages).where(eq(messages.agentId, agent.id))).filter(
          (message) => message.content === '[System] Agent recovered after a process restart.'
        )
      ).toHaveLength(1)
    } finally {
      offMessage()
      offAgent()
      if (restartWorkers.has(owner)) await owner.close()
      await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
    }
  })

  // Regression (root cause of the startup-recovery flake family): a SIGKILLed
  // restart worker's Postgres sessions survive the kill server-side until the
  // backend notices the closed socket (measured on this harness: p50 ≈ 1.5ms,
  // p99 ≈ 30ms, ALWAYS > 0 at the moment close() resolves). Every
  // `owner.close(); recoverInterruptedExecutionsForStartup()` site in this file
  // raced that window: the recovery's single un-retried
  // pg_try_advisory_xact_lock proof saw the not-yet-reaped session holding the
  // incarnation lock, judged the dead owner live, and skipped recovery — so
  // `toContain(execution.id)` failed a moment later. close() now WAITS for the
  // server-side release before returning.
  //
  // The interleaving is forced deterministically, without relying on the
  // natural millisecond-scale reap lag: SIGKILL the owner, then await a BLOCKING
  // acquire of its incarnation lock from a distinct session. Whether that query
  // waits briefly for backend reap or finds the key already free, the distinct
  // session provably holds the key BEFORE close() begins — exactly the state an
  // un-reaped dead backend presents to the proof. A Promise.race then establishes
  // that the exact try-lock attempt returned false because of that hold before we
  // assert close() is still pending. On the old harness close() resolves first
  // (RED); with the release wait the blocked proof wins that race and close()
  // completes only after the unlock (GREEN).
  test('close() does not return while the worker liveness lock is still held server-side', async () => {
    await maintenanceStore.initialize()
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'server-side death proof' })
    createdExecutionIds.push(execution.id)
    const owner = spawnRestartWorker('owner', execution.id, 'requested')
    try {
      const barrier = await owner.waitForEvent('barrier')
      await expectCloseWaitsForLivenessLockRelease(owner, String(barrier.incarnation))
    } finally {
      if (restartWorkers.has(owner)) await owner.close()
      await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
    }
  })

  test('close() also waits for helper-created admission-lock holders', async () => {
    const incarnation = randomUUID()
    const holder = await holdAdmissionLockInChild(incarnation)
    await expectCloseWaitsForLivenessLockRelease(holder, incarnation)
  })

  for (const invalidClaim of ['missing', 'mismatched'] as const) {
    test(`startup recovery fails closed for ${invalidClaim} reservation identity`, async () => {
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: invalidClaim })
      createdExecutionIds.push(execution.id)
      expect(await attemptPickup(execution)).toBe('started')
      const lifecycle = executionLifecycleRegistry.get(execution.id)!
      await lifecycle.runnerFinished
      if (invalidClaim === 'missing') {
        await db
          .delete(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
      } else {
        await db
          .update(executionAdmissionReservations)
          .set({ token: randomUUID() })
          .where(eq(executionAdmissionReservations.executionId, execution.id))
      }
      const before = await Execution.mustFind(execution.id)
      expect(await recoverInterruptedExecutionsForStartup()).not.toContain(execution.id)
      expect((await Execution.mustFind(execution.id)).toJson()).toEqual(before.toJson())
      removeSession(agent.id)
      lifecycle.settle()
      await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
    })
  }

  test('startup recovery CAS loss rolls back notice, timestamp, and events', async () => {
    await maintenanceStore.initialize()
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'recovery CAS rollback' })
    createdExecutionIds.push(execution.id)
    const owner = spawnRestartWorker('owner', execution.id, 'requested')
    await owner.waitForEvent('barrier')
    await owner.close()
    const [executionBefore] = await db.select().from(executions).where(eq(executions.id, execution.id))
    const [agentBefore] = await db.select().from(agents).where(eq(agents.id, agent.id))
    const events: string[] = []
    const offMessage = eventEmitter.on('message.created', () => events.push('message.created'))
    const offAgent = eventEmitter.on('agent.updated', () => events.push('agent.updated'))
    try {
      await expect(
        recoverInterruptedExecutionsForStartup({
          beforeExactCas: async (tx, id) => {
            if (id === execution.id)
              await tx.update(executions).set({ runnerClaimToken: randomUUID() }).where(eq(executions.id, id))
          },
        })
      ).rejects.toThrow('Startup recovery lost its exact transactional CAS')
      expect((await db.select().from(executions).where(eq(executions.id, execution.id)))[0]).toEqual(executionBefore)
      expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0].updatedAt).toEqual(
        agentBefore.updatedAt
      )
      expect(
        (await db.select().from(messages).where(eq(messages.agentId, agent.id))).filter(
          (message) => message.content === '[System] Agent recovered after a process restart.'
        )
      ).toEqual([])
      expect(events).toEqual([])
    } finally {
      offMessage()
      offAgent()
      await db.update(executions).set({ status: 'failed' }).where(eq(executions.id, execution.id))
    }
  })

  for (const target of [
    'provisional',
    'requested',
    'sandbox-drift-recreate',
    'sandbox-ensure',
    'toolchain-reconcile',
    'workspace-watch-configure',
    'local-deployment-restart',
    'session-create',
    'running',
    'agent-session',
    'settlement',
  ]) {
    // 60s, not the file default: each variant spawns TWO real worker
    // subprocesses (owner to the target state, then a successor that recovers
    // and completes), so it carries real multi-process boot cost (~1.9s/variant
    // on CI, ~4.6s under heavy local contention).
    //
    // History: the 2026-08-20/21 at-cap failures here (settlement at 30018ms,
    // local-deployment-restart at 60061ms, workspace-watch-configure at
    // 60026ms — a DIFFERENT variant each run, each exactly at budget, while
    // its neighbors ran ~1.9s) were NOT this test being slow. A spawned
    // worker's very first DB query hung forever: db/connection.ts's Bun
    // socket factory awaited TCP 'connect' unboundedly, and postgres.js only
    // arms connect_timeout AFTER the factory resolves, so a lost SYN on the
    // loaded runner meant a silent, empty-stderr child that only the test
    // budget could kill. Fixed by bounding the factory's connect wait
    // (db/connection.test.ts covers it); the harness waits below are also
    // deadline-bounded now, so a wedged worker fails with a message naming
    // the awaited event instead of an anonymous budget death.
    test(`restarts real worker incarnations from ${target}`, async () => {
      await maintenanceStore.initialize()
      const [maintenance] = await db
        .select()
        .from(instanceMaintenanceState)
        .where(eq(instanceMaintenanceState.id, 'global'))
      expect(maintenance).toMatchObject({ adminHold: false, platformLeaseId: null })
      const excluded = await createExcludedNeighbor(maintenance!.generation, maintenance!.holderRevision)
      const agent = await createSquadAgent('zai:glm-5.2')
      const execution = await agent.queueExecution({ message: `process restart ${target}` })
      createdExecutionIds.push(execution.id)
      const owner = spawnRestartWorker('owner', execution.id, target)
      let successor: ManagedRestartWorker | undefined
      try {
        const barrier = await owner.waitForEvent('barrier')
        const [durableReservation] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        const durableExecution = await Execution.mustFind(execution.id)
        expect(durableExecution.status).toBe('running')
        expect(barrier.executionStatus).toBe(durableExecution.status)
        expect(durableExecution.runnerClaimToken).toBe(durableReservation.token!)
        expect(barrier.ownerId!).toBe(durableReservation.ownerId!)
        expect(barrier.runnerClaimGeneration).toBe(durableExecution.runnerClaimGeneration)
        expect(barrier.admittedGeneration!).toBe(durableReservation.admittedGeneration!)
        expect(barrier.admittedHolderRevision!).toBe(durableReservation.admittedHolderRevision!.toString())
        expect(durableExecution.runnerClaimGeneration).toBe(durableReservation.admittedGeneration!)
        expect(durableReservation.ownerIncarnation!).toBe(String(barrier.incarnation))
        expect(durableReservation.state).toBe(String(barrier.state))
        expect(durableReservation.phase).toBe(String(barrier.phase))
        expect(durableReservation.phaseSequence).toBe(Number(barrier.phaseSequence))
        expect(durableReservation.operationId).toBe(barrier.operationId === null ? null : String(barrier.operationId))
        expect(durableReservation.resourceKey).toBe(barrier.resourceKey === null ? null : String(barrier.resourceKey))
        expect(durableReservation.token!).toBe(String(barrier.token!))
        expect(durableReservation.claimEpoch!.toString()).toBe(String(barrier.claimEpoch!))
        expect(barrier.state, target).toBe(
          target === 'provisional' || target === 'requested' || target === 'running'
            ? target
            : target === 'settlement'
              ? 'settling'
              : 'starting'
        )
        const expectedPhase =
          target === 'provisional' || target === 'requested' || target === 'running' || target === 'settlement'
            ? 'none'
            : target
        expect(barrier.phase, `${target} durable phase`).toBe(expectedPhase)
        if (expectedPhase !== 'none') {
          expect(barrier.operationId, `${target} operation identity`).toBeTruthy()
          expect(barrier.resourceKey, `${target} resource identity`).toBeTruthy()
        }
        await owner.close()
        successor = spawnRestartWorker('successor', execution.id)
        const settled = await successor.waitForEvent('settled')
        expect(await successor.awaitExit()).toBe(0)
        expect(settled.incarnation).not.toBe(String(barrier.incarnation))
        expect(settled.recovered).toContain(execution.id)
        expect(settled.result).toBe('started')
        expect(settled.reservationState).toBe('released')
        expect(settled.executionStatus).toBe('completed')
        expect(settled.runnerClaimToken).toBe(String(settled.token!))
        expect(settled.runnerClaimGeneration).toBe(settled.admittedGeneration!)
        const [successorReservation] = await db
          .select()
          .from(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, execution.id))
        const successorExecution = await Execution.mustFind(execution.id)
        expect(successorExecution.status).toBe('completed')
        expect(successorReservation.state).toBe('released')
        expect(successorReservation.phase).toBe('none')
        expect(successorReservation.ownerId!).toBe(String(settled.ownerId!))
        expect(successorReservation.ownerIncarnation!).toBe(String(settled.ownerIncarnation!))
        expect(successorReservation.token!).toBe(String(settled.token!))
        expect(successorReservation.claimEpoch!.toString()).toBe(String(settled.claimEpoch!))
        expect(successorExecution.runnerClaimToken).toBe(successorReservation.token!)
        expect(successorExecution.runnerClaimGeneration).toBe(successorReservation.admittedGeneration!)
        const [{ dead }] = await secondConnection`
          SELECT pg_try_advisory_lock(
            hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${String(barrier.incarnation)}, ${ADMISSION_LIVENESS_HASH_SEED})
          ) AS dead
        `
        expect(dead, `${target} owner lock must be dead`).toBe(true)
        await secondConnection`
          SELECT pg_advisory_unlock(
            hashtextextended(${ADMISSION_LIVENESS_LOCK_VERSION} || ${String(barrier.incarnation)}, ${ADMISSION_LIVENESS_HASH_SEED})
          )
        `

        // Startup recovery first downgrades the dead lease to a queue-owned
        // admission, so the successor begins a fresh token/epoch lineage.
        expect(BigInt(String(settled.claimEpoch!))).toBe(1n)
        const staleStore = new AdmissionReservationStore(String(barrier.ownerId!), String(barrier.incarnation))
        expect(
          await staleStore.releaseLease({
            executionId: execution.id,
            token: String(barrier.token!),
            claimEpoch: BigInt(String(barrier.claimEpoch!)),
            generation: Number(barrier.admittedGeneration!),
            holderRevision: BigInt(String(barrier.admittedHolderRevision!)),
            ownerId: String(barrier.ownerId!),
            ownerIncarnation: String(barrier.incarnation),
          })
        ).toBe(false)
        await expectNeighborUnchanged(excluded.neighbor.id, excluded.snapshot)
        await db
          .delete(executionAdmissionReservations)
          .where(eq(executionAdmissionReservations.executionId, excluded.neighbor.id))
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(executionAdmissionReservations)
          .where(
            and(
              eq(executionAdmissionReservations.executionId, execution.id),
              sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
            )
          )
        expect(count).toBe(0)
        expect(restartWorkers.size).toBe(0)
      } finally {
        for (const child of [owner, successor]) {
          if (!child || !restartWorkers.has(child)) continue
          await child.close()
        }
      }
    }, 60_000)
  }

  test('soaks 25 maintenance-off admissions with zero active reservations', async () => {
    soakPendingMessagesSpy = spyOn(Agent.prototype, 'listPendingHumanMessages').mockResolvedValue([])
    await maintenanceStore.initialize()
    const [maintenance] = await db
      .select()
      .from(instanceMaintenanceState)
      .where(eq(instanceMaintenanceState.id, 'global'))
    expect(maintenance).toMatchObject({ adminHold: false, platformLeaseId: null })
    const excluded = await createExcludedNeighbor(maintenance!.generation, maintenance!.holderRevision)
    const soakExecutions: Array<{ agent: Agent; execution: Execution }> = []
    // Admission is per agent/execution. Twenty-five unrelated agent types and
    // squads add expensive setup, not additional coverage of reservation leaks.
    const firstAgent = await createSquadAgent('zai:glm-5.2')
    for (let index = 0; index < 25; index += 1) {
      const agent =
        index === 0
          ? firstAgent
          : await Agent.create({ agentTypeId: firstAgent.agentTypeId, squadId: firstAgent.squadId! })
      if (index !== 0) createdAgentIds.push(agent.id)
      const execution = await agent.queueExecution({ message: `soak ${index}` })
      createdExecutionIds.push(execution.id)
      soakExecutions.push({ agent, execution })
    }
    const soakExecutionIds = soakExecutions.map(({ execution }) => execution.id)
    const [{ count: activeBefore }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(executionAdmissionReservations)
      .where(
        and(
          inArray(executionAdmissionReservations.executionId, soakExecutionIds),
          sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      )
    expect(activeBefore).toBe(25)

    for (const [index, { agent, execution }] of soakExecutions.entries()) {
      expect(await attemptPickup(execution), `soak ${index}`).toBe('started')
      const lifecycle = executionLifecycleRegistry.get(execution.id)!
      await lifecycle.runnerFinished
      const completed = new Promise<void>((resolve) => {
        const unsubscribe = eventEmitter.on('execution.updated', (payload) => {
          if (payload.executionId !== execution.id || payload.status === 'running') return
          unsubscribe()
          resolve()
        })
      })
      createdSessions.at(-1)!.pi.simulateNormalEnd(`soak ${index}`)
      await completed
      await lifecycle.settled
      expect((await Execution.mustFind(execution.id)).status).toBe('completed')
      expect(isSessionActive(agent.id)).toBe(false)
      expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      concurrencyLimiter.release(execution.id)
    }

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(executionAdmissionReservations)
      .where(
        and(
          inArray(executionAdmissionReservations.executionId, soakExecutionIds),
          sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
        )
      )
    expect(count).toBe(0)
    await expectNeighborUnchanged(excluded.neighbor.id, excluded.snapshot)
    expect(soakExecutions.filter(({ agent }) => isSessionActive(agent.id)).map(({ agent }) => agent.id)).toEqual([])
    expect(soakExecutionIds.filter((executionId) => executionLifecycleRegistry.get(executionId) !== undefined)).toEqual(
      []
    )
    expect(restartWorkers.size).toBe(0)
  })

  test('no-capacity: releases nothing it never acquired', async () => {
    const first = await createSquadAgent('zai:glm-5.2')
    const second = await createSquadAgent('zai:glm-5.2')
    const firstExecution = await first.queueExecution({ message: 'first' })
    const secondExecution = await second.queueExecution({ message: 'second' })
    createdExecutionIds.push(firstExecution.id, secondExecution.id)

    expect(await attemptPickup(firstExecution)).toBe('started')
    await waitFor(
      async () =>
        (await Execution.mustFind(firstExecution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'first execution to occupy the only zai slot' }
    )
    // This is intentionally aggregate coverage: the configured provider limit
    // is one, and the first execution consumes that sole unit of capacity.
    expect(concurrencyLimiter.getInFlight('zai')).toBe(1)
    expect(concurrencyLimiter.hasSlot(firstExecution.id)).toBe(true)

    const result = await attemptPickup(secondExecution)

    expect(result).toBe('no-capacity')
    // The first execution's slot is untouched — a 'no-capacity' result never
    // acquired anything of its own to release.
    expect(concurrencyLimiter.getInFlight('zai')).toBe(1)
    expect(concurrencyLimiter.hasSlot(firstExecution.id)).toBe(true)
    expect(concurrencyLimiter.hasSlot(secondExecution.id)).toBe(false)
    expect((await Execution.mustFind(secondExecution.id)).status).toBe('queued')
  })

  test('pre-CAS session guard: a live reservation for the agent blocks pickup without claiming', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'blocked by reservation' })
    createdExecutionIds.push(execution.id)

    // Simulate a session reservation for this agent that's still live for a
    // DIFFERENT execution (e.g. Execution.run()'s reserveSession call for a
    // still-in-flight execution). attemptPickup for THIS queued row must bail
    // before the CAS instead of claiming it out from under that reservation.
    const reservedExecutionId = randomUUID()
    expect(reserveSession(agent.id, reservedExecutionId)).toBe(true)

    try {
      const result = await attemptPickup(execution)

      // Restores the old reserve-before-CAS protection: without the pre-CAS
      // guard, this queued row would win the CAS and go 'running' with no
      // runner (Execution.run()'s own reserveSession call would fail against
      // the pre-existing reservation), stranding it until the watchdog's
      // orphan arm requeues it ~3 minutes later instead of the normal 5s poll.
      expect(result).toBe('no-capacity')
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
      expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)
    } finally {
      releaseSessionReservation(agent.id, reservedExecutionId)
    }
  })

  test('lost-race: releases the slot it acquired when the CAS loses', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'race me' })
    createdExecutionIds.push(execution.id)

    // A second, independent handle on the same still-queued row — this is
    // the "loser": its in-memory status is stale relative to the winner below.
    const staleHandle = await Execution.mustFind(execution.id)
    staleHandle.setAgent(agent)

    // The "winner" claims the CAS directly (bypassing attemptPickup, so no
    // provider slot is acquired for it — isolating the loser's release).
    expect(await execution.transitionTo({ kind: 'started' })).toBe(true)
    expect(staleHandle.status).toBe('queued')

    const result = await attemptPickup(staleHandle)

    expect(result).toBe('lost-race')
    expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
    // The loser acquired a zai slot before its CAS lost the race — it must
    // release that slot itself. No session was ever created for it.
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)

    // Settle the winner (never ran a real session) so cleanup doesn't wait
    // out the running-execution timeout.
    await execution.stop()
  })

  test('transition exception removes the never-started provisional lifecycle', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'claim throws' })
    createdExecutionIds.push(execution.id)
    const transition = spyOn(execution, 'transitionTo').mockRejectedValue(new Error('claim failed after transition'))

    try {
      expect(await attemptPickup(execution)).toBe('lost-race')
      expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    } finally {
      transition.mockRestore()
    }
  })

  test("sequential stale-handle lost-race does not release the already-running winner's slot", async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'stale sequential race' })
    createdExecutionIds.push(execution.id)

    // Handle A: fetched up front and never refreshed — models a stale
    // snapshot caller (e.g. pickupQueuedExecutions iterating an
    // Execution.list() list fetched before another trigger picks the row up
    // and fully settles it mid-sweep). Its in-memory status stays 'queued'.
    const handleA = await Execution.mustFind(execution.id)
    handleA.setAgent(agent)

    // Handle B: the real winner, picked up via the normal attemptPickup path
    // and awaited to completion — SEQUENTIALLY, not concurrently with
    // handleA's call below, so the inflight deduper (keyed by execution.id)
    // has already cleared its entry by the time handleA calls in. This is
    // exactly what the deduper (previous commit) cannot cover.
    const handleB = await Execution.mustFind(execution.id)
    handleB.setAgent(agent)
    expect(await attemptPickup(handleB)).toBe('started')
    await waitFor(
      async () =>
        (await Execution.mustFind(execution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'winner to start and create a session' }
    )
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    expect(handleA.status).toBe('queued')

    const result = await attemptPickup(handleA)

    expect(result).toBe('lost-race')
    // The critical assertion: the running winner's slot survives. Without
    // the ownership guard, handleA's tryAcquire would no-op onto the
    // winner's existing slot (same provider/modelId), its own CAS would
    // lose (the row is already 'running'), and its release(execution.id)
    // would delete the winner's slot — dropping this to 0 while the winner
    // is still actively running.
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
    // Only one session was ever created — the winner's run is undisturbed.
    expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(1)
  })

  test("dedupes concurrent attemptPickup calls for the same execution — loser must not release the winner's slot", async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'race concurrently' })
    createdExecutionIds.push(execution.id)

    // Two independent handles on the SAME still-queued row — mirrors the
    // real routine the reviewer flagged: queueExecution emits both
    // execution.created and execution.queued synchronously, and the worker
    // registers pickupIfQueued on both, so attemptPickup gets called twice
    // for the same execution id with no await between the two calls.
    const handleA = execution
    const handleB = await Execution.mustFind(execution.id)
    handleB.setAgent(agent)

    const [resultA, resultB] = await Promise.all([attemptPickup(handleA), attemptPickup(handleB)])

    // Both callers observe the SAME outcome — they shared one guard sequence
    // via the inflight dedupe, not two independent ones (pre-fix, the loser
    // ran its own guard sequence and got 'lost-race').
    expect(resultA).toBe('started')
    expect(resultB).toBe('started')

    // The critical assertion, checked immediately (before the runner's own
    // model-selection reconciliation — model-failover.ts's
    // concurrencyLimiter.reassign() — gets a chance to run and mask a
    // transient leak): the winner still owns its provider slot. Provider-wide
    // counts are asserted separately in the no-capacity test above; ownership
    // is the contract here because unrelated pickups may hold sibling slots.
    // Pre-fix, the "loser" ran its own redundant guard sequence for the same
    // id, its tryAcquire was a same-slot no-op, and its lost CAS then called
    // release(execution.id) — deleting the slot the running winner depends
    // on. Confirmed via a temporary deduper bypass: this assertion observed
    // getInFlight('zai') === 0 immediately after Promise.all against the
    // pre-fix code (see task-5-report.md for the full RED-evidence log).
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)

    await waitFor(
      async () =>
        (await Execution.mustFind(execution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'execution to start and create a session' }
    )

    // Only one session was ever created — the guard sequence (and therefore
    // the runner spawn) ran exactly once, not once per caller.
    expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(1)
  })

  test('refuses a legacy queued execution that has no canonical admission', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const [row] = await db.insert(executions).values({ agentId: agent.id, status: 'queued' }).returning()
    createdExecutionIds.push(row.id)
    const candidate = (await Execution.mustFind(row.id)).setAgent(agent)
    let admissionVerified = false
    setPickupAdmissionVerifiedHookForTests(() => (admissionVerified = true))
    try {
      expect(await attemptPickup(candidate)).toBe('lost-race')
    } finally {
      setPickupAdmissionVerifiedHookForTests()
    }
    expect(admissionVerified).toBe(false)
    expect((await Execution.mustFind(row.id)).status).toBe('queued')
    expect(createdSessions).toHaveLength(0)
  })

  test('refuses every pickup while duplicate active rows await reconciliation', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    ;(concurrencyLimiter as any).limits.zai = 4
    const rows = await db
      .insert(executions)
      .values(Array.from({ length: 4 }, () => ({ agentId: agent.id, status: 'queued' as const })))
      .returning()
    createdExecutionIds.push(...rows.map(({ id }) => id))
    await db
      .insert(executionAdmissionReservations)
      .values({ executionId: rows[2]!.id, agentId: agent.id, state: 'queued' })
    const candidates = await Promise.all(rows.map((row) => Execution.mustFind(row.id)))
    for (const candidate of candidates) candidate.setAgent(agent)

    const results = await Promise.all(candidates.map((candidate) => attemptPickup(candidate)))

    expect(results).toEqual(['lost-race', 'lost-race', 'lost-race', 'lost-race'])
    expect(
      await db
        .select()
        .from(executions)
        .where(and(eq(executions.agentId, agent.id), eq(executions.status, 'running')))
    ).toHaveLength(0)
    expect(createdSessions).toHaveLength(0)
  })

  test('picks up work after admin hold parks and atomically resumes its admission', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'before hold' })
    createdExecutionIds.push(execution.id)
    const paused = await maintenanceStore.setAdminHold({ active: true, actor: 'pickup-resume-test' })
    try {
      expect(await execution.parkForMaintenance(paused.generation)).toBe(true)
      await maintenanceStore.setAdminHold({ active: false, actor: 'pickup-resume-test' })
      expect(await maintenanceStore.resumeWaitingExecutions()).toEqual([{ id: execution.id, agentId: agent.id }])
      expect(await attemptPickup((await Execution.mustFind(execution.id)).setAgent(agent))).toBe('started')
    } finally {
      await maintenanceStore.setAdminHold({ active: false, actor: 'pickup-resume-cleanup' })
    }
  })

  test('picks up work queued during maintenance after resume repairs waiting admission', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    await maintenanceStore.setAdminHold({ active: true, actor: 'queue-during-hold' })
    try {
      const execution = await agent.queueExecution({ message: 'during hold' })
      createdExecutionIds.push(execution.id)
      expect(execution.status).toBe('waiting-maintenance')
      await maintenanceStore.setAdminHold({ active: false, actor: 'queue-during-hold' })
      expect(await maintenanceStore.resumeWaitingExecutions()).toHaveLength(1)
      expect(await attemptPickup((await Execution.mustFind(execution.id)).setAgent(agent))).toBe('started')
    } finally {
      await maintenanceStore.setAdminHold({ active: false, actor: 'queue-during-hold-cleanup' })
    }
  })

  test('repairs a maintenance-queued admission through a fresh store after restart', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    await maintenanceStore.setAdminHold({ active: true, actor: 'restart-resume' })
    try {
      const execution = await agent.queueExecution({ message: 'restart during hold' })
      createdExecutionIds.push(execution.id)
      await maintenanceStore.setAdminHold({ active: false, actor: 'restart-resume' })
      expect(await new MaintenanceStore().resumeWaitingExecutions()).toHaveLength(1)
      expect(await attemptPickup((await Execution.mustFind(execution.id)).setAgent(agent))).toBe('started')
    } finally {
      await maintenanceStore.setAdminHold({ active: false, actor: 'restart-resume-cleanup' })
    }
  })

  test('watchdog orphan requeue restores queue admission for the next pickup', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'watchdog retry' })
    createdExecutionIds.push(execution.id)
    const [maintenance] = await db.select().from(instanceMaintenanceState).limit(1)
    const now = new Date()
    await db
      .update(executions)
      .set({ status: 'running', startedAt: new Date(now.getTime() - 150_000) })
      .where(eq(executions.id, execution.id))
    await db
      .update(executionAdmissionReservations)
      .set({
        token: randomUUID(),
        claimEpoch: 1n,
        ownerId: 'orphan-watchdog',
        ownerIncarnation: admissionProcessIncarnation,
        admittedGeneration: maintenance!.generation,
        admittedHolderRevision: maintenance!.holderRevision,
        state: 'running',
        leaseExpiresAt: new Date(now.getTime() - 10_000),
        lastHeartbeatAt: new Date(now.getTime() - 10_000),
      })
      .where(eq(executionAdmissionReservations.executionId, execution.id))

    const t0 = now.getTime()
    await runQueueWatchdogOnce({ now: t0 })
    await runQueueWatchdogOnce({ now: t0 + WATCHDOG_INTERVAL_MS + 1 })
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect(await attemptPickup(execution)).toBe('started')
  })

  /** Insert a ready machine and bind the agent's box to it (unfenced). */
  async function bindBoxForAgent(agent: Agent): Promise<string> {
    const sandboxId = await agent.getSandboxId()
    const machine = await insertMachine({
      name: `pickup-fence-${randomUUID()}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    createdMachineIds.push(machine.id)
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    return sandboxId
  }

  /**
   * From the second connection, try to take the box row's `FOR UPDATE` lock
   * with NOWAIT. Returns `'locked'` when the lock was acquired (nobody held
   * it — autocommit releases it at statement end) or the SQLSTATE code of the
   * failure (`'55P03'` = lock held elsewhere).
   */
  async function tryLockBoxRowFromSecondConnection(sandboxId: string): Promise<string> {
    try {
      await secondConnection`SELECT migrating FROM machine_boxes WHERE sandbox_id = ${sandboxId} FOR UPDATE NOWAIT`
      return 'locked'
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown'
    }
  }

  /**
   * The load-bearing evidence for a deliberate omission: `sandboxActivity`'s
   * squad predicate counts `running`/`stopping` but NOT `queued`
   * (box-migrate.ts). That is only safe if a queued row the fence ignored can
   * never start behind its back — pickup's start guard takes the same
   * `machine_boxes` row `FOR UPDATE` inside the claim transaction, so a
   * committed fence forces it to defer.
   *
   * Everything here runs on real connections against real Postgres with the
   * REAL production probe (no stubbed fence check), in the dangerous order:
   * the fence commits first, THEN the queued execution tries to claim.
   */
  test('box-migrating: a queued execution does not block the squad fence — and cannot start once it commits', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'wait for squad migration' })
    createdExecutionIds.push(execution.id)
    const sandboxIds = await agent.getExecutionSandboxIds()
    const machine = await insertMachine({
      name: `pickup-squad-fence-${randomUUID()}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    createdMachineIds.push(machine.id)
    for (const [index, sandboxId] of sandboxIds.entries()) {
      await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: `box-${index}` })
    }
    const squadSandboxId = `squad_${agent.squadId}`
    expect(sandboxIds).toContain(squadSandboxId)
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')

    // 1. The queued row is invisible to the production activity probe...
    expect(await sandboxHasActiveExecution(squadSandboxId)).toBe(false)
    // 2. ...so the real fence (set-then-recheck, real probe) claims the box
    //    despite it.
    expect(await fenceBoxForMigration(squadSandboxId, sandboxHasActiveExecution)).toBe(true)

    // 3. And the row it ignored still cannot start: pickup's locked read sees
    //    the committed fence and defers, writing nothing.
    expect(await attemptPickup(execution)).toBe('box-migrating')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)

    // 4. The row really was startable — the deferral above was the fence, not
    //    an ineligible fixture.
    await clearBoxMigrating(squadSandboxId)
    expect(await attemptPickup(execution)).toBe('started')

    // 5. The other half of the trade: a RUNNING execution of the same squad
    //    DOES refuse the fence, so ignoring `queued` gives up no safety.
    //    Inserted directly so the assertion cannot race execution.run()'s
    //    settlement.
    const [running] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    createdExecutionIds.push(running.id)
    expect(await sandboxHasActiveExecution(squadSandboxId)).toBe(true)
    expect(await fenceBoxForMigration(squadSandboxId, sandboxHasActiveExecution)).toBe(false)
  })

  test("box-migrating: defers pickup while the agent's box is fenced, then starts after the fence clears", async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'wait for the fence' })
    createdExecutionIds.push(execution.id)

    // A REAL fenced box for this agent's sandbox: machine + bound box row,
    // fenced via the same claim primitive the migration path uses (so the
    // pickup's locked read is exercised against genuine fence state, not a
    // stub).
    const sandboxId = await agent.getSandboxId()
    const machine = await insertMachine({
      name: `pickup-fence-${randomUUID()}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    createdMachineIds.push(machine.id)
    await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: 'box' })
    expect(await fenceBoxForMigration(sandboxId, async () => false)).toBe(true)

    const result = await attemptPickup(execution)

    // Deferred, not failed: the row stays 'queued' (no queued->running CAS
    // committed — the claim was refused inside the claim transaction under
    // the box row's FOR UPDATE lock), no runner was spawned, and no provider
    // slot is held afterwards. Retried on a later worker tick like
    // 'no-capacity'.
    expect(result).toBe('box-migrating')
    expect((await Execution.mustFind(execution.id)).status).toBe('queued')
    expect(execution.status).toBe('queued')
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)

    // Fence lifts (migration finished/failed) -> the SAME queued row is
    // picked up normally on re-attempt (the worker's 5s poll in production).
    await clearBoxMigrating(sandboxId)

    expect(await attemptPickup(execution)).toBe('started')
    await waitFor(
      async () =>
        (await Execution.mustFind(execution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'execution to start once the fence cleared' }
    )
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
  })

  test('box-migrating: the claim BLOCKS on the box row lock while a fence transaction is in flight, and refuses once it commits', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'race an in-flight fence transaction' })
    createdExecutionIds.push(execution.id)
    await bindBoxForAgent(agent)
    const sandboxId = `squad_${agent.squadId}`
    const squadMachine = await insertMachine({
      name: `pickup-squad-holder-${randomUUID()}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    createdMachineIds.push(squadMachine.id)
    await bindMachineBox({ sandboxId, machineId: squadMachine.id, unixUser: 'box-squad-holder' })

    // An IN-FLIGHT fence transaction (not yet committed), driven from a
    // genuinely separate connection: take the box row FOR UPDATE and set
    // migrating = true, then HOLD the transaction open — the exact window
    // mid-fenceBoxForMigration, between its locked set and its commit.
    let commitHolder!: () => void
    const holderGate = new Promise<void>((resolve) => {
      commitHolder = resolve
    })
    let signalFenceLockTaken!: () => void
    const fenceLockTaken = new Promise<void>((resolve) => {
      signalFenceLockTaken = resolve
    })
    const holder = secondConnection.begin(async (tx) => {
      // postgres.js typings gap: TransactionSql extends Omit<Sql, ...>, and
      // Omit drops the tagged-template call signatures — cast back to the
      // callable shape (runtime object is the same tagged-template function).
      const sql = tx as unknown as postgres.Sql
      await sql`SELECT migrating FROM machine_boxes WHERE sandbox_id = ${sandboxId} FOR UPDATE`
      await sql`UPDATE machine_boxes SET migrating = true WHERE sandbox_id = ${sandboxId}`
      signalFenceLockTaken()
      await holderGate
    })

    try {
      await fenceLockTaken

      // THE same-transaction pin: attemptPickup's claim must BLOCK on the box
      // row lock (its guard is the locked read INSIDE the claim transaction),
      // so its promise cannot settle while the fence transaction holds the
      // lock. A plain (non-locking) fence read — inside the transaction or
      // hoisted out of it — would not block: it would read the pre-fence
      // migrating = false (the holder's write is uncommitted) and settle
      // 'started' here, starting a turn under a live migration.
      const pickup = attemptPickup(execution)
      const raced = await Promise.race([
        pickup.then((result) => `settled:${result}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 400)),
      ])
      expect(raced).toBe('pending')

      // Fence commits (migrating = true now durable) -> the blocked locked
      // read wakes, sees the fence, and refuses the claim.
      commitHolder()
      await holder

      expect(await pickup).toBe('box-migrating')
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
      expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)
    } finally {
      // On assertion failure, make sure the holder transaction is never left
      // open (it would wedge afterEach's machine cleanup on the row lock).
      commitHolder()
      await holder.catch(() => {})
    }
  })

  test('box-migrating: the fence read runs on the OPEN claim transaction, its row lock still held after it returns', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'probe the claim lock' })
    createdExecutionIds.push(execution.id)
    const sandboxId = await bindBoxForAgent(agent) // bound, NOT fenced

    // Complements the blocking test above (which a hoisted-but-still-locking
    // guard would survive: an autocommit FOR UPDATE read also blocks on the
    // holder and then sees the committed fence). Here the guard delegates to
    // the REAL locked read on the handle it was given, then HOLDS the claim
    // transaction open — if the guard ran on an autocommit handle OUTSIDE the
    // claim transaction (the forbidden hoist), the row lock would already be
    // released at statement end, and the fence could sneak in between the
    // guard's read and the claim's commit.
    let releaseGuard!: () => void
    const guardGate = new Promise<void>((resolve) => {
      releaseGuard = resolve
    })
    let signalGuardRead!: () => void
    const guardRead = new Promise<void>((resolve) => {
      signalGuardRead = resolve
    })
    setBoxMigratingLockedCheckForTests(async (tx, boxSandboxIds) => {
      const migrating = await areBoxesMigratingLocked(tx, boxSandboxIds)
      signalGuardRead()
      await guardGate
      return migrating
    })

    try {
      const pickup = attemptPickup(execution)
      await guardRead

      // The guard's FOR UPDATE statement has COMPLETED, yet the box row lock
      // must still be held — proof the read ran inside the still-open claim
      // transaction, whose lock persists through the queued->running commit.
      expect(await tryLockBoxRowFromSecondConnection(sandboxId)).toBe('55P03')

      releaseGuard()
      // Unfenced box -> the held-open claim proceeds and wins normally.
      expect(await pickup).toBe('started')
    } finally {
      releaseGuard()
      setBoxMigratingLockedCheckForTests()
    }

    await waitFor(
      async () =>
        (await Execution.mustFind(execution.id)).status === 'running' &&
        ((createSessionSpy as any)?.mock.calls.length ?? 0) >= 1,
      { description: 'execution to start after the gated guard released' }
    )
    expect(concurrencyLimiter.hasSlot(execution.id)).toBe(true)
  })

  test('box-migrating: pickup first locks private and squad boxes so a racing squad fence backs off', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'pickup wins the squad race' })
    createdExecutionIds.push(execution.id)
    const sandboxIds = await agent.getExecutionSandboxIds()
    const machine = await insertMachine({
      name: `pickup-wins-${randomUUID()}`,
      provider: 'ssh',
      sshHost: '10.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'secret-key-1',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      status: 'ready',
    })
    createdMachineIds.push(machine.id)
    for (const [index, sandboxId] of sandboxIds.entries()) {
      await bindMachineBox({ sandboxId, machineId: machine.id, unixUser: `box-race-${index}` })
    }
    const squadSandboxId = `squad_${agent.squadId}`

    let releaseGuard!: () => void
    const guardGate = new Promise<void>((resolve) => {
      releaseGuard = resolve
    })
    let signalLocked!: () => void
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve
    })
    setBoxMigratingLockedCheckForTests(async (tx, ids) => {
      const migrating = await areBoxesMigratingLocked(tx, ids)
      signalLocked()
      await guardGate
      return migrating
    })

    try {
      const pickup = attemptPickup(execution)
      await locked
      for (const sandboxId of sandboxIds) {
        expect(await tryLockBoxRowFromSecondConnection(sandboxId)).toBe('55P03')
      }

      const fence = fenceBoxForMigration(squadSandboxId, sandboxHasActiveExecution)
      expect(
        await Promise.race([
          fence.then(() => 'settled'),
          new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
        ])
      ).toBe('pending')

      releaseGuard()
      expect(await pickup).toBe('started')
      expect(await fence).toBe(false)
      expect(
        (await db.select().from(machineBoxes).where(eq(machineBoxes.sandboxId, squadSandboxId)))[0]?.migrating
      ).toBe(false)
    } finally {
      releaseGuard()
      setBoxMigratingLockedCheckForTests()
    }
  })

  test('no-capacity: a sandbox-resolution failure defers the pickup instead of rejecting', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'orphaned subagent' })
    createdExecutionIds.push(execution.id)

    // Models the orphan-subagent race: getSandboxId() throws when a
    // subagent's parent row vanished between canPickupForAgent and the
    // sandbox resolution in doAttemptPickup. That throw must NOT escape
    // attemptPickup — on the event path (pickupIfQueued) it would become an
    // unhandled rejection, and in the poll sweep it would abort the rest of
    // that tick's queued list. Instead: 'no-capacity', row stays queued
    // (retried later), no provider slot leaked.
    const getSandboxIdSpy = spyOn(Agent.prototype, 'getSandboxId').mockImplementation(async () => {
      throw new Error(`Subagent parent vanished for sandbox resolution`)
    })

    try {
      const result = await attemptPickup(execution)

      expect(result).toBe('no-capacity')
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
      expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)
    } finally {
      getSandboxIdSpy.mockRestore()
    }
  })

  test('instance-paused: leaves work queued without creating a session', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'paused work' })
    createdExecutionIds.push(execution.id)
    await maintenanceStore.initialize()
    await maintenanceStore.setAdminHold({ active: true, reason: 'test', actor: 'test' })
    try {
      expect(await attemptPickup(execution)).toBe('instance-paused')
      expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      expect((await Execution.mustFind(execution.id)).status).toBe('waiting-maintenance')
      expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)
    } finally {
      await maintenanceStore.setAdminHold({ active: false, actor: 'test' })
    }
  })

  // The test above only proves the CACHED fast path, which this process
  // populated itself. The authoritative gate is `isPausedLocked` inside the
  // claim transaction, and it is the one that matters: a pause committed by
  // ANOTHER process (the API handling PUT /pause/admin) is invisible to this
  // worker's cache until its 60s refresh or the notify lands — and
  // `isPausedCached` answers `false` outright when the cache is unpopulated.
  // Writing the row directly leaves the cache stale on purpose, so only the
  // in-transaction fence can refuse this claim.
  test('instance-paused: an out-of-process pause still fences the claim transaction', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'externally paused work' })
    createdExecutionIds.push(execution.id)
    await maintenanceStore.initialize()
    await db
      .update(instanceMaintenanceState)
      .set({ adminHold: true, adminHeldAt: new Date(), adminHeldBy: 'other-process', generation: 1 })
      .where(eq(instanceMaintenanceState.id, 'global'))
    // Precondition: this process cannot see the pause yet, so a passing
    // assertion below cannot be the cached check doing the work.
    expect(maintenanceStore.isPausedCached()).toBe(false)
    try {
      expect(await attemptPickup(execution)).toBe('instance-paused')
      expect((await Execution.mustFind(execution.id)).status).toBe('waiting-maintenance')
      expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
    } finally {
      await db
        .update(instanceMaintenanceState)
        .set({ adminHold: false, adminHeldAt: null, adminHeldBy: null })
        .where(eq(instanceMaintenanceState.id, 'global'))
      await maintenanceStore.refresh()
    }
  })

  test('box-migrating: the injected fence check runs inside the claim transaction with every accessible sandboxId', async () => {
    const agent = await createSquadAgent('zai:glm-5.2')
    const execution = await agent.queueExecution({ message: 'stubbed fence' })
    createdExecutionIds.push(execution.id)

    // Injection seam: no machine/box rows at all — the stub alone must defer
    // the pickup, and it must be handed a live transaction handle (the claim
    // transaction's) plus the sandboxId resolved from the execution's agent.
    const seen: Array<{ sandboxIds: string[]; hasTx: boolean }> = []
    setBoxMigratingLockedCheckForTests(async (tx, sandboxIds) => {
      seen.push({ sandboxIds, hasTx: typeof tx?.select === 'function' })
      return true
    })

    try {
      const result = await attemptPickup(execution)

      expect(result).toBe('box-migrating')
      expect(executionLifecycleRegistry.get(execution.id)).toBeUndefined()
      expect(seen).toEqual([{ sandboxIds: await agent.getExecutionSandboxIds(), hasTx: true }])
      expect((await Execution.mustFind(execution.id)).status).toBe('queued')
      expect(concurrencyLimiter.hasSlot(execution.id)).toBe(false)
      expect((createSessionSpy as any)?.mock.calls.length ?? 0).toBe(0)
    } finally {
      setBoxMigratingLockedCheckForTests()
    }
  })
})
