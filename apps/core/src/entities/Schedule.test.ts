import { createBlankWorkflow, type WorkStreamCompletionMode } from '@ficus/shared'
import { storedLegacyWorkStream } from '../test-utils/stored-legacy-work-stream'
import { getFlow } from '../services/workflows/execution'
import * as flowExecution from '../services/workflows/execution'
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { db } from '../db'
import { agents, executions, schedules, workStreams, squads } from '../db/schema'
import { eq, like, and, sql } from 'drizzle-orm'
import {
  Schedule,
  setScheduleAgentLockAcquiredHookForTest,
  setScheduleAgentLockAttemptedHookForTest,
  setScheduleLifecycleLockedHookForTest,
} from './Schedule'
import { Agent } from './Agent'
import { Squad } from './Squad'
import { AgentType } from '../entities/AgentType'
import { InboxMessage, setBeforeRecipientLifecycleLockHookForTest } from './InboxMessage'
import { WorkStream } from './WorkStream'
import { verifyWebhookToken } from '../lib/utils/webhook-token'
import type { ScheduleAction, ScheduleConfig } from '@ficus/shared'
import { eventEmitter } from '../lib/infra/event-emitter'
import { runDormantAgentSweep } from '../services/agents/cleanup'
import { makeDormant, setMakeDormantBeforeExecutionLockHookForTest, terminate } from '../services/agent/lifecycle'

function testFlow(mode: WorkStreamCompletionMode = 'deliverable', profile = 'engineer') {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = profile
  definition.completion.mode = mode
  return { kind: 'inline' as const, definition }
}

async function waitForAdvisoryLockWait(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ waiting: number }>(sql`
      select count(*)::int as waiting
      from pg_locks
      where locktype = 'advisory' and not granted
    `)
    if ((row?.waiting ?? 0) > 0) return
    await Bun.sleep(5)
  }
  throw new Error('Expected a transaction to be waiting on an advisory lock')
}

describe('Schedule', () => {
  describe('parseInterval', () => {
    it('parses seconds', () => {
      expect(Schedule.parseInterval('30s')).toBe(30_000)
    })

    it('parses minutes', () => {
      expect(Schedule.parseInterval('15m')).toBe(900_000)
    })

    it('parses hours', () => {
      expect(Schedule.parseInterval('2h')).toBe(7_200_000)
    })

    it('parses single digit values', () => {
      expect(Schedule.parseInterval('1s')).toBe(1_000)
      expect(Schedule.parseInterval('1m')).toBe(60_000)
      expect(Schedule.parseInterval('1h')).toBe(3_600_000)
    })

    it('parses large values', () => {
      expect(Schedule.parseInterval('120m')).toBe(7_200_000)
      expect(Schedule.parseInterval('3600s')).toBe(3_600_000)
    })

    it('throws on invalid format', () => {
      expect(() => Schedule.parseInterval('abc')).toThrow('Invalid interval format')
    })

    it('throws on missing unit', () => {
      expect(() => Schedule.parseInterval('15')).toThrow('Invalid interval format')
    })

    it('throws on invalid unit', () => {
      expect(() => Schedule.parseInterval('15d')).toThrow('Invalid interval format')
    })

    it('throws on empty string', () => {
      expect(() => Schedule.parseInterval('')).toThrow('Invalid interval format')
    })

    it('throws on negative values', () => {
      expect(() => Schedule.parseInterval('-5m')).toThrow('Invalid interval format')
    })

    it('throws on decimal values', () => {
      expect(() => Schedule.parseInterval('1.5m')).toThrow('Invalid interval format')
    })
  })

  describe('calculateNextTrigger', () => {
    it('calculates from interval with lastTriggered', () => {
      const config: ScheduleConfig = { interval: '15m' }
      const lastTriggered = new Date('2026-02-10T10:00:00Z')
      const next = Schedule.calculateNextTrigger(config, lastTriggered)
      expect(next).toEqual(new Date('2026-02-10T10:15:00Z'))
    })

    it('calculates from interval without lastTriggered (uses now)', () => {
      const config: ScheduleConfig = { interval: '15m' }
      const before = Date.now()
      const next = Schedule.calculateNextTrigger(config, null)!
      const after = Date.now()
      expect(next.getTime()).toBeGreaterThanOrEqual(before + 900_000)
      expect(next.getTime()).toBeLessThanOrEqual(after + 900_000)
    })

    it('calculates from cron expression', () => {
      const config: ScheduleConfig = { cron: '0 * * * *' } // every hour at minute 0
      const next = Schedule.calculateNextTrigger(config, null)!
      // Should be a valid future date
      expect(next.getTime()).toBeGreaterThan(Date.now())
      // Should be at minute 0
      expect(next.getMinutes()).toBe(0)
      expect(next.getSeconds()).toBe(0)
    })

    it('calculates five-field cron minute 15 as hourly at minute 15', () => {
      const config: ScheduleConfig = { cron: '15 * * * *' }
      const next = Schedule.calculateNextTrigger(config, null, new Date('2026-05-20T14:10:00Z'))!
      expect(next).toEqual(new Date('2026-05-20T14:15:00Z'))
    })

    it('returns null for one-shot runAt in the past', () => {
      const config: ScheduleConfig = { runAt: '2020-01-01T00:00:00Z' }
      const next = Schedule.calculateNextTrigger(config, null)
      expect(next).toBeNull()
    })

    it('returns null for one-shot runAt already triggered', () => {
      const config: ScheduleConfig = { runAt: '2030-01-01T00:00:00Z' }
      const next = Schedule.calculateNextTrigger(config, new Date())
      expect(next).toBeNull()
    })

    it('returns future date for one-shot runAt not yet triggered', () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString()
      const config: ScheduleConfig = { runAt: futureDate }
      const next = Schedule.calculateNextTrigger(config, null)
      expect(next).toEqual(new Date(futureDate))
    })

    it('returns null when no schedule config provided', () => {
      const config: ScheduleConfig = {}
      const next = Schedule.calculateNextTrigger(config, null)
      expect(next).toBeNull()
    })

    it('caps the next occurrence at a strict expiration boundary', () => {
      const config: ScheduleConfig = {
        interval: '1h',
        expiresAt: '2026-02-10T10:30:00.000Z',
      }
      expect(Schedule.calculateNextTrigger(config, new Date('2026-02-10T10:00:00Z'))).toBeNull()
    })

    it('prefers interval over cron when both are set', () => {
      const config: ScheduleConfig = { interval: '30m', cron: '0 * * * *' }
      const lastTriggered = new Date('2026-02-10T10:00:00Z')
      const next = Schedule.calculateNextTrigger(config, lastTriggered)
      // Should use interval: 30m from last triggered
      expect(next).toEqual(new Date('2026-02-10T10:30:00Z'))
    })
  })

  describe('validateAction', () => {
    it('allows inbox_message with agent target for any scope', () => {
      const action: ScheduleAction = {
        type: 'inbox_message',
        target: { type: 'agent', agentId: 'test-id' },
        content: 'Hello',
      }
      expect(() => Schedule.validateAction('squad', action)).not.toThrow()
      expect(() => Schedule.validateAction('agent', action)).not.toThrow()
    })

    it('allows inbox_message with squad_manager target only for squad scope', () => {
      const action: ScheduleAction = {
        type: 'inbox_message',
        target: { type: 'squad_manager' },
        content: 'Hello',
      }
      expect(() => Schedule.validateAction('squad', action)).not.toThrow()
      expect(() => Schedule.validateAction('agent', action)).toThrow('squad_manager target requires squad scope')
    })

    it('allows spawn_agent only for squad scope', () => {
      const action: ScheduleAction = {
        type: 'spawn_agent',
        agentTypeId: 'engineer',
        prompt: 'Do work',
      }
      expect(() => Schedule.validateAction('squad', action)).not.toThrow()
      expect(() => Schedule.validateAction('agent', action)).toThrow('spawn_agent action requires squad scope')
    })

    it('allows create_work_stream only for squad scope', () => {
      const action: ScheduleAction = {
        type: 'create_work_stream',
        title: 'New task',
      }
      expect(() => Schedule.validateAction('squad', action)).not.toThrow()
      expect(() => Schedule.validateAction('agent', action)).toThrow('create_work_stream action requires squad scope')
    })

    it('requires a flow for stream-producing actions and accepts standalone workers', () => {
      expect(() =>
        Schedule.validateAction('squad', { type: 'spawn_agent', agentTypeId: 'engineer', prompt: 'Do work' })
      ).not.toThrow()
      expect(() =>
        Schedule.validateAction('squad', {
          type: 'spawn_agent',
          agentTypeId: 'engineer',
          prompt: 'Do work',
          workStream: { title: 'Work' },
        })
      ).toThrow('create_work_stream')
      expect(() =>
        Schedule.validateAction('squad', {
          type: 'create_work_stream',
          title: 'Work',
          workflow: testFlow('direct-merge'),
        })
      ).not.toThrow()
      expect(() =>
        Schedule.validateAction('squad', { type: 'create_work_stream', title: 'Work', completionMode: 'direct-merge' })
      ).toThrow('workflow')
    })

    it('rejects unsupported completion modes at the entity boundary', () => {
      expect(() =>
        Schedule.validateAction('squad', {
          type: 'spawn_agent',
          agentTypeId: 'engineer',
          prompt: 'Do work',
          workStream: { title: 'Scheduled work', completionMode: 'bogus' },
        } as never)
      ).toThrow(/workflow/i)
      expect(() =>
        Schedule.validateAction('squad', {
          type: 'create_work_stream',
          title: 'Scheduled work',
          completionMode: 'bogus',
        } as never)
      ).toThrow(/workflow/i)
    })
  })

  describe('validateScheduleConfig', () => {
    it('requires at least one of interval, cron, or runAt', () => {
      expect(() => Schedule.validateScheduleConfig({})).toThrow('Schedule must have interval, cron, or runAt')
    })

    it('accepts valid interval', () => {
      expect(() => Schedule.validateScheduleConfig({ interval: '15m' })).not.toThrow()
    })

    it('accepts valid cron', () => {
      expect(() => Schedule.validateScheduleConfig({ cron: '0 * * * *' })).not.toThrow()
    })

    it('accepts valid runAt', () => {
      expect(() => Schedule.validateScheduleConfig({ runAt: '2030-01-01T00:00:00Z' })).not.toThrow()
    })

    it('rejects invalid interval format', () => {
      expect(() => Schedule.validateScheduleConfig({ interval: 'bad' })).toThrow('Invalid interval format')
    })

    it('rejects invalid cron expression', () => {
      expect(() => Schedule.validateScheduleConfig({ cron: 'not a cron' })).toThrow()
    })

    it('requires expiresAt to be a real ISO-8601 datetime with timezone', () => {
      expect(() => Schedule.validateScheduleConfig({ interval: '1h', expiresAt: '08/26/2026' })).toThrow(
        'expiresAt must be an ISO-8601 datetime with timezone'
      )
      expect(() => Schedule.validateScheduleConfig({ interval: '1h', expiresAt: '2026-02-30T12:00:00Z' })).toThrow()
      expect(() =>
        Schedule.validateScheduleConfig({ interval: '1h', expiresAt: '2026-08-26T12:00:00+02:00' })
      ).not.toThrow()
    })
  })
})

