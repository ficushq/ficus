import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { agents, db, executions, executionAdmissionReservations } from '../../db'
import { acquireMaintenanceTestIsolation } from '../../test-utils/maintenance-test-isolation'
import { AdmissionReservationStore, AdmissionScope } from '../maintenance/admission-reservation'
import { MaintenanceStore } from '../maintenance/store'
import { ensureWorkspaceSandbox, type EnsureWorkspaceDeps } from './ensure'

let releaseIsolation: (() => Promise<void>) | undefined
beforeAll(async () => (releaseIsolation = await acquireMaintenanceTestIsolation()))
afterAll(() => releaseIsolation?.())

// Bound a readiness handshake so a missing heartbeat fails with a useful
// assertion and finally can release/join both callers, rather than leaking a
// blocked warmup when the test runner's outer timeout expires.
async function ready<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Sandbox wait never opened its admission heartbeat')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const disposition of ['resume', 'maintenance', 'successor'] as const) {
  test(`joining a warmup rebuild renews the runner lease and respects ${disposition}`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ficus-admission-wait-'))
    const [agent] = await db.insert(agents).values({ agentTypeId: 'worker' }).returning()
    const [execution] = await db.insert(executions).values({ agentId: agent.id, status: 'running' }).returning()
    const store = new AdmissionReservationStore('worker:test', crypto.randomUUID())
    const lease = await store.createProvisional(execution.id)
    expect(await store.adoptLease(lease)).toBe(true)
    const sandboxId = `agent_${agent.id}`
    const rebuildStarted = Promise.withResolvers<void>()
    const releaseRebuild = Promise.withResolvers<void>()
    const heartbeatStarted = Promise.withResolvers<void>()
    let heartbeat: (() => void) | undefined
    let timers = 0
    const scope = new AdmissionScope(store, lease, (callback) => {
      heartbeat = callback
      timers++
      heartbeatStarted.resolve()
      return () => {
        timers--
      }
    })
    let rebuilds = 0
    let ensures = 0
    let stamp = 'old'
    const manager = {
      assertProvisionInspectionAllowed: async () => {},
      computeSpecHash: () => 'new',
      getRunningSandboxSpecHash: async () => stamp,
      recreateSandbox: async () => {
        rebuilds++
        rebuildStarted.resolve()
        await releaseRebuild.promise
        stamp = 'new'
        return '/private'
      },
      ensureSandbox: async () => {
        ensures++
      },
      getWorkspaceLayout: () => ({ privateMount: '/private', workspaceMount: '/workspace' }),
    }
    const deps = {
      isK8sRuntime: () => false,
      isRemoteSandboxRuntime: () => true,
      getSandboxManager: () => manager,
      getHomeDir: () => tmp,
      getCliHostPath: () => join(tmp, 'unused'),
      ensureSquadWorkspace: () => '/workspace',
      isSessionActive: () => false,
    } as unknown as EnsureWorkspaceDeps
    const pending: Promise<unknown>[] = []
    try {
      const warmup = ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId }, deps)
      pending.push(warmup)
      await ready(rebuildStarted.promise)
      // Warmup has no execution lease; the runner must renew ITS OWN lease
      // while joining the shared rebuild, without starting a second rebuild.
      const runner = ensureWorkspaceSandbox({ sandboxId, workspaceId: sandboxId, admissionScope: scope }, deps)
      const result = runner.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      )
      pending.push(result)
      await ready(heartbeatStarted.promise)
      expect(ensures).toBe(0)
      expect(rebuilds).toBe(1)
      const [waiting] = await db
        .select()
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(waiting).toMatchObject({ state: 'starting', phase: 'sandbox-ensure', resourceKey: `sandbox:${sandboxId}` })

      // Advance lease age using the database clock instead of sleeping 30s.
      // The real heartbeat must repair/renew this exact in-flight phase.
      await db
        .update(executionAdmissionReservations)
        .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      await heartbeat!()
      const [renewed] = await db
        .select({ live: sql<boolean>`lease_expires_at > clock_timestamp()` })
        .from(executionAdmissionReservations)
        .where(eq(executionAdmissionReservations.executionId, execution.id))
      expect(renewed.live).toBe(true)

      if (disposition === 'maintenance') {
        await new MaintenanceStore().setAdminHold({ active: true, actor: 'test' })
      } else if (disposition === 'successor') {
        await db
          .update(executionAdmissionReservations)
          .set({ token: crypto.randomUUID(), claimEpoch: lease.claimEpoch + 1n })
          .where(eq(executionAdmissionReservations.executionId, execution.id))
      }
      releaseRebuild.resolve()
      await warmup
      const outcome = await result
      if (disposition === 'resume') {
        expect(outcome.error).toBeNull()
        expect(outcome.value).toBe('/private')
        expect(ensures).toBe(1)
      } else {
        expect(outcome.error).toBeInstanceOf(Error)
        expect(ensures).toBe(0)
      }
      expect(rebuilds).toBe(1)
      expect(timers).toBe(0)
    } finally {
      releaseRebuild.resolve()
      await Promise.allSettled(pending)
      await scope.close()
      if (disposition === 'maintenance') await new MaintenanceStore().setAdminHold({ active: false, actor: 'test' })
      await db.delete(executions).where(eq(executions.id, execution.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
      rmSync(tmp, { recursive: true, force: true })
    }
  })
}
