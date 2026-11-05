import { expect, test } from 'bun:test'
import { inArray } from 'drizzle-orm'
import { Agent } from '../../entities/Agent'
import { Squad } from '../../entities/Squad'
import { db, agents, executions, monitors, squads } from '../../db'
import { sandboxActivity, sandboxHasActiveExecution } from './sandbox-activity'

type MonitorStatus = (typeof monitors.$inferInsert)['status']

async function insertMonitor(agentId: string, sandboxId: string, status: MonitorStatus): Promise<string> {
  const [row] = await db
    .insert(monitors)
    .values({
      agentId,
      sandboxId,
      label: 'synthetic',
      command: 'sleep 3600',
      processId: `proc-${crypto.randomUUID()}`,
      timeoutMs: 3_600_000,
      maxBatchLines: 100,
      maxBatchBytes: 10_000,
      batchDebounceMs: 1000,
      status,
    })
    .returning({ id: monitors.id })
  return row.id
}

test('a live monitor keeps an otherwise idle box active; an ended one does not', async () => {
  // The case that restarted a squad box under a running monitor: the agent had
  // ended its turn to wait on the monitor, so no execution was active.
  const squad = await Squad.create({ purpose: 'test', name: `Monitor activity ${crypto.randomUUID()}` })
  const other = await Squad.create({ purpose: 'test', name: `Other monitor activity ${crypto.randomUUID()}` })
  const ids: string[] = []
  const monitorIds: string[] = []
  try {
    const worker = await Agent.create({ squadId: squad.id, agentTypeId: 'subagent' })
    ids.push(worker.id)
    const squadBox = `squad_${squad.id}`
    const agentBox = `agent_${worker.id}`

    expect(await sandboxActivity(squadBox)).toEqual({ active: false, activeExecutionCount: 0 })

    for (const status of ['exited', 'canceled', 'timed-out', 'failed', 'overload'] as const)
      monitorIds.push(await insertMonitor(worker.id, squadBox, status))
    expect(await sandboxHasActiveExecution(squadBox)).toBe(false)

    for (const status of ['starting', 'running', 'canceling'] as const) {
      const id = await insertMonitor(worker.id, squadBox, status)
      monitorIds.push(id)
      expect(await sandboxActivity(squadBox)).toEqual({
        active: true,
        activeExecutionCount: 0,
        liveMonitorCount: 1,
      })
      expect(await sandboxHasActiveExecution(squadBox)).toBe(true)
      await db.delete(monitors).where(inArray(monitors.id, [id]))
    }

    // Matched by the monitor's own sandbox, not by its agent or squad.
    monitorIds.push(await insertMonitor(worker.id, agentBox, 'running'))
    expect(await sandboxActivity(agentBox)).toMatchObject({ active: true, liveMonitorCount: 1 })
    expect(await sandboxActivity(squadBox)).toEqual({ active: false, activeExecutionCount: 0 })
    expect(await sandboxActivity(`squad_${other.id}`)).toEqual({ active: false, activeExecutionCount: 0 })

    // An active execution answers as before, without consulting monitors.
    await db.insert(executions).values({ agentId: worker.id, status: 'running' })
    expect(await sandboxActivity(agentBox)).toEqual({ active: true, activeExecutionCount: 1 })
  } finally {
    if (monitorIds.length) await db.delete(monitors).where(inArray(monitors.id, monitorIds))
    if (ids.length) {
      await db.delete(executions).where(inArray(executions.agentId, ids))
      await db.delete(agents).where(inArray(agents.id, ids))
    }
    await db.delete(squads).where(inArray(squads.id, [squad.id, other.id]))
  }
})
