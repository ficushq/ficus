import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { refreshAgentActivity, refreshAgentActivityMany } from '../services/agents/activity-summary'
import { db } from '../db'
import {
  agents,
  agentTokens,
  chatSendReceipts,
  agentTypes,
  executionAdmissionReservations,
  executions,
  inbox,
  messages,
  modelTiers,
  squads,
} from '../db/schema'
import { Squad } from './Squad'
import { AgentType } from '../entities/AgentType'
import { Agent, setAgentUpdatePrewriteHookForTest, setSendMessageLockedHookForTests } from './Agent'
import { convergeDormancyResourceGeneration, findAgentLifecycleState, listAgentActivityRows } from './agent-queries'
import { Execution } from './Execution'
import { Image } from './Image'
import { InboxMessage } from './InboxMessage'
import { Monitor } from './Monitor'
import { setCascadeDormantChildBeforeRequestHookForTest } from './Subagent'
import { eventEmitter } from '../lib/infra/event-emitter'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from './agent-runners/constants'
import { monitorSupervisor } from '../services/monitors'
import * as cleanupModule from '../services/agents/cleanup'
import {
  completeDormancy,
  completeDormancyIfPending,
  completeWake,
  deleteAgent,
  makeDormant,
  requestAgentLifecycle,
  reconcileLegacyTerminatedAgent,
  runDormancyCompletionSweep,
  runLegacyTerminatedAgentSweepForTest,
  setCompleteWakeBeforeClearHookForTest,
  setDormancyEffectHookForTest,
  setMakeDormantBeforeExecutionLockHookForTest,
  terminate,
  wakeInTransaction,
} from '../services/agent/lifecycle'
import { confirmPendingMessage } from '../services/agent/pending-delivery'
import { acquireAgentQueueLock, AGENT_QUEUE_LOCK_NAMESPACE } from '../services/execution/agent-admission'
import { resolveTokenContext } from '../services/auth/resolve-token'

