import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { like } from 'drizzle-orm'
import type { LocalDeployment } from '@ficus/shared'
import { db, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { createLocalDeployment, updateLocalDeploymentRecord } from './local-deployment-service'
import { listPeriodicRunners } from '../../lib/infra/PeriodicRunner'
import {
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

    expect(restarts).toEqual([crashed.id])
  })
})
