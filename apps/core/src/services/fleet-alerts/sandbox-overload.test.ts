import { afterEach, describe, expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import type { SandboxPressure } from '@ficus/shared'
import { db } from '../../db'
import { agents, executions, machineBoxes, machines, squads } from '../../db/schema'
import { listBusySandboxIds, reconcileSandboxOverload } from './sandbox-overload'
import type { SandboxOverloadObservation } from './store'

const NOW = new Date('2026-09-24T09:00:00Z')
const overloaded: SandboxPressure = { cpus: 4, load: [31.9, 20, 10], memTotalMb: 16_000, memAvailableMb: 463 }
const calm: SandboxPressure = { cpus: 4, load: [0.5, 0.4, 0.3], memTotalMb: 16_000, memAvailableMb: 9_000 }

function harness(input: {
  busy?: string[]
  open?: string[]
  vm?: boolean
  read?: (sandboxId: string) => Promise<SandboxPressure | null | undefined>
  maxProbes?: number
}) {
  const probed: string[] = []
  const observed: SandboxOverloadObservation[] = []
  const run = () =>
    reconcileSandboxOverload(
      { now: NOW },
      {
        isVmRuntime: () => input.vm ?? true,
        listBusySandboxIds: async () => input.busy ?? [],
        listOpenIncidentSandboxIds: async () => input.open ?? [],
        readPressure: async (sandboxId) => {
          probed.push(sandboxId)
          return (input.read ?? (async () => overloaded))(sandboxId)
        },
        observe: async (observation) => {
          observed.push(observation)
          return undefined
        },
        probeTimeoutMs: 20,
        ...(input.maxProbes ? { maxProbes: input.maxProbes } : {}),
      }
    )
  return { run, probed, observed }
}

describe('sandbox overload detector', () => {
  test('does nothing outside the VM runtime', async () => {
    let listed = false
    await reconcileSandboxOverload(
      { now: NOW },
      {
        isVmRuntime: () => false,
        listBusySandboxIds: async () => {
          listed = true
          return ['squad_a']
        },
        listOpenIncidentSandboxIds: async () => {
          listed = true
          return ['squad_a']
        },
        readPressure: async () => {
          throw new Error('must not probe')
        },
        observe: async () => {
          throw new Error('must not observe')
        },
      }
    )
    expect(listed).toBe(false)
  })

  test('probes only busy boxes and reports what they read', async () => {
    const { run, probed, observed } = harness({
      busy: ['squad_hot', 'agent_calm'],
      read: async (id) => (id === 'squad_hot' ? overloaded : calm),
    })
    await run()
    expect(probed.sort()).toEqual(['agent_calm', 'squad_hot'])
    expect(observed).toContainEqual({ status: 'sampled', sandboxId: 'squad_hot', pressure: overloaded, now: NOW })
    expect(observed).toContainEqual({ status: 'sampled', sandboxId: 'agent_calm', pressure: calm, now: NOW })
  })

  test('never probes an open episode whose box is idle, and lets the store close it when stale', async () => {
    const { run, probed, observed } = harness({ busy: [], open: ['squad_idle'] })
    await run()
    expect(probed).toEqual([])
    expect(observed).toEqual([{ status: 'unobserved', sandboxId: 'squad_idle', now: NOW }])
  })

  test('ignores boxes that fail, answer without pressure, or time out', async () => {
    const { run, observed } = harness({
      busy: ['squad_throws', 'squad_null', 'squad_old_server', 'squad_slow', 'squad_hot'],
      open: ['squad_throws', 'squad_slow'],
      read: async (id) => {
        if (id === 'squad_throws') throw new Error('connection refused')
        if (id === 'squad_null') return null
        if (id === 'squad_old_server') return undefined
        if (id === 'squad_slow') return new Promise<SandboxPressure>(() => {})
        return overloaded
      },
    })
    await run()
    expect(observed.filter((o) => o.status === 'sampled').map((o) => o.sandboxId)).toEqual(['squad_hot'])
    expect(
      observed
        .filter((o) => o.status === 'unobserved')
        .map((o) => o.sandboxId)
        .sort()
    ).toEqual(['squad_slow', 'squad_throws'])
  })

  test('a failing store write for one box does not stop the others', async () => {
    const observed: string[] = []
    await reconcileSandboxOverload(
      { now: NOW },
      {
        isVmRuntime: () => true,
        listBusySandboxIds: async () => ['squad_a', 'squad_b'],
        listOpenIncidentSandboxIds: async () => [],
        readPressure: async () => overloaded,
        observe: async (observation) => {
          if (observation.sandboxId === 'squad_a') throw new Error('db down')
          observed.push(observation.sandboxId)
          return undefined
        },
      }
    )
    expect(observed).toEqual(['squad_b'])
  })

  test('caps probes per tick, open episodes first, and never runs more than eight at once', async () => {
    const busy = Array.from({ length: 30 }, (_, index) => `agent_${String(index).padStart(2, '0')}`)
    let inFlight = 0
    let peak = 0
    const { run, probed } = harness({
      busy,
      open: ['agent_29'],
      maxProbes: 12,
      read: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await Bun.sleep(1)
        inFlight--
        return calm
      },
    })
    await run()
    expect(probed).toHaveLength(12)
    expect(probed[0]).toBe('agent_29')
    expect(new Set(probed).size).toBe(12)
    expect(peak).toBeLessThanOrEqual(8)
  })
})

