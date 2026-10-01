import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { eq, like } from 'drizzle-orm'
import net from 'node:net'
import http from 'node:http'
import type { LocalDeployment } from '@ficus/shared'
import { db, squads, localDeployments } from '../../db'
import { Squad } from '../../entities/Squad'
import { createLocalDeployment, getLocalDeployment, updateLocalDeploymentRecord } from './local-deployment-service'
import {
  configureLocalDeploymentHealthDependencies,
  refreshLocalDeploymentHealth,
  restartManagedLocalDeployment,
} from './local-deployment-health'
import { drainLocalDeploymentHealthObservations } from './local-deployment-observation'
import { listPeriodicRunners } from '../../lib/infra/PeriodicRunner'
import {
  drainLocalDeploymentRecoveries,
  reconcileLocalDeploymentHealth,
  startLocalDeploymentHealthPoller,
  stopLocalDeploymentHealthPoller,
} from './local-deployment-health-poller'

describe('local deployment health poller', () => {
  let testPrefix: string

  beforeEach(() => {
    testPrefix = `local-deployment-poller-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  afterEach(async () => {
    await stopLocalDeploymentHealthPoller()
    configureLocalDeploymentHealthDependencies()
    await db.delete(squads).where(like(squads.name, `${testPrefix}%`))
  })

  async function createTestSquad(name: string): Promise<Squad> {
    const [row] = await db
      .insert(squads)
      .values({ name: `${testPrefix}-${name}`, purpose: 'LocalDeployment health poller test squad' })
      .returning()
    return new Squad(row)
  }

  it('reconciles on a 30s timer', async () => {
    startLocalDeploymentHealthPoller()
    const runner = listPeriodicRunners().find((r) => r.runnerName === 'local-deployment-health-reconcile')
    expect(runner?.runnerIntervalMs).toBe(30_000)
  })

  it('passes the listed row straight to the health refresh instead of re-reading it', async () => {
    const squad = await createTestSquad('reuse')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, mode: 'attached' })
    const live = await updateLocalDeploymentRecord(localDeployment.id, { status: 'running' })

    const refreshArgs: Array<string | LocalDeployment> = []
    await reconcileLocalDeploymentHealth({
      listLiveLocalDeployments: async () => [live],
      refreshLocalDeploymentHealth: async (target) => {
        refreshArgs.push(target)
        return live
      },
      restartManagedLocalDeployment: async () => live,
    })

    expect(refreshArgs).toEqual([live])
  })

  it('restarts a crashed managed always deployment', async () => {
    const squad = await createTestSquad('restart')
    const localDeployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    const crashed = { ...(await updateLocalDeploymentRecord(localDeployment.id, { status: 'crashed' })) }

    const restarts: string[] = []
    await reconcileLocalDeploymentHealth({
      listLiveLocalDeployments: async () => [crashed],
      refreshLocalDeploymentHealth: async () => crashed,
      restartManagedLocalDeployment: async (id) => {
        restarts.push(id)
        return crashed
      },
    })

    await drainLocalDeploymentRecoveries()
    expect(restarts).toEqual([crashed.id])
  })
  it('automatically recovers after box loss and reconnect without an operator restart', async () => {
    const squad = await createTestSquad('reconnect')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'session', restartCount: 53 })
    let boxAvailable = false
    let sessionAlive = false
    let starts = 0
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => {
        if (!boxAvailable) throw new Error('fixture box offline')
        return '/workspace'
      },
      isBoxMigrating: async () => false,
      probeLocalDeploymentHttp: async () => sessionAlive,
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 5173 }),
      supervisor: {
        hasSession: async () => {
          if (!boxAvailable) throw new Error('fixture box offline')
          return sessionAlive
        },
        startManagedLocalDeployment: async () => {
          starts++
          sessionAlive = true
          return { processId: 'session' }
        },
        stopLocalDeployment: async () => {
          sessionAlive = false
        },
      },
    })
    const reconcile = () =>
      reconcileLocalDeploymentHealth({
        listLiveLocalDeployments: async () => [(await getLocalDeployment(deployment.id))!],
        refreshLocalDeploymentHealth,
        restartManagedLocalDeployment,
      })
    await reconcile()
    expect((await getLocalDeployment(deployment.id))?.status).toBe('unhealthy')
    expect(starts).toBe(0)
    await drainLocalDeploymentRecoveries()
    boxAvailable = true
    await stopLocalDeploymentHealthPoller()
    await Promise.all([reconcile(), reconcile()])
    await drainLocalDeploymentRecoveries()
    expect(starts).toBe(1)
    expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('running')
    expect((await getLocalDeployment(deployment.id))?.restartCount).toBe(54)
    // Core may forget its box tracking, but the external session is alive.
    await reconcile()
    await drainLocalDeploymentRecoveries()
    expect(starts).toBe(1)
  })

  it('recovers a lost app listener despite an accepting forward without an operator restart', async () => {
    const squad = await createTestSquad('lost-listener')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'fixture web app' })
    await updateLocalDeploymentRecord(deployment.id, { status: 'running', processId: 'fixture-session' })
    const sockets = new Set<net.Socket>()
    const forward = net.createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.end()
    })
    const apps: http.Server[] = []
    let app: http.Server
    let sessionAlive = true
    let starts = 0
    const startApp = async () => {
      app = http.createServer((_req, response) => {
        response.end('recovered')
      })
      apps.push(app)
      await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve))
      sessionAlive = true
    }
    try {
      await new Promise<void>((resolve) => forward.listen(0, '127.0.0.1', resolve))
      await startApp()
      configureLocalDeploymentHealthDependencies({
        ensureSquadSandbox: async () => '/workspace',
        isBoxMigrating: async () => false,
        resolveLocalDeploymentTarget: async () => ({
          host: '127.0.0.1',
          port: ((sessionAlive ? app : forward).address() as net.AddressInfo).port,
        }),
        supervisor: {
          hasSession: async () => sessionAlive,
          startManagedLocalDeployment: async () => {
            starts++
            await startApp()
            return { processId: 'fixture-session' }
          },
          stopLocalDeployment: async () => {
            sessionAlive = false
          },
        },
      })
      expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('running')
      // Lose the app's real listener; leave a synthetic SSH forward accepting.
      app!.closeAllConnections()
      await new Promise<void>((resolve) => app!.close(() => resolve()))
      sessionAlive = false
      await reconcileLocalDeploymentHealth({
        listLiveLocalDeployments: async () => [(await getLocalDeployment(deployment.id))!],
        refreshLocalDeploymentHealth,
        restartManagedLocalDeployment,
      })
      await drainLocalDeploymentRecoveries()
      expect(starts).toBe(1)
      expect((await refreshLocalDeploymentHealth(deployment.id)).status).toBe('running')
    } finally {
      for (const socket of sockets) socket.destroy()
      for (const server of apps) {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      if (forward.listening) await new Promise<void>((resolve) => forward.close(() => resolve()))
    }
  })

  it('continues ticks and a second app while session observation and owned ensure stall', async () => {
    const squad = await createTestSquad('stalled-observation-and-ensure')
    const first = await createLocalDeployment(squad, { name: 'first', port: 5173, command: 'fixture' })
    const second = await createLocalDeployment(squad, { name: 'second', port: 5174, mode: 'attached' })
    await updateLocalDeploymentRecord(first.id, { status: 'running', processId: 'fixture-session' })
    await updateLocalDeploymentRecord(second.id, { status: 'running' })
    const sessionEntered = Promise.withResolvers<void>()
    const ensureEntered = Promise.withResolvers<void>()
    const session = Promise.withResolvers<boolean>()
    const ensure = Promise.withResolvers<string>()
    const timeouts: Array<() => void> = []
    let sessionCalls = 0
    let ensureCalls = 0
    let starts = 0
    configureLocalDeploymentHealthDependencies({
      scheduleObservationTimeout: (callback) => {
        timeouts.push(callback)
        return () => {}
      },
      ensureSquadSandbox: async () => {
        ensureCalls++
        ensureEntered.resolve()
        return ensure.promise
      },
      supervisor: {
        hasSession: async () => {
          sessionCalls++
          sessionEntered.resolve()
          return session.promise
        },
        startManagedLocalDeployment: async () => {
          starts++
          return { processId: 'fixture-session' }
        },
        stopLocalDeployment: async () => {},
      },
      isBoxMigrating: async () => false,
      probeLocalDeploymentHttp: async () => true,
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 5173 }),
    })
    const tick = () =>
      reconcileLocalDeploymentHealth({
        listLiveLocalDeployments: async () => [
          (await getLocalDeployment(first.id))!,
          (await getLocalDeployment(second.id))!,
        ],
        refreshLocalDeploymentHealth,
        restartManagedLocalDeployment,
      })
    const firstTick = tick()
    try {
      await sessionEntered.promise
      timeouts[0]()
      await firstTick
      await ensureEntered.promise
      expect((await getLocalDeployment(first.id))?.status).toBe('unhealthy')
      expect((await getLocalDeployment(second.id))?.status).toBe('running')
      await tick()
      expect(sessionCalls).toBe(1)
      expect(ensureCalls).toBe(1)
      expect(starts).toBe(0)
      session.resolve(true)
      await drainLocalDeploymentHealthObservations()
      expect((await getLocalDeployment(first.id))?.status).toBe('unhealthy')
      ensure.resolve('/workspace')
      await drainLocalDeploymentRecoveries()
      expect((await getLocalDeployment(first.id))?.status).toBe('running')
      expect(starts).toBe(0) // connectivity returned; no healthy app was killed
    } finally {
      session.resolve(true)
      ensure.resolve('/workspace')
      await firstTick
      await drainLocalDeploymentRecoveries()
      await drainLocalDeploymentHealthObservations()
    }
  })

  it('recovers an incomplete initial row after Core loss without reviving a never-restart row', async () => {
    const squad = await createTestSquad('core-lost-initial-row')
    const managed = await createLocalDeployment(squad, { name: 'managed', port: 5173, command: 'fixture' })
    const never = await createLocalDeployment(squad, {
      name: 'never',
      port: 5174,
      command: 'fixture',
      restartPolicy: 'never',
    })
    for (const deployment of [managed, never])
      await db
        .update(localDeployments)
        .set({ createdAt: new Date(Date.now() - 11_000) })
        .where(eq(localDeployments.id, deployment.id))
    const sessions = new Set<string>()
    const starts: string[] = []
    configureLocalDeploymentHealthDependencies({
      ensureSquadSandbox: async () => '/workspace',
      isBoxMigrating: async () => false,
      supervisor: {
        hasSession: async (_id, processId) => sessions.has(processId),
        startManagedLocalDeployment: async (args) => {
          starts.push(args.localDeploymentId)
          const processId = `tau-local-deployment-${args.localDeploymentId.slice(0, 8)}`
          sessions.add(processId)
          return { processId }
        },
        stopLocalDeployment: async () => {},
      },
      probeLocalDeploymentHttp: async () => true,
      resolveLocalDeploymentTarget: async () => ({ host: 'localhost', port: 5173 }),
    })
    await reconcileLocalDeploymentHealth({
      listLiveLocalDeployments: async () => [
        (await getLocalDeployment(managed.id))!,
        (await getLocalDeployment(never.id))!,
      ],
      refreshLocalDeploymentHealth,
      restartManagedLocalDeployment,
    })
    await drainLocalDeploymentRecoveries()
    expect(starts).toEqual([managed.id])
    expect((await refreshLocalDeploymentHealth(managed.id)).status).toBe('running')
    expect((await getLocalDeployment(never.id))?.status).toBe('crashed')
  })

  it('keeps failed recovery attempts behind the restart cooldown', async () => {
    const squad = await createTestSquad('cooldown')
    const deployment = await createLocalDeployment(squad, { name: 'web', port: 5173, command: 'bun run dev' })
    const crashed = await updateLocalDeploymentRecord(deployment.id, { status: 'crashed' })
    let attempts = 0
    const deps = {
      listLiveLocalDeployments: async () => [crashed],
      refreshLocalDeploymentHealth: async () => crashed,
      restartManagedLocalDeployment: async () => {
        attempts++
        throw new Error('fixture failed launch')
      },
    }
    await Promise.all([reconcileLocalDeploymentHealth(deps), reconcileLocalDeploymentHealth(deps)])
    await reconcileLocalDeploymentHealth(deps)
    await drainLocalDeploymentRecoveries()
    expect(attempts).toBe(1)
  })

  it('does not recover stopped or never-restart apps', async () => {
    const squad = await createTestSquad('no-auto-restart')
    const deployment = await createLocalDeployment(squad, {
      name: 'web',
      port: 5173,
      command: 'bun run dev',
      restartPolicy: 'never',
    })
    const crashed = await updateLocalDeploymentRecord(deployment.id, { status: 'crashed' })
    let starts = 0
    await reconcileLocalDeploymentHealth({
      listLiveLocalDeployments: async () => [crashed, { ...crashed, restartPolicy: 'always', status: 'stopped' }],
      refreshLocalDeploymentHealth: async (target) => target as LocalDeployment,
      restartManagedLocalDeployment: async () => {
        starts++
        return crashed
      },
    })
    expect(starts).toBe(0)
  })
})