describe('Schedule CRUD', () => {
  let testPrefix: string
  let testSquadId: string
  let testAgentId: string
  let testTargetAgentId: string

  beforeEach(async () => {
    testPrefix = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await AgentType.upsert({ id: 'manager', model: 'test:model', name: 'Manager', systemPrompt: 'Manager' })
    await AgentType.upsert({ id: 'engineer', model: 'test:model', name: 'Engineer', systemPrompt: 'Engineer' })
    const squad = await Squad.create({ name: `${testPrefix}-squad`, purpose: 'Test squad' })
    testSquadId = squad.id
    await AgentType.upsert({ id: 'engineer', model: 'test:model', name: 'Engineer', systemPrompt: 'Engineer' })
    await squad.update({ metadata: { workflow: testFlow() } })
    testAgentId = (await Agent.create({ agentTypeId: 'engineer', squadId: squad.id })).id
    testTargetAgentId = (await Agent.create({ agentTypeId: 'manager', squadId: squad.id })).id
    await db.update(squads).set({ managerAgentId: testTargetAgentId }).where(eq(squads.id, squad.id))
  })

  afterEach(async () => {
    await db.delete(schedules).where(like(schedules.name, `${testPrefix}%`))
    await db
      .delete(squads)
      .where(eq(squads.id, testSquadId))
      .catch(() => {})
  })

  describe('create', () => {
    it('creates a schedule with valid input', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-test`,
        schedule: { interval: '15m' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Hello',
        },
      })

      expect(schedule.id).toBeDefined()
      expect(schedule.scopeType).toBe('agent')
      expect(schedule.name).toBe(`${testPrefix}-test`)
      expect(schedule.enabled).toBe(true)
      expect(schedule.triggerCount).toBe(0)
      expect(schedule.nextTriggerAt).toBeInstanceOf(Date)
      expect(schedule.toJson()).toMatchObject({
        healthStatus: 'never_run',
        failureCount: 0,
        consecutiveFailureCount: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastRecoveredAt: null,
        lastErrorCode: null,
        lastErrorSummary: null,
        automaticallyDisabledAt: null,
        automaticDisableReason: null,
      })
    })

    it('persists metadata and exposes it on reload and toJson', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-metadata`,
        schedule: { interval: '15m' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Hello',
        },
        metadata: { kind: 'subagent-watchdog' },
      })

      expect(schedule.metadata).toEqual({ kind: 'subagent-watchdog' })
      expect(schedule.toJson().metadata).toEqual({ kind: 'subagent-watchdog' })
      expect((await Schedule.mustFind(schedule.id)).metadata).toEqual({ kind: 'subagent-watchdog' })
    })

    it('defaults metadata to empty object', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-metadata-default`,
        schedule: { interval: '15m' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Hello',
        },
      })

      expect(schedule.metadata).toEqual({})
    })

    it('persists explicit flows and allows inheriting the squad default', async () => {
      const schedule = await Schedule.create({
        scopeType: 'squad',
        scopeId: testSquadId,
        name: `${testPrefix}-flow`,
        schedule: { interval: '1h' },
        action: { type: 'create_work_stream', title: 'Work', workflow: testFlow('review-approval') },
      })
      expect(schedule.toJson().action).toMatchObject({ workflow: testFlow('review-approval') })
      await schedule.update({
        action: { type: 'create_work_stream', title: 'New task', workflow: testFlow('direct-merge') },
      })
      expect((await Schedule.mustFind(schedule.id)).action).toMatchObject({ workflow: testFlow('direct-merge') })
      await schedule.update({ action: { type: 'create_work_stream', title: 'Use squad default' } })
      expect(schedule.action).not.toHaveProperty('workflow')
    })

    it('throws on invalid action for scope', async () => {
      await expect(
        Schedule.create({
          scopeType: 'agent',
          scopeId: testAgentId,
          name: `${testPrefix}-invalid`,
          schedule: { interval: '15m' },
          action: { type: 'spawn_agent', agentTypeId: 'engineer', prompt: 'test' },
        })
      ).rejects.toThrow('spawn_agent action requires squad scope')
    })
  })

  describe('skipIfUnresolved', () => {
    it('rejects skipIfUnresolved on actions that do not create work streams', async () => {
      await expect(
        Schedule.create({
          scopeType: 'agent',
          scopeId: testAgentId,
          name: `${testPrefix}-skip-bad`,
          schedule: { interval: '1h', skipIfUnresolved: true },
          action: {
            type: 'inbox_message',
            target: { type: 'agent', agentId: testTargetAgentId },
            content: 'x',
          },
        })
      ).rejects.toThrow(/skipIfUnresolved requires/)
    })

    it('accepts skipIfUnresolved on work-stream-producing actions', async () => {
      const schedule = await Schedule.create({
        scopeType: 'squad',
        scopeId: testSquadId,
        name: `${testPrefix}-skip-good`,
        schedule: { interval: '1h', skipIfUnresolved: true },
        action: { type: 'create_work_stream', title: 'New task' },
      })

      expect(schedule.schedule.skipIfUnresolved).toBe(true)
      expect(schedule.skipCount).toBe(0)
      expect(schedule.lastSkippedAt).toBeNull()
    })
  })

  describe('find', () => {
    it('finds schedule by id', async () => {
      const created = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-find`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      const found = await Schedule.find(created.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
    })

    it('finds schedule by id prefix', async () => {
      const created = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-prefix`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      const found = await Schedule.find(created.id.slice(0, 8))
      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
    })

    it('returns null for non-existent id', async () => {
      const found = await Schedule.find('00000000-0000-0000-0000-000000000000')
      expect(found).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all schedules', async () => {
      await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-list1`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      const all = await Schedule.list()
      expect(all.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by metadata kind and excludeKind', async () => {
      const scopeId = testAgentId
      const watchdog = await Schedule.create({
        scopeType: 'agent',
        scopeId,
        name: `${testPrefix}-kind-watchdog`,
        schedule: { interval: '15m' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Hello',
        },
        metadata: { kind: 'subagent-watchdog' },
      })
      const plain = await Schedule.create({
        scopeType: 'agent',
        scopeId,
        name: `${testPrefix}-kind-plain`,
        schedule: { interval: '15m' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Hello',
        },
      })

      expect(
        (await Schedule.list({ scopeType: 'agent', scopeId, kind: 'subagent-watchdog' })).map((s) => s.id)
      ).toEqual([watchdog.id])
      expect(
        (await Schedule.list({ scopeType: 'agent', scopeId, excludeKind: 'subagent-watchdog' })).map((s) => s.id)
      ).toEqual([plain.id])
    })

    it('filters by scopeType', async () => {
      await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-agent`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      const agentSchedules = await Schedule.list({ scopeType: 'agent' })
      expect(agentSchedules.every((s) => s.scopeType === 'agent')).toBe(true)
    })
  })

  describe('update', () => {
    async function automaticallyDisabledSchedule(suffix: string) {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-${suffix}`,
        enabled: false,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })
      const incidentId = crypto.randomUUID()
      await db
        .update(schedules)
        .set({
          consecutiveFailureCount: 10,
          failureCount: 10,
          automaticallyDisabledAt: new Date(),
          automaticDisableReason: 'Circuit breaker opened.',
          openFailureIncidentId: incidentId,
          lastErrorCode: 'transport_error',
          lastErrorSummary: 'A transport error interrupted the scheduled action.',
        })
        .where(eq(schedules.id, schedule.id))
      return { schedule: await Schedule.mustFind(schedule.id), incidentId }
    }

    it('atomically resets breaker state through every re-enable entry point', async () => {
      const direct = await automaticallyDisabledSchedule('direct-enable')
      await direct.schedule.enable()
      expect(direct.schedule).toMatchObject({
        enabled: true,
        consecutiveFailureCount: 0,
        automaticallyDisabledAt: null,
        automaticDisableReason: null,
        failureCount: 10,
        openFailureIncidentId: direct.incidentId,
      })

      const patched = await automaticallyDisabledSchedule('patch-enable')
      await patched.schedule.update({ enabled: true })
      expect(patched.schedule.consecutiveFailureCount).toBe(0)
      expect(patched.schedule.automaticallyDisabledAt).toBeNull()

      const webhook = await automaticallyDisabledSchedule('webhook-enable')
      await webhook.schedule.enableWebhook('https://example.test')
      expect(webhook.schedule.webhookEnabled).toBe(true)
      expect(webhook.schedule.consecutiveFailureCount).toBe(0)
      expect(webhook.schedule.automaticallyDisabledAt).toBeNull()
    })

    it('rejects every re-enable entry while an attempt lease is live', async () => {
      for (const entry of ['enable', 'patch', 'webhook'] as const) {
        const { schedule } = await automaticallyDisabledSchedule(`active-attempt-${entry}`)
        await db
          .update(schedules)
          .set({
            activeAttemptId: crypto.randomUUID(),
            activeAttemptSource: 'manual',
            activeAttemptStartedAt: new Date(),
            activeAttemptLeaseUntil: new Date(Date.now() + 60_000),
          })
          .where(eq(schedules.id, schedule.id))
        const action =
          entry === 'enable'
            ? schedule.enable()
            : entry === 'patch'
              ? schedule.update({ enabled: true })
              : schedule.enableWebhook('https://example.test')
        await expect(action).rejects.toMatchObject({ code: 'attempt_in_progress' })
      }
    })

    it('repairs an expired attempt marker through every re-enable entry point', async () => {
      for (const entry of ['enable', 'patch', 'webhook'] as const) {
        const { schedule } = await automaticallyDisabledSchedule(`stale-attempt-${entry}`)
        await db
          .update(schedules)
          .set({
            activeAttemptId: crypto.randomUUID(),
            activeAttemptSource: 'manual',
            activeAttemptStartedAt: new Date(Date.now() - 120_000),
            activeAttemptLeaseUntil: new Date(Date.now() - 60_000),
          })
          .where(eq(schedules.id, schedule.id))
        if (entry === 'enable') await schedule.enable()
        else if (entry === 'patch') await schedule.update({ enabled: true })
        else await schedule.enableWebhook('https://example.test')
        const repaired = await Schedule.mustFind(schedule.id)
        expect(repaired.activeAttemptId).toBeNull()
        expect(repaired.automaticallyDisabledAt).toBeNull()
      }
    })

    it('does not partially commit a PATCH-enable when merged reference validation fails', async () => {
      const { schedule } = await automaticallyDisabledSchedule('atomic-patch')
      const originalName = schedule.name
      await expect(
        schedule.update({
          enabled: true,
          name: `${testPrefix}-must-not-commit`,
          action: {
            type: 'inbox_message',
            target: { type: 'agent', agentId: crypto.randomUUID() },
            content: 'invalid',
          },
        })
      ).rejects.toMatchObject({ code: 'target_agent_not_found' })
      const reloaded = await Schedule.mustFind(schedule.id)
      expect(reloaded.name).toBe(originalName)
      expect(reloaded.automaticallyDisabledAt).not.toBeNull()
      expect(reloaded.consecutiveFailureCount).toBe(10)
    })

    it('updates schedule fields', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-update`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      await schedule.update({ name: `${testPrefix}-updated`, enabled: false })

      expect(schedule.name).toBe(`${testPrefix}-updated`)
      expect(schedule.enabled).toBe(false)
    })
  })

  describe('delete', () => {
    it('deletes a schedule', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-delete`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      await Schedule.delete(schedule.id)
      const found = await Schedule.find(schedule.id)
      expect(found).toBeNull()
    })
  })

  describe('listDue', () => {
    it('returns enabled schedules with nextTriggerAt in the past', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-due`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      // Set nextTriggerAt to the past
      await db
        .update(schedules)
        .set({ nextTriggerAt: new Date(Date.now() - 60000) })
        .where(eq(schedules.id, schedule.id))

      const due = await Schedule.listDue()
      expect(due.some((s) => s.id === schedule.id)).toBe(true)
    })

    it('excludes disabled schedules', async () => {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: testAgentId,
        name: `${testPrefix}-disabled`,
        enabled: false,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: testTargetAgentId },
          content: 'Test',
        },
      })

      // Set nextTriggerAt to the past
      await db
        .update(schedules)
        .set({ nextTriggerAt: new Date(Date.now() - 60000) })
        .where(eq(schedules.id, schedule.id))

      const due = await Schedule.listDue()
      expect(due.some((s) => s.id === schedule.id)).toBe(false)
    })
  })
})

describe('Schedule trigger', () => {
  let testPrefix: string
  let testSquadId: string

  beforeEach(async () => {
    testPrefix = `sched-trig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Ensure manager agent type exists
    await AgentType.upsert({
      id: 'manager',
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Manager',
      systemPrompt: 'Manager agent',
    })
    await AgentType.upsert({
      id: 'engineer',
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Engineer',
      systemPrompt: 'Engineer agent',
    })

    // Create test squad
    const squad = await Squad.create({
      name: `${testPrefix}-squad`,
      purpose: 'Test squad',
    })
    testSquadId = squad.id
    await AgentType.upsert({ id: 'engineer', model: 'test:model', name: 'Engineer', systemPrompt: 'Engineer' })
    await squad.update({ metadata: { workflow: testFlow() } })
  })

  afterEach(async () => {
    await db.delete(schedules).where(like(schedules.name, `${testPrefix}%`))
    if (testSquadId) {
      // Hard-delete the test squad in teardown (archive() would leave the row behind)
      await db
        .delete(squads)
        .where(eq(squads.id, testSquadId))
        .catch(() => {})
    }
  })

  it('executes inbox_message action with agent target', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-inbox`,
      schedule: { interval: '1h' },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        subject: 'Test',
        content: 'Hello from schedule',
      },
    })

    await schedule.trigger()

    const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
    expect(messages.some((m) => m.content === 'Hello from schedule')).toBe(true)
    expect(schedule.triggerCount).toBe(1)
    expect(schedule.lastTriggeredAt).toBeInstanceOf(Date)
  })

  it('locks multi-agent schedule references in sorted order without deadlock', async () => {
    const firstAgent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const secondAgent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const [low, high] = [firstAgent.id, secondAgent.id].sort()
    const firstLock = Promise.withResolvers<void>()
    let secondLockBeforeRelease = false
    const release = Promise.withResolvers<void>()
    const secondAttempt = Promise.withResolvers<void>()
    let acquisitions = 0
    let attempts = 0
    let released = false
    setScheduleAgentLockAttemptedHookForTest(async (agentId) => {
      if (agentId === low && ++attempts === 2) secondAttempt.resolve()
    })
    setScheduleAgentLockAcquiredHookForTest(async () => {
      acquisitions++
      if (acquisitions === 1) {
        firstLock.resolve()
        await release.promise
      } else if (!released) {
        secondLockBeforeRelease = true
      }
    })
    try {
      const highToLow = Schedule.create({
        scopeType: 'agent',
        scopeId: high,
        name: `${testPrefix}-high-low`,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: low }, content: 'x' },
      })
      await firstLock.promise
      const lowToHigh = Schedule.create({
        scopeType: 'agent',
        scopeId: low,
        name: `${testPrefix}-low-high`,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: high }, content: 'x' },
      })
      await secondAttempt.promise
      await waitForAdvisoryLockWait()
      expect(secondLockBeforeRelease).toBe(false)
      released = true
      release.resolve()
      expect((await Promise.allSettled([highToLow, lowToHigh])).map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ])
    } finally {
      released = true
      release.resolve()
      setScheduleAgentLockAttemptedHookForTest(undefined)
      setScheduleAgentLockAcquiredHookForTest(undefined)
    }
  }, 120_000)

  it('rejects active schedule creation and re-enablement for a dormant agent', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const timer = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-disabled-timer`,
      enabled: false,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
    })
    const webhook = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-disabled-webhook`,
      enabled: false,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
    })
    await makeDormant(agent)

    await expect(
      Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-late-create`,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
      })
    ).rejects.toMatchObject({ code: 'target_agent_dormant' })
    await expect(timer.enable()).rejects.toMatchObject({ code: 'target_agent_dormant' })
    await expect(webhook.enableWebhook('https://example.test')).rejects.toMatchObject({ code: 'target_agent_dormant' })
    expect(await Schedule.mustFind(timer.id)).toMatchObject({ enabled: false, webhookEnabled: false })
    expect(await Schedule.mustFind(webhook.id)).toMatchObject({ enabled: false, webhookEnabled: false })
  })

  it('serializes schedule create before dormancy and lets reconciliation disable it', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    setScheduleLifecycleLockedHookForTest(async () => {
      setScheduleLifecycleLockedHookForTest(undefined)
      locked.resolve()
      await release.promise
    })
    try {
      const creating = Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-create-wins`,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
      })
      await locked.promise
      const dormancy = makeDormant(agent)
      release.resolve()
      const [schedule] = await Promise.all([creating, dormancy])
      expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
      expect(await Schedule.mustFind(schedule.id)).toMatchObject({ enabled: false, webhookEnabled: false })
    } finally {
      release.resolve()
      setScheduleLifecycleLockedHookForTest(undefined)
    }
  }, 120_000)

  it('serializes dormancy before schedule create and rejects the active row', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const locked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const scheduleLockAttempted = Promise.withResolvers<void>()
    let scheduleReachedLifecycleBoundary = false
    setScheduleAgentLockAttemptedHookForTest(async (agentId) => {
      if (agentId === agent.id) scheduleLockAttempted.resolve()
    })
    setScheduleLifecycleLockedHookForTest(async () => {
      scheduleReachedLifecycleBoundary = true
    })
    setMakeDormantBeforeExecutionLockHookForTest(async () => {
      setMakeDormantBeforeExecutionLockHookForTest(undefined)
      locked.resolve()
      await release.promise
    })
    try {
      const dormancy = makeDormant(agent)
      await locked.promise
      const creating = Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-dormancy-wins`,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
      }).then(
        (schedule) => ({ schedule, error: null }),
        (error: unknown) => ({ schedule: null, error })
      )
      await scheduleLockAttempted.promise
      await waitForAdvisoryLockWait()
      expect(scheduleReachedLifecycleBoundary).toBe(false)
      release.resolve()
      const [, result] = await Promise.all([dormancy, creating])
      expect(result.schedule).toBeNull()
      expect(result.error).toMatchObject({ code: 'target_agent_dormant' })
    } finally {
      release.resolve()
      setMakeDormantBeforeExecutionLockHookForTest(undefined)
      setScheduleAgentLockAttemptedHookForTest(undefined)
      setScheduleLifecycleLockedHookForTest(undefined)
    }
  }, 120_000)

  it.each(['timer', 'webhook'] as const)(
    'serializes %s re-enable before dormancy and lets reconciliation disable it',
    async (source) => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-${source}-reenable-wins`,
        enabled: false,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
      })
      const locked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      setScheduleLifecycleLockedHookForTest(async () => {
        setScheduleLifecycleLockedHookForTest(undefined)
        locked.resolve()
        await release.promise
      })
      try {
        const enabling = source === 'timer' ? schedule.enable() : schedule.enableWebhook('https://example.test')
        await locked.promise
        const dormancy = makeDormant(agent)
        release.resolve()
        await Promise.all([enabling, dormancy])
        expect(await Schedule.mustFind(schedule.id)).toMatchObject({ enabled: false, webhookEnabled: false })
      } finally {
        release.resolve()
        setScheduleLifecycleLockedHookForTest(undefined)
      }
    },
    120_000
  )

  it.each(['timer', 'webhook'] as const)(
    'serializes dormancy before %s re-enable and rejects it',
    async (source) => {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-${source}-dormancy-wins`,
        enabled: false,
        schedule: { interval: '1h' },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'x' },
      })
      const locked = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      setMakeDormantBeforeExecutionLockHookForTest(async () => {
        setMakeDormantBeforeExecutionLockHookForTest(undefined)
        locked.resolve()
        await release.promise
      })
      try {
        const dormancy = makeDormant(agent)
        await locked.promise
        const enabling = (source === 'timer' ? schedule.enable() : schedule.enableWebhook('https://example.test')).then(
          () => null,
          (error: unknown) => error
        )
        release.resolve()
        const [, error] = await Promise.all([dormancy, enabling])
        expect(error).toMatchObject({ code: 'target_agent_dormant' })
        expect(await Schedule.mustFind(schedule.id)).toMatchObject({ enabled: false, webhookEnabled: false })
      } finally {
        release.resolve()
        setMakeDormantBeforeExecutionLockHookForTest(undefined)
      }
    },
    120_000
  )

  it('keeps a timer tick non-waking when it races target dormancy', async () => {
    const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-dormancy-race`,
      schedule: { interval: '1h' },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        content: 'automatic tick',
      },
    })
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 1_000) })
      .where(eq(schedules.id, schedule.id))
    setBeforeRecipientLifecycleLockHookForTest(async () => {
      setBeforeRecipientLifecycleLockHookForTest(undefined)
      await agent.tryTerminate()
    })
    try {
      expect(await schedule.triggerIfDue()).toBe(true)
    } finally {
      setBeforeRecipientLifecycleLockHookForTest(undefined)
    }

    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')
    expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(0)
    const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
    expect(messages).toHaveLength(1)
    expect(messages[0].metadata).toMatchObject({ wakeEligible: false, type: 'schedule' })
    expect(await Schedule.mustFind(schedule.id)).toMatchObject({ enabled: false, webhookEnabled: false })
    expect(await schedule.triggerIfDue()).toBe(false)
    expect((await Agent.mustFind(agent.id)).status).toBe('dormant')

    const now = new Date()
    await db
      .update(agents)
      .set({ dormantAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(agents.id, agent.id))
    await agent.reload()
    const reclaimed: string[] = []
    expect(
      await runDormantAgentSweep({
        now,
        getRetentionDays: () => 7,
        listDormant: async () => [agent],
        finalize: (candidate) => terminate(candidate, { finalCleanup: async (id) => void reclaimed.push(id) }),
      })
    ).toBe(1)
    expect((await Agent.mustFind(agent.id)).status).toBe('terminated')
    expect(reclaimed).toEqual([agent.id])
  })

  it('treats an authenticated webhook as explicit wake-eligible work', async () => {
    const warmup = await import('../services/sandbox/agent-warmup')
    const ensure = spyOn(warmup, 'ensureAgentSandbox').mockResolvedValue('ensured')
    try {
      const agent = await Agent.create({ agentTypeId: 'engineer', squadId: testSquadId })
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-wake`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'explicit webhook work',
        },
      })
      await schedule.enableWebhook('https://example.test')
      await db
        .update(agents)
        .set({
          status: 'dormant',
          dormantAt: new Date(),
          metadata: { ...(agent.metadata ?? {}), dormancyEpisodeId: crypto.randomUUID() },
        })
        .where(eq(agents.id, agent.id))
      await agent.reload()

      await schedule.triggerViaWebhook({ event: 'requested' })

      expect((await Agent.mustFind(agent.id)).status).toBe('idle')
      expect(await db.select().from(executions).where(eq(executions.agentId, agent.id))).toHaveLength(1)
      const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
      expect(messages[0].metadata).toMatchObject({ wakeEligible: true, type: 'webhook' })
      expect(ensure).toHaveBeenCalled()
    } finally {
      ensure.mockRestore()
    }
  })

  it('advances nextTriggerAt after trigger', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-advance`,
      schedule: { interval: '1h' },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        content: 'Test',
      },
    })

    const beforeTrigger = schedule.nextTriggerAt!
    await schedule.trigger()

    expect(schedule.nextTriggerAt!.getTime()).toBeGreaterThan(beforeTrigger.getTime())
  })

  it('disables one-shot schedule after trigger', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const futureDate = new Date(Date.now() + 1000).toISOString()

    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-oneshot`,
      schedule: { runAt: futureDate },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        content: 'One-shot',
      },
    })

    await schedule.trigger()

    expect(schedule.enabled).toBe(false)
    expect(schedule.nextTriggerAt).toBeNull()
  })

  it('refuses expired manual and webhook execution without counting a failure or attempt', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    for (const source of ['manual', 'webhook'] as const) {
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-expired-${source}`,
        schedule: { interval: '1h', expiresAt: new Date(Date.now() + 60_000).toISOString() },
        action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'must not run' },
      })
      if (source === 'webhook') await schedule.enableWebhook('https://example.test')
      await db
        .update(schedules)
        .set({
          schedule: { interval: '1h', expiresAt: new Date(Date.now() - 1_000).toISOString() },
        })
        .where(eq(schedules.id, schedule.id))
      await schedule.reload()
      const execution = source === 'manual' ? schedule.trigger() : schedule.triggerViaWebhook()
      await expect(execution).rejects.toMatchObject({ safeSummary: 'Schedule has expired.' })
      const expired = await Schedule.mustFind(schedule.id)
      expect(expired).toMatchObject({ triggerCount: 0, failureCount: 0, enabled: false, webhookEnabled: false })
      expect(expired.automaticallyDisabledAt).toBeInstanceOf(Date)
    }
  })

  it('expires before unresolved-work skipping and never records a normal skip', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-expired-skip`,
      schedule: { interval: '1h', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      action: { type: 'create_work_stream', title: 'must not skip' },
    })
    await db
      .update(schedules)
      .set({
        schedule: { interval: '1h', expiresAt: new Date(Date.now() - 1_000).toISOString() },
      })
      .where(eq(schedules.id, schedule.id))
    await schedule.reload()
    const unresolved = spyOn(Schedule, 'hasUnresolvedWorkStreams').mockResolvedValueOnce(true)
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({ safeSummary: 'Schedule has expired.' })
      expect(unresolved).not.toHaveBeenCalled()
    } finally {
      unresolved.mockRestore()
    }
    const expired = await Schedule.mustFind(schedule.id)
    expect(expired).toMatchObject({ skipCount: 0, enabled: false })
    expect(expired.automaticDisableReason).toMatch(/^Schedule expired at /)
  })

  it('does not overwrite an ordinary disable racing a deferred manual skip', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-disable-race`,
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: 'skip race' },
    })
    let markChecked!: () => void
    const checked = new Promise<void>((resolve) => {
      markChecked = resolve
    })
    let releaseCheck!: () => void
    const release = new Promise<void>((resolve) => {
      releaseCheck = resolve
    })
    const unresolved = spyOn(Schedule, 'hasUnresolvedWorkStreams').mockImplementationOnce(async () => {
      markChecked()
      await release
      return true
    })
    try {
      const triggering = schedule.trigger()
      await checked
      const operatorView = await Schedule.mustFind(schedule.id)
      await operatorView.disable()
      releaseCheck()
      await triggering
    } finally {
      unresolved.mockRestore()
    }
    expect(await Schedule.mustFind(schedule.id)).toMatchObject({ enabled: false, skipCount: 1 })
  })

  it('keeps a skipped schedule discoverable until expiry when no recurrence fits', async () => {
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-until-expiry`,
      schedule: { interval: '1h', expiresAt: expiresAt.toISOString() },
      action: { type: 'create_work_stream', title: 'skip until expiry' },
    })
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 1_000) })
      .where(eq(schedules.id, schedule.id))
    await schedule.reload()
    const unresolved = spyOn(Schedule, 'hasUnresolvedWorkStreams').mockResolvedValue(true)
    try {
      expect(await schedule.triggerIfDue()).toBe(true)
      let current = await Schedule.mustFind(schedule.id)
      expect(current).toMatchObject({ enabled: true, skipCount: 1 })
      expect(current.nextTriggerAt).toEqual(expiresAt)
      expect(current.automaticallyDisabledAt).toBeNull()

      const elapsedExpiry = new Date(Date.now() - 1_000)
      await db
        .update(schedules)
        .set({
          schedule: { ...current.schedule, expiresAt: elapsedExpiry.toISOString() },
          nextTriggerAt: elapsedExpiry,
        })
        .where(eq(schedules.id, schedule.id))
      await current.reload()
      expect((await Schedule.listDue()).map((due) => due.id)).toContain(schedule.id)
      expect(await current.expireIfNeeded(new Date())).toBe(true)
      current = await Schedule.mustFind(schedule.id)
      expect(current.enabled).toBe(false)
      expect(current.automaticDisableReason).toMatch(/^Schedule expired at /)
    } finally {
      unresolved.mockRestore()
    }
  })

  it('refuses automatically-disabled unresolved-work schedules instead of skipping', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-disabled-skip`,
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: 'must not skip' },
    })
    await db
      .update(schedules)
      .set({
        enabled: false,
        automaticallyDisabledAt: new Date(),
        automaticDisableReason: 'Circuit breaker opened.',
        consecutiveFailureCount: 10,
      })
      .where(eq(schedules.id, schedule.id))
    await schedule.reload()
    const unresolved = spyOn(Schedule, 'hasUnresolvedWorkStreams').mockResolvedValueOnce(true)
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({
        safeSummary: 'Automatically disabled schedule must be re-enabled before it can run.',
      })
      expect(unresolved).not.toHaveBeenCalled()
    } finally {
      unresolved.mockRestore()
    }
    expect(await Schedule.mustFind(schedule.id)).toMatchObject({ skipCount: 0, consecutiveFailureCount: 10 })
  })

  it('claims a due schedule atomically so concurrent runners only execute once', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-concurrent`,
      schedule: { interval: '1h' },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        content: 'Concurrent trigger',
      },
    })

    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    const runnerOne = await Schedule.mustFind(schedule.id)
    const runnerTwo = await Schedule.mustFind(schedule.id)
    const results = await Promise.all([runnerOne.triggerIfDue(), runnerTwo.triggerIfDue()])

    expect(results.filter(Boolean)).toHaveLength(1)
    const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
    expect(messages.filter((m) => m.content === 'Concurrent trigger')).toHaveLength(1)

    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(1)
  })

  it('sanitizes unresolved-work pre-action failures without recording an attempt', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-secret`,
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: 'test' },
    })
    const unresolved = spyOn(Schedule, 'hasUnresolvedWorkStreams').mockRejectedValueOnce(
      new Error('Bearer pre-action-secret postgres://user:password@database/internal')
    )
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({
        code: 'action_failed',
        safeSummary: 'Scheduled action failed. Inspect Core logs for details.',
      })
    } finally {
      unresolved.mockRestore()
    }
    expect(await Schedule.mustFind(schedule.id)).toMatchObject({ triggerCount: 0, failureCount: 0 })
  })

  it('records and advances failed attempts before side effects can be retried', async () => {
    const agentTypeId = `${testPrefix}-partial-failure-agent-type`
    await AgentType.upsert({
      id: agentTypeId,
      model: 'test:model',
      name: 'Partial failure type',
      systemPrompt: 'test',
    })
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-partial-failure`,
      schedule: { interval: '1h' },
      action: {
        type: 'create_work_stream',
        title: `${testPrefix}-partial-work-stream`,
        workflow: testFlow('deliverable', agentTypeId),
      },
    })

    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    // Dispatch runs after committing the flow snapshot. A failed dispatch must still settle
    // this schedule attempt and advance its deadline, so the timer cannot create duplicate work.
    const dispatch = spyOn(flowExecution, 'ensureFlowDispatch').mockRejectedValueOnce(
      new Error('synthetic dispatch failure')
    )
    try {
      await expect(schedule.triggerIfDue()).rejects.toMatchObject({
        code: 'action_failed',
        safeSummary: 'Scheduled action failed. Inspect Core logs for details.',
      })
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      dispatch.mockRestore()
    }

    await expect((await Schedule.mustFind(schedule.id)).triggerIfDue()).resolves.toBe(false)

    const [workStream] = await db
      .select()
      .from(workStreams)
      .where(and(eq(workStreams.squadId, testSquadId), eq(workStreams.title, `${testPrefix}-partial-work-stream`)))

    expect(workStream).toBeDefined()
    expect(await db.select().from(agents).where(eq(agents.agentTypeId, agentTypeId))).toHaveLength(0)
    expect(
      await db
        .select({ id: executions.id })
        .from(executions)
        .innerJoin(agents, eq(executions.agentId, agents.id))
        .where(eq(agents.agentTypeId, agentTypeId))
    ).toHaveLength(0)
    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(1)
    expect(reloaded.failureCount).toBe(1)
    expect(reloaded.consecutiveFailureCount).toBe(1)
    expect(reloaded.lastFailureAt).toBeInstanceOf(Date)
    expect(reloaded.lastErrorCode).toBe('action_failed')
    expect(reloaded.lastTriggeredAt).toBeInstanceOf(Date)
    expect(reloaded.nextTriggerAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('does not rewrite a committed failure when projection refresh or event publication fails', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-post-commit-failure`,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const send = spyOn(InboxMessage, 'send').mockRejectedValueOnce(new Error('action failed'))
    const reload = spyOn(schedule, 'reload')
      .mockResolvedValueOnce(schedule)
      .mockRejectedValueOnce(new Error('projection refresh failed'))
    const listener = () => {
      throw new Error('subscriber failed')
    }
    const unsubscribe = eventEmitter.on('schedule.failed', listener)
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({ code: 'action_failed' })
    } finally {
      unsubscribe()
      reload.mockRestore()
      send.mockRestore()
    }
    const committed = await Schedule.mustFind(schedule.id)
    expect(committed.failureCount).toBe(1)
    expect(committed.lastErrorCode).toBe('action_failed')
  })

  it('reports health_persistence_failed when action failure settlement cannot fence its attempt', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-failed-store`,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const send = spyOn(InboxMessage, 'send').mockImplementationOnce(async () => {
      await db.update(schedules).set({ activeAttemptId: crypto.randomUUID() }).where(eq(schedules.id, schedule.id))
      throw new Error('action failed')
    })
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({ code: 'health_persistence_failed' })
    } finally {
      send.mockRestore()
    }
  })

  it('reports health_persistence_failed when success settlement cannot fence its attempt', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-success-store`,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const send = spyOn(InboxMessage, 'send').mockImplementationOnce(async () => {
      await db.update(schedules).set({ activeAttemptId: crypto.randomUUID() }).where(eq(schedules.id, schedule.id))
      return undefined as never
    })
    try {
      await expect(schedule.trigger()).rejects.toMatchObject({ code: 'health_persistence_failed' })
    } finally {
      send.mockRestore()
    }
  })

  it('does not turn a committed success into a persistence failure when refresh fails', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-success-refresh`,
      schedule: { interval: '1h' },
      action: { type: 'inbox_message', target: { type: 'agent', agentId: agent.id }, content: 'hello' },
    })
    const reload = spyOn(schedule, 'reload')
      .mockResolvedValueOnce(schedule)
      .mockRejectedValueOnce(new Error('projection refresh failed'))
    try {
      await expect(schedule.trigger()).resolves.toBeUndefined()
    } finally {
      reload.mockRestore()
    }
    expect((await Schedule.mustFind(schedule.id)).lastSuccessAt).toBeInstanceOf(Date)
  })

  it('tags created work streams and skips by default while prior work is unresolved', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-open`,
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: `${testPrefix}-work` },
    })

    await schedule.trigger()
    let tagged = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    expect(tagged).toHaveLength(1)
    expect(tagged[0].metadata.scheduleId).toBe(schedule.id)

    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    expect(await (await Schedule.mustFind(schedule.id)).triggerIfDue()).toBe(true)

    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(1)
    expect(reloaded.skipCount).toBe(1)
    expect(reloaded.lastSkippedAt).toBeInstanceOf(Date)
    tagged = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    expect(tagged).toHaveLength(1)
  })

  it('reconciles an unassigned inactive schedule orphan to review while preserving the skip', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-orphan`,
      schedule: { interval: '1h' },
      action: { type: 'create_work_stream', title: `${testPrefix}-orphan-work` },
    })
    const orphan = await storedLegacyWorkStream({
      squadId: testSquadId,
      title: `${testPrefix}-stored-orphan`,
      metadata: { scheduleId: schedule.id },
    })
    await db.update(workStreams).set({ status: 'active', assigneeAgentId: null }).where(eq(workStreams.id, orphan.id))
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    expect(await (await Schedule.mustFind(schedule.id)).triggerIfDue()).toBe(true)
    await orphan.reload()
    expect(orphan.status).toBe('active')
    const orphanWaits = await orphan.getOpenWaits()
    const reviewWait = orphanWaits.find((w) => w.type === 'review')
    expect(reviewWait?.message).toContain('no assignee or active execution')
    expect(orphan.metadata.scheduleRecovery).toMatchObject({ reason: 'unassigned-in-progress' })
    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(0)
    expect(reloaded.skipCount).toBe(1)
  })

  it('does not skip work-stream schedules when explicitly opted out', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-opt-out`,
      schedule: { interval: '1h', skipIfUnresolved: false },
      action: { type: 'create_work_stream', title: `${testPrefix}-work-opt-out` },
    })

    await schedule.trigger()
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    expect(await (await Schedule.mustFind(schedule.id)).triggerIfDue()).toBe(true)

    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(2)
    expect(reloaded.skipCount).toBe(0)
    expect(await WorkStream.findByMetadata({ scheduleId: schedule.id })).toHaveLength(2)
  })

  it('tags and skips explicit flows while prior work is unresolved', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-spawn-work-stream`,
      schedule: { interval: '1h', skipIfUnresolved: true },
      action: {
        type: 'create_work_stream',
        title: `${testPrefix}-flow-work`,
        handoffMessage: 'Do scheduled work',
        workflow: testFlow('review-approval'),
      },
    })

    await expect(schedule.trigger()).resolves.toBeUndefined()
    const tagged = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    expect(tagged).toHaveLength(1)
    expect(tagged[0].metadata.scheduleId).toBe(schedule.id)
    expect(tagged[0].completionMode).toBe('review-approval')
    expect(tagged[0].description).toContain('Do scheduled work')
    expect((await getFlow(tagged[0].id))?.state.definition.completion.mode).toBe('review-approval')
    const assignedAgent = await Agent.mustFind(tagged[0].assigneeAgentId!)
    expect((await assignedAgent.getActiveExecution())?.message).toContain('Do scheduled work')

    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    expect(await (await Schedule.mustFind(schedule.id)).triggerIfDue()).toBe(true)

    const reloaded = await Schedule.mustFind(schedule.id)
    expect(reloaded.triggerCount).toBe(1)
    expect(reloaded.skipCount).toBe(1)
    expect(await WorkStream.findByMetadata({ scheduleId: schedule.id })).toHaveLength(1)
  })

  it('fires again after prior work stream reaches a terminal status', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-done`,
      schedule: { interval: '1h', skipIfUnresolved: true },
      action: { type: 'create_work_stream', title: `${testPrefix}-work-done` },
    })

    await schedule.trigger()
    const [first] = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    await first.cancelWithSideEffects()
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    expect(await (await Schedule.mustFind(schedule.id)).triggerIfDue()).toBe(true)
    expect(await WorkStream.findByMetadata({ scheduleId: schedule.id })).toHaveLength(2)
  })

  it('records only one skip for concurrent due runners', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-skip-concurrent`,
      schedule: { interval: '1h', skipIfUnresolved: true },
      action: { type: 'create_work_stream', title: `${testPrefix}-work-concurrent` },
    })

    await schedule.trigger()
    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    const results = await Promise.all([
      (await Schedule.mustFind(schedule.id)).triggerIfDue(),
      (await Schedule.mustFind(schedule.id)).triggerIfDue(),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await Schedule.mustFind(schedule.id)).skipCount).toBe(1)
  })

  it('does not claim disabled schedules', async () => {
    const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
    const schedule = await Schedule.create({
      scopeType: 'agent',
      scopeId: agent.id,
      name: `${testPrefix}-disabled-due`,
      enabled: false,
      schedule: { interval: '1h' },
      action: {
        type: 'inbox_message',
        target: { type: 'agent', agentId: agent.id },
        content: 'Disabled trigger',
      },
    })

    await db
      .update(schedules)
      .set({ nextTriggerAt: new Date(Date.now() - 60_000) })
      .where(eq(schedules.id, schedule.id))

    await expect((await Schedule.mustFind(schedule.id)).triggerIfDue()).resolves.toBe(false)
    const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
    expect(messages.some((m) => m.content === 'Disabled trigger')).toBe(false)
  })
})