describe('busy sandbox listing', () => {
  const owned = { squads: [] as string[], agents: [] as string[], machines: [] as string[], boxes: [] as string[] }

  afterEach(async () => {
    if (owned.boxes.length) await db.delete(machineBoxes).where(inArray(machineBoxes.sandboxId, owned.boxes))
    if (owned.machines.length) await db.delete(machines).where(inArray(machines.id, owned.machines))
    if (owned.agents.length) {
      await db.delete(executions).where(inArray(executions.agentId, owned.agents))
      await db.delete(agents).where(inArray(agents.id, owned.agents))
    }
    if (owned.squads.length) await db.delete(squads).where(inArray(squads.id, owned.squads))
    owned.squads = []
    owned.agents = []
    owned.machines = []
    owned.boxes = []
  })

  test('lists ready boxes an agent is running in, and not idle or parked ones', async () => {
    const machineId = crypto.randomUUID()
    owned.machines.push(machineId)
    await db.insert(machines).values({
      id: machineId,
      name: `overload-${machineId}`,
      provider: 'ssh',
      sshHost: '127.0.0.1',
      sshUser: 'tau',
      sshKeyId: 'test',
      sshPublicKey: 'test',
    })
    const squad = async () => {
      const id = crypto.randomUUID()
      owned.squads.push(id)
      await db.insert(squads).values({ id, name: `overload-${id}`, purpose: 'Busy boxes', status: 'active' })
      return id
    }
    const agent = async (squadId: string | null, status?: 'running' | 'completed') => {
      const [row] = await db.insert(agents).values({ agentTypeId: 'worker', squadId }).returning()
      owned.agents.push(row!.id)
      if (status) await db.insert(executions).values({ agentId: row!.id, status })
      return row!.id
    }
    let port = 46_000
    const box = async (sandboxId: string, status = 'ready') => {
      owned.boxes.push(sandboxId)
      await db.insert(machineBoxes).values({ sandboxId, machineId, unixUser: 'tau', port: port++, status })
    }

    const busySquad = await squad()
    const busyMember = await agent(busySquad, 'running')
    const idleSquad = await squad()
    const idleMember = await agent(idleSquad, 'completed')
    const parkedSquad = await squad()
    await agent(parkedSquad, 'running')
    const loner = await agent(null, 'running')
    const noBox = await agent(null, 'running')

    await box(`squad_${busySquad}`)
    await box(`agent_${busyMember}`)
    await box(`squad_${idleSquad}`)
    await box(`agent_${idleMember}`)
    await box(`squad_${parkedSquad}`, 'stopped')
    await box(`agent_${loner}`)

    const busy = await listBusySandboxIds()
    const mine = busy.filter((id) => owned.boxes.includes(id))
    expect(mine.sort()).toEqual([`agent_${busyMember}`, `agent_${loner}`, `squad_${busySquad}`].sort())
    expect(busy).not.toContain(`agent_${noBox}`)
  })
})
