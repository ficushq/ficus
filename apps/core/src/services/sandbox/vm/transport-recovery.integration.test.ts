import { describe, expect, test } from 'bun:test'
import { SandboxClient, SandboxTransportError } from '../k8s/http-client'
import { runIdempotentSandboxOperation } from './retry'

describe('VM transport recovery integration', () => {
  test('classifies a socket reset, replaces the client, and retries only the declared health probe', async () => {
    const auth: Array<string | null> = []
    const stale = new SandboxClient('stale.test', 'box-token', {
      fetch: async (_input, init) => {
        auth.push(new Headers(init?.headers).get('authorization'))
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })
      },
    })
    const fresh = new SandboxClient('fresh.test', 'box-token', {
      fetch: async (_input, init) => {
        auth.push(new Headers(init?.headers).get('authorization'))
        return Response.json({ healthy: true, devboxReady: true, version: 'test', uptimeSeconds: 1 })
      },
    })
    let current = stale
    let recoveries = 0
    const health = await runIdempotentSandboxOperation({
      sandboxId: 'squad_s1',
      operationClass: 'health',
      getClient: () => current,
      recoverClient: async (_failed, cause) => {
        expect(cause).toBeInstanceOf(SandboxTransportError)
        expect((cause as SandboxTransportError).kind).toBe('connection_reset')
        recoveries++
        return (current = fresh)
      },
      operation: (client) => client.health(),
      sleep: async () => {},
    })

    expect(health.devboxReady).toBe(true)
    expect(recoveries).toBe(1)
    expect(auth).toEqual(['Bearer box-token', 'Bearer box-token'])
  })
})

describe('VM degraded setup recovery triplet', () => {
  test('settles ambiguous Devbox once, continues bashrc/Git on generation two, backs off, then recovers', async () => {
    const { reconcileVmSetup } = await import('./setup-reconciler')
    const { runBash } = await import('./file-sync')
    const oldClient = new SandboxClient('old.test', undefined, {
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/bash/cancel')) throw Object.assign(new Error('cancel reset'), { code: 'ECONNRESET' })
        if (url.endsWith('/bash')) return new Response('')
        return Response.json({ ok: true })
      },
    })
    const freshClient = new SandboxClient('fresh.test', undefined, {
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.endsWith('/bash')) return new Response('data: {"exitCode":0}\n\n')
        return Response.json({ remainingPids: [] })
      },
    })
    let current = oldClient
    let now = new Date(0)
    let durable: any = {
      sandboxId: 'squad_s1',
      desiredFingerprint: 'fp',
      readiness: 'pending',
      reasons: [],
      attemptCount: 0,
      nextAttemptAt: null,
      pendingInvocationId: null,
      pendingInvocationKind: null,
      lastFailureClass: null,
      lastAttemptAt: null,
      updatedAt: now,
    }
    const effects: string[] = []
    const deps: any = {
      withLease: async (_id: string, fn: () => Promise<unknown>) => fn(),
      ensureFingerprint: async () => durable,
      markReconciling: async () => true,
      setPendingInvocation: async (_id: string, _fp: string, invocationId: string, kind: string) => {
        durable = { ...durable, pendingInvocationId: invocationId, pendingInvocationKind: kind }
        effects.push(`fence:${kind}`)
        return true
      },
      clearPendingInvocation: async (_id: string, _fp: string, invocationId: string) => {
        if (durable.pendingInvocationId === invocationId)
          durable = { ...durable, pendingInvocationId: null, pendingInvocationKind: null }
        effects.push(`clear:${invocationId}`)
        return true
      },
      markDegraded: async (input: any) =>
        (durable = {
          ...durable,
          readiness: 'ready_degraded',
          reasons: input.reasons,
          attemptCount: durable.attemptCount + 1,
          nextAttemptAt: new Date(now.getTime() + 30_000),
        }),
      markReady: async () => {
        durable = { ...durable, readiness: 'ready', reasons: [], attemptCount: 0, nextAttemptAt: null }
        return true
      },
      getClient: () => current,
      recoverClient: async () => (current = freshClient),
      seedDevbox: async (client: SandboxClient, invocationId: string) => {
        effects.push('devbox')
        await runBash(client, 'devbox install', 'devbox_install', invocationId)
      },
      signalDevboxReady: async () => {
        effects.push('devbox-ready')
      },
      writeBashrc: async (client: unknown) => {
        expect(client).toBe(freshClient)
        effects.push('bashrc')
      },
      configureGit: async (client: unknown) => {
        expect(client).toBe(freshClient)
        effects.push('git')
      },
      sleep: async () => {},
      now: () => now,
    }
    const input = {
      sandboxId: 'squad_s1',
      fingerprint: 'fp',
      devboxInvocationId: 'devbox-1',
      gitInvocationId: 'git-1',
      configureGit: true,
    }
    const degraded = await reconcileVmSetup({ ...input, now }, deps)
    expect(degraded).toMatchObject({ readiness: 'ready_degraded', reasons: ['devbox_unavailable'], attemptCount: 1 })
    expect(effects).toContain('devbox')
    expect(effects).toContain('bashrc')
    expect(effects).toContain('git')
    const beforeBackoff = effects.length
    await reconcileVmSetup({ ...input, now }, deps)
    expect(effects).toHaveLength(beforeBackoff)

    now = new Date(31_000)
    const recovered = await reconcileVmSetup({ ...input, now }, deps)
    expect(recovered).toMatchObject({ readiness: 'ready', reasons: [], attemptCount: 0 })
    expect(effects.filter((effect) => effect === 'devbox')).toHaveLength(2)
    expect(effects).toContain('devbox-ready')
  })
})

