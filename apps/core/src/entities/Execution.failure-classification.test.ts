import { afterAll as maintenanceAfterAll, beforeAll as maintenanceBeforeAll } from 'bun:test'
import { acquireMaintenanceTestIsolation } from '../test-utils/maintenance-test-isolation'

let releaseMaintenanceIsolation: (() => Promise<void>) | undefined
maintenanceBeforeAll(async () => (releaseMaintenanceIsolation = await acquireMaintenanceTestIsolation()))
maintenanceAfterAll(() => releaseMaintenanceIsolation?.())

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { executions, agents, agentTypes, messages, sandboxProvisionRecoveries } from '../db/schema'
import { AgentType } from './AgentType'
import { Agent } from './Agent'
import { Execution } from './Execution'
import { eventEmitter } from '../lib/infra/event-emitter'
import { releaseSessionReservation, reserveSession } from '../services/execution/session-state'

describe('Execution failure classification persistence', () => {
  let testPrefix: string
  let testAgentTypeId: string
  let testAgent: Agent

  beforeEach(async () => {
    await db.delete(sandboxProvisionRecoveries)
    testPrefix = `failcls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`
    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })
    testAgent = await Agent.create({ agentTypeId: testAgentTypeId })
  })

  afterEach(async () => {
    await db.delete(sandboxProvisionRecoveries)
    await db.delete(executions).where(eq(executions.agentId, testAgent.id))
    await db.delete(agents).where(eq(agents.id, testAgent.id))
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  it('fail() persists the structural classification in the same terminal write', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()

    const ok = await execution.fail('Admission effect was refused by the durable fence', undefined, {
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })
    expect(ok).toBe(true)

    const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(row.status).toBe('failed')
    expect(row.failureClass).toBe('platform_pre_tool_refusal')
    expect(row.failureReason).toBe('admission_fence-closed')
    // One write: endedAt and error landed together with the classification.
    expect(row.endedAt).toBeTruthy()
    expect(row.error).toBe('Admission effect was refused by the durable fence')
  })

  it('fail() without a classification leaves the columns NULL (legacy-compatible)', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()

    await execution.fail('some provider blew up')

    const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(row.status).toBe('failed')
    expect(row.failureClass).toBeNull()
    expect(row.failureReason).toBeNull()
  })

  it('the execution.failed event payload carries the classification additively', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()
    const events: Array<Record<string, unknown>> = []
    const unsub = eventEmitter.on('execution.failed', (data) => events.push(data as Record<string, unknown>))

    await execution.fail('Admission effect was refused by the durable fence', undefined, {
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })
    unsub()

    expect(events.length).toBe(1)
    expect(events[0]).toMatchObject({
      executionId: execution.id,
      agentId: testAgent.id,
      status: 'failed',
      failureClass: 'platform_pre_tool_refusal',
      failureReason: 'admission_fence-closed',
    })
  })

  it('an unclassified failure emits the legacy payload shape (no class fields)', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()
    const events: Array<Record<string, unknown>> = []
    const unsub = eventEmitter.on('execution.failed', (data) => events.push(data as Record<string, unknown>))

    await execution.fail('legacy prose failure')
    unsub()

    expect(events.length).toBe(1)
    expect(events[0]).toEqual({
      executionId: execution.id,
      agentId: testAgent.id,
      status: 'failed',
    })
  })

  it('toJson() round-trips the nullable classification fields', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()
    await execution.fail('boom', undefined, { failureClass: 'provider_model', failureReason: 'model_call' })

    const fresh = await Execution.mustFind(execution.id)
    expect(fresh.toJson()).toMatchObject({
      failureClass: 'provider_model',
      failureReason: 'model_call',
    })

    const unclassified = await testAgent.queueExecution({})
    await unclassified.start()
    await unclassified.fail('legacy')
    expect((await Execution.mustFind(unclassified.id)).toJson()).toMatchObject({
      failureClass: null,
      failureReason: null,
    })
  })

  it('sandbox-recovery-exhausted persists the platform classification', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()
    await execution.transitionTo({
      kind: 'waiting-sandbox',
      recovery: {
        scope: 'scope',
        sandboxKey: 'box',
        circuitVersion: 3,
        refusalId: crypto.randomUUID(),
        errorCode: 'SANDBOX_PROVISION_UNAVAILABLE' as const,
        reasonCode: 'unschedulable_capacity' as const,
        nextAttemptAt: new Date(Date.now() + 5_000),
        deadlineAt: new Date(Date.now() + 60_000),
      },
    })
    await db
      .update(sandboxProvisionRecoveries)
      .set({ status: 'leased', leaseOwner: 'worker', claimKind: 'ordinary' })
      .where(eq(sandboxProvisionRecoveries.executionId, execution.id))

    const ok = await execution.transitionTo({
      kind: 'sandbox-recovery-exhausted',
      generation: 1,
      leaseOwner: 'worker',
      error: 'deadline',
    })
    expect(ok).toBe(true)

    const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
    expect(row.status).toBe('failed')
    expect(row.failureClass).toBe('platform_pre_tool_refusal')
    expect(row.failureReason).toBe('sandbox_provision_exhausted')
  })

  it('publishes correlated resume context before even an admission refusal, without an unexplained failure notice', async () => {
    const execution = await testAgent.queueExecution({})
    await execution.start()
    const restart = { restartId: 'restart-admission', restartedAt: '2026-10-28T21:32:00.000Z' }
    await db.insert(messages).values({
      agentId: testAgent.id,
      role: 'assistant',
      content: 'pause fixture',
      metadata: {
        isSystem: true,
        executionId: execution.id,
        admissionRecoveryExecutionId: execution.id,
        restartPhase: 'pause',
        restart,
      },
    })
    const noticeIds: string[] = []
    const off = eventEmitter.on('message.created', (event) => {
      if (event.agentId === testAgent.id) noticeIds.push(event.messageId)
    })
    expect(reserveSession(testAgent.id, '00000000-0000-4000-8000-0000000000ff')).toBe(true)
    try {
      await execution.run()
      const rows = await db.select().from(messages).where(eq(messages.agentId, testAgent.id))
      const notices = noticeIds.map((id) => rows.find((row) => row.id === id)?.content)
      expect(notices[0]).toBe(
        '[System] Resumed after a restart. Commands that were running were cancelled; the agent was told to check them and re-run what was interrupted.'
      )
      expect(notices).toHaveLength(2)
      expect(notices[1]).toContain(
        'Resumed after a restart, but the run could not finish: Execution session capacity reservation was refused'
      )
      expect(notices.join('\n')).not.toContain('Execution failed:')
    } finally {
      off()
      releaseSessionReservation(testAgent.id, '00000000-0000-4000-8000-0000000000ff')
    }
  })

  it('a capacity reservation refusal in run() classifies as platform_pre_tool_refusal', async () => {
    // Hold the agent's single session slot so run()'s reserveSession refuses.
    expect(reserveSession(testAgent.id, '00000000-0000-4000-8000-0000000000ff')).toBe(true)
    try {
      const execution = await testAgent.queueExecution({})
      await execution.start()
      await execution.run()

      const [row] = await db.select().from(executions).where(eq(executions.id, execution.id))
      expect(row.status).toBe('failed')
      expect(row.failureClass).toBe('platform_pre_tool_refusal')
      expect(row.failureReason).toBe('capacity_reservation_refused')
      expect(row.error).toBe('Execution session capacity reservation was refused')
    } finally {
      releaseSessionReservation(testAgent.id, '00000000-0000-4000-8000-0000000000ff')
    }
  })
})
