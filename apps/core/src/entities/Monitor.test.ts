import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agents, agentTypes, monitors } from '../db/schema'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { Monitor } from './Monitor'

describe('Monitor entity', () => {
  let agentId: string
  let agentTypeId: string

  beforeEach(async () => {
    agentTypeId = `monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await AgentType.create({
      id: agentTypeId,
      name: 'Monitor Test',
      model: 'anthropic:claude-sonnet-4-5',
      systemPrompt: 'test',
    })
    const agent = await Agent.create({ agentTypeId })
    agentId = agent.id
  })

  afterEach(async () => {
    await db.delete(monitors).where(eq(monitors.agentId, agentId))
    await db.delete(agents).where(eq(agents.id, agentId))
    await db.delete(agentTypes).where(eq(agentTypes.id, agentTypeId))
  })

  it('creates, lists, updates and marks monitors ended', async () => {
    const monitor = await Monitor.create({
      agentId,
      sandboxId: 'sandbox-1',
      label: 'build watch',
      command: 'bun test --watch',
      processId: 'ficus-monitor-abc',
      timeoutMs: 30_000,
      maxBatchLines: 20,
      maxBatchBytes: 4096,
      batchDebounceMs: 750,
    })

    expect(monitor.status).toBe('starting')
    expect(monitor.createdAt).toBeInstanceOf(Date)

    const listed = await Monitor.listForAgent(agentId)
    expect(listed.map((m) => m.id)).toContain(monitor.id)

    await monitor.markRunning()
    expect(monitor.status).toBe('running')
    expect(monitor.startedAt).toBeInstanceOf(Date)

    await monitor.update({ linesEmitted: 2, bytesEmitted: 12 })
    expect(monitor.linesEmitted).toBe(2)
    expect(monitor.bytesEmitted).toBe(12)

    const active = await Monitor.listActive()
    expect(active.map((m) => m.id)).toContain(monitor.id)

    await monitor.markEnded('exited', 2, 'done')
    expect(monitor.status).toBe('exited')
    expect(monitor.exitCode).toBe(2)
    expect(monitor.failureReason).toBe('done')
    expect(monitor.endedAt).toBeInstanceOf(Date)
  })
})