describe('production VM recovery wiring', () => {
  test('repairs the exact tunnel, persists/alerts degradation through lifecycle, and emits one recovery', async () => {
    const { createHash, randomUUID } = await import('crypto')
    const { mkdtempSync, rmSync, writeFileSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const { eq, inArray } = await import('drizzle-orm')
    const { db } = await import('../../../db')
    const { machines, machineBoxes, vmBoxSetupStates, fleetIncidents, fleetIncidentNotifications, inbox } =
      await import('../../../db/schema')
    const { MachineTunnelManager } = await import('../../machines/tunnel-manager')
    const { computeDevboxInstallInvocationId } = await import('../../machines/devbox-seed')
    const { VmSandboxManager } = await import('./manager')
    const { resolveBoxApiUrl, runBash } = await import('./file-sync')
    const { recoverVmSetupOwner } = await import('./lifecycle')
    const { reconcileVmSetupIncidents } = await import('./setup-state')
    const { FleetIncidentNotifier } = await import('../../fleet-alerts/notifier')

    const machineId = randomUUID()
    const sandboxId = `agent_${randomUUID()}`
    // /tmp on darwin: os.tmpdir()'s /var/folders/... base pushes the derived
    // owner socket path past the tunnel manager's 90-byte guard (see
    // tunnel-manager.test.ts).
    const controlDir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'vm-rec-'))
    const socketPath = join(controlDir, `${createHash('sha256').update(machineId).digest('hex').slice(0, 12)}.sock`)
    writeFileSync(socketPath, 'integration-master')
    const sshCalls: string[][] = []
    const spawn = ((args: string[]) => {
      sshCalls.push(args)
      const isCheck = args.includes('-O') && args[args.indexOf('-O') + 1] === 'check'
      return {
        stdout: isCheck ? 'Master running (pid=700)' : '',
        stderr: '',
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }) as unknown as typeof Bun.spawn
    const tunnels = new MachineTunnelManager({ spawn, controlDir, controlTimeoutMs: 50 })
    const machine = {
      id: machineId,
      name: `integration-${machineId}`,
      provider: 'ssh',
      providerRef: null,
      sshHost: '127.0.0.1',
      sshPort: 22,
      sshUser: 'ficus',
      sshKeyId: 'unused',
      sshPublicKey: 'test',
      status: 'ready',
      capabilities: {},
      scope: 'shared',
      bootstrapVersion: null,
      lastSeenAt: null,
      createdAt: new Date(),
    } as any
    await db.insert(machines).values({
      id: machineId,
      name: machine.name,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'ficus',
      sshKeyId: 'unused',
      sshPublicKey: 'test',
      status: 'ready',
    })
    await db
      .insert(machineBoxes)
      .values({ sandboxId, machineId, unixUser: 'ficus', port: 50100, status: 'ready', authToken: 'box-token' })

    let bashCalls = 0
    const oldClient = new SandboxClient('127.0.0.1:45000', 'box-token', {
      fetch: async (input) => {
        if (String(input).endsWith('/bash')) bashCalls++
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      },
    })
    const recoveredCancelBodies: Array<{ invocationId?: string; reason?: string }> = []
    const createFreshClient = () =>
      new SandboxClient('127.0.0.1:45001', 'box-token', {
        fetch: async (input, init) => {
          const url = String(input)
          if (url.endsWith('/bash/cancel')) recoveredCancelBodies.push(JSON.parse(String(init?.body)))
          if (url.endsWith('/bash')) {
            bashCalls++
            return new Response('data: {"exitCode":0}\n\n')
          }
          return url.endsWith('/healthz')
            ? Response.json({ healthy: true, devboxReady: true, version: 'test', uptimeSeconds: 1 })
            : Response.json({ remainingPids: [] })
        },
      })
    let clientCreations = 0
    let seedCalls = 0
    const previousConsoleLog = console.log
    const logLines: string[] = []
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(' '))
    }

    const initialLocalPort = await tunnels.addForward(machine, 50100)
    const manager = new VmSandboxManager({
      resolveMachine: async () => machine,
      resolveBoxApiUrl: (m: any) =>
        resolveBoxApiUrl(m, {
          tunnels,
          getCorePort: () => 3000,
          getAppUrl: () => undefined,
          sleep: async () => {},
          warn: () => {},
        }),
      ensureBox: async () =>
        ({
          machine,
          box: {
            sandboxId,
            machineId,
            unixUser: 'ficus',
            port: 50100,
            status: 'ready',
            authToken: 'box-token',
            syncedHashes: {},
          },
          endpoint: `http://127.0.0.1:${initialLocalPort}`,
        }) as any,
      syncBoxFiles: async () => {},
      seedBoxDevbox: async (client: SandboxClient, _id: string, _role: any, invocationId?: string) => {
        seedCalls++
        if (seedCalls === 1) await runBash(client, 'devbox install', 'devbox_install', invocationId)
        else if (seedCalls <= 3) throw new Error('devbox unavailable')
        return {}
      },
      createClient: () => (++clientCreations === 1 ? oldClient : createFreshClient()),
      resolveGitHubIdentity: async () => ({
        githubToken: 'token',
        gitUserName: 'Bot',
        gitUserEmail: 'bot@example.com',
      }),
      getSecret: () => 'callback-secret',
      getBundleVersion: async () => 'bundle',
      getBoxProvisionVersion: () => 'provision',
      getAppUrl: () => undefined,
      boxChainHealth: async () => ({
        status: 'ready',
        chain: { boxProvisioned: true, machine: 'reachable', boxServer: 'up' },
      }),
      ensureMaster: (m: any) => tunnels.ensureMaster(m),
      refreshForward: (m: any, port: number) => tunnels.refreshForward(m, port),
      addForward: (m: any, port: number) => tunnels.addForward(m, port),
      removeForward: (id: string, port: number) => tunnels.removeForwardById(id, port),
      releaseMachineForwards: (id: string) => tunnels.cancelMachineForwards(id),
      persistBoxActivity: async () => {},
    } as any)

    try {
      await manager.ensureSandbox(sandboxId, { workspacePath: '/tmp/work', k8s: { sandboxType: 'agent' } })
      expect(await manager.getSandboxStatus(sandboxId)).toMatchObject({
        status: 'running',
        readiness: 'ready_degraded',
        degradation: { reasons: ['devbox_unavailable'], attemptCount: 1 },
      })
      expect(seedCalls).toBe(1) // ambiguous Devbox was not replayed in the same cycle
      expect(recoveredCancelBodies).toHaveLength(1)
      expect(recoveredCancelBodies[0]).toMatchObject({
        invocationId: computeDevboxInstallInvocationId(sandboxId, 'agent'),
        reason: 'transport-loss',
      })
      expect(logLines.find((line) => line.includes(`Box ready_degraded: ${sandboxId}`))).toContain(
        'reasons=devbox_unavailable attempt=1'
      )
      expect(logLines.find((line) => line.includes('VM transport recovery complete'))).toContain(
        '"localForward":"rebound"'
      )
      expect(sshCalls.some((args) => args.includes('-O') && args[args.indexOf('-O') + 1] === 'check')).toBe(true)
      const mutations = sshCalls.filter(
        (args) => args.includes('-O') && ['forward', 'cancel'].includes(args[args.indexOf('-O') + 1])
      )
      expect(mutations.some((args) => args.includes('-R'))).toBe(true)
      expect(mutations.some((args) => args.includes('cancel') && args.includes('-L'))).toBe(true)
      expect(mutations.some((args) => args.includes('forward') && args.includes('-L'))).toBe(true)

      const recover = () =>
        recoverVmSetupOwner(sandboxId, {
          reconcileTracked: (id) => manager.reconcileDueSetup(id),
          ensureSquad: async () => {
            throw new Error('wrong owner')
          },
          classifyAgentOwner: async () => ({ kind: 'live' as const, agent: { id: sandboxId } }),
          ensureAgent: async () => {
            await manager.ensureSandbox(sandboxId, { workspacePath: '/tmp/work', k8s: { sandboxType: 'agent' } })
          },
          ensureSystemManager: async () => {
            throw new Error('wrong owner')
          },
          retireSetupRecovery: async () => {
            throw new Error('owner is live — must not be retired')
          },
        })
      const tunnelMutationCount = () =>
        sshCalls.filter((args) => args.includes('-O') && ['forward', 'cancel'].includes(args[args.indexOf('-O') + 1]))
          .length
      const effectsBeforeNonDue = {
        seedCalls,
        bashCalls,
        tunnelMutations: tunnelMutationCount(),
        cancelCalls: recoveredCancelBodies.length,
      }
      await recover()
      expect({
        seedCalls,
        bashCalls,
        tunnelMutations: tunnelMutationCount(),
        cancelCalls: recoveredCancelBodies.length,
      }).toEqual(effectsBeforeNonDue)

      for (let attempt = 2; attempt <= 3; attempt++) {
        await db
          .update(vmBoxSetupStates)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(vmBoxSetupStates.sandboxId, sandboxId))
        await recover()
      }
      await reconcileVmSetupIncidents()
      const [incident] = await db
        .select()
        .from(fleetIncidents)
        .where(eq(fleetIncidents.scopeKey, `sandbox:${sandboxId}`))
      expect(
        (
          await db
            .select()
            .from(fleetIncidentNotifications)
            .where(eq(fleetIncidentNotifications.incidentId, incident.id))
        )
          .map((row) => `${row.kind}:${row.audience}`)
          .sort()
      ).toEqual(['alert:human', 'alert:manager'])
      await new FleetIncidentNotifier().drain({ now: new Date(), incidentIds: [incident.id] })

      await db
        .update(vmBoxSetupStates)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(vmBoxSetupStates.sandboxId, sandboxId))
      await recover()
      expect(await manager.getSandboxStatus(sandboxId)).toMatchObject({ status: 'running', readiness: 'ready' })
      await Bun.sleep(20)
      await reconcileVmSetupIncidents()
      expect(
        (
          await db
            .select()
            .from(fleetIncidentNotifications)
            .where(eq(fleetIncidentNotifications.incidentId, incident.id))
        )
          .map((row) => `${row.kind}:${row.audience}`)
          .sort()
      ).toEqual(['alert:human', 'alert:manager', 'recovery:human'])
      expect(await manager.getSandboxStatus(sandboxId)).toMatchObject({ status: 'running', readiness: 'ready' })
      expect(seedCalls).toBe(4)
      expect(logLines.find((line) => line.includes(`Box ready: ${sandboxId}`))).toContain('readiness=ready')
    } finally {
      console.log = previousConsoleLog
      await manager.cleanup().catch(() => {})
      const incidents = await db
        .select({ id: fleetIncidents.id })
        .from(fleetIncidents)
        .where(eq(fleetIncidents.scopeKey, `sandbox:${sandboxId}`))
      if (incidents.length) {
        const inboxMessageIds = (
          await db
            .select({ id: fleetIncidentNotifications.inboxMessageId })
            .from(fleetIncidentNotifications)
            .where(
              inArray(
                fleetIncidentNotifications.incidentId,
                incidents.map((row) => row.id)
              )
            )
        ).flatMap((row) => (row.id ? [row.id] : []))
        await db.delete(fleetIncidentNotifications).where(
          inArray(
            fleetIncidentNotifications.incidentId,
            incidents.map((row) => row.id)
          )
        )
        await db.delete(fleetIncidents).where(
          inArray(
            fleetIncidents.id,
            incidents.map((row) => row.id)
          )
        )
        if (inboxMessageIds.length) await db.delete(inbox).where(inArray(inbox.id, inboxMessageIds))
      }
      await db.delete(machines).where(eq(machines.id, machineId))
      rmSync(controlDir, { recursive: true, force: true })
    }
  })
})