async function ensureRecoveryMessageIndexForTest(): Promise<() => Promise<void>> {
  const existingIndex = (await db.execute(sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'idx_messages_agent_sandbox_recovery_unique'
  `)) as unknown as unknown[]
  if (existingIndex.length) return async () => {}

  await db.execute(sql`
    CREATE UNIQUE INDEX idx_messages_agent_sandbox_recovery_unique
    ON messages (agent_id, (metadata->>'sandboxId'), (metadata->>'recoveryEpisodeId'), (metadata->>'recoveryNotificationKind'))
    WHERE role = 'human' AND metadata->>'source' = 'sandbox-recovery'
  `)
  return async () => {
    await db.execute(sql`DROP INDEX idx_messages_agent_sandbox_recovery_unique`)
  }
}

async function seedAgentLifecycleForTest(agent: Agent, updates: Partial<typeof agents.$inferInsert>): Promise<void> {
  const set = updates.metadata ? { ...updates, metadata: { ...(agent.metadata ?? {}), ...updates.metadata } } : updates
  await db.update(agents).set(set).where(eq(agents.id, agent.id))
  await agent.reload()
}

describe('agents service', () => {
  let testPrefix: string
  let testAgentTypeId: string

  beforeEach(async () => {
    testPrefix = `agent-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    testAgentTypeId = `${testPrefix}-type`

    await AgentType.create({
      id: testAgentTypeId,
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Test Agent Type',
      systemPrompt: 'You are a test agent.',
    })

    // Ensure manager agent type exists for lifecycle guard tests
    await AgentType.upsert({
      id: 'manager',
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Manager',
      systemPrompt: 'You are a manager agent.',
    })
  })

  afterEach(async () => {
    // Clean up agents created with our test agent type
    const testAgents = await db.select().from(agents).where(eq(agents.agentTypeId, testAgentTypeId))
    for (const agent of testAgents) {
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
    await db.delete(agentTypes).where(eq(agentTypes.id, testAgentTypeId))
  })

  describe('delete', () => {
    it('passes the captured personal sandbox ID to post-delete reclamation', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const calls: Array<[string, string]> = []
      await deleteAgent(agent, { reclaim: async (agentId, sandboxId) => void calls.push([agentId, sandboxId]) })

      expect(await Agent.find(agent.id)).toBeNull()
      expect(calls).toEqual([[agent.id, `agent_${agent.id}`]])
    })

    it('reclaims a terminated top-level agent personal sandbox during deletion', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await seedAgentLifecycleForTest(agent, { status: 'terminated', terminatedAt: new Date() })
      const terminated = await Agent.mustFind(agent.id)
      const calls: Array<[string, string]> = []

      await deleteAgent(terminated, {
        reclaim: async (agentId, sandboxId) => void calls.push([agentId, sandboxId]),
      })

      expect(await Agent.find(agent.id)).toBeNull()
      expect(calls).toEqual([[agent.id, `agent_${agent.id}`]])
    })

    it('keeps the database deletion committed when reclamation rejects', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await deleteAgent(agent, { reclaim: async () => Promise.reject(new Error('cleanup unavailable')) })

      expect(await Agent.find(agent.id)).toBeNull()
    })

    it('does not reclaim a shared sandbox after deletion', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const calls: string[] = []
      const sharedAgent = Object.assign(agent, {
        getPersonalSandboxIdForCleanup: () => null,
      })
      await deleteAgent(sharedAgent, { reclaim: async (_agentId, sandboxId) => void calls.push(sandboxId) })

      expect(await Agent.find(agent.id)).toBeNull()
      expect(calls).toEqual([])
    })
  })

  describe('listPendingHumanMessages', () => {
    it('returns only pending human messages for the agent', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const otherAgent = await Agent.create({ agentTypeId: testAgentTypeId })

      const pending = await agent.recordMessage({ role: 'human', content: 'pending human', pending: true })
      await agent.recordMessage({ role: 'human', content: 'confirmed human', pending: false })
      await agent.recordMessage({ role: 'assistant', content: 'pending assistant', pending: true })
      await otherAgent.recordMessage({ role: 'human', content: 'other pending human', pending: true })

      const result = await agent.listPendingHumanMessages()

      expect(result.map((message) => message.id)).toEqual([pending.id])
    })

    it('lists all pending human messages not yet accepted by the session', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'queued follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      const steer = await agent.recordMessage({
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      const plain = await agent.recordMessage({ role: 'human', content: 'plain pending', pending: true })
      const alreadyInjected = await agent.recordMessage({
        role: 'human',
        content: 'already claimed',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      await db.update(messages).set({ injectedAt: new Date() }).where(eq(messages.id, alreadyInjected.id))

      const result = await agent.listPendingInterventionsForSessionDelivery()

      expect(result.map((message) => message.id)).toEqual([steer.id, plain.id, followUp.id])
    })

    it('claims all immediate messages for the initial prompt before follow-ups', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'queued follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      const steer = await agent.recordMessage({
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      const plain = await agent.recordMessage({ role: 'human', content: 'plain pending', pending: true })

      const claimed = await agent.claimInitialPendingMessagesForSessionDelivery()

      expect(claimed.map((message) => message.id)).toEqual([steer.id, plain.id])
      expect(claimed.every((message) => message.injectedAt instanceof Date)).toBe(true)
      expect((await Agent.findMessage(followUp.id))?.injectedAt).toBeNull()
    })

    it('claims only the first follow-up for the initial prompt when no steers exist', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const first = await agent.recordMessage({
        role: 'human',
        content: 'first follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      const second = await agent.recordMessage({
        role: 'human',
        content: 'second follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })

      const claimed = await agent.claimInitialPendingMessagesForSessionDelivery()

      expect(claimed.map((message) => message.id)).toEqual([first.id])
      expect(claimed[0]?.injectedAt).toBeInstanceOf(Date)
      expect((await Agent.findMessage(second.id))?.injectedAt).toBeNull()
    })

    it('claims a pending message for session delivery only once', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'queued message',
        pending: true,
      })

      const claimed = await agent.claimPendingInterventionForSessionDelivery(pending.id)
      const duplicate = await agent.claimPendingInterventionForSessionDelivery(pending.id)

      expect(claimed?.id).toBe(pending.id)
      expect(claimed?.injectedAt).toBeInstanceOf(Date)
      expect(duplicate).toBeNull()
    })

    it('resets injectedAt after failed pending intervention delivery', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'queued steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      const claimed = await agent.claimPendingInterventionForSessionDelivery(pending.id)
      expect(claimed?.injectedAt).toBeInstanceOf(Date)

      await agent.resetPendingInterventionSessionDelivery(pending.id)

      const retryable = await agent.listPendingInterventionsForSessionDelivery()
      expect(retryable.map((message) => message.id)).toEqual([pending.id])
    })

    it('clears injectedAt when marking stranded pending retries', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'queued follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await agent.claimPendingInterventionForSessionDelivery(pending.id)

      await agent.markPendingHumanMessagesStrandedRetry([pending.id])

      const retryable = await agent.listPendingInterventionsForSessionDelivery()
      expect(retryable.map((message) => message.id)).toEqual([pending.id])
      expect(retryable[0].metadata?.strandedPendingRetryCount).toBe(1)
    })

    it('claim reset and stranded-retry updates repeat persisted response identity', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'identified follow-up',
        metadata: {
          deliveryMode: 'follow-up',
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        },
        pending: true,
      })
      const events: Array<{ messageId: string; executionId?: string; streamGroupId?: string }> = []
      const unsubscribe = eventEmitter.on('message.updated', (event) => {
        if (event.messageId === pending.id) events.push(event)
      })

      try {
        await agent.claimPendingInterventionForSessionDelivery(pending.id)
        await agent.resetPendingInterventionSessionDelivery(pending.id)
        await agent.markPendingHumanMessagesStrandedRetry([pending.id])
      } finally {
        unsubscribe()
      }

      expect(events).toHaveLength(3)
      expect(events).toEqual(
        events.map(() => ({
          messageId: pending.id,
          agentId: agent.id,
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        }))
      )
    })
  })

  describe('Agent.create', () => {
    it('creates agent with idle status and correct agentTypeId', async () => {
      const agent = await Agent.create({
        agentTypeId: testAgentTypeId,
        context: { taskId: 'test-task', stepIndex: 0 },
      })

      expect(agent.id).toBeDefined()
      expect(agent.status).toBe('idle')
      expect(agent.agentTypeId).toBe(testAgentTypeId)
      expect(agent.context).toEqual({ taskId: 'test-task', stepIndex: 0 })
      expect(agent.questionData).toBeNull()
      expect(agent.sessionUsage).toBeNull()
      expect(agent.createdAt).toBeInstanceOf(Date)
      expect(agent.updatedAt).toBeInstanceOf(Date)
    })

    it('emits agent.created event', async () => {
      const events: any[] = []
      const unsub = eventEmitter.on('agent.created', (data) => events.push(data))

      const agent = await Agent.create({
        agentTypeId: testAgentTypeId,
      })

      expect(events.length).toBe(1)
      expect(events[0].agentId).toBe(agent.id)
      expect(events[0].squadId).toBeNull()
      unsub()
    })

    it('always creates manager agents with persist=true', async () => {
      const manager = await Agent.create({ agentTypeId: 'manager', persist: false })

      expect(manager.persist).toBe(true)

      // cleanup
      await db.delete(agents).where(eq(agents.id, manager.id))
    })

    it('uses agent type model when no overrides are set', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      expect(await agent.getEffectiveModelSpec()).toBe('anthropic:claude-sonnet-4-5')
      expect(agent.toJson().modelOverride).toBeNull()
    })

    it('resolves tier-only types and serializes safely before selection', async () => {
      await db
        .insert(modelTiers)
        .values({ slug: 'tier-only-resolution', label: 'Test', chain: 'anthropic:claude-sonnet-4-5' })
        .onConflictDoNothing()
      await db.insert(agentTypes).values({
        id: 'tier-only-agent',
        name: 'Tier Only',
        model: '',
        tier: 'tier-only-resolution',
        systemPrompt: 'test',
      })
      const agent = await Agent.create({ agentTypeId: 'tier-only-agent' })
      expect(await agent.getEffectiveModelSpec()).toBe('anthropic:claude-sonnet-4-5')
      expect(() => agent.toJson()).not.toThrow()
      expect(agent.getSelectedOrConfiguredModelSpec()).toBeUndefined()
      await db.delete(agents).where(eq(agents.id, agent.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, 'tier-only-agent'))
      await db.delete(modelTiers).where(eq(modelTiers.slug, 'tier-only-resolution'))
    })

    it('composes effective model from per-agent overrides', async () => {
      const agent = await Agent.create({
        agentTypeId: testAgentTypeId,
        modelOverride: 'anthropic:claude-sonnet-4-5:high',
      })

      expect(await agent.getEffectiveModelSpec()).toBe('anthropic:claude-sonnet-4-5:high')
    })

    it('uses full model spec override with thinking level', async () => {
      const agent = await Agent.create({
        agentTypeId: testAgentTypeId,
        modelOverride: 'anthropic:claude-sonnet-4-5:low',
      })

      expect(await agent.getEffectiveModelSpec()).toBe('anthropic:claude-sonnet-4-5:low')
    })

    it('rejects invalid model overrides', async () => {
      await expect(
        Agent.create({ agentTypeId: testAgentTypeId, modelOverride: 'unknown-provider:some-model' })
      ).rejects.toThrow('Unknown provider')
    })
  })

  describe('Agent serialization', () => {
    it('omits cached relation fields from JSON', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.getAgentType()

      const serialized = JSON.parse(JSON.stringify(agent))

      expect(serialized.id).toBe(agent.id)
      expect(serialized.agentTypeId).toBe(testAgentTypeId)
      expect(serialized._agentType).toBeUndefined()
      expect(serialized._squad).toBeUndefined()
    })

    it('never exposes a per-execution delta on sessionUsage serialization', async () => {
      // Rows written during the #1362 deployment window may already hold a
      // meaningless `delta` inside agents.sessionUsage. Serialization must
      // strip it while round-tripping the cumulative stats untouched.
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const stats = {
        userMessages: 1,
        assistantMessages: 2,
        totalMessages: 3,
        tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
        cost: 1.25,
      }
      await db
        .update(agents)
        .set({
          sessionUsage: {
            stats,
            context: null,
            delta: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 },
          } as any,
        })
        .where(eq(agents.id, agent.id))
      await agent.reload()

      // The persisted row really does carry the historical delta.
      expect((agent.sessionUsage as any)?.delta).toBeDefined()

      expect((agent.toJSON().sessionUsage as any)?.delta).toBeUndefined()
      expect((agent.toJson().sessionUsage as any)?.delta).toBeUndefined()
      expect(agent.toJSON().sessionUsage!.stats).toEqual(stats)
      expect(agent.toJson().sessionUsage!.stats).toEqual(stats)
      expect(agent.toJSON().sessionUsage!.context).toBeNull()
    })
  })

  describe('Agent.find', () => {
    it('returns agent by ID', async () => {
      const created = await Agent.create({
        agentTypeId: testAgentTypeId,
        context: { scope: { type: 'global' } },
      })

      const fetched = await Agent.find(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
      expect(fetched!.agentTypeId).toBe(testAgentTypeId)
      expect(fetched!.context).toEqual({ scope: { type: 'global' } })
    })

    it('returns null for non-existent ID', async () => {
      const result = await Agent.find('00000000-0000-0000-0000-000000000000')
      expect(result).toBeNull()
    })

    it('resolves agent by UUID prefix', async () => {
      const created = await Agent.create({ agentTypeId: testAgentTypeId })
      const prefix = created.id.slice(0, 8)

      const fetched = await Agent.find(prefix)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
    })

    it('returns null for non-matching prefix', async () => {
      const result = await Agent.find('zzzzzzzz')
      expect(result).toBeNull()
    })

    it('includes lastMessageAt from most recent message', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      // Create messages
      await agent.recordMessage({ role: 'human', content: 'First message' })
      await new Promise((r) => setTimeout(r, 10))
      const lastMsg = await agent.recordMessage({ role: 'assistant', content: 'Second message' })

      const result = await Agent.find(agent.id)

      expect(result).not.toBeNull()
      expect(result!.lastMessageAt).toBeInstanceOf(Date)
      expect(result!.lastMessageAt!.getTime()).toBe(lastMsg.createdAt.getTime())
    })

    it('returns latest human message timestamp separately from latest assistant message timestamp', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const humanMsg = await agent.recordMessage({ role: 'human', content: 'Prompt' })
      await new Promise((r) => setTimeout(r, 10))
      const assistantMsg = await agent.recordMessage({ role: 'assistant', content: 'Streaming response' })

      const result = await Agent.find(agent.id)

      expect(result).not.toBeNull()
      expect(result!.lastMessageAt).toBeInstanceOf(Date)
      expect(result!.lastMessageAt!.getTime()).toBe(assistantMsg.createdAt.getTime())
      expect(result!.lastHumanMessageAt).toBeInstanceOf(Date)
      expect(result!.lastHumanMessageAt!.getTime()).toBe(humanMsg.createdAt.getTime())
    })

    it('returns null lastMessageAt when agent has no messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const result = await Agent.find(agent.id)

      expect(result).not.toBeNull()
      expect(result!.lastMessageAt).toBeNull()
      expect(result!.lastHumanMessageAt).toBeNull()
    })
    it('uses effective visible message projections without cross-agent leakage', async () => {
      const agentA = await Agent.create({ agentTypeId: testAgentTypeId })
      const agentB = await Agent.create({ agentTypeId: testAgentTypeId })
      const consumedAt = '2026-08-10T10:30:00.123456Z'
      const deletedId = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaa50'

      await db.insert(messages).values([
        {
          agentId: agentA.id,
          role: 'human',
          content: 'PENDING_BEFORE',
          pending: true,
          createdAt: new Date('2026-08-10T10:15:00.000Z'),
        },
        {
          agentId: agentA.id,
          role: 'assistant',
          content: 'SYSTEM_AT_20',
          metadata: { isSystem: true, consumedAt: '2026-08-10T12:00:00.000Z' },
          createdAt: new Date('2026-08-10T10:20:00.000Z'),
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaa30',
          agentId: agentA.id,
          role: 'human',
          content: 'CONSUMED_HUMAN',
          pending: false,
          metadata: { source: 'inbox', deliveryMode: 'follow-up', consumedAt },
          createdAt: new Date('2026-08-01T10:00:00.000Z'),
        },
        {
          agentId: agentA.id,
          role: 'human',
          content: 'PENDING_AFTER',
          pending: true,
          createdAt: new Date('2026-08-10T10:45:00.000Z'),
        },
        {
          id: deletedId,
          agentId: agentA.id,
          role: 'assistant',
          content: 'DELETED_FUTURE',
          createdAt: new Date('2026-08-10T10:50:00.000Z'),
        },
        {
          agentId: agentB.id,
          role: 'assistant',
          content: 'OTHER_AGENT_AT_25',
          createdAt: new Date('2026-08-10T10:25:00.000Z'),
        },
      ])
      await db.delete(messages).where(eq(messages.id, deletedId))

      const [human] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.agentId, agentA.id), eq(messages.content, 'CONSUMED_HUMAN')))
      expect(human.createdAt.toISOString()).toBe('2026-08-01T10:00:00.000Z')
      expect((human.metadata as { consumedAt?: string } | null)?.consumedAt).toBe(consumedAt)
      expect(human.createdAt.getTime()).not.toBe(Date.parse(consumedAt))
      expect((await db.select().from(messages).where(eq(messages.id, deletedId))).length).toBe(0)

      // These tests insert straight into `messages`, bypassing every write
      // path, so nothing maintains the denormalized summary. Establish it
      // explicitly — the projection semantics being asserted below now live in
      // refreshAgentActivity's SQL (see services/agents/activity-summary).
      await refreshAgentActivity(agentA.id)
      await refreshAgentActivity(agentB.id)

      const projectedA = await Agent.find(agentA.id)
      const projectedB = await Agent.find(agentB.id)
      expect(projectedA!.lastMessageAt?.toISOString()).toBe('2026-08-10T10:30:00.123Z')
      expect(projectedA!.lastHumanMessageAt?.toISOString()).toBe('2026-08-10T10:30:00.123Z')
      expect(projectedA!.lastMessagePreview).toBe('CONSUMED_HUMAN')
      expect(projectedA!.lastMessagePreview).not.toContain('PENDING')
      expect(projectedA!.lastMessagePreview).not.toContain('DELETED')
      expect(projectedB!.lastMessageAt?.toISOString()).toBe('2026-08-10T10:25:00.000Z')
      expect(projectedB!.lastMessagePreview).toBe('OTHER_AGENT_AT_25')
    })

    it('breaks equal effective preview times by descending message ID', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const at = new Date('2026-08-10T11:00:00.000Z')
      await db.insert(messages).values([
        {
          id: 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaa01',
          agentId: agent.id,
          role: 'assistant',
          content: 'LOW_ID',
          createdAt: at,
        },
        {
          id: 'dddddddd-dddd-4ddd-bddd-dddddddddddd',
          agentId: agent.id,
          role: 'assistant',
          content: 'HIGH_ID',
          createdAt: at,
        },
      ])

      // These tests insert straight into `messages`, bypassing every write
      // path, so nothing maintains the denormalized summary. Establish it
      // explicitly — the projection semantics being asserted below now live in
      // refreshAgentActivity's SQL (see services/agents/activity-summary).
      await refreshAgentActivity(agent.id)

      expect((await Agent.find(agent.id))!.lastMessagePreview).toBe('HIGH_ID')
    })
  })

  describe('Agent.update', () => {
    it('updates status', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      await agent.update({ status: 'active' })
      expect(agent.status).toBe('active')

      const fetched = await Agent.mustFind(agent.id)
      expect(fetched.status).toBe('active')
    })

    it('updates context', async () => {
      const agent = await Agent.create({
        agentTypeId: testAgentTypeId,
        context: { taskId: 'old-task', stepIndex: 0 },
      })

      await agent.update({
        context: { taskId: 'new-task', stepIndex: 1 },
      })
      expect(agent.context).toEqual({ taskId: 'new-task', stepIndex: 1 })
    })

    it('emits agent.updated event', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const events: any[] = []
      const unsub = eventEmitter.on('agent.updated', (data) => events.push(data))

      await agent.update({ status: 'active' })

      expect(events.length).toBe(1)
      expect(events[0].agentId).toBe(agent.id)
      unsub()
    })

    it('sets, trims, and clears purpose without modifying name', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, name: 'Stable Name' })

      await agent.update({ purpose: '  Reviewer handoff prep  ' })
      expect(agent.metadata?.purpose).toBe('Reviewer handoff prep')
      expect(agent.metadata?.name).toBe('Stable Name')

      await agent.update({ purpose: '   ' })
      expect(agent.metadata?.purpose).toBeUndefined()
      expect(agent.metadata?.name).toBe('Stable Name')

      await agent.update({ purpose: 'Implementation reviewer' })
      await agent.update({ purpose: null })
      expect(agent.metadata?.purpose).toBeUndefined()
      expect(agent.metadata?.name).toBe('Stable Name')
    })
  })

  describe('listAgents', () => {
    it('filters by agent type', async () => {
      // Create a second agent type
      const otherTypeId = `${testPrefix}-other`
      await AgentType.create({
        id: otherTypeId,
        model: 'anthropic:claude-sonnet-4-5',
        name: 'Other Agent Type',
        systemPrompt: 'Other agent.',
      })

      await Agent.create({ agentTypeId: testAgentTypeId })
      await Agent.create({ agentTypeId: testAgentTypeId })
      await Agent.create({ agentTypeId: otherTypeId })

      const filtered = await Agent.list({ agentTypeId: testAgentTypeId })
      expect(filtered.length).toBe(2)
      expect(filtered.every((a) => a.agentTypeId === testAgentTypeId)).toBe(true)

      // Clean up the other agent type's agents and the type itself
      const otherAgents = await db.select().from(agents).where(eq(agents.agentTypeId, otherTypeId))
      for (const a of otherAgents) {
        await db.delete(agents).where(eq(agents.id, a.id))
      }
      await db.delete(agentTypes).where(eq(agentTypes.id, otherTypeId))
    })

    it('includes lastMessageAt from most recent message', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      // Create messages with a small delay to ensure different timestamps
      await agent.recordMessage({ role: 'human', content: 'First message' })
      await new Promise((r) => setTimeout(r, 10))
      await agent.recordMessage({ role: 'assistant', content: 'Second message' })
      await new Promise((r) => setTimeout(r, 10))
      const lastMsg = await agent.recordMessage({ role: 'human', content: 'Third message' })

      const results = await Agent.list({ agentTypeId: testAgentTypeId })
      const result = results.find((a) => a.id === agent.id)

      expect(result).toBeDefined()
      expect(result!.lastMessageAt).toBeInstanceOf(Date)
      expect(result!.lastMessageAt!.getTime()).toBe(lastMsg.createdAt.getTime())
    })

    it('returns null lastMessageAt when agent has no messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const results = await Agent.list({ agentTypeId: testAgentTypeId })
      const result = results.find((a) => a.id === agent.id)

      expect(result).toBeDefined()
      expect(result!.lastMessageAt).toBeNull()
    })
    it('paginates equal effective activity deterministically by agent ID', async () => {
      const first = await Agent.create({ agentTypeId: testAgentTypeId })
      const second = await Agent.create({ agentTypeId: testAgentTypeId })
      const noMessages = await Agent.create({ agentTypeId: testAgentTypeId })
      const at = new Date('2099-08-10T12:00:00.000Z')
      // Insert in the opposite order from the expected agent ID tie-break.
      const tied = [first, second].sort((a, b) => a.id.localeCompare(b.id))
      await db.insert(messages).values(
        [...tied].reverse().map((agent) => ({
          agentId: agent.id,
          role: 'assistant' as const,
          content: agent.id,
          createdAt: at,
        }))
      )
      // Agent IDs are random, so creation order agrees with ID order half the time and an
      // unordered scan would tie-break correctly by luck. Rewriting the lower-ID row moves its
      // tuple to the end of the heap, so physical order always contradicts the expected order.
      await db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, tied[0]!.id))

      // Direct inserts above bypass the write path; establish the summary the
      // ordering under test is computed from.
      await refreshAgentActivityMany([first.id, second.id, noMessages.id])

      const page1 = await Agent.list({ agentTypeId: testAgentTypeId, limit: 1, offset: 0 }, 'latestMessage')
      const page2 = await Agent.list({ agentTypeId: testAgentTypeId, limit: 1, offset: 1 }, 'latestMessage')
      expect(page1[0]!.lastMessageAt?.getTime()).toBe(page2[0]!.lastMessageAt?.getTime())
      expect([...page1, ...page2].map(({ id }) => id)).toEqual(tied.map(({ id }) => id))

      const all = await Agent.list({ agentTypeId: testAgentTypeId }, 'latestMessage')
      expect(all.find(({ id }) => id === noMessages.id)!.lastMessageAt).toBeNull()
    })
  })

  describe('persist flag', () => {
    it('defaults persist to false', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      expect(agent.persist).toBe(false)
    })

    it('creates agent with persist true', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true })
      expect(agent.persist).toBe(true)
    })

    it('updates persist flag', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      expect(agent.persist).toBe(false)

      const updated = await agent.update({ persist: true })
      expect(updated?.persist).toBe(true)
    })

    it('throws when updating persist for manager agent', async () => {
      const manager = await Agent.create({ agentTypeId: 'manager' })

      await expect(manager.update({ persist: false })).rejects.toThrow('Cannot update persist flag for manager agents')

      const unchanged = await Agent.mustFind(manager.id)
      expect(unchanged.persist).toBe(true)

      // cleanup
      await db.delete(agents).where(eq(agents.id, manager.id))
    })
  })

  describe('Agent.terminate', () => {
    it('routes public dormancy through teardown but requires an explicit wake API', async () => {
      const squad = await Squad.create({ name: `update-lifecycle-${crypto.randomUUID()}`, purpose: 'test' })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      await agent.getOrCreateToken()
      const generation = (agent.metadata as Record<string, unknown>).resourceGeneration
      await agent.update({ questionData: { questions: [{ id: 'stale', type: 'text', question: 'Old?' }] } })

      await agent.update({
        status: 'dormant',
        metadata: { resourceGeneration: 'caller-controlled', dormancyCompletionPending: false },
      })
      expect(agent).toMatchObject({ status: 'dormant', dormantAt: expect.any(Date), questionData: null })
      expect((agent.metadata as Record<string, unknown>).resourceGeneration).toBe(generation)
      expect(
        (await db.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id))).every((row) => row.revokedAt)
      ).toBe(true)

      await expect(agent.update({ status: 'idle' })).rejects.toThrow('explicit wake source')
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')

      const warmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      try {
        await agent.wake()
      } finally {
        ensure.mockRestore()
      }
      expect(agent.status).toBe('idle')
      expect(agent.questionData).toBeNull()
      expect((agent.metadata as Record<string, unknown>).resourceGeneration).not.toBe(generation)
    })

    it('makes a non-persistent agent dormant without finalizing it', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      await agent.tryTerminate()

      const fetched = await Agent.mustFind(agent.id)
      expect(fetched.status).toBe('dormant')
      expect(fetched.dormantAt).toBeInstanceOf(Date)
      expect(fetched.terminatedAt).toBeNull()
    })

    it('keeps lifecycle audit timestamps owned by authoritative transitions', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await makeDormant(agent)
      const dormantAt = agent.dormantAt
      await agent.update({ status: 'dormant', dormantAt: null })
      expect(agent.dormantAt).toEqual(dormantAt)
      await expect(agent.update({ dormantAt: new Date('2000-01-01T00:00:00.000Z') })).rejects.toThrow(
        'lifecycle changed during update'
      )
      expect((await Agent.mustFind(agent.id)).dormantAt).toEqual(dormantAt)

      await terminate(agent, { finalCleanup: async () => true })
      await agent.reload()
      const terminatedAt = agent.terminatedAt
      await agent.update({ status: 'terminated', terminatedAt: new Date('2001-01-01T00:00:00.000Z') })
      expect(agent.terminatedAt).toEqual(terminatedAt)
    })

    it('rejects token issuance for dormant and terminated agents', async () => {
      const squad = await Squad.create({ name: `token-status-${crypto.randomUUID()}`, purpose: 'test' })
      const wrongGeneration = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      expect(
        await wrongGeneration.getOrCreateToken({ expectedResourceGeneration: 'caller-controlled' })
      ).toBeUndefined()
      expect(await db.select().from(agentTokens).where(eq(agentTokens.agentId, wrongGeneration.id))).toEqual([])

      const dormant = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      await makeDormant(dormant)
      await expect(dormant.createAgentToken()).rejects.toThrow('cannot issue an agent token')
      expect(await dormant.getOrCreateToken()).toBeUndefined()

      const terminated = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      await makeDormant(terminated)
      await terminate(terminated, { finalCleanup: async () => true })
      await expect(terminated.createAgentToken()).rejects.toThrow('cannot issue an agent token')
      expect(await terminated.getOrCreateToken()).toBeUndefined()
    })

    it('replaces cached plaintext whose durable token row was revoked by another process', async () => {
      const squad = await Squad.create({ name: `token-cache-${crypto.randomUUID()}`, purpose: 'test' })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const original = await agent.getOrCreateToken()
      await db
        .update(agentTokens)
        .set({ revokedAt: new Date() })
        .where(eq(agentTokens.tokenHash, createHash('sha256').update(original!).digest('hex')))
      const generation = crypto.randomUUID()
      await db
        .update(agents)
        .set({ metadata: { ...(agent.metadata ?? {}), resourceGeneration: generation } })
        .where(eq(agents.id, agent.id))
      await agent.reload()

      const replacement = await agent.getOrCreateToken({ expectedResourceGeneration: generation })

      expect(replacement).not.toBe(original)
      const active = await db
        .select()
        .from(agentTokens)
        .where(and(eq(agentTokens.agentId, agent.id), sql`${agentTokens.revokedAt} IS NULL`))
      expect(active).toHaveLength(1)
      expect(active[0].tokenHash).toBe(createHash('sha256').update(replacement!).digest('hex'))
      expect(await resolveTokenContext(replacement!)).toMatchObject({
        identity: { type: 'agent', agentId: agent.id, squadId: squad.id },
      })
    })

    it('serializes token mint behind dormancy so the new token cannot miss the revocation snapshot', async () => {
      const squad = await Squad.create({ name: `token-race-${crypto.randomUUID()}`, purpose: 'test' })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const dormancyLocked = Promise.withResolvers<void>()
      const releaseDormancy = Promise.withResolvers<void>()
      setMakeDormantBeforeExecutionLockHookForTest(async () => {
        setMakeDormantBeforeExecutionLockHookForTest(undefined)
        dormancyLocked.resolve()
        await releaseDormancy.promise
      })
      try {
        const becomingDormant = makeDormant(agent)
        await dormancyLocked.promise
        const mint = agent.createAgentToken().then(
          () => null,
          (error: unknown) => error
        )
        await Bun.sleep(20)
        releaseDormancy.resolve()
        await becomingDormant
        expect(await mint).toBeInstanceOf(Error)
        expect(((await mint) as Error).message).toContain('cannot issue an agent token')
        expect(await db.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id))).toEqual([])
      } finally {
        releaseDormancy.resolve()
        setMakeDormantBeforeExecutionLockHookForTest(undefined)
      }
    })

    it('matches execution settlement lock order while requesting dormancy', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const execution = await agent.queueExecution({ message: 'running work' })
      await execution.start()
      const settlementLocked = Promise.withResolvers<void>()
      const releaseSettlement = Promise.withResolvers<void>()
      const dormancyAtExecutionBoundary = Promise.withResolvers<void>()
      const releaseDormancy = Promise.withResolvers<void>()
      setMakeDormantBeforeExecutionLockHookForTest(async () => {
        dormancyAtExecutionBoundary.resolve()
        await releaseDormancy.promise
      })
      const settlement = execution.transitionTo(
        { kind: 'completed' },
        {
          afterExecutionLocked: async () => {
            settlementLocked.resolve()
            await releaseSettlement.promise
          },
        }
      )
      try {
        await settlementLocked.promise
        const dormancy = makeDormant(await Agent.mustFind(agent.id))
        await dormancyAtExecutionBoundary.promise
        releaseSettlement.resolve()
        releaseDormancy.resolve()
        await Promise.race([
          Promise.all([settlement, dormancy]),
          Bun.sleep(2_000).then(() => {
            throw new Error('execution settlement and dormancy deadlocked')
          }),
        ])
        expect((await Execution.mustFind(execution.id)).status).toBe('completed')
      } finally {
        releaseSettlement.resolve()
        releaseDormancy.resolve()
        setMakeDormantBeforeExecutionLockHookForTest(undefined)
      }
    })

    it('rejects an execution admission that began before dormancy committed', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const dormantAt = new Date()
      await agent.update({ status: 'dormant', dormantAt })

      await expect(
        db.transaction((tx) =>
          agent.queueExecutionInTransaction(
            tx,
            { message: 'racing work', lifecycleDormancyEpisodeAtAcceptance: null },
            []
          )
        )
      ).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
    })

    it('rejects dormant correspondence accepted during an earlier dormancy episode', async () => {
      const warmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      try {
        await makeDormant(agent)
        await agent.reload()
        const staleEpisode = (agent.metadata as Record<string, unknown>).dormancyEpisodeId
        expect(typeof staleEpisode).toBe('string')

        await agent.wake()
        await makeDormant(agent)
        await agent.reload()
        expect((agent.metadata as Record<string, unknown>).dormancyEpisodeId).not.toBe(staleEpisode)

        await expect(
          db.transaction((tx) =>
            agent.queueExecutionInTransaction(
              tx,
              { message: 'stale correspondence', lifecycleDormancyEpisodeAtAcceptance: staleEpisode as string },
              []
            )
          )
        ).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })
        expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
        expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
      } finally {
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('completes four independent dormancy teardowns without exhausting the default DB pool', async () => {
      const agents = await Promise.all(Array.from({ length: 4 }, () => Agent.create({ agentTypeId: testAgentTypeId })))
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all(agents.map((agent) => agent.tryTerminate())),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('concurrent dormancy teardown deadlocked')), 5000)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
      for (const agent of agents) {
        expect(await Agent.mustFind(agent.id)).toMatchObject({
          status: 'dormant',
          metadata: expect.not.objectContaining({ dormancyCompletionPending: true }),
        })
      }
    })

    it.each(['monitors', 'tokens', 'children', 'schedules', 'sandbox'] as const)(
      'serializes a genuine wake behind dormant %s teardown',
      async (blockedStage) => {
        const agentWarmup = await import('../services/sandbox/agent-warmup')
        const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
        const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
        const agent = await Agent.create({ agentTypeId: testAgentTypeId })
        let admission: Promise<Execution> | undefined
        let settled = false
        let triggered = false
        const visitedStages: string[] = []
        setDormancyEffectHookForTest(async (stage) => {
          visitedStages.push(stage)
          if (stage !== blockedStage || triggered) return
          triggered = true
          admission = agent.queueExecution({ message: `wake during ${stage}` }).finally(() => {
            settled = true
          })
          await Bun.sleep(20)
          expect(settled).toBe(false)
        })
        try {
          await agent.tryTerminate()
          expect(admission).toBeDefined()
          await admission
          expect((await Agent.mustFind(agent.id)).status).toBe('idle')
          expect(visitedStages).toEqual(['monitors', 'tokens', 'children', 'schedules', 'sandbox'])
        } finally {
          setDormancyEffectHookForTest(undefined)
          ensure.mockRestore()
          mint.mockRestore()
        }
      }
    )

    it('does not run stale dormancy teardown effects for a later episode', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const staleId = crypto.randomUUID()
      const currentId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          dormancyCompletionPending: true,
          dormancyCompletionId: currentId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      const visitedStages: string[] = []
      setDormancyEffectHookForTest(async (stage) => {
        visitedStages.push(stage)
      })
      try {
        expect(await completeDormancy(agent.id, staleId)).toBe(false)
        expect(visitedStages).toEqual([])
        expect((await Agent.mustFind(agent.id)).metadata).toMatchObject({
          dormancyCompletionPending: true,
          dormancyCompletionId: currentId,
        })
      } finally {
        setDormancyEffectHookForTest(undefined)
      }
    })

    it('does not run stale claimed effects after a newer dormancy episode replaces it', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const staleId = crypto.randomUUID()
      const currentId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: { dormancyCompletionPending: true, dormancyCompletionId: staleId },
      })
      const stop = spyOn(monitorSupervisor, 'stopAllForAgent')
      setDormancyEffectHookForTest(async (stage) => {
        if (stage !== 'monitors') return
        setDormancyEffectHookForTest(undefined)
        await db
          .update(agents)
          .set({
            metadata: {
              ...(agent.metadata ?? {}),
              dormancyCompletionPending: true,
              dormancyCompletionId: currentId,
              dormancyCompletionClaimId: crypto.randomUUID(),
              dormancyCompletionClaimedAt: new Date().toISOString(),
            },
          })
          .where(eq(agents.id, agent.id))
      })
      try {
        expect(await completeDormancy(agent.id, staleId)).toBe(false)
        expect(stop).not.toHaveBeenCalled()
        expect((await Agent.mustFind(agent.id)).metadata).toMatchObject({
          dormancyCompletionPending: true,
          dormancyCompletionId: currentId,
        })
      } finally {
        setDormancyEffectHookForTest(undefined)
        stop.mockRestore()
      }
    })

    it('rejects a child dormancy mutation without the exact current parent episode', async () => {
      const squad = await Squad.create({ name: `parent-episode-${crypto.randomUUID()}`, purpose: 'test' })
      const parent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const child = await Agent.create({
        agentTypeId: testAgentTypeId,
        squadId: squad.id,
        parentAgentId: parent.id,
        persist: false,
      })
      expect(
        await requestAgentLifecycle(child, {
          target: 'dormant',
          expectedResourceGeneration: (child.metadata as Record<string, unknown>).resourceGeneration as string,
          parentFence: {
            parentAgentId: parent.id,
            episodeId: crypto.randomUUID(),
            claimId: crypto.randomUUID(),
            resourceGeneration: (parent.metadata as Record<string, unknown>).resourceGeneration as string,
          },
        })
      ).toBe(false)
      expect((await Agent.mustFind(child.id)).status).toBe('idle')
    })

    it('fences every child dormancy mutation after an expired owner and parent wake', async () => {
      const squad = await Squad.create({ name: `child-fence-${crypto.randomUUID()}`, purpose: 'test' })
      const parent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id, parentAgentId: parent.id, persist: false })
      const revivedChild = await Agent.create({
        agentTypeId: testAgentTypeId,
        squadId: squad.id,
        parentAgentId: parent.id,
        persist: false,
      })
      const staleOwnerAtSecondChild = Promise.withResolvers<void>()
      const releaseStaleOwner = Promise.withResolvers<void>()
      setCascadeDormantChildBeforeRequestHookForTest(async (_parentId, childId) => {
        if (childId !== revivedChild.id) return
        setCascadeDormantChildBeforeRequestHookForTest(undefined)
        staleOwnerAtSecondChild.resolve()
        await releaseStaleOwner.promise
      })
      const warmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      try {
        const stale = makeDormant(parent)
        await staleOwnerAtSecondChild.promise
        await parent.reload()
        const episodeId = (parent.metadata as Record<string, unknown>).dormancyCompletionId as string
        await db
          .update(agents)
          .set({
            metadata: {
              ...(parent.metadata ?? {}),
              dormancyCompletionClaimedAt: '2000-01-01T00:00:00.000Z',
            },
          })
          .where(eq(agents.id, parent.id))

        expect(await completeDormancy(parent.id, episodeId)).toBe(true)
        await parent.reload()
        await parent.wake()
        await revivedChild.reload()
        await revivedChild.wake()
        const revivedGeneration = (revivedChild.metadata as Record<string, unknown>).resourceGeneration

        releaseStaleOwner.resolve()
        await stale
        await revivedChild.reload()
        expect(revivedChild.status).toBe('idle')
        expect((revivedChild.metadata as Record<string, unknown>).resourceGeneration).toBe(revivedGeneration)
      } finally {
        releaseStaleOwner.resolve()
        setCascadeDormantChildBeforeRequestHookForTest(undefined)
        ensure.mockRestore()
      }
    })

    it('runs destructive dormancy stages once across concurrent completers', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: { dormancyCompletionPending: true, dormancyCompletionId: episodeId },
      })
      const visited: string[] = []
      setDormancyEffectHookForTest(async (stage) => {
        visited.push(stage)
        await Bun.sleep(10)
      })
      try {
        const results = await Promise.all([
          completeDormancy(agent.id, episodeId),
          completeDormancy(agent.id, episodeId),
          completeDormancy(agent.id, episodeId),
        ])
        expect(results.filter(Boolean)).toHaveLength(1)
        expect(visited).toEqual(['monitors', 'tokens', 'children', 'schedules', 'sandbox'])
      } finally {
        setDormancyEffectHookForTest(undefined)
      }
    })

    it('fences resumed expired token revocation from a revived token', async () => {
      const warmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const firstRevokeEntered = Promise.withResolvers<void>()
      const releaseFirstRevoke = Promise.withResolvers<void>()
      const originalRevoke = Agent.prototype.revokeTokensForAgent
      let revokeCalls = 0
      const revoke = spyOn(Agent.prototype, 'revokeTokensForAgent').mockImplementation(async function (
        this: Agent,
        options: Parameters<Agent['revokeTokensForAgent']>[0]
      ) {
        revokeCalls++
        if (revokeCalls === 1) {
          firstRevokeEntered.resolve()
          await releaseFirstRevoke.promise
        }
        return originalRevoke.call(this, options)
      })
      const squad = await Squad.create({ name: `token-fence-${crypto.randomUUID()}`, purpose: 'test' })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
      const episodeId = crypto.randomUUID()
      const firstToken = await agent.getOrCreateToken()
      const [firstTokenRow] = await db.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id))
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          resourceGeneration: 'generation-a',
          dormancyTokenIds: [firstTokenRow.id],
          dormancyEpisodeId: episodeId,
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
        },
      })
      try {
        const stale = completeDormancy(agent.id, episodeId)
        await firstRevokeEntered.promise
        const row = await Agent.mustFind(agent.id)
        await seedAgentLifecycleForTest(row, {
          metadata: { ...(row.metadata ?? {}), dormancyCompletionClaimedAt: '2000-01-01T00:00:00.000Z' },
        })
        expect(await completeDormancy(agent.id, episodeId)).toBe(true)
        await agent.reload()
        await agent.wake()
        const revivedToken = await agent.getOrCreateToken()
        expect(revivedToken).not.toBe(firstToken)
        releaseFirstRevoke.resolve()
        expect(await stale).toBe(false)
        const tokens = await db.select().from(agentTokens).where(eq(agentTokens.agentId, agent.id))
        expect(tokens.filter((token) => token.revokedAt === null)).toHaveLength(1)
        expect(await agent.getOrCreateToken()).toBe(revivedToken)
      } finally {
        releaseFirstRevoke.resolve()
        revoke.mockRestore()
        ensure.mockRestore()
        await db.delete(agents).where(eq(agents.id, agent.id))
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('does not let a superseded wake mint into a newer resource generation', async () => {
      const warmup = await import('../services/sandbox/agent-warmup')
      const firstEnsureEntered = Promise.withResolvers<void>()
      const releaseFirstEnsure = Promise.withResolvers<void>()
      let ensureCalls = 0
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockImplementation(async () => {
        ensureCalls++
        if (ensureCalls === 1) {
          firstEnsureEntered.resolve()
          await releaseFirstEnsure.promise
        }
        return 'ensured'
      })
      const mintedGenerations: Array<string | undefined> = []
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockImplementation(async (options = {}) => {
        mintedGenerations.push(options.expectedResourceGeneration)
        return 'ficus_agent_test'
      })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })
      try {
        const staleWake = agent.wake()
        await firstEnsureEntered.promise
        const firstWakeGeneration = ((await Agent.mustFind(agent.id)).metadata as Record<string, unknown>)
          .resourceGeneration as string

        const current = await Agent.mustFind(agent.id)
        await makeDormant(current)
        await current.reload()
        await current.wake()
        const currentGeneration = (current.metadata as Record<string, unknown>).resourceGeneration as string
        expect(currentGeneration).not.toBe(firstWakeGeneration)

        releaseFirstEnsure.resolve()
        await expect(staleWake).rejects.toThrow('wake was superseded')
        expect(mintedGenerations).toEqual([currentGeneration])
        expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      } finally {
        releaseFirstEnsure.resolve()
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('propagates an explicit legacy-resource fence for a first post-upgrade dormancy', async () => {
      const sandbox = await import('../services/sandbox')
      const stoppedGenerations: Array<string | null | undefined> = []
      const manager = {
        stopSandbox: async (_sandboxId: string, options?: { lifecycleGeneration?: string | null }) => {
          stoppedGenerations.push(options?.lifecycleGeneration)
          return { kind: 'stopped' as const }
        },
        removeSandbox: async () => {},
      }
      const getManager = spyOn(sandbox, 'getSandboxManager').mockReturnValue(manager as never)
      const created = await Agent.create({ agentTypeId: testAgentTypeId })
      await db
        .update(agents)
        .set({ metadata: sql`${agents.metadata} - 'resourceGeneration'` })
        .where(eq(agents.id, created.id))

      try {
        await makeDormant(await Agent.mustFind(created.id))
        expect(stoppedGenerations).toEqual([null])
      } finally {
        getManager.mockRestore()
      }
    })

    it('fences a resumed expired sandbox effect from a revived resource generation', async () => {
      const sandbox = await import('../services/sandbox')
      const warmup = await import('../services/sandbox/agent-warmup')
      const firstStopEntered = Promise.withResolvers<void>()
      const releaseFirstStop = Promise.withResolvers<void>()
      let stopCalls = 0
      const stoppedGenerations: string[] = []
      let currentGeneration = 'generation-a'
      const manager = {
        stopSandbox: async (_sandboxId: string, options?: { lifecycleGeneration?: string }) => {
          stopCalls++
          if (stopCalls === 1) {
            firstStopEntered.resolve()
            await releaseFirstStop.promise
          }
          if (options?.lifecycleGeneration === currentGeneration) {
            stoppedGenerations.push(options.lifecycleGeneration)
            return { kind: 'stopped' as const }
          }
          return {
            kind: 'generation-mismatch' as const,
            actualLifecycleGeneration: currentGeneration,
          }
        },
        removeSandbox: async () => {},
      }
      const getManager = spyOn(sandbox, 'getSandboxManager').mockReturnValue(manager as never)
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockImplementation(async (candidate) => {
        currentGeneration = ((candidate.metadata as Record<string, unknown>).resourceGeneration as string) ?? ''
        return 'ensured'
      })
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          resourceGeneration: currentGeneration,
          dormancyResourceGeneration: currentGeneration,
          dormancyEpisodeId: episodeId,
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
        },
      })
      try {
        const stale = completeDormancy(agent.id, episodeId)
        await Promise.race([
          firstStopEntered.promise,
          Bun.sleep(2_000).then(() => {
            throw new Error('stale dormancy did not reach sandbox stop')
          }),
        ])
        const row = await Agent.mustFind(agent.id)
        await seedAgentLifecycleForTest(row, {
          metadata: {
            ...(row.metadata ?? {}),
            dormancyCompletionClaimedAt: '2000-01-01T00:00:00.000Z',
          },
        })
        expect(
          await Promise.race([
            completeDormancy(agent.id, episodeId),
            Bun.sleep(2_000).then(() => {
              throw new Error('dormancy takeover did not complete')
            }),
          ])
        ).toBe(true)
        await agent.reload()
        await agent.wake()
        const revivedGeneration = (agent.metadata as Record<string, unknown>).resourceGeneration as string
        expect(revivedGeneration).not.toBe('generation-a')
        releaseFirstStop.resolve()
        expect(await stale).toBe(false)
        expect(stoppedGenerations).toEqual(['generation-a'])
        expect(currentGeneration).toBe(revivedGeneration)
        expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      } finally {
        releaseFirstStop.resolve()
        getManager.mockRestore()
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('retries the observed generation when the same dormant episode still owns the stop', async () => {
      const sandbox = await import('../services/sandbox')
      const stopped: Array<string | null | undefined> = []
      const manager = {
        stopSandbox: async (_sandboxId: string, options?: { lifecycleGeneration?: string | null }) => {
          stopped.push(options?.lifecycleGeneration)
          if (options?.lifecycleGeneration === 'generation-a') {
            return { kind: 'generation-mismatch' as const, actualLifecycleGeneration: 'generation-b' }
          }
          return { kind: 'stopped' as const }
        },
        removeSandbox: async () => {},
      }
      const getManager = spyOn(sandbox, 'getSandboxManager').mockReturnValue(manager as never)
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          resourceGeneration: 'generation-b',
          dormancyResourceGeneration: 'generation-a',
          dormancyEpisodeId: episodeId,
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
        },
      })
      try {
        expect(await completeDormancy(agent.id, episodeId)).toBe(true)
      } finally {
        getManager.mockRestore()
      }
      expect(stopped).toEqual(['generation-a', 'generation-b'])
      expect((await Agent.mustFind(agent.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    })

    it('reclaims an expired dormancy completion claim after a crashed completer', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: '2000-01-01T00:00:00.000Z',
        },
      })

      expect(await completeDormancy(agent.id, episodeId)).toBe(true)
      expect((await Agent.mustFind(agent.id)).metadata).not.toHaveProperty('dormancyCompletionPending')
    })

    it('backs off while waiting for an active dormancy completion claim', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const episodeId = crypto.randomUUID()
      await seedAgentLifecycleForTest(agent, {
        status: 'dormant',
        dormantAt: new Date(),
        metadata: {
          dormancyCompletionPending: true,
          dormancyCompletionId: episodeId,
          dormancyCompletionClaimId: crypto.randomUUID(),
          dormancyCompletionClaimedAt: new Date().toISOString(),
        },
      })
      const delays: number[] = []

      expect(
        await completeDormancyIfPending(agent.id, {
          timeoutMs: 500,
          wait: async (delayMs) => {
            delays.push(delayMs)
            await Bun.sleep(delayMs)
          },
        })
      ).toBe(false)
      expect(delays[0]).toBe(25)
      expect(delays.length).toBeLessThanOrEqual(6)
    })

    it('retries an incomplete durable dormancy teardown', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const originalStop = monitorSupervisor.stopAllForAgent.bind(monitorSupervisor)
      let fail = true
      monitorSupervisor.stopAllForAgent = async () => {
        if (fail) throw new Error('injected dormancy crash')
      }
      try {
        await expect(agent.tryTerminate()).rejects.toThrow('injected dormancy crash')
        let dormant = await Agent.mustFind(agent.id)
        expect((dormant.metadata as Record<string, unknown>).dormancyCompletionPending).toBe(true)
        // Make this row the oldest candidate so unrelated eligible rows left by
        // concurrently running files cannot consume the bounded sweep ahead of it.
        await db
          .update(agents)
          .set({
            dormantAt: new Date(0),
            metadata: { ...(dormant.metadata ?? {}), dormancyCompletionSweepAt: -1 },
          })
          .where(eq(agents.id, agent.id))
        fail = false
        const delivered: string[] = []
        await runDormancyCompletionSweep({
          deliver: async (agentId) => void delivered.push(agentId),
        })
        dormant = await Agent.mustFind(agent.id)
        expect((dormant.metadata as Record<string, unknown>).dormancyCompletionPending).toBeUndefined()
        expect(delivered.filter((agentId) => agentId === agent.id)).toHaveLength(1)
      } finally {
        monitorSupervisor.stopAllForAgent = originalStop
      }
    })

    it('clears a legacy non-string inbox redelivery marker without delivering it', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await db
        .update(agents)
        .set({
          status: 'dormant',
          dormantAt: new Date(0),
          metadata: { pendingInboxRedelivery: true, dormancyCompletionSweepAt: -1 },
        })
        .where(eq(agents.id, agent.id))
      const delivered: string[] = []

      await runDormancyCompletionSweep({
        deliver: async (agentId) => void delivered.push(agentId),
      })

      const dormant = await Agent.mustFind(agent.id)
      expect(dormant.status).toBe('dormant')
      expect((dormant.metadata as Record<string, unknown>).pendingInboxRedelivery).toBeUndefined()
      expect(delivered).not.toContain(agent.id)
    })

    it('retains durable dormancy completion when schedule reconciliation fails', async () => {
      const reconciliation = await import('../services/scheduling/reconciliation')
      const reconcile = spyOn(reconciliation, 'reconcileSchedulesForDormantAgent')
        .mockResolvedValueOnce({ scanned: 1, repaired: 0, failed: 1 })
        .mockResolvedValue({ scanned: 1, repaired: 1, failed: 0 })
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      try {
        await expect(agent.tryTerminate()).rejects.toThrow('Failed to reconcile 1 dormant schedule(s)')
        let dormant = await Agent.mustFind(agent.id)
        expect(dormant.metadata).toMatchObject({ dormancyCompletionPending: true })
        await makeDormant(dormant)
        dormant = await Agent.mustFind(agent.id)
        expect(dormant.metadata).not.toHaveProperty('dormancyCompletionPending')
        expect(reconcile).toHaveBeenCalledTimes(2)
      } finally {
        reconcile.mockRestore()
      }
    })

    it('defers unverified compute stop without request errors, then settles after remnant externalization', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      let allowStop = false
      const stop = spyOn(cleanupModule, 'stopPersonalSandbox').mockImplementation(async () =>
        allowStop ? { kind: 'not-found' } : { kind: 'unverified' }
      )
      try {
        await expect(agent.tryTerminate()).resolves.toBeUndefined()
        expect(stop).toHaveBeenCalledTimes(1)
        let dormant = await Agent.mustFind(agent.id)
        expect(dormant.metadata).toMatchObject({ dormancyCompletionPending: true })
        await expect(dormant.sendMessage('deferred correspondence')).rejects.toMatchObject({
          code: 'AGENT_TARGET_UNAVAILABLE',
          message: expect.stringContaining('retry shortly'),
        })
        const afterSend = stop.mock.calls.length
        expect(afterSend).toBeGreaterThan(1)
        await expect(dormant.queueExecution({ message: 'deferred execution' })).rejects.toMatchObject({
          code: 'AGENT_TARGET_UNAVAILABLE',
        })
        const afterQueue = stop.mock.calls.length
        expect(afterQueue).toBeGreaterThan(afterSend)
        await expect(dormant.wake()).resolves.toBe(false)
        expect(stop).toHaveBeenCalledTimes(afterQueue + 1)
        expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
        allowStop = true
        await makeDormant(dormant)
        dormant = await Agent.mustFind(agent.id)
        expect((dormant.metadata as Record<string, unknown>).dormancyCompletionPending).toBeUndefined()
        expect(stop).toHaveBeenCalledTimes(afterQueue + 2)
      } finally {
        stop.mockRestore()
      }
    })

    it('suppresses monitor notices after atomically making the agent non-live', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const originalStopAllForAgent = monitorSupervisor.stopAllForAgent.bind(monitorSupervisor)
      const statusesDuringCleanup: string[] = []
      const notifyValues: Array<boolean | undefined> = []
      monitorSupervisor.stopAllForAgent = async (agentId: string, options?: { notifyAgent?: boolean }) => {
        statusesDuringCleanup.push((await Agent.mustFind(agentId)).status)
        notifyValues.push(options?.notifyAgent)
      }

      try {
        await agent.tryTerminate()
      } finally {
        monitorSupervisor.stopAllForAgent = originalStopAllForAgent
      }

      expect(statusesDuringCleanup).toEqual(['dormant'])
      expect(notifyValues).toEqual([false])
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
    })

    it('stops queued work before making the agent dormant', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const execution = await agent.queueExecution({ message: 'not started' })

      await agent.tryTerminate()

      expect((await Execution.mustFind(execution.id)).status).toBe('stopped')
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
    })

    it('leaves no queued housekeeping execution when making an agent with a monitor dormant', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const monitor = await Monitor.create({
        agentId: agent.id,
        sandboxId: agent.getAgentWorkspaceSandboxId(),
        label: 'protected checks',
        command: 'sleep 60',
        status: 'running',
        processId: 'monitor-test',
        timeoutMs: 60_000,
        maxBatchLines: 20,
        maxBatchBytes: 4096,
        batchDebounceMs: 750,
      })

      const sendInbox = spyOn(InboxMessage, 'send')
      // Deliberately move the host clock behind PostgreSQL. A host `new Date()`
      // cutoff would now predate the monitor row and leave it running; the
      // DB-written dormancy cutoff remains comparable to monitors.createdAt.
      setSystemTime(new Date(Date.now() - 5_000))
      try {
        await agent.tryTerminate()
        expect(sendInbox).not.toHaveBeenCalled()
      } finally {
        setSystemTime()
        sendInbox.mockRestore()
      }

      expect((await Monitor.mustFind(monitor.id)).status).toBe('canceled')
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
      const dormant = await Agent.mustFind(agent.id)
      expect(dormant.status).toBe('dormant')
      expect(dormant.dormantAt!.getTime()).toBeGreaterThanOrEqual(monitor.createdAt.getTime())
    })

    it('requests monitor cleanup before termination returns', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const originalStopAllForAgent = monitorSupervisor.stopAllForAgent.bind(monitorSupervisor)
      const cleanedAgentIds: string[] = []
      monitorSupervisor.stopAllForAgent = async (agentId: string) => {
        cleanedAgentIds.push(agentId)
      }

      try {
        await agent.tryTerminate()
      } finally {
        monitorSupervisor.stopAllForAgent = originalStopAllForAgent
      }

      expect(cleanedAgentIds).toEqual([agent.id])
    })

    it.each(['compacting', 'resetting'] as const)('does not enter dormancy while %s', async (status) => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status })

      await expect(agent.tryTerminate()).rejects.toThrow(`Agent is ${status}`)
      expect((await Agent.mustFind(agent.id)).status).toBe(status)
    })

    it('throws when terminating manager agent', async () => {
      const manager = await Agent.create({ agentTypeId: 'manager' })

      await expect(manager.tryTerminate()).rejects.toThrow('Cannot terminate manager agents')

      const fetched = await Agent.mustFind(manager.id)
      expect(fetched.status).toBe('idle')
      expect(fetched.terminatedAt).toBeNull()

      // cleanup
      await db.delete(agents).where(eq(agents.id, manager.id))
    })

    it('throws when terminating persistent non-manager agent', async () => {
      const persistentAgent = await Agent.create({ agentTypeId: testAgentTypeId, persist: true })

      await expect(persistentAgent.tryTerminate()).rejects.toThrow(
        'Cannot terminate persistent agent. Set persist=false first.'
      )

      const fetched = await Agent.mustFind(persistentAgent.id)
      expect(fetched.status).toBe('idle')
      expect(fetched.terminatedAt).toBeNull()
    })

    it('wakes a dormant agent with sandbox and token side effects before queueing work', async () => {
      const agentWarmup = await import('../services/sandbox/agent-warmup')
      const ensured: string[] = []
      const minted: string[] = []
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockImplementation(async (candidate: Agent) => {
        ensured.push(candidate.id)
        return 'ensured'
      })
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockImplementation(async function (this: Agent) {
        minted.push(this.id)
        return 'ficus_agent_test'
      })
      try {
        const agent = await Agent.create({ agentTypeId: testAgentTypeId })
        await makeDormant(agent)

        const execution = await agent.queueExecution({ message: 'wake up' })

        expect(execution.status).toBe('queued')
        const fetched = await Agent.mustFind(agent.id)
        expect(fetched.status).toBe('idle')
        expect(fetched.dormantAt).toBeNull()
        expect((fetched.metadata as Record<string, unknown>).wakeCompletionPending).toBeUndefined()
        expect(ensured).toEqual([agent.id])
        expect(minted).toEqual([agent.id])
      } finally {
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it.each([
      ['ensured', true],
      ['skipped-subagent', true],
      ['skipped-maintenance', true],
      ['skipped-squad-inactive', true],
      ['skipped-work-stream-queued', true],
      ['skipped-agent-unavailable', false],
    ] as const)('completes wake after intentional sandbox result %s', async (ensureResult, expected) => {
      const agentWarmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue(ensureResult)
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await makeDormant(agent)
      const completionId = await db.transaction(async (tx) => {
        await acquireAgentQueueLock(tx, agent.id)
        return wakeInTransaction(tx, agent.id)
      })
      try {
        expect(completionId).toBeString()
        expect(await completeWake(agent.id, agent, completionId!)).toBe(expected)
        const current = await Agent.mustFind(agent.id)
        expect((current.metadata as Record<string, unknown>).wakeCompletionPending).toBe(expected ? undefined : true)
        expect(mint).toHaveBeenCalledTimes(expected ? 1 : 0)
      } finally {
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('does not clear wake completion when dormancy wins the final clear boundary', async () => {
      const agentWarmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
      await child.update({ status: 'dormant', dormantAt: new Date() })
      setCompleteWakeBeforeClearHookForTest(async () => {
        setCompleteWakeBeforeClearHookForTest(undefined)
        await makeDormant(await Agent.mustFind(child.id))
      })
      try {
        await expect(child.wake()).rejects.toThrow('wake was superseded')
      } finally {
        setCompleteWakeBeforeClearHookForTest(undefined)
        ensure.mockRestore()
        mint.mockRestore()
      }

      const final = await Agent.mustFind(child.id)
      expect(final.status).toBe('dormant')
      expect((final.metadata as Record<string, unknown>).wakeCompletionPending).toBe(true)
    })

    it('does not let a stale wake completion clear a newer wake episode', async () => {
      const agentWarmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
      await child.update({ status: 'dormant', dormantAt: new Date() })
      let episodeA: string | undefined
      let episodeB: string | null = null
      setCompleteWakeBeforeClearHookForTest(async () => {
        setCompleteWakeBeforeClearHookForTest(undefined)
        const wakingA = await Agent.mustFind(child.id)
        episodeA = (wakingA.metadata as Record<string, unknown>).wakeCompletionId as string
        await makeDormant(wakingA)
        episodeB = await db.transaction(async (tx) => {
          await acquireAgentQueueLock(tx, child.id)
          return wakeInTransaction(tx, child.id)
        })
      })
      try {
        await expect(child.wake()).rejects.toThrow('wake was superseded')
        expect(episodeA).toBeString()
        expect(episodeB).toBeString()
        expect(episodeB).not.toBe(episodeA)
        let current = await Agent.mustFind(child.id)
        expect((current.metadata as Record<string, unknown>).wakeCompletionId).toBe(episodeB)
        expect((current.metadata as Record<string, unknown>).wakeCompletionPending).toBe(true)

        expect(await completeWake(child.id, child, episodeB!)).toBe(true)
        current = await Agent.mustFind(child.id)
        expect((current.metadata as Record<string, unknown>).wakeCompletionId).toBeUndefined()
        expect((current.metadata as Record<string, unknown>).wakeCompletionPending).toBeUndefined()
      } finally {
        setCompleteWakeBeforeClearHookForTest(undefined)
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('rejects direct execution admission once dormancy is pending', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ pendingDormancyAt: new Date() })

      await expect(agent.queueExecution({ message: 'late work' })).rejects.toMatchObject({
        code: 'AGENT_TARGET_UNAVAILABLE',
      })
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
    })

    it('does not wake a dormant agent for explicitly ineligible work', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'dormant', dormantAt: new Date() })

      await expect(
        agent.queueExecution({ message: 'housekeeping', metadata: { wakeEligible: false } })
      ).rejects.toMatchObject({ code: 'AGENT_TARGET_UNAVAILABLE' })

      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
    })

    it('does not let stale housekeeping callbacks wake or mutate a dormant episode', async () => {
      const warmup = await import('../services/sandbox/agent-warmup')
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const staleIdle = await Agent.mustFind(agent.id)
      await makeDormant(await Agent.mustFind(agent.id))
      const dormant = await Agent.mustFind(agent.id)
      const episodeId = (dormant.metadata as Record<string, unknown>).dormancyEpisodeId
      const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      const mint = spyOn(Agent.prototype, 'getOrCreateToken').mockResolvedValue('ficus_agent_test')

      try {
        await dormant.finishCompaction()
        await dormant.finishReset()
        await dormant.clearWaitingInput()
        await expect(staleIdle.startCompaction()).rejects.toThrow('lifecycle changed before compaction')
        await expect(staleIdle.startReset()).rejects.toThrow('lifecycle changed before reset')

        const current = await Agent.mustFind(agent.id)
        expect(current.status).toBe('dormant')
        expect((current.metadata as Record<string, unknown>).dormancyEpisodeId).toBe(episodeId)
        expect(ensure).not.toHaveBeenCalled()
        expect(mint).not.toHaveBeenCalled()
        expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
      } finally {
        ensure.mockRestore()
        mint.mockRestore()
      }
    })

    it('preserves a benign write across a concurrent live-to-live transition', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      setAgentUpdatePrewriteHookForTest(async () => {
        setAgentUpdatePrewriteHookForTest(undefined)
        await db.update(agents).set({ status: 'active' }).where(eq(agents.id, agent.id))
      })
      try {
        await agent.update({ name: 'Preserved rename' })
      } finally {
        setAgentUpdatePrewriteHookForTest(undefined)
      }

      expect(await Agent.mustFind(agent.id)).toMatchObject({
        status: 'active',
        metadata: expect.objectContaining({ name: 'Preserved rename' }),
      })
    })

    it('does not let a stale status update overwrite concurrent final termination', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const read = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      setAgentUpdatePrewriteHookForTest(async () => {
        read.resolve()
        await release.promise
      })
      try {
        const staleUpdate = agent.update({ status: 'idle' })
        await read.promise
        await db.update(agents).set({ status: 'terminated', terminatedAt: new Date() }).where(eq(agents.id, agent.id))
        release.resolve()
        await expect(staleUpdate).rejects.toThrow('lifecycle changed during update')
      } finally {
        setAgentUpdatePrewriteHookForTest(undefined)
      }
      expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
    })

    it('forbids reviving a finally terminated agent', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await seedAgentLifecycleForTest(agent, { status: 'terminated', terminatedAt: new Date() })

      await expect(agent.update({ status: 'idle', terminatedAt: null })).rejects.toThrow(
        'Final agent termination is irreversible'
      )
    })

    it('rejects queueing work for a terminated agent without creating rows', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await seedAgentLifecycleForTest(agent, { status: 'terminated', terminatedAt: new Date() })

      await expect(agent.queueExecution({ message: 'impossible' })).rejects.toMatchObject({
        name: 'AgentTerminatedError',
        code: 'AGENT_TERMINATED',
      })
      expect(await Execution.list({ agentId: agent.id })).toHaveLength(0)
      expect(await agent.listMessages()).toMatchObject({ messages: [] })
    })
  })

  describe('Agent.getSandboxId', () => {
    it('shares consultant runtimes per squad, including existing chats, without sharing cleanup ownership', async () => {
      const make = (id: string, squadId: string) => new Agent({ id, agentTypeId: 'consultant', squadId } as any)
      const first = make('first', 'squad-one')
      const second = make('second', 'squad-one')
      expect(await first.getSandboxId()).toBe('consultants_squad-one')
      expect(await second.getSandboxId()).toBe(await first.getSandboxId())
      expect(await make('third', 'squad-two').getSandboxId()).not.toBe(await first.getSandboxId())
      // Old per-agent storage can still be retired; the shared runtime cannot.
      expect(first.getPersonalSandboxIdForCleanup()).toBe('agent_first')
      expect(second.getPersonalSandboxIdForCleanup()).toBe('agent_second')
    })

    it('returns the per-user shared sandbox for system-manager agents', async () => {
      const agent = new Agent({
        id: 'agent-1',
        agentTypeId: 'system-manager',
        ownerUserId: 'user-1',
        squadId: null,
      } as any)
      expect(await agent.getSandboxId()).toBe('system_manager_user-1')
    })

    it('shares one sandbox across a user’s system-managers, isolated between users', async () => {
      const a = new Agent({ id: 'sm-a', agentTypeId: 'system-manager', ownerUserId: 'user-1', squadId: null } as any)
      const b = new Agent({ id: 'sm-b', agentTypeId: 'system-manager', ownerUserId: 'user-1', squadId: null } as any)
      const c = new Agent({ id: 'sm-c', agentTypeId: 'system-manager', ownerUserId: 'user-2', squadId: null } as any)
      expect(await a.getSandboxId()).toBe(await b.getSandboxId())
      expect(await a.getSandboxId()).not.toBe(await c.getSandboxId())
    })

    it('falls back to the per-agent box for a system-manager with no owner', async () => {
      const agent = new Agent({ id: 'agent-1', agentTypeId: 'system-manager', ownerUserId: null, squadId: null } as any)
      expect(await agent.getSandboxId()).toBe('agent_agent-1')
    })

    it('returns agent_<id> for consultant agents (not consultant_channel_<id>)', async () => {
      const agent = new Agent({ id: 'agent-1', agentTypeId: 'consultant', squadId: null } as any)
      expect(await agent.getSandboxId()).toBe('agent_agent-1')
    })

    it('returns agent_<id> for solo agents', async () => {
      const agent = new Agent({ id: 'agent-1', agentTypeId: testAgentTypeId, squadId: null } as any)
      expect(await agent.getSandboxId()).toBe('agent_agent-1')
    })

    it('returns parent sandbox id for non-squad subagents', async () => {
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const subagent = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
      expect(await subagent.getSandboxId()).toBe(parent.getAgentWorkspaceSandboxId())
    })

    it('fails closed for missing, terminated, cyclic, and cross-squad sandbox ancestry', async () => {
      const missing = new Agent({
        id: crypto.randomUUID(),
        agentTypeId: testAgentTypeId,
        squadId: null,
        parentAgentId: crypto.randomUUID(),
      } as any)
      await expect(missing.getSandboxId()).rejects.toThrow('ancestry')

      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
      await seedAgentLifecycleForTest(parent, { status: 'terminated', terminatedAt: new Date() })
      await expect(child.getSandboxId()).rejects.toThrow('ancestry')

      const liveParent = await Agent.create({ agentTypeId: testAgentTypeId })
      const staleChild = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: liveParent.id })
      await db
        .update(agents)
        .set({ status: 'terminated', terminatedAt: new Date() })
        .where(eq(agents.id, staleChild.id))
      await expect(staleChild.getSandboxId()).rejects.toThrow('ancestry')

      const squadA = await Squad.create({ name: `ancestry-a-${Date.now()}`, purpose: 'test' })
      const squadB = await Squad.create({ name: `ancestry-b-${Date.now()}`, purpose: 'test' })
      try {
        const crossParent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squadA.id })
        const crossChild = await Agent.create({
          agentTypeId: testAgentTypeId,
          squadId: squadB.id,
          parentAgentId: crossParent.id,
        })
        await expect(crossChild.getSandboxId()).rejects.toThrow('ancestry')

        const cycleA = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squadA.id })
        const cycleB = await Agent.create({
          agentTypeId: testAgentTypeId,
          squadId: squadA.id,
          parentAgentId: cycleA.id,
        })
        await db.update(agents).set({ parentAgentId: cycleB.id }).where(eq(agents.id, cycleA.id))
        await expect(cycleB.getSandboxId()).rejects.toThrow('ancestry')
      } finally {
        await db.delete(squads).where(inArray(squads.id, [squadA.id, squadB.id]))
      }
    })

    it('accepts dormant sandbox ancestry only after the agents are explicitly woken', async () => {
      const agentWarmup = await import('../services/sandbox/agent-warmup')
      const ensure = spyOn(agentWarmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
      try {
        const parent = await Agent.create({ agentTypeId: testAgentTypeId })
        const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
        await makeDormant(parent)
        await child.reload()

        await expect(child.getSandboxId()).rejects.toThrow('ancestry')
        await parent.queueExecution({ message: 'wake parent' })
        await child.queueExecution({ message: 'wake child' })
        await child.reload()

        expect(await child.getSandboxId()).toBe(parent.getAgentWorkspaceSandboxId())
      } finally {
        ensure.mockRestore()
      }
    })

    it('returns parent sandbox id (not squad_<id>) for squad subagents with parentAgentId set', async () => {
      const squad = await Squad.create({ name: `test-squad-${Date.now()}`, purpose: 'test' })
      try {
        const parent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
        const subagent = await Agent.create({
          agentTypeId: testAgentTypeId,
          squadId: squad.id,
          parentAgentId: parent.id,
        })
        expect(await subagent.getSandboxId()).toBe(parent.getAgentWorkspaceSandboxId())
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })
  })

  describe('Agent execution sandbox ids', () => {
    it('includes sorted private and squad boxes for squad-capable top-level runners', async () => {
      for (const agentTypeId of ['manager', testAgentTypeId, 'consultant']) {
        const agent = new Agent({ id: `agent-${agentTypeId}`, agentTypeId, squadId: 'squad-1' } as any)
        expect(await agent.getExecutionSandboxIds()).toEqual([
          agentTypeId === 'consultant' ? 'consultants_squad-1' : `agent_agent-${agentTypeId}`,
          'squad_squad-1',
        ])
      }
    })

    it('sorts the ids even when the private box sorts AFTER the squad box', async () => {
      // Every private-box id this can return today starts 'agent_', which sorts
      // before 'squad_' — so with real fixtures the sort is invisible and
      // deleting it fails nothing. Force the disagreement (the shape a
      // 'system_manager_…' private box, or any renamed prefix, would produce)
      // so the ordering contract is genuinely pinned rather than accidentally
      // satisfied by insertion order.
      //
      // Ordering matters because these ids become a lock acquisition order.
      // areBoxesMigratingLocked re-sorts defensively, so a regression here
      // would not deadlock today; this keeps the two halves from drifting.
      const agent = new Agent({ id: 'sort-probe', agentTypeId: 'manager', squadId: 'squad-1' } as any)
      agent.getSandboxId = async () => 'system_manager_owner'
      expect(await agent.getExecutionSandboxIds()).toEqual(['squad_squad-1', 'system_manager_owner'])

      // De-duplication survives the sort: a private box that IS the squad box
      // must yield one id, not a doubled lock target.
      const collapsed = new Agent({ id: 'dedupe-probe', agentTypeId: 'manager', squadId: 'squad-1' } as any)
      collapsed.getSandboxId = async () => 'squad_squad-1'
      expect(await collapsed.getExecutionSandboxIds()).toEqual(['squad_squad-1'])
    })

    it('includes the inherited private box and squad box for squad subagents', async () => {
      const squad = await Squad.create({ name: `execution-boxes-${Date.now()}`, purpose: 'test' })
      try {
        const parent = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id })
        const child = await Agent.create({ agentTypeId: testAgentTypeId, squadId: squad.id, parentAgentId: parent.id })
        expect(await child.getExecutionSandboxIds()).toEqual([parent.getAgentWorkspaceSandboxId(), `squad_${squad.id}`])
      } finally {
        await db.delete(squads).where(eq(squads.id, squad.id))
      }
    })

    it('keeps personal-only runners on their private box even when squadId is present', async () => {
      const systemManager = new Agent({
        id: 'sm',
        agentTypeId: 'system-manager',
        ownerUserId: 'owner',
        squadId: 'squad-1',
      } as any)
      const artifactBuilder = new Agent({
        id: 'ab',
        agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID,
        squadId: 'squad-1',
      } as any)
      expect(await systemManager.getExecutionSandboxIds()).toEqual(['system_manager_owner'])
      expect(await artifactBuilder.getExecutionSandboxIds()).toEqual(['agent_ab'])
    })
  })

  describe('Agent.runnerType', () => {
    it('returns squad-manager when squadId and agentTypeId is squad-manager', () => {
      const agent = new Agent({ squadId: 's1', agentTypeId: 'manager' } as any)
      expect(agent.runnerType).toBe('squad-manager')
    })

    it('returns squad-worker when squadId but agentTypeId is not squad-manager', () => {
      const agent = new Agent({ squadId: 's1', agentTypeId: 'some-worker' } as any)
      expect(agent.runnerType).toBe('squad-worker')
    })

    it('returns system-manager when agentTypeId is system-manager', () => {
      const agent = new Agent({ agentTypeId: 'system-manager' } as any)
      expect(agent.runnerType).toBe('system-manager')
    })

    it('returns artifact-builder for artifact builder agents without a squad', () => {
      const agent = new Agent({ agentTypeId: ARTIFACT_BUILDER_AGENT_TYPE_ID, squadId: null } as any)
      expect(agent.runnerType).toBe('artifact-builder')
    })

    it('errors when no squadId and agentTypeId is unexpected', () => {
      const agent = new Agent({ agentTypeId: 'unknown' } as any)
      expect(() => agent.runnerType).toThrow('Unexpected agent type: unknown')
    })
  })

  describe('Agent.queueExecution while compacting', () => {
    it('queues execution and persists pending human message (no throw)', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'compacting' })

      const image = await Image.create({
        content: { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
        agentId: agent.id,
      })
      const exec = await agent.queueExecution({
        message: 'hi',
        metadata: { source: 'inbox', inboxMessageIds: ['m1'] },
        imageIds: [image.id],
      })

      expect(exec.status).toBe('queued')
      const msgs = await agent.listMessages()
      const human = msgs.messages.find((m) => m.role === 'human' && m.pending)
      expect(human?.content).toBe('hi')
      expect(human?.metadata).toMatchObject({ source: 'inbox', imageIds: [image.id] })
      await Image.deleteMany([image.id])
    })

    it('Agent.sendMessage while compacting persists and returns queued', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'compacting' })

      const image = await Image.create({
        content: { type: 'image', data: Buffer.from('image').toString('base64'), mimeType: 'image/png' },
        agentId: agent.id,
      })
      const result = await agent.sendMessage('hello', { imageIds: [image.id] })
      expect(result).toEqual({ success: true, status: 'queued', queued: false })

      const active = await agent.getActiveExecution()
      expect(active?.status).toBe('queued')
      await Image.deleteMany([image.id])
    })

    it('second sendMessage while compacting does not create a duplicate execution', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'compacting' })

      await agent.sendMessage('one')
      await agent.sendMessage('two')

      const queued = await Execution.list({ agentId: agent.id, status: 'queued' })
      expect(queued).toHaveLength(1)

      const humans = (await agent.listMessages()).messages.filter((m) => m.role === 'human')
      expect(humans.map((m) => m.content)).toEqual(['one', 'two'])
    })
  })

  describe('transactional queued-message persistence', () => {
    it('queues a prompt through the shared record-message path exactly once', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const original = agent.recordMessageInTransaction.bind(agent)
      let sharedPathCalls = 0
      agent.recordMessageInTransaction = async (...args) => {
        sharedPathCalls++
        return original(...args)
      }

      await agent.queueExecution({ message: 'shared prompt' })

      expect(sharedPathCalls).toBe(1)
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(1)
    })

    it('sendMessage announces a new message, not an agent change', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const newMessage: unknown[] = []
      const updated: unknown[] = []
      const unsubNew = eventEmitter.on('agent.new-message', (event) => newMessage.push(event))
      const unsubUpdated = eventEmitter.on('agent.updated', (event) => updated.push(event))
      try {
        await agent.sendMessage('hello')
      } finally {
        unsubNew()
        unsubUpdated()
      }

      // This path deliberately does not touch the agents row, so calling it an
      // agent change made every client refetch that agent's whole query family
      // (and, on mobile, every agent's) for each message sent.
      expect(newMessage).toHaveLength(1)
      expect(newMessage[0]).toMatchObject({ agentId: agent.id })
      expect(updated).toHaveLength(0)
    })

    it('rolls back the shared message without emitting message.created', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const events: unknown[] = []
      const unsubscribe = eventEmitter.on('message.created', (event) => events.push(event))
      try {
        await expect(
          db.transaction(async (tx) => {
            await agent.recordMessageInTransaction(tx, { role: 'human', content: 'rollback' })
            throw new Error('rollback')
          })
        ).rejects.toThrow('rollback')
      } finally {
        unsubscribe()
      }

      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(0)
      expect(events).toHaveLength(0)
    })

    it('emits the queued message only after its transaction commits', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const events: unknown[] = []
      const unsubscribe = eventEmitter.on('message.created', (event) => events.push(event))
      const afterCommit: Array<() => void> = []
      try {
        await db.transaction(async (tx) => {
          await agent.queueExecutionInTransaction(tx, { message: 'commit first' }, afterCommit)
          expect(events).toHaveLength(0)
        })
        expect(events).toHaveLength(0)
        for (const emit of afterCommit) emit()
        expect(events).toHaveLength(1)
      } finally {
        unsubscribe()
      }
    })

    // Pins the per-agent advisory lock itself rather than the transaction plumbing:
    // delete `pg_advisory_xact_lock` from queueExecutionInTransaction and this fails
    // with one execution per pooled connection instead of one execution total.
    it('serializes concurrent queueExecution: exactly one execution wins', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      // postgres.js opens pooled connections lazily, and a transaction owns its
      // connection for its whole life — so on a COLD pool all eight callers queue
      // onto the single warm connection and run one after another, which an
      // unlocked check-then-insert survives. Warm the pool first, and assert the
      // warm-up worked, so this test can actually observe the race it guards.
      const warmed = await Promise.all(
        Array.from({ length: 8 }, () => db.execute(sql`select pg_sleep(0.05), pg_backend_pid() as pid`))
      )
      const backends = new Set(warmed.map((rows) => (rows as unknown as Array<{ pid: number }>)[0]?.pid))
      expect(backends.size).toBeGreaterThan(1)

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => agent.queueExecution({ message: `m${i}` }))
      )

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7)
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(1)
      // The losers' human messages roll back with their transactions — no orphan pending rows.
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(1)
    })

    // agent.new-message is what invalidates the squad agent-list queries in web
    // and mobile (those lists render lastMessageAt/lastMessagePreview), so
    // dropping it silently freezes them. It replaced agent.updated here: the
    // agents row is untouched on this path, and calling it an agent change made
    // every message refetch the agent's whole query family.
    it('emits exactly one agent.new-message for a queued message, only after commit', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const events: unknown[] = []
      const agentUpdated: unknown[] = []
      const unsubscribe = eventEmitter.on('agent.new-message', (event) => events.push(event))
      const unsubscribeUpdated = eventEmitter.on('agent.updated', (event) => agentUpdated.push(event))
      const afterCommit: Array<() => void> = []
      try {
        await db.transaction(async (tx) => {
          await agent.queueExecutionInTransaction(tx, { message: 'refresh the list' }, afterCommit)
          expect(events).toHaveLength(0)
        })
        expect(events).toHaveLength(0)
        for (const emit of afterCommit) emit()
        expect(events).toEqual([{ agentId: agent.id, squadId: agent.squadId }])
        expect(agentUpdated).toHaveLength(0)
      } finally {
        unsubscribe()
        unsubscribeUpdated()
      }
    })

    it('keeps public recordMessage immediate event behavior', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const events: unknown[] = []
      const unsubscribe = eventEmitter.on('message.created', (event) => events.push(event))
      try {
        const message = await agent.recordMessage({ role: 'assistant', content: 'ordinary caller' })
        expect(events).toEqual([{ messageId: message.id, agentId: agent.id }])
      } finally {
        unsubscribe()
      }
    })
  })

  describe('Agent.startCompaction', () => {
    it('throws when agent is not idle', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'active' })

      await expect(agent.startCompaction()).rejects.toThrow('Agent is not idle')
    })

    it('throws when agent has active execution', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecution({ message: 'test' })

      await expect(agent.startCompaction()).rejects.toThrow('Agent has active execution')
    })

    it('sets status to compacting when idle with no execution', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      await agent.startCompaction()

      expect(agent.status).toBe('compacting')
    })
  })

  describe('Agent.finishCompaction', () => {
    it('sets status to idle', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'compacting' })

      await agent.finishCompaction()

      expect(agent.status).toBe('idle')
    })

    it('re-emits execution.queued for any queued execution belonging to the agent', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({ status: 'compacting' })
      const exec = await agent.queueExecution({ message: 'pending' })

      const events: Array<{ executionId: string; status: string }> = []
      const handler = (payload: { executionId: string; status: string }) => events.push(payload)
      const off = eventEmitter.on('execution.queued', handler)
      try {
        await agent.finishCompaction()
      } finally {
        off()
      }

      expect(agent.status).toBe('idle')
      expect(events.some((e) => e.executionId === exec.id)).toBe(true)
    })

    it('retries undelivered inbox messages after compaction finishes', async () => {
      const recipient = await Agent.create({ agentTypeId: testAgentTypeId })
      const msg = await InboxMessage.send({
        recipientType: 'agent',
        recipientId: recipient.id,
        senderType: 'system',
        content: 'hello',
      })
      await db.update(inbox).set({ deliveredAt: null }).where(eq(inbox.id, msg.id))

      await recipient.update({ status: 'compacting' })
      await recipient.finishCompaction()

      const undelivered = await InboxMessage.listUndeliveredUnread('agent', recipient.id)
      expect(undelivered).toHaveLength(0)
    })
  })

  describe('Agent.clearWaitingInput', () => {
    it('clears questionData and sets status to idle', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.update({
        status: 'waiting-input',
        questionData: { questions: [{ id: 'q1', type: 'text', question: 'Test?' }] },
      })

      await agent.clearWaitingInput()

      expect(agent.status).toBe('idle')
      expect(agent.questionData).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  describe('agent.recordMessage', () => {
    it('adds message to agent', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      const message = await agent.recordMessage({
        role: 'human',
        content: 'Hello',
      })

      expect(message.id).toBeDefined()
      expect(message.agentId).toBe(agent.id)
      expect(message.role).toBe('human')
      expect(message.content).toBe('Hello')

      // cleanup
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('defaults pending to false', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const msg = await agent.recordMessage({ role: 'human', content: 'Hello' })
      expect(msg.pending).toBe(false)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('respects pending flag', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const msg = await agent.recordMessage({ role: 'human', content: 'Hello', pending: true })
      expect(msg.pending).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })
  })

  describe('agent.listMessages', () => {
    it('returns messages in chronological order', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'First' })
      await agent.recordMessage({ role: 'assistant', content: 'Second' })
      await agent.recordMessage({ role: 'human', content: 'Third' })

      const result = await agent.listMessages()

      expect(result.messages[0].content).toBe('First')
      expect(result.messages[1].content).toBe('Second')
      expect(result.messages[2].content).toBe('Third')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('returns pagination metadata', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'First' })
      await agent.recordMessage({ role: 'assistant', content: 'Second' })

      const result = await agent.listMessages()

      expect(result.messages.length).toBe(2)
      expect(result.pagination.hasMore).toBe(false)
      expect(result.pagination.totalCount).toBe(2)
      expect(result.pagination.oldestId).toBe(result.messages[0].id)
      expect(result.pagination.newestId).toBe(result.messages[1].id)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('supports limit parameter', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'One' })
      await agent.recordMessage({ role: 'assistant', content: 'Two' })
      await agent.recordMessage({ role: 'human', content: 'Three' })

      const result = await agent.listMessages({ limit: 2 })

      expect(result.messages.length).toBe(2)
      expect(result.messages[0].content).toBe('Two')
      expect(result.messages[1].content).toBe('Three')
      expect(result.pagination.hasMore).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('supports cursor-based pagination with beforeId', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'One' })
      await new Promise((r) => setTimeout(r, 50))
      await agent.recordMessage({ role: 'assistant', content: 'Two' })
      await new Promise((r) => setTimeout(r, 50))
      const msg3 = await agent.recordMessage({ role: 'human', content: 'Three' })

      const result = await agent.listMessages({ beforeId: msg3.id })

      expect(result.messages.length).toBe(2)
      expect(result.messages[0].content).toBe('One')
      expect(result.messages[1].content).toBe('Two')
      expect(result.pagination.hasMore).toBe(false)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('paginates tied rows by frozen enqueue order after deleting a cursor row', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const tiedAt = new Date('2026-08-10T12:00:00.000Z')
      const ids = [
        'ffffffff-ffff-4fff-8fff-fffffffffff1',
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
        '11111111-1111-4111-8111-111111111113',
        '00000000-0000-4000-8000-000000000004',
      ]
      const inserted = []
      for (const [index, id] of ids.entries()) {
        const [row] = await db
          .insert(messages)
          .values({ id, agentId: agent.id, role: 'human', content: String(index), createdAt: tiedAt })
          .returning()
        inserted.push(row!)
      }
      expect(new Set(inserted.map((row) => row.createdAt.toISOString()))).toEqual(new Set([tiedAt.toISOString()]))
      expect(ids).not.toEqual([...ids].sort())
      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 4; page += 1) {
        const result = await agent.listMessages({ limit: 1, cursor })
        expect(result.messages).toHaveLength(1)
        seen.unshift(result.messages[0]!.id)
        cursor = result.pagination.nextCursor
        if (page === 0) await db.delete(messages).where(eq(messages.id, result.messages[0]!.id))
      }
      expect(seen).toEqual(ids)
      expect(new Set(seen).size).toBe(4)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('filters by role', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Question 1' })
      await agent.recordMessage({ role: 'assistant', content: 'Answer 1' })
      await agent.recordMessage({ role: 'human', content: 'Question 2' })

      const result = await agent.listMessages({ role: 'human' })
      expect(result.messages.length).toBe(2)
      expect(result.messages.every((m) => m.role === 'human')).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('searches message content case-insensitively', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Tell me about databases' })
      await agent.recordMessage({ role: 'assistant', content: 'Databases are great' })
      await agent.recordMessage({ role: 'human', content: 'What about caching?' })

      const result = await agent.listMessages({ search: 'database' })
      expect(result.messages.length).toBe(2)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('combines search with role filter', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Tell me about databases' })
      await agent.recordMessage({ role: 'assistant', content: 'Databases are storage systems' })

      const result = await agent.listMessages({ search: 'database', role: 'assistant' })
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].role).toBe('assistant')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('filters by after timestamp', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Old message' })
      const cutoff = '2026-01-02T00:00:00.000Z'
      await agent.recordMessage({ role: 'assistant', content: 'New message' })
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
        .where(and(eq(messages.agentId, agent.id), eq(messages.role, 'human')))
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-03T00:00:00Z') })
        .where(and(eq(messages.agentId, agent.id), eq(messages.role, 'assistant')))

      const result = await agent.listMessages({ after: cutoff })
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].content).toBe('New message')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('filters by before timestamp', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Old message' })
      const cutoff = '2026-01-02T00:00:00.000Z'
      await agent.recordMessage({ role: 'assistant', content: 'New message' })
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
        .where(and(eq(messages.agentId, agent.id), eq(messages.role, 'human')))
      await db
        .update(messages)
        .set({ createdAt: new Date('2026-01-03T00:00:00Z') })
        .where(and(eq(messages.agentId, agent.id), eq(messages.role, 'assistant')))

      const result = await agent.listMessages({ before: cutoff })
      expect(result.messages.length).toBe(1)
      expect(result.messages[0].content).toBe('Old message')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })
  })

  describe('Agent.findMessage', () => {
    it('returns message by id', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const created = await agent.recordMessage({ role: 'human', content: 'Test message' })

      const found = await Agent.findMessage(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.content).toBe('Test message')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('returns null for non-existent id', async () => {
      const found = await Agent.findMessage('00000000-0000-0000-0000-000000000000')
      expect(found).toBeNull()
    })
  })

  describe('pending messages', () => {
    it('tryConfirmPendingMessage confirms oldest pending human message', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const first = await agent.recordMessage({ role: 'human', content: 'First', pending: true })
      await agent.recordMessage({ role: 'human', content: 'Second', pending: true })
      await agent.claimPendingInterventionForSessionDelivery(first.id)

      const confirmed = await agent.tryConfirmPendingMessage()
      expect(confirmed).not.toBeNull()
      expect(confirmed!.content).toBe('First')
      expect(confirmed!.pending).toBe(false)

      const result = await agent.listMessages()
      const second = result.messages.find((m) => m.content === 'Second')
      expect(second!.pending).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage skips non-pending and assistant messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Confirmed', pending: false })
      await agent.recordMessage({ role: 'assistant', content: 'Response', pending: true })
      const pending = await agent.recordMessage({ role: 'human', content: 'Pending', pending: true })
      await agent.claimPendingInterventionForSessionDelivery(pending.id)

      const confirmed = await agent.tryConfirmPendingMessage()
      expect(confirmed!.content).toBe('Pending')
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage returns null when no pending messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Done', pending: false })

      const confirmed = await agent.tryConfirmPendingMessage()
      expect(confirmed).toBeNull()
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage does not let a neutral prompt confirm an unclaimed pending row', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({ role: 'human', content: 'hello', pending: true })

      expect(await agent.tryConfirmPendingMessage('Continue.')).toBeNull()
      expect((await Agent.findMessage(pending.id))?.pending).toBe(true)

      await agent.claimPendingInterventionForSessionDelivery(pending.id)
      const confirmed = await agent.tryConfirmPendingMessage('hello')
      expect(confirmed?.id).toBe(pending.id)
      expect((await Agent.findMessage(pending.id))?.pending).toBe(false)

      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage without content follows the drain ordering for claimed rows', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const imageOnly = await agent.recordMessage({
        role: 'human',
        content: '',
        metadata: { imageIds: ['00000000-0000-0000-0000-000000000101'] },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'later follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await agent.claimPendingInterventionForSessionDelivery(imageOnly.id)
      await agent.claimPendingInterventionForSessionDelivery(followUp.id)

      expect((await agent.tryConfirmPendingMessage())?.id).toBe(imageOnly.id)
      expect((await Agent.findMessage(followUp.id))?.pending).toBe(true)
      expect((await agent.tryConfirmPendingMessage())?.id).toBe(followUp.id)

      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('confirmAllPendingMessages skips follow-up messages that are not stranded-retried', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const steerMsg = await agent.recordMessage({
        role: 'human',
        content: 'steer content',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      const followUpMsg = await agent.recordMessage({
        role: 'human',
        content: 'follow-up content',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })

      const count = await agent.confirmAllPendingMessages()

      expect(count).toBe(1)
      expect((await Agent.findMessage(steerMsg.id))?.pending).toBe(false)
      expect((await Agent.findMessage(followUpMsg.id))?.pending).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('confirmAllPendingMessages confirms stranded-retried follow-up messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUpMsg = await agent.recordMessage({
        role: 'human',
        content: 'stranded follow-up',
        metadata: { deliveryMode: 'follow-up', strandedPendingRetryCount: 1 },
        pending: true,
      })

      const count = await agent.confirmAllPendingMessages()

      expect(count).toBe(1)
      expect((await Agent.findMessage(followUpMsg.id))?.pending).toBe(false)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('quick-succession steer + follow-up keeps follow-up pending after confirmAllPendingMessages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const steerMsg = await agent.recordMessage({
        role: 'human',
        content: 'Interrupt: change priority',
        metadata: { deliveryMode: 'steer', source: 'inbox' },
        pending: true,
      })
      const followUpMsg = await agent.recordMessage({
        role: 'human',
        content: 'Follow-up: after you finish',
        metadata: { deliveryMode: 'follow-up', source: 'inbox' },
        pending: true,
      })

      const confirmedCount = await agent.confirmAllPendingMessages()

      expect(confirmedCount).toBe(1)
      expect((await Agent.findMessage(steerMsg.id))?.pending).toBe(false)
      expect((await Agent.findMessage(followUpMsg.id))?.pending).toBe(true)

      await agent.claimPendingInterventionForSessionDelivery(followUpMsg.id)
      await agent.tryConfirmPendingMessage('Follow-up: after you finish')
      expect((await Agent.findMessage(followUpMsg.id))?.pending).toBe(false)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage prioritizes steer before older follow-up and then FIFO within mode', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUpOne = await agent.recordMessage({
        role: 'human',
        content: 'Later 1',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const steerOne = await agent.recordMessage({
        role: 'human',
        content: 'Interrupt 1',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const followUpTwo = await agent.recordMessage({
        role: 'human',
        content: 'Later 2',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const steerTwo = await agent.recordMessage({
        role: 'human',
        content: 'Interrupt 2',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      for (const message of [followUpOne, steerOne, followUpTwo, steerTwo]) {
        await agent.claimPendingInterventionForSessionDelivery(message.id)
      }

      expect((await agent.tryConfirmPendingMessage())?.id).toBe(steerOne.id)
      expect((await agent.tryConfirmPendingMessage())?.id).toBe(steerTwo.id)
      expect((await agent.tryConfirmPendingMessage())?.id).toBe(followUpOne.id)
      expect((await agent.tryConfirmPendingMessage())?.id).toBe(followUpTwo.id)

      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('session-time confirmations clear batched steers together and leave follow-ups pending until their own turn', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const firstFollowUp = await agent.recordMessage({
        role: 'human',
        content: 'queued follow-up one',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const firstSteer = await agent.recordMessage({
        role: 'human',
        content: 'batched steer one',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const secondFollowUp = await agent.recordMessage({
        role: 'human',
        content: 'queued follow-up two',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const secondSteer = await agent.recordMessage({
        role: 'human',
        content: 'batched steer two',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      for (const message of [firstFollowUp, firstSteer, secondFollowUp, secondSteer]) {
        await agent.claimPendingInterventionForSessionDelivery(message.id)
      }

      // These calls model AgentRunner handling Pi session_message_persisted
      // user events: steeringMode=all may persist multiple steers in one active
      // session, while followUpMode=one-at-a-time persists one follow-up turn at
      // a time. Each persisted user event should confirm exactly the row Pi just
      // processed and leave later follow-ups pending.
      expect((await agent.tryConfirmPendingMessage('batched steer one'))?.id).toBe(firstSteer.id)
      expect((await agent.tryConfirmPendingMessage('batched steer two'))?.id).toBe(secondSteer.id)
      expect((await Agent.findMessage(firstFollowUp.id))?.pending).toBe(true)
      expect((await Agent.findMessage(secondFollowUp.id))?.pending).toBe(true)

      expect((await agent.tryConfirmPendingMessage('queued follow-up one'))?.id).toBe(firstFollowUp.id)
      expect((await Agent.findMessage(secondFollowUp.id))?.pending).toBe(true)

      expect((await agent.tryConfirmPendingMessage('queued follow-up two'))?.id).toBe(secondFollowUp.id)
      expect((await agent.listPendingHumanMessages()).map((message) => message.id)).toEqual([])

      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('tryConfirmPendingMessage matches claimed exact content and only falls back among claimed rows', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'matched follow-up',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      const steer = await agent.recordMessage({
        role: 'human',
        content: 'different steer',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      await agent.claimPendingInterventionForSessionDelivery(followUp.id)
      await agent.claimPendingInterventionForSessionDelivery(steer.id)

      expect((await agent.tryConfirmPendingMessage('matched follow-up'))?.id).toBe(followUp.id)
      expect((await Agent.findMessage(steer.id))?.pending).toBe(true)
      expect(await agent.tryConfirmPendingMessage('missing content')).toBeNull()
      expect((await agent.tryConfirmPendingMessage())?.id).toBe(steer.id)

      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('confirmPendingMessage confirms the requested pending intervention and leaves older follow-up pending', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'same later',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      await new Promise((r) => setTimeout(r, 10))
      const steer = await agent.recordMessage({
        role: 'human',
        content: 'same later',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      const confirmed = await agent.confirmPendingMessage(steer.id)

      expect(confirmed?.id).toBe(steer.id)
      expect(confirmed?.pending).toBe(false)

      const followUpAfter = await Agent.findMessage(followUp.id)
      expect(followUpAfter?.pending).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('confirmPendingMessage returns null for a non-pending or different-agent message', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const other = await Agent.create({ agentTypeId: testAgentTypeId })
      const otherPending = await other.recordMessage({ role: 'human', content: 'other', pending: true })
      const confirmed = await agent.confirmPendingMessage(otherPending.id)
      expect(confirmed).toBeNull()

      const notPending = await agent.recordMessage({ role: 'human', content: 'done', pending: false })
      const notPendingConfirmed = await agent.confirmPendingMessage(notPending.id)
      expect(notPendingConfirmed).toBeNull()

      await db.delete(messages).where(eq(messages.agentId, agent.id))
      await db.delete(messages).where(eq(messages.agentId, other.id))
    })

    it('active confirmation keeps older follow-up pending when newer steer is processed first', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const followUp = await agent.recordMessage({
        role: 'human',
        content: 'Later',
        metadata: { deliveryMode: 'follow-up' },
        pending: true,
      })
      const steer = await agent.recordMessage({
        role: 'human',
        content: 'Interrupt',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })

      await agent.claimPendingInterventionForSessionDelivery(followUp.id)
      await agent.claimPendingInterventionForSessionDelivery(steer.id)

      const confirmed = await agent.tryConfirmPendingMessage()

      expect(confirmed?.id).toBe(steer.id)
      expect((await Agent.findMessage(steer.id))?.pending).toBe(false)
      expect((await Agent.findMessage(followUp.id))?.pending).toBe(true)

      await agent.tryConfirmPendingMessage()
      expect((await Agent.findMessage(followUp.id))?.pending).toBe(false)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('confirmPendingMessage uses the database clock and preserves immutable creation time under host skew', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'steer me',
        metadata: { deliveryMode: 'steer' },
        pending: true,
      })
      expect(pending.pending).toBe(true)
      expect(pending.metadata?.consumedAt).toBeUndefined()
      const [clockPremise] = await db.execute<{ sampledAt: string }>(sql`SELECT clock_timestamp() AS "sampledAt"`)

      setSystemTime(new Date('2000-01-01T00:00:00.000Z'))
      try {
        const confirmed = await agent.confirmPendingMessage(pending.id)
        const readBack = await Agent.findMessage(pending.id)

        expect(confirmed?.id).toBe(pending.id)
        expect(confirmed?.pending).toBe(false)
        expect(confirmed?.createdAt.toISOString()).toBe(pending.createdAt.toISOString())
        const consumedAt = new Date(confirmed!.metadata!.consumedAt!).getTime()
        expect(consumedAt).toBeGreaterThanOrEqual(pending.createdAt.getTime())
        expect(consumedAt).toBeGreaterThanOrEqual(new Date(clockPremise.sampledAt).getTime())
        expect(readBack?.metadata?.consumedAt).toBe(confirmed?.metadata?.consumedAt)
        expect(readBack?.createdAt.toISOString()).toBe(pending.createdAt.toISOString())
      } finally {
        setSystemTime()
      }
    })

    it('confirmPendingMessage atomically allows only one concurrent confirmation', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({ role: 'human', content: 'once', pending: true })

      const results = await Promise.all(Array.from({ length: 8 }, () => agent.confirmPendingMessage(pending.id)))

      expect(results.filter((result) => result?.id === pending.id)).toHaveLength(1)
      expect(results.filter((result) => result === null)).toHaveLength(7)
      expect((await Agent.findMessage(pending.id))?.pending).toBe(false)
    })

    it('confirmPendingMessage uses statement time rather than a stale transaction clock snapshot', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })

      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT CURRENT_TIMESTAMP`)
        const pending = await agent.recordMessage({ role: 'human', content: 'same tick', pending: true })
        const confirmed = await confirmPendingMessage(agent.id, pending.id, tx)

        expect(confirmed?.id).toBe(pending.id)
        expect(new Date(confirmed!.metadata!.consumedAt!).getTime()).toBeGreaterThanOrEqual(pending.createdAt.getTime())
      })
    })

    it('confirmPendingMessage rolls back the pending transition with its caller transaction', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({ role: 'human', content: 'rollback', pending: true })
      const rollback = new Error('force rollback')

      await expect(
        db.transaction(async (tx) => {
          const confirmed = await confirmPendingMessage(agent.id, pending.id, tx)
          expect(confirmed?.id).toBe(pending.id)
          throw rollback
        })
      ).rejects.toBe(rollback)

      const readBack = await Agent.findMessage(pending.id)
      expect(readBack?.pending).toBe(true)
      expect(readBack?.metadata?.consumedAt).toBeUndefined()
    })

    it('confirmPendingMessage atomically binds the response group identity', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const pending = await agent.recordMessage({
        role: 'human',
        content: 'response group',
        metadata: { clientId: 'client-1' },
        pending: true,
      })
      const events: Array<{ messageId: string; agentId: string; executionId?: string; streamGroupId?: string }> = []
      const unsubscribe = eventEmitter.on('message.updated', (event) => events.push(event))

      try {
        const confirmed = await agent.confirmPendingMessage(pending.id, {
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        })

        expect(confirmed?.metadata).toMatchObject({
          clientId: 'client-1',
          consumedAt: expect.any(String),
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        })
        expect(events).toContainEqual({
          messageId: pending.id,
          agentId: agent.id,
          executionId: 'execution-1',
          streamGroupId: 'group-1',
        })
      } finally {
        unsubscribe()
      }
    })

    it('confirmPendingMessage publishes message.updated for standalone confirmations but not caller transactions', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const events: { messageId: string }[] = []
      const unsubscribe = eventEmitter.on('message.updated', (event) => events.push(event))

      try {
        // A caller transaction can still roll back, leaving the row pending —
        // publishing from inside it would announce a transition that never
        // happened, so the caller owns publishing after commit instead.
        const rolledBack = await agent.recordMessage({ role: 'human', content: 'tx rollback', pending: true })
        const rollback = new Error('force rollback')
        await expect(
          db.transaction(async (tx) => {
            expect((await confirmPendingMessage(agent.id, rolledBack.id, tx))?.id).toBe(rolledBack.id)
            throw rollback
          })
        ).rejects.toBe(rollback)
        expect(events.filter((event) => event.messageId === rolledBack.id)).toHaveLength(0)

        // The standalone path commits on its own, so it must still publish.
        const standalone = await agent.recordMessage({ role: 'human', content: 'standalone', pending: true })
        expect((await agent.confirmPendingMessage(standalone.id))?.id).toBe(standalone.id)
        expect(events.filter((event) => event.messageId === standalone.id)).toHaveLength(1)
      } finally {
        unsubscribe()
      }
    })

    it('deletePendingMessages removes all pending human messages', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Pending 1', pending: true })
      await agent.recordMessage({ role: 'human', content: 'Pending 2', pending: true })
      await agent.recordMessage({ role: 'human', content: 'Confirmed', pending: false })
      await agent.recordMessage({ role: 'assistant', content: 'Response' })

      const deleted = await agent.deletePendingMessages()
      expect(deleted).toBe(2)

      const result = await agent.listMessages()
      expect(result.messages.length).toBe(2)
      expect(result.messages.some((m) => m.content === 'Confirmed')).toBe(true)
      expect(result.messages.some((m) => m.content === 'Response')).toBe(true)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('deletePendingMessages returns 0 when none pending', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'Done', pending: false })

      const deleted = await agent.deletePendingMessages()
      expect(deleted).toBe(0)
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('clearQueue reports FAILURE when a running execution never acks, but still deletes the DB rows', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'queued steer', pending: true })
      const execution = await agent.queueExecution({ message: 'running turn' })
      await execution.start()

      // No ack means no worker cleared the in-memory SDK queue, and the API
      // cannot reach it. This previously resolved `true`, so the UI reported a
      // successful clear while the agent went on to answer every message the
      // user thought they had cleared.
      const result = await agent.clearQueue({ ackTimeoutMs: 20 })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('ack_timeout')
      expect(result.cleared).toBe(0)

      // The DB cleanup is still best-effort: fewer messages survive to be
      // re-delivered, even though the queue cannot be declared clear. (The
      // count includes the queued execution's own message, so assert it did
      // work rather than pinning an exact number.)
      expect(result.deleted).toBeGreaterThanOrEqual(1)
      const remainingPending = (await agent.listMessages()).messages.filter((message) => message.pending)
      expect(remainingPending).toEqual([])
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('clearQueue reports success without an ack when there is no running execution', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.recordMessage({ role: 'human', content: 'queued steer', pending: true })

      // No running execution means no SDK queue exists, so the DB rows ARE the
      // whole queue and deleting them genuinely clears it.
      const result = await agent.clearQueue({ ackTimeoutMs: 20 })
      expect(result).toMatchObject({ ok: true, code: 'no_active_execution', deleted: 1 })
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })
  })

  describe('parentAgentId subagent behavior', () => {
    it('persists parentAgentId through create/find and exposes it in JSON', async () => {
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })

      expect(child.parentAgentId).toBe(parent.id)
      expect(child.toJson().parentAgentId).toBe(parent.id)

      const reloaded = await Agent.mustFind(child.id)
      expect(reloaded.parentAgentId).toBe(parent.id)
    })

    it('routes parentAgentId agents to subagent runner before squad worker', () => {
      const child = new Agent({
        id: 'sub-1',
        agentTypeId: 'subagent',
        squadId: 'squad-1',
        parentAgentId: 'parent-1',
      } as any)
      expect(child.runnerType).toBe('subagent')
    })

    it('resolves a null-squad subagent sandbox through its parent', async () => {
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id, squadId: null })
      expect(await child.getSandboxId()).toBe(await parent.getSandboxId())
      expect(await child.getSandboxId()).not.toBe(child.getAgentWorkspaceSandboxId())
    })

    it('can list top-level agents and fetch a parent children explicitly', async () => {
      const parent = await Agent.create({ agentTypeId: testAgentTypeId })
      const child = await Agent.create({ agentTypeId: testAgentTypeId, parentAgentId: parent.id })
      const topLevel = await Agent.list({ topLevelOnly: true, agentTypeId: testAgentTypeId })
      expect(topLevel.map((a) => a.id)).toContain(parent.id)
      expect(topLevel.map((a) => a.id)).not.toContain(child.id)
      const children = await Agent.list({ parentAgentId: parent.id })
      expect(children.map((a) => a.id)).toEqual([child.id])
    })
  })

  describe('consultant runner routing', () => {
    it('routes a squad consultant to the squad-manager runner', async () => {
      const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'test' })
      const consultant = await Agent.create({ agentTypeId: 'consultant', squadId: squad.id })
      expect(consultant.runnerType).toBe('squad-manager')
      // cleanup
      await db.delete(agents).where(eq(agents.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
    })
  })

  describe('clientId idempotency', () => {
    it('queueExecution stores clientId in metadata and dedups a retry by clientId', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecution({ message: 'hi', metadata: { clientId: 'c-1' } })

      const echoed = await agent.findHumanMessageByClientId('c-1')
      expect(echoed?.metadata?.clientId).toBe('c-1')

      // A retry with the same clientId must not create a duplicate human row.
      const before = await agent.listMessages()
      await agent.queueExecutionIdempotent({ message: 'hi', metadata: { clientId: 'c-1' } })
      const after = await agent.listMessages()
      expect(after.messages.length).toBe(before.messages.length)

      await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })

    it('concurrent identical initial sends adopt one exact execution and message', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          agent.queueExecutionIdempotent({ message: 'same', metadata: { clientId: 'concurrent-1' } })
        )
      )
      expect(new Set(results.map((result) => result.id)).size).toBe(1)
      expect((await agent.listMessages()).messages.filter((message) => message.role === 'human')).toHaveLength(1)
    })

    it('rejects the same idempotency key with a conflicting payload', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecutionIdempotent({ message: 'first', metadata: { clientId: 'conflict-1' } })
      await expect(
        agent.queueExecutionIdempotent({ message: 'different', metadata: { clientId: 'conflict-1' } })
      ).rejects.toThrow('different payload')
    })

    it('concurrent identical interventions persist one pending human row', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecution({ message: 'initial' })
      await Promise.all(
        Array.from({ length: 8 }, () =>
          agent.sendMessage('intervene', { metadata: { clientId: 'intervention-concurrent' } })
        )
      )
      const matching = (await agent.listMessages()).messages.filter(
        (message) => message.metadata?.clientId === 'intervention-concurrent'
      )
      expect(matching).toHaveLength(1)
    })

    it('rejects intervention retries when image identity changes', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecution({ message: 'initial' })
      const firstImage = await Image.create({
        content: { type: 'image', data: Buffer.from('first').toString('base64'), mimeType: 'image/png' },
        agentId: agent.id,
      })
      const secondImage = await Image.create({
        content: { type: 'image', data: Buffer.from('second').toString('base64'), mimeType: 'image/png' },
        agentId: agent.id,
      })
      await agent.sendMessage('intervene', {
        imageIds: [firstImage.id],
        metadata: { clientId: 'intervention-image-conflict' },
      })
      await expect(
        agent.sendMessage('intervene', {
          imageIds: [secondImage.id],
          metadata: { clientId: 'intervention-image-conflict' },
        })
      ).rejects.toThrow('different payload')
      await Image.deleteMany([firstImage.id, secondImage.id])
    })

    it('rejects intervention retries when delivery mode changes', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.queueExecution({ message: 'initial' })
      await agent.sendMessage('intervene', {
        deliveryMode: 'steer',
        metadata: { clientId: 'intervention-mode-conflict' },
      })
      await expect(
        agent.sendMessage('intervene', {
          deliveryMode: 'follow-up',
          metadata: { clientId: 'intervention-mode-conflict' },
        })
      ).rejects.toThrow('different payload')
    })

    it('adopts the receipt-bound historical execution after a newer execution starts', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const first = await agent.queueExecution({ message: 'initial' })
      await agent.sendMessage('intervene', { metadata: { clientId: 'intervention-turnover' } })
      await first.transitionTo({ kind: 'completed' })
      const newer = await agent.queueExecution({ message: 'newer' })

      const retry = await agent.sendMessage('intervene', { metadata: { clientId: 'intervention-turnover' } })

      expect(retry.status).toBe('completed')
      expect(newer.id).not.toBe(first.id)
    })

    it('sendMessage dedups a retry carrying an already-seen clientId (no second human row)', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      await agent.sendMessage('hi', { metadata: { clientId: 'c-send-1' } })
      const before = (await agent.listMessages()).messages.filter((m) => m.role === 'human')
      await agent.sendMessage('hi', { metadata: { clientId: 'c-send-1' } }) // retry, same clientId
      const after = (await agent.listMessages()).messages.filter((m) => m.role === 'human')
      expect(after.length).toBe(before.length)
      await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
      await db.delete(messages).where(eq(messages.agentId, agent.id))
    })
  })

  it('holds the shared agent advisory lock for a no-clientId send', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    let competingLock: boolean | undefined
    setSendMessageLockedHookForTests(async (_tx, agentId) => {
      const [probe] = (await db.execute(
        sql`select pg_try_advisory_xact_lock(${AGENT_QUEUE_LOCK_NAMESPACE}, hashtext(${agentId})) as locked`
      )) as unknown as Array<{ locked: boolean }>
      competingLock = probe?.locked
    })
    try {
      await agent.sendMessage('ordinary no-client-id send')
    } finally {
      setSendMessageLockedHookForTests()
    }
    expect(competingLock).toBe(false)
  })

  it('atomically supersedes waiting input before a racing automatic queue', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    const original = await agent.queueExecution({ message: 'waiting turn' })
    await agent.update({ status: 'waiting-input', questionData: { questions: [] } })
    let entered!: () => void
    const locked = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    setSendMessageLockedHookForTests(async () => {
      entered()
      await gate
    })
    try {
      const manual = agent.sendMessage('manual answer')
      await locked
      const automatic = agent.queueExecution({ message: 'automatic collision' })
      release()
      const [manualResult, automaticResult] = await Promise.allSettled([manual, automatic])
      expect(manualResult.status).toBe('fulfilled')
      expect(automaticResult.status).toBe('rejected')
    } finally {
      setSendMessageLockedHookForTests()
    }

    const active = await db
      .select()
      .from(executions)
      .where(and(eq(executions.agentId, agent.id), inArray(executions.status, ['queued', 'running', 'stopping'])))
    expect(active).toHaveLength(1)
    expect(active[0]?.id).not.toBe(original.id)
    expect(
      await db
        .select()
        .from(executionAdmissionReservations)
        .where(
          and(
            eq(executionAdmissionReservations.agentId, agent.id),
            sql`${executionAdmissionReservations.state} NOT IN ('released', 'revoked')`
          )
        )
    ).toHaveLength(1)
  })

  it('does not supersede when a stale waiting-input object becomes active before the locked reread', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    const original = await agent.queueExecution({ message: 'original turn' })
    await agent.update({ status: 'waiting-input', questionData: { questions: [] } })
    let entered!: () => void
    const locked = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    setSendMessageLockedHookForTests(async () => {
      entered()
      await gate
    })
    try {
      const send = agent.sendMessage('late intervention')
      await locked
      await db.update(agents).set({ status: 'active', questionData: null }).where(eq(agents.id, agent.id))
      await db.update(executions).set({ status: 'running' }).where(eq(executions.id, original.id))
      release()
      expect(await send).toMatchObject({ success: true, status: 'running' })
    } finally {
      setSendMessageLockedHookForTests()
    }

    const rows = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: original.id, status: 'running' })
  })

  it('supersedes when a stale idle object becomes waiting-input before the locked reread', async () => {
    const agent = await Agent.create({ agentTypeId: testAgentTypeId })
    const original = await agent.queueExecution({ message: 'original turn' })
    expect(agent.status).toBe('idle')
    let entered!: () => void
    const locked = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    setSendMessageLockedHookForTests(async () => {
      entered()
      await gate
    })
    try {
      const send = agent.sendMessage('authoritative answer')
      await locked
      await db
        .update(agents)
        .set({ status: 'waiting-input', questionData: { questions: [] } })
        .where(eq(agents.id, agent.id))
      release()
      expect(await send).toMatchObject({ success: true, status: 'queued' })
    } finally {
      setSendMessageLockedHookForTests()
    }

    const rows = await db.select().from(executions).where(eq(executions.agentId, agent.id))
    expect(rows.find(({ id }) => id === original.id)?.status).toBe('completed')
    expect(rows.filter(({ status }) => status === 'queued')).toHaveLength(1)
  })

  describe('recovery message idempotency', () => {
    it('repairs one missing wake across concurrent post-persistence retries', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const identity = {
        sandboxId: `agent_${crypto.randomUUID()}`,
        recoveryEpisodeId: crypto.randomUUID(),
        recoveryNotificationKind: 'recovered' as const,
      }
      const cleanupIndex = await ensureRecoveryMessageIndexForTest()
      agent.sendMessage = async (content, options = {}) => {
        await agent.recordMessage({ role: 'human', content, metadata: options.metadata, pending: true })
        throw new Error('injected post-message/pre-wake failure')
      }

      try {
        await Promise.all(
          Array.from({ length: 8 }, () => agent.sendRecoveryMessageOnce('[System] recovered', identity))
        )
        expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(1)
        expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(1)
      } finally {
        await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
        await db.delete(messages).where(eq(messages.agentId, agent.id))
        await db.delete(executions).where(eq(executions.agentId, agent.id))
        await db.delete(agents).where(eq(agents.id, agent.id))
        await cleanupIndex()
      }
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(0)
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(0)
    })

    it('persists one message per distinct episode but queues exactly one wake', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const first = {
        sandboxId: `agent_${crypto.randomUUID()}`,
        recoveryEpisodeId: crypto.randomUUID(),
        recoveryNotificationKind: 'recovered' as const,
      }
      const second = {
        sandboxId: `squad_${crypto.randomUUID()}`,
        recoveryEpisodeId: crypto.randomUUID(),
        recoveryNotificationKind: 'recovered' as const,
      }

      try {
        await agent.sendRecoveryMessageOnce('[System] private recovered', first)
        await agent.sendRecoveryMessageOnce('[System] shared recovered', second)

        const recovered = await db
          .select()
          .from(messages)
          .where(and(eq(messages.agentId, agent.id), sql`${messages.metadata}->>'source' = 'sandbox-recovery'`))
        expect(recovered).toHaveLength(2)
        expect(
          new Set(
            recovered.map((message) => (message.metadata as { recoveryEpisodeId?: string } | null)?.recoveryEpisodeId)
          )
        ).toEqual(new Set([first.recoveryEpisodeId, second.recoveryEpisodeId]))
        expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(1)
      } finally {
        await db.delete(chatSendReceipts).where(eq(chatSendReceipts.agentId, agent.id))
        await db.delete(messages).where(eq(messages.agentId, agent.id))
        await db.delete(executions).where(eq(executions.agentId, agent.id))
        await db.delete(agents).where(eq(agents.id, agent.id))
      }
      expect(await db.select().from(messages).where(eq(messages.agentId, agent.id))).toHaveLength(0)
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(0)
    })

    it('persists one visible message and queues one wake across concurrent retries', async () => {
      const agent = await Agent.create({ agentTypeId: testAgentTypeId })
      const neighbor = await Agent.create({ agentTypeId: testAgentTypeId })
      const identity = {
        sandboxId: `agent_${crypto.randomUUID()}`,
        recoveryEpisodeId: crypto.randomUUID(),
        recoveryNotificationKind: 'recovered' as const,
      }
      await neighbor.recordMessage({ role: 'human', content: 'neighbor fixture' })
      const cleanupIndex = await ensureRecoveryMessageIndexForTest()

      try {
        await Promise.all(
          Array.from({ length: 8 }, () =>
            agent.sendRecoveryMessageOnce('[System] recovered', identity, { recordOnly: false })
          )
        )

        const recovered = await db
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.agentId, agent.id),
              sql`${messages.metadata}->>'sandboxId' = ${identity.sandboxId}`,
              sql`${messages.metadata}->>'recoveryEpisodeId' = ${identity.recoveryEpisodeId}`,
              sql`${messages.metadata}->>'recoveryNotificationKind' = ${identity.recoveryNotificationKind}`
            )
          )
        expect(recovered).toHaveLength(1)
        expect(recovered[0]).toMatchObject({ content: '[System] recovered', role: 'human' })

        const wakes = await db.select().from(executions).where(eq(executions.agentId, agent.id))
        expect(wakes).toHaveLength(1)
        expect(await db.select().from(executions).where(eq(executions.agentId, neighbor.id))).toHaveLength(0)
        expect(await db.select().from(messages).where(eq(messages.agentId, neighbor.id))).toHaveLength(1)
      } finally {
        await db.delete(chatSendReceipts).where(inArray(chatSendReceipts.agentId, [agent.id, neighbor.id]))
        await db.delete(messages).where(sql`${messages.agentId} IN (${agent.id}, ${neighbor.id})`)
        await db.delete(executions).where(sql`${executions.agentId} IN (${agent.id}, ${neighbor.id})`)
        await db.delete(agents).where(sql`${agents.id} IN (${agent.id}, ${neighbor.id})`)
        await cleanupIndex()
      }

      expect(
        await db
          .select()
          .from(messages)
          .where(sql`${messages.agentId} IN (${agent.id}, ${neighbor.id})`)
      ).toHaveLength(0)
      expect(
        await db
          .select()
          .from(executions)
          .where(sql`${executions.agentId} IN (${agent.id}, ${neighbor.id})`)
      ).toHaveLength(0)
      // Mutation guard: removing any tuple field propagation or the partial unique index must persist duplicates here.
    })
  })
})

describe('legacy terminated-row reconciliation', () => {
  it('rejects an empty destructive test scope', () => {
    expect(() => runLegacyTerminatedAgentSweepForTest([])).toThrow('test scope must not be empty')
  })

  it('canonically terminates bounded late old-writer rows and preserves audit metadata', async () => {
    const first = await Agent.create({ agentTypeId: 'engineer' })
    const second = await Agent.create({ agentTypeId: 'engineer' })
    const terminatedAt = new Date('2026-09-01T00:00:00Z')
    await db
      .update(agents)
      .set({ terminatedAt, metadata: { sibling: 'preserved' } })
      .where(inArray(agents.id, [first.id, second.id]))

    expect(await runLegacyTerminatedAgentSweepForTest([first.id, second.id], { maxCandidates: 1 })).toBe(1)
    expect(await runLegacyTerminatedAgentSweepForTest([first.id, second.id], { maxCandidates: 1 })).toBe(1)
    expect(await runLegacyTerminatedAgentSweepForTest([first.id, second.id], { maxCandidates: 1 })).toBe(0)

    for (const id of [first.id, second.id]) {
      const repaired = await Agent.mustFind(id, { eager: false })
      expect(repaired.status).toBe('terminated')
      expect(repaired.terminatedAt).toEqual(terminatedAt)
      expect(repaired.metadata).toMatchObject({
        sibling: 'preserved',
        finalCleanupPending: true,
        finalCleanupId: expect.any(String),
      })
    }
  })

  it('emits updated then terminated only after a committed legacy repair', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    await db.update(agents).set({ terminatedAt: new Date() }).where(eq(agents.id, agent.id))
    const events: string[] = []
    const stopUpdated = eventEmitter.on('agent.updated', ({ agentId }) => {
      if (agentId === agent.id) events.push('updated')
    })
    const stopTerminated = eventEmitter.on('agent.terminated', ({ agentId }) => {
      if (agentId === agent.id) events.push('terminated')
    })
    try {
      expect(await runLegacyTerminatedAgentSweepForTest([agent.id])).toBe(1)
    } finally {
      stopUpdated()
      stopTerminated()
    }
    expect(events).toEqual(['updated', 'terminated'])
    expect(await Agent.mustFind(agent.id, { eager: false })).toMatchObject({
      status: 'terminated',
      metadata: expect.objectContaining({ finalCleanupPending: true }),
    })
  })

  it('repairs the marker-only live shape left by an old revive', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    const finalCleanupId = crypto.randomUUID()
    await db
      .update(agents)
      .set({ metadata: { sibling: 'preserved', finalCleanupPending: true, finalCleanupId } })
      .where(eq(agents.id, agent.id))

    expect(await runLegacyTerminatedAgentSweepForTest([agent.id])).toBe(1)
    expect(await Agent.mustFind(agent.id, { eager: false })).toMatchObject({
      status: 'terminated',
      terminatedAt: expect.any(Date),
      metadata: expect.objectContaining({ sibling: 'preserved', finalCleanupPending: true, finalCleanupId }),
    })
  })

  it('does not re-terminate a late row whose legacy audit timestamp is concurrently cleared', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    await db.update(agents).set({ terminatedAt: new Date() }).where(eq(agents.id, agent.id))

    const events: string[] = []
    const stopUpdated = eventEmitter.on('agent.updated', ({ agentId }) => {
      if (agentId === agent.id) events.push('updated')
    })
    const stopTerminated = eventEmitter.on('agent.terminated', ({ agentId }) => {
      if (agentId === agent.id) events.push('terminated')
    })
    await db.update(agents).set({ terminatedAt: null }).where(eq(agents.id, agent.id))
    try {
      expect(await reconcileLegacyTerminatedAgent(agent.id)).toBeNull()
    } finally {
      stopUpdated()
      stopTerminated()
    }
    expect(events).toEqual([])
    expect(await Agent.mustFind(agent.id, { eager: false })).toMatchObject({
      status: 'idle',
      terminatedAt: null,
    })
    expect((await Agent.mustFind(agent.id, { eager: false })).metadata).not.toHaveProperty('finalCleanupPending')
  })
})

describe('Agent.find eager opt-out', () => {
  it('skips the squad + agent-type eager loads with { eager: false } and still lazy-loads on demand', async () => {
    const name = `agent-find-eager-${Date.now()}`
    const typeId = `${name}-type`
    await AgentType.create({ id: typeId, name: 'A', systemPrompt: 'p' })
    const squad = await Squad.create({ name, purpose: 'p' })
    try {
      const [row] = await db
        .insert(agents)
        .values({ squadId: squad.id, agentTypeId: typeId })
        .returning({ id: agents.id })

      const squadFindSpy = spyOn(Squad, 'find')
      const typeFindSpy = spyOn(AgentType, 'find')
      try {
        // Default (unchanged): eager-loads both relations.
        await Agent.find(row.id)
        expect(squadFindSpy).toHaveBeenCalledTimes(1)
        expect(typeFindSpy).toHaveBeenCalledTimes(1)

        squadFindSpy.mockClear()
        typeFindSpy.mockClear()

        // Background sweeps only read row fields — no relation queries at all.
        const lean = await Agent.find(row.id, { eager: false })
        expect(lean!.id).toBe(row.id)
        expect(lean!.terminatedAt).toBeNull()
        expect(squadFindSpy).not.toHaveBeenCalled()
        expect(typeFindSpy).not.toHaveBeenCalled()

        const mustLean = await Agent.mustFind(row.id, { eager: false })
        expect(mustLean.id).toBe(row.id)
        expect(squadFindSpy).not.toHaveBeenCalled()
        expect(typeFindSpy).not.toHaveBeenCalled()

        // The relations are still reachable lazily (opt-out, not amputation).
        expect((await lean!.getSquad())!.id).toBe(squad.id)
        expect(squadFindSpy).toHaveBeenCalledTimes(1)
      } finally {
        squadFindSpy.mockRestore()
        typeFindSpy.mockRestore()
      }
    } finally {
      await db.delete(agents).where(eq(agents.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
      AgentType.invalidateCache()
    }
  })
})

describe('findAgentLifecycleState', () => {
  it('rejects an ambiguous lifecycle prefix instead of fencing an arbitrary agent', async () => {
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']
    await db.insert(agents).values(ids.map((id) => ({ id, agentTypeId: 'engineer' })))
    try {
      await expect(findAgentLifecycleState('aaaaaaaa')).rejects.toThrow('Ambiguous agent ID prefix')
    } finally {
      await db.delete(agents).where(inArray(agents.id, ids))
    }
  })

  it('projects only lifecycle fields even when the agent has messages', async () => {
    const [row] = await db.insert(agents).values({ agentTypeId: 'engineer' }).returning({ id: agents.id })
    try {
      await db.insert(messages).values({ agentId: row.id, role: 'human', content: 'not lifecycle state' })
      const state = await findAgentLifecycleState(row.id)
      expect(Object.keys(state!).sort()).toEqual(['dormantAt', 'id', 'metadata', 'status', 'terminatedAt'])
      expect(state).toMatchObject({ id: row.id, status: 'idle', dormantAt: null, terminatedAt: null })

      for (const [json, expected] of [
        [`'{"purpose":"kept"}'::jsonb`, { purpose: 'kept' }],
        [`'[]'::jsonb`, null],
        [`'null'::jsonb`, null],
        [`'7'::jsonb`, null],
      ] as const) {
        await db
          .update(agents)
          .set({ metadata: sql.raw(json) })
          .where(eq(agents.id, row.id))
        expect((await findAgentLifecycleState(row.id))?.metadata).toEqual(expected)
      }
      expect(await findAgentLifecycleState('00000000-0000-0000-0000-000000000000')).toBeNull()
    } finally {
      await db.delete(agents).where(eq(agents.id, row.id))
    }
  })
})

describe('convergeDormancyResourceGeneration', () => {
  it('updates only the exact dormant generation and preserves sibling metadata', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    await seedAgentLifecycleForTest(agent, {
      status: 'dormant',
      dormantAt: new Date(),
      metadata: { sibling: 'kept', dormancyResourceGeneration: 'generation-a' },
    })

    expect(await convergeDormancyResourceGeneration(agent.id, 'generation-a', 'generation-b')).toBe(true)
    expect((await Agent.mustFind(agent.id, { eager: false })).metadata).toMatchObject({
      sibling: 'kept',
      dormancyResourceGeneration: 'generation-b',
    })
    expect(await convergeDormancyResourceGeneration(agent.id, 'generation-a', 'generation-c')).toBe(false)
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id))
    expect(await convergeDormancyResourceGeneration(agent.id, 'generation-b', 'generation-c')).toBe(false)
  })

  it('uses null-safe comparison for legacy dormant generations', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer' })
    await seedAgentLifecycleForTest(agent, { status: 'dormant', dormantAt: new Date(), metadata: { sibling: true } })
    expect(await convergeDormancyResourceGeneration(agent.id, null, 'generation-b')).toBe(true)
    expect((await Agent.mustFind(agent.id, { eager: false })).metadata).toMatchObject({
      sibling: true,
      dormancyResourceGeneration: 'generation-b',
    })
  })
})

describe('listAgentActivityRows', () => {
  it('returns id/lastMessageAt/status for a set of ids in one query, omitting unknown ids', async () => {
    const name = `agent-activity-rows-${Date.now()}`
    const typeId = `${name}-type`
    await AgentType.create({ id: typeId, name: 'A', systemPrompt: 'p' })
    const squad = await Squad.create({ name, purpose: 'p' })
    try {
      const inserted = await db
        .insert(agents)
        .values([
          { squadId: squad.id, agentTypeId: typeId },
          { squadId: squad.id, agentTypeId: typeId, status: 'terminated', terminatedAt: new Date() },
        ])
        .returning({ id: agents.id })
      const [live, terminated] = inserted.map((r) => r.id)

      const rows = await listAgentActivityRows([live, terminated, '00000000-0000-0000-0000-000000000000'])
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.size).toBe(2)
      expect(byId.get(live)!.status).toBe('idle')
      expect(byId.get(terminated)!.status).toBe('terminated')
      expect(byId.get(live)!.lastMessageAt).toBeNull()
      expect(byId.has('00000000-0000-0000-0000-000000000000')).toBe(false)
    } finally {
      await db.delete(agents).where(eq(agents.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(agentTypes).where(eq(agentTypes.id, typeId))
      AgentType.invalidateCache()
    }
  })

  it('never queries for an empty id set', async () => {
    expect(await listAgentActivityRows([])).toEqual([])
  })
})

describe('Agent.list relation hydration (batched)', () => {
  it('loads squads and agent types with one batch query each, not per agent, and leaves getters warm', async () => {
    const name = `agent-list-batch-${Date.now()}`
    const typeA = `${name}-type-a`
    const typeB = `${name}-type-b`
    await AgentType.create({ id: typeA, name: 'A', systemPrompt: 'p' })
    await AgentType.create({ id: typeB, name: 'B', systemPrompt: 'p' })
    const squad = await Squad.create({ name, purpose: 'p' })
    try {
      const inserted = await db
        .insert(agents)
        .values([
          { squadId: squad.id, agentTypeId: typeA },
          { squadId: squad.id, agentTypeId: typeA },
          { squadId: squad.id, agentTypeId: typeB },
        ])
        .returning({ id: agents.id })
      const insertedIds = new Set(inserted.map((row) => row.id))
      const findSpy = spyOn(Squad, 'find')
      const findManySpy = spyOn(Squad, 'findManyByIds')
      const typeFindSpy = spyOn(AgentType, 'find')
      try {
        const listed = await Agent.list({ squadId: squad.id })
        // Squad.create also spawns the squad's manager agent.
        expect(listed.length).toBeGreaterThanOrEqual(3)
        expect(findManySpy).toHaveBeenCalledTimes(1)
        expect(findSpy).not.toHaveBeenCalled()
        expect(typeFindSpy).not.toHaveBeenCalled()
        // Relations are already hydrated — the lazy getters do no further work.
        for (const agent of listed.filter((a) => insertedIds.has(a.id))) {
          expect((await agent.getSquad())!.id).toBe(squad.id)
          expect((await agent.getAgentType())!.id).toBe(agent.agentTypeId)
        }
        expect(findSpy).not.toHaveBeenCalled()
        expect(typeFindSpy).not.toHaveBeenCalled()
      } finally {
        findSpy.mockRestore()
        findManySpy.mockRestore()
        typeFindSpy.mockRestore()
      }
    } finally {
      await db.delete(agents).where(eq(agents.squadId, squad.id))
      await db.delete(squads).where(eq(squads.id, squad.id))
      await db.delete(agentTypes).where(inArray(agentTypes.id, [typeA, typeB]))
      AgentType.invalidateCache()
    }
  })
})