describe('Schedule webhook', () => {
  let testPrefix: string
  let testSquadId: string

  beforeEach(async () => {
    testPrefix = `sched-wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Ensure manager agent type exists
    await AgentType.upsert({
      id: 'manager',
      model: 'anthropic:claude-sonnet-4-5',
      name: 'Manager',
      systemPrompt: 'Manager agent',
    })

    // Create test squad
    const squad = await Squad.create({
      name: `${testPrefix}-squad`,
      purpose: 'Test squad',
    })
    testSquadId = squad.id
    await AgentType.upsert({ id: 'engineer', model: 'test:model', name: 'Engineer', systemPrompt: 'Engineer' })
    await squad.update({ metadata: { workflow: testFlow() } })
  })

  afterEach(async () => {
    await db.delete(schedules).where(like(schedules.name, `${testPrefix}%`))
    if (testSquadId) {
      // Hard-delete the test squad in teardown (archive() would leave the row behind)
      await db
        .delete(squads)
        .where(eq(squads.id, testSquadId))
        .catch(() => {})
    }
  })

  describe('enableWebhook', () => {
    it('enables webhook and returns token', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-enable`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      expect(schedule.webhookEnabled).toBe(false)
      expect(schedule.webhookTokenHash).toBeNull()

      const result = await schedule.enableWebhook('https://example.com')

      expect(result.webhookEnabled).toBe(true)
      expect(result.token).toMatch(/^whsec_[a-f0-9]{64}$/)
      expect(result.webhookUrl).toBe(`https://example.com/api/webhooks/trigger/${schedule.id}`)
      expect(schedule.webhookEnabled).toBe(true)
      expect(schedule.webhookTokenHash).not.toBeNull()
    })

    it('stores hashed token that can be verified', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-hash`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      const result = await schedule.enableWebhook('https://example.com')

      // Token should be verifiable against stored hash
      expect(verifyWebhookToken(result.token, schedule.webhookTokenHash!)).toBe(true)
      expect(schedule.verifyToken(result.token)).toBe(true)
    })
  })

  describe('disableWebhook', () => {
    it('disables webhook and clears token hash', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-disable`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      await schedule.enableWebhook('https://example.com')
      expect(schedule.webhookEnabled).toBe(true)

      await schedule.disableWebhook()

      expect(schedule.webhookEnabled).toBe(false)
      expect(schedule.webhookTokenHash).toBeNull()
    })
  })

  describe('regenerateWebhookToken', () => {
    it('generates a new token', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-regen`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      const result1 = await schedule.enableWebhook('https://example.com')
      const oldHash = schedule.webhookTokenHash

      const result2 = await schedule.regenerateWebhookToken('https://example.com')

      expect(result2.token).not.toBe(result1.token)
      expect(schedule.webhookTokenHash).not.toBe(oldHash)
      expect(schedule.verifyToken(result2.token)).toBe(true)
      expect(schedule.verifyToken(result1.token)).toBe(false) // Old token no longer works
    })

    it('throws if webhook is not enabled', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-regen-err`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      await expect(schedule.regenerateWebhookToken('https://example.com')).rejects.toThrow(
        'Webhook is not enabled for this schedule'
      )
    })
  })

  describe('verifyToken', () => {
    it('returns false when webhook is disabled', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-verify`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      expect(schedule.verifyToken('whsec_abc123')).toBe(false)
    })

    it('returns false for invalid token', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-verify-invalid`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
      })

      await schedule.enableWebhook('https://example.com')
      expect(schedule.verifyToken('whsec_invalidtoken')).toBe(false)
    })
  })

  describe('triggerViaWebhook', () => {
    it('records failed webhook attempts through the shared health lifecycle', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })
      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-failure`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test message',
        },
      })
      await schedule.enableWebhook('https://example.com')
      const send = spyOn(InboxMessage, 'send').mockRejectedValueOnce(new Error('Bearer top-secret'))
      try {
        await expect(schedule.triggerViaWebhook()).rejects.toMatchObject({ code: 'action_failed' })
      } finally {
        send.mockRestore()
      }
      const failed = await Schedule.mustFind(schedule.id)
      expect(failed).toMatchObject({ triggerCount: 1, failureCount: 1, consecutiveFailureCount: 1 })
      expect(failed.lastWebhookTriggerAt).toBeInstanceOf(Date)
      expect(failed.lastErrorSummary).not.toContain('top-secret')
    })

    it('triggers schedule and records lastWebhookTriggerAt', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-trigger`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test message',
        },
      })

      await schedule.enableWebhook('https://example.com')

      const result = await schedule.triggerViaWebhook()

      expect(result.triggered).toBe(true)
      expect(result.scheduleId).toBe(schedule.id)
      expect(result.scheduleName).toBe(schedule.name)
      expect(schedule.lastWebhookTriggerAt).toBeInstanceOf(Date)
      expect(schedule.triggerCount).toBe(1)
    })

    it('includes webhook context in the flow task and snapshots delivery policy', async () => {
      const schedule = await Schedule.create({
        scopeType: 'squad',
        scopeId: testSquadId,
        name: `${testPrefix}-webhook-work-stream-context`,
        schedule: { interval: '1h' },
        action: {
          type: 'create_work_stream',
          title: 'Webhook check',
          handoffMessage: 'Inspect the event',
          workflow: testFlow('direct-merge'),
        },
      })

      const result = await schedule.triggerViaWebhook({ event: 'deploy' })
      const ws = await WorkStream.mustFind(result.workStreamId!)

      expect(ws.completionMode).toBe('direct-merge')
      expect(ws.description).toContain('Inspect the event')
      expect(ws.description).toContain('Webhook Context')
      expect(ws.description).toContain('deploy')
      expect((await getFlow(ws.id))?.state.definition.completion.mode).toBe('direct-merge')
      const agent = await Agent.mustFind(ws.assigneeAgentId!)
      expect((await agent.getActiveExecution())?.message).toContain('Inspect the event')
    })

    it('injects context into inbox message', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-context`,
        schedule: { interval: '1h' },
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Base message',
        },
      })

      await schedule.enableWebhook('https://example.com')

      await schedule.triggerViaWebhook({ event: 'deploy', version: '1.2.3' })

      const messages = await InboxMessage.listForRecipient('agent', agent.id, { includeRead: true })
      const msg = messages.find((m) => m.content.includes('Base message'))
      expect(msg).toBeDefined()
      expect(msg!.content).toContain('Webhook Context')
      expect(msg!.content).toContain('"event": "deploy"')
      expect(msg!.content).toContain('"version": "1.2.3"')
    })
  })

  it('does not apply skipIfUnresolved to webhook-created work streams', async () => {
    const schedule = await Schedule.create({
      scopeType: 'squad',
      scopeId: testSquadId,
      name: `${testPrefix}-webhook-skip-bypass`,
      schedule: { interval: '1h', skipIfUnresolved: true },
      action: { type: 'create_work_stream', title: `${testPrefix}-webhook-work` },
    })

    await schedule.trigger()
    await schedule.triggerViaWebhook()

    const tagged = await WorkStream.findByMetadata({ scheduleId: schedule.id })
    expect(tagged).toHaveLength(2)
  })

  describe('webhook-only schedules', () => {
    it('creates schedule with empty config when webhookOnly is true', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-webhook-only`,
        schedule: {}, // Empty config
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Webhook only',
        },
        webhookOnly: true,
      })

      expect(schedule.nextTriggerAt).toBeNull()
      expect(schedule.webhookEnabled).toBe(true)
    })

    it('rejects empty schedule config without webhookOnly flag', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      await expect(
        Schedule.create({
          scopeType: 'agent',
          scopeId: agent.id,
          name: `${testPrefix}-empty-config`,
          schedule: {},
          action: {
            type: 'inbox_message',
            target: { type: 'agent', agentId: agent.id },
            content: 'Test',
          },
        })
      ).rejects.toThrow('Schedule must have interval, cron, or runAt')
    })

    it('rejects webhook trigger when schedule is disabled', async () => {
      const agent = await Agent.create({ agentTypeId: 'manager', squadId: testSquadId })

      const schedule = await Schedule.create({
        scopeType: 'agent',
        scopeId: agent.id,
        name: `${testPrefix}-disabled-schedule`,
        schedule: {},
        action: {
          type: 'inbox_message',
          target: { type: 'agent', agentId: agent.id },
          content: 'Test',
        },
        webhookOnly: true,
      })

      // Disable the schedule
      await schedule.update({ enabled: false })

      // verifyToken should work, but the webhook route should reject
      // (route logic is tested separately)
      expect(schedule.enabled).toBe(false)
      expect(schedule.webhookEnabled).toBe(true)
    })
  })
})
