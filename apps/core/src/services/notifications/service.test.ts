import { getSettingsStore } from '../settings'
import * as relayModule from '../push/relay'
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test'
import { generateKeyPairSync } from 'crypto'
import webpush from 'web-push'
import { eq } from 'drizzle-orm'
import { NotificationService } from './service'
import type { NotificationConfig, EventContext } from './types'
import { db, apnsDevices, pushSubscriptions, desktopNotifications } from '../../db'
import { eventBuilders } from './event-builders'
import { cleanupTestRbac, createTestUser, type TestUser } from '../../test-utils'
import { registerApnsDevice, getApnsDevicesByUser } from '../push/apns-devices'
import { registerPushSubscription } from '../push/subscriptions'
import { resetSecretStore } from '../secrets'
import * as apnsModule from '../push/apns'
import * as desktopPushModule from '../push/desktop'
import * as questionsModule from '../agents/questions'
import { UserNotificationPreferences } from '../../entities/UserNotificationPreferences'

const APNS_ENV_KEYS = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_ENV'] as const

function installApnsEnv(environment: 'production' | 'sandbox' = 'production') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  process.env.APNS_KEY_P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  process.env.APNS_KEY_ID = 'KID123'
  process.env.APNS_TEAM_ID = 'TEAM456'
  process.env.APNS_BUNDLE_ID = 'ai.hiretau.mobile'
  process.env.APNS_ENV = environment
  resetSecretStore()
}

type TestEvent = {
  type?: string
  notificationKind?: string
  source?: string
  workStreamNumber?: number
  title: string
  body: string
  url?: string
  squadId?: string
  agentId?: string
  workStreamId?: string
  waitId?: string
  questionId?: string
  messageId?: string
  actionId?: string
  subtitle?: string
  collapseKey?: string
  threadKey?: string
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive'
}

async function callResolveEnabledPushUserIds(service: NotificationService, data: unknown, eventType: string) {
  const resolveEnabledPushUserIds = (service as any).resolveEnabledPushUserIds.bind(service) as (
    data: unknown,
    eventType: string
  ) => Promise<string[]>
  return resolveEnabledPushUserIds(data, eventType)
}

async function callSendPushNotifications(
  service: NotificationService,
  event: TestEvent | null,
  data: unknown,
  eventType: string
) {
  const sendPushNotifications = (service as any).sendPushNotifications.bind(service) as (
    event: TestEvent | null,
    data: unknown,
    eventType: string
  ) => Promise<void>
  await sendPushNotifications(event, data, eventType)
}

async function callSendWebPush(service: NotificationService, userIds: string[], event: TestEvent) {
  const sendWebPush = (service as any).sendWebPush.bind(service) as (
    userIds: string[],
    event: TestEvent
  ) => Promise<void>
  await sendWebPush(userIds, event)
}

async function callSendApnsPush(service: NotificationService, userIds: string[], event: TestEvent) {
  const sendApnsPush = (service as any).sendApnsPush.bind(service) as (
    userIds: string[],
    event: TestEvent
  ) => Promise<void>
  await sendApnsPush(userIds, event)
}

describe('NotificationService', () => {
  let previousVapidSubject: string | undefined
  let service: NotificationService
  let consoleSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    previousVapidSubject = process.env.VAPID_SUBJECT
    process.env.VAPID_SUBJECT = 'mailto:fixture@example.com'
    for (const key of APNS_ENV_KEYS) delete process.env[key]
    resetSecretStore()
    service = new NotificationService()
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    if (previousVapidSubject === undefined) delete process.env.VAPID_SUBJECT
    else process.env.VAPID_SUBJECT = previousVapidSubject
    consoleSpy.mockRestore()
    for (const key of APNS_ENV_KEYS) delete process.env[key]
    resetSecretStore()
  })

  describe('matchRule', () => {
    const config: NotificationConfig = {
      rules: [
        { event: 'execution.failed', channels: ['console'] },
        { event: 'inbox.messageReceived', channels: ['console'] },
        { channels: ['console'] }, // catch-all
      ],
      channels: { console: { enabled: true } },
    }

    beforeEach(() => {
      service.setConfig(config)
    })

    test('matches exact event', () => {
      const ctx: EventContext = { event: 'inbox.messageReceived' }
      const rule = service.matchRule(ctx)
      expect(rule).not.toBeNull()
      expect(rule!.event).toBe('inbox.messageReceived')
    })

    test('first match wins', () => {
      const ctx: EventContext = { event: 'inbox.messageReceived' }
      const rule = service.matchRule(ctx)
      expect(rule!.event).toBe('inbox.messageReceived')
    })

    test('returns null if no rules and no catch-all', () => {
      service.setConfig({ rules: [], channels: {} })
      const ctx: EventContext = { event: 'inbox.messageReceived' }
      const rule = service.matchRule(ctx)
      expect(rule).toBeNull()
    })

    test('falls through to catch-all for unmatched events', () => {
      const ctx: EventContext = { event: 'unknown.event' }
      const rule = service.matchRule(ctx)
      expect(rule).not.toBeNull()
      expect(rule!.event).toBeUndefined() // catch-all
    })

    describe('match conditions', () => {
      test('matches when data field equals expected value', () => {
        service.setConfig({
          rules: [{ event: 'inbox.messageReceived', match: { 'message.recipientType': 'human' }, channels: ['push'] }],
          channels: { push: { enabled: true } },
        })
        const ctx: EventContext = { event: 'inbox.messageReceived' }
        const data = { message: { recipientType: 'human', content: 'Hello' } }
        const rule = service.matchRule(ctx, data)
        expect(rule).not.toBeNull()
        expect(rule!.channels).toEqual(['push'])
      })

      test('does not match when data field differs from expected value', () => {
        service.setConfig({
          rules: [{ event: 'inbox.messageReceived', match: { 'message.recipientType': 'human' }, channels: ['push'] }],
          channels: { push: { enabled: true } },
        })
        const ctx: EventContext = { event: 'inbox.messageReceived' }
        const data = { message: { recipientType: 'agent', content: 'Hello' } }
        const rule = service.matchRule(ctx, data)
        expect(rule).toBeNull()
      })

      test('does not match when nested path does not exist', () => {
        service.setConfig({
          rules: [{ event: 'inbox.messageReceived', match: { 'message.recipientType': 'human' }, channels: ['push'] }],
          channels: { push: { enabled: true } },
        })
        const ctx: EventContext = { event: 'inbox.messageReceived' }
        const data = { message: { content: 'Hello' } } // no recipientType
        const rule = service.matchRule(ctx, data)
        expect(rule).toBeNull()
      })

      test('matches deeply nested paths', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { 'a.b.c.d': 'value' }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        const data = { a: { b: { c: { d: 'value' } } } }
        const rule = service.matchRule(ctx, data)
        expect(rule).not.toBeNull()
      })

      test('matches multiple conditions (all must match)', () => {
        service.setConfig({
          rules: [
            {
              event: 'inbox.messageReceived',
              match: { 'message.recipientType': 'human', 'message.senderType': 'agent' },
              channels: ['push'],
            },
          ],
          channels: { push: { enabled: true } },
        })
        const ctx: EventContext = { event: 'inbox.messageReceived' }

        // Both match
        const data1 = { message: { recipientType: 'human', senderType: 'agent' } }
        expect(service.matchRule(ctx, data1)).not.toBeNull()

        // Only one matches
        const data2 = { message: { recipientType: 'human', senderType: 'system' } }
        expect(service.matchRule(ctx, data2)).toBeNull()
      })

      test('matches top-level fields without dot notation', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { status: 'active' }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        const data = { status: 'active' }
        const rule = service.matchRule(ctx, data)
        expect(rule).not.toBeNull()
      })

      test('does not match when data is null', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { field: 'value' }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        const rule = service.matchRule(ctx, null)
        expect(rule).toBeNull()
      })

      test('does not match when data is undefined', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { field: 'value' }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        const rule = service.matchRule(ctx, undefined)
        expect(rule).toBeNull()
      })

      test('falls through to next rule when match fails', () => {
        service.setConfig({
          rules: [
            { event: 'inbox.messageReceived', match: { 'message.recipientType': 'human' }, channels: ['push'] },
            { event: 'inbox.messageReceived', channels: ['console'] }, // fallback without match
          ],
          channels: { push: { enabled: true }, console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'inbox.messageReceived' }
        const data = { message: { recipientType: 'agent' } }
        const rule = service.matchRule(ctx, data)
        expect(rule).not.toBeNull()
        expect(rule!.channels).toEqual(['console'])
      })

      test('matches numeric values', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { count: 5 }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        expect(service.matchRule(ctx, { count: 5 })).not.toBeNull()
        expect(service.matchRule(ctx, { count: 10 })).toBeNull()
      })

      test('matches boolean values', () => {
        service.setConfig({
          rules: [{ event: 'test.event', match: { active: true }, channels: ['console'] }],
          channels: { console: { enabled: true } },
        })
        const ctx: EventContext = { event: 'test.event' }
        expect(service.matchRule(ctx, { active: true })).not.toBeNull()
        expect(service.matchRule(ctx, { active: false })).toBeNull()
      })
    })
  })

  describe('buildContext', () => {
    test('returns event in context', () => {
      const ctx = service.buildContext('execution.failed', { execution: {}, error: 'err' })
      expect(ctx.event).toBe('execution.failed')
    })

    test('handles any event type', () => {
      const ctx = service.buildContext('unknown.event', {})
      expect(ctx.event).toBe('unknown.event')
    })
  })

  describe('notify', () => {
    beforeEach(() => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console'] }],
        channels: { console: { enabled: true } },
      })
    })

    test('logs when notification config is missing', async () => {
      const unconfiguredService = new NotificationService()
      await unconfiguredService.notify('inbox.messageReceived', {})
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('Notification config not loaded; skipping inbox.messageReceived')
    })

    test('a newly registered push event reaches web, APNs, and desktop through shared recipient preferences', async () => {
      const prefix = `notification-fanout-${crypto.randomUUID()}`
      const eventType = `${prefix}.created`
      const previousDesktop = process.env.FICUS_DESKTOP_MANAGED
      const configureSpy = spyOn(service, 'configureVapid').mockResolvedValue()
      const webSpy = spyOn(service as any, 'sendWebPush').mockImplementation(async () => {})
      const apnsSpy = spyOn(service as any, 'sendApnsPush').mockImplementation(async () => {})
      const event = {
        type: eventType,
        messageId: crypto.randomUUID(),
        title: 'New event',
        body: 'Ready for attention',
        url: '/inbox',
        timestamp: new Date(),
      }
      try {
        const user = await createTestUser({ prefix })
        process.env.FICUS_DESKTOP_MANAGED = '1'
        eventBuilders[eventType] = async () => event
        service.setConfig({ rules: [{ event: eventType, channels: ['push'] }], channels: { push: { enabled: true } } })
        const data = { recipientType: 'user', recipientId: user.id }

        await service.notify(eventType, data)

        expect(webSpy).toHaveBeenCalledTimes(1)
        expect(webSpy).toHaveBeenCalledWith([user.id], event)
        expect(apnsSpy).toHaveBeenCalledTimes(1)
        expect(apnsSpy).toHaveBeenCalledWith([user.id], event)
        const rows = await db.select().from(desktopNotifications).where(eq(desktopNotifications.userId, user.id))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          userId: user.id,
          eventType,
          category: 'message',
          title: event.title,
          body: event.body,
          url: event.url,
        })

        await db.delete(desktopNotifications).where(eq(desktopNotifications.userId, user.id))
        webSpy.mockClear()
        apnsSpy.mockClear()
        await UserNotificationPreferences.upsert(user.id, { mutedEvents: [eventType] })
        await service.notify(eventType, data)
        expect(webSpy).not.toHaveBeenCalled()
        expect(apnsSpy).not.toHaveBeenCalled()
        expect(
          await db.select().from(desktopNotifications).where(eq(desktopNotifications.userId, user.id))
        ).toHaveLength(0)
      } finally {
        delete eventBuilders[eventType]
        if (previousDesktop === undefined) delete process.env.FICUS_DESKTOP_MANAGED
        else process.env.FICUS_DESKTOP_MANAGED = previousDesktop
        configureSpy.mockRestore()
        webSpy.mockRestore()
        apnsSpy.mockRestore()
        await cleanupTestRbac(prefix)
      }
    })

    test('logs to console when rule matches', async () => {
      await service.notify('inbox.messageReceived', { message: { content: 'Test Message' } })
      expect(consoleSpy).toHaveBeenCalled()
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('[notify]')
      expect(allLogs).toContain('inbox.messageReceived')
    })

    test('logs when no rule matches', async () => {
      await service.notify('unknown.event', {})
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('[notify]')
      expect(allLogs).toContain('Event unknown.event matched no notification rule')
    })

    test('does not log when channel is disabled', async () => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console'] }],
        channels: { console: { enabled: false } },
      })
      await service.notify('inbox.messageReceived', { message: {} })
      expect(consoleSpy).not.toHaveBeenCalled()
    })

    test('does not route a configured channel without a truthy enabled value', async () => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console'] }],
        channels: { console: { enabled: undefined } as any },
      })
      await service.notify('inbox.messageReceived', { message: {} })
      expect(consoleSpy).not.toHaveBeenCalled()
    })

    test('routes a channel without a channel config', async () => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console'] }],
        channels: {},
      })
      await service.notify('inbox.messageReceived', { message: {} })
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('inbox.messageReceived → console')
    })

    test('sends to multiple channels', async () => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console', 'push'] }],
        channels: { console: { enabled: true }, push: { enabled: true } },
      })
      await service.notify('inbox.messageReceived', { message: { content: 'Test' } })
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      // Should log both console and push channel routing
      expect(allLogs).toContain('inbox.messageReceived → console')
      expect(allLogs).toContain('inbox.messageReceived → push')
    })

    test('skips disabled channels in multi-channel rule', async () => {
      service.setConfig({
        rules: [{ event: 'inbox.messageReceived', channels: ['console', 'push'] }],
        channels: { console: { enabled: true }, push: { enabled: false } },
      })
      await service.notify('inbox.messageReceived', { message: { content: 'Test' } })
      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('inbox.messageReceived → console')
      expect(allLogs).not.toContain('inbox.messageReceived → push')
    })
  })

  describe('sendPushNotifications', () => {
    test('uses the agent question notify audience and per-user preferences', async () => {
      const audienceSpy = spyOn(questionsModule, 'listAgentQuestionNotifyUserIds').mockResolvedValue([
        'owner-user',
        'watcher-user',
        'owner-user',
      ])
      const preferenceSpy = spyOn(UserNotificationPreferences, 'shouldPush').mockImplementation(
        async (userId, eventType) => userId === 'owner-user' && eventType === 'agent-question.created'
      )

      try {
        expect(
          await callResolveEnabledPushUserIds(
            service,
            { questionId: 'q1', recipientType: 'user', recipientId: 'forged' },
            'agent-question.created'
          )
        ).toEqual(['owner-user'])
        expect(audienceSpy).toHaveBeenCalledWith('q1')
      } finally {
        audienceSpy.mockRestore()
        preferenceSpy.mockRestore()
      }
    })

    test('gates each push on the category derived from the built event, not only the raw event type', async () => {
      const calls: Array<[string, string, string | undefined]> = []
      const preferenceSpy = spyOn(UserNotificationPreferences, 'shouldPush').mockImplementation(
        async (userId, eventType, category) => {
          calls.push([userId, eventType, category])
          return false
        }
      )
      try {
        await callSendPushNotifications(
          service,
          { type: 'inbox.messageReceived', notificationKind: 'workStream.done', title: 'Completed', body: 'x' },
          { recipientType: 'user', recipientId: 'category-user', messageId: 'm1' },
          'inbox.messageReceived'
        )
        await callSendPushNotifications(
          service,
          { type: 'inbox.messageReceived', source: 'fleet-alert', title: 'Alert', body: 'x' },
          { recipientType: 'user', recipientId: 'category-user', messageId: 'm2' },
          'inbox.messageReceived'
        )
        expect(calls).toEqual([
          ['category-user', 'inbox.messageReceived', 'done'],
          ['category-user', 'inbox.messageReceived', 'fleet'],
        ])
      } finally {
        preferenceSpy.mockRestore()
      }
    })

    test('resolves a saved Assistant mailbox to its owner and nobody after deletion or muting', async () => {
      const { assistantConversations } = await import('../../db')
      const owner = await createTestUser({ prefix: 'notif-assistant' })
      const conversationId = crypto.randomUUID()
      await db.insert(assistantConversations).values({ id: conversationId, ownerUserId: owner.id })
      const data = { recipientType: 'voice_assistant', recipientId: `assistant:${conversationId}`, messageId: 'm1' }
      try {
        expect(await callResolveEnabledPushUserIds(service, data, 'inbox.messageReceived')).toEqual([owner.id])
        await UserNotificationPreferences.upsert(owner.id, { mutedEvents: ['inbox.messageReceived'] })
        expect(await callResolveEnabledPushUserIds(service, data, 'inbox.messageReceived')).toEqual([])
        await UserNotificationPreferences.upsert(owner.id, { mutedEvents: [] })
        expect(await callResolveEnabledPushUserIds(service, data, 'inbox.messageReceived')).toEqual([owner.id])
        await db.delete(assistantConversations).where(eq(assistantConversations.id, conversationId))
        expect(await callResolveEnabledPushUserIds(service, data, 'inbox.messageReceived')).toEqual([])
      } finally {
        await db.delete(assistantConversations).where(eq(assistantConversations.id, conversationId))
        await cleanupTestRbac('notif-assistant')
      }
    })

    test('bundled rules only put the push channel on events that can resolve recipients', async () => {
      const { join } = await import('node:path')
      const { MONOREPO_ROOT } = await import('../../lib/paths')
      const bundled = Bun.YAML.parse(
        await Bun.file(join(MONOREPO_ROOT, 'config/notifications/rules.yaml')).text()
      ) as NotificationConfig
      const pushEvents = bundled.rules.filter((rule) => rule.channels.includes('push')).map((rule) => rule.event)
      expect(new Set(pushEvents)).toEqual(new Set(['agent-question.created', 'inbox.messageReceived']))
    })

    test('routes only push-eligible Assistant updates to push', async () => {
      const { join } = await import('node:path')
      const { MONOREPO_ROOT } = await import('../../lib/paths')
      const bundled = Bun.YAML.parse(
        await Bun.file(join(MONOREPO_ROOT, 'config/notifications/rules.yaml')).text()
      ) as NotificationConfig
      service.setConfig(bundled)
      const context = service.buildContext('inbox.messageReceived', {})
      const eligible = service.matchRule(context, {
        recipientType: 'voice_assistant',
        recipientId: 'assistant:507a9ac0-164e-4f49-9441-e57522bdc52b',
        assistantPush: true,
      })
      expect(eligible?.id).toBe('assistant-task-update')
      expect(eligible?.channels).toEqual(['push'])
      const routine = service.matchRule(context, {
        recipientType: 'voice_assistant',
        recipientId: 'assistant:507a9ac0-164e-4f49-9441-e57522bdc52b',
      })
      expect(routine).toBeNull()
    })

    test('fans out the same agent question notification through web push and APNs', async () => {
      const event: TestEvent = {
        title: 'Question',
        body: 'Which release?',
        actionId: 'agent-question:q1',
        agentId: 'a1',
        squadId: 's1',
      }
      const configureSpy = spyOn(service, 'configureVapid').mockResolvedValue()
      const resolveSpy = spyOn(service as any, 'resolveEnabledPushUserIds').mockResolvedValue(['owner-user'])
      const webSpy = spyOn(service as any, 'sendWebPush').mockImplementation(async () => {})
      const apnsSpy = spyOn(service as any, 'sendApnsPush').mockImplementation(async () => {})
      const desktopSpy = spyOn(desktopPushModule, 'enqueueDesktopNotifications').mockResolvedValue()

      try {
        await callSendPushNotifications(service, event, { questionId: 'q1' }, 'agent-question.created')

        expect(webSpy).toHaveBeenCalledWith(['owner-user'], event)
        expect(apnsSpy).toHaveBeenCalledWith(['owner-user'], event)
        expect(webSpy.mock.calls[0][1]).toBe(apnsSpy.mock.calls[0][1])
      } finally {
        configureSpy.mockRestore()
        resolveSpy.mockRestore()
        webSpy.mockRestore()
        apnsSpy.mockRestore()
        desktopSpy.mockRestore()
      }
    })

    test('does not fan out an agent question when preferences exclude every recipient', async () => {
      const configureSpy = spyOn(service, 'configureVapid').mockResolvedValue()
      const audienceSpy = spyOn(questionsModule, 'listAgentQuestionNotifyUserIds').mockResolvedValue(['muted-user'])
      const preferenceSpy = spyOn(UserNotificationPreferences, 'shouldPush').mockResolvedValue(false)
      const webSpy = spyOn(service as any, 'sendWebPush').mockImplementation(async () => {})
      const apnsSpy = spyOn(service as any, 'sendApnsPush').mockImplementation(async () => {})

      try {
        await callSendPushNotifications(
          service,
          { title: 'Question', body: 'Which release?' },
          { questionId: 'q1' },
          'agent-question.created'
        )

        expect(preferenceSpy).toHaveBeenCalledWith('muted-user', 'agent-question.created', 'question')
        expect(webSpy).not.toHaveBeenCalled()
        expect(apnsSpy).not.toHaveBeenCalled()
      } finally {
        configureSpy.mockRestore()
        audienceSpy.mockRestore()
        preferenceSpy.mockRestore()
        webSpy.mockRestore()
        apnsSpy.mockRestore()
      }
    })

    test('logs resolved recipient user IDs before fanout', async () => {
      await callSendPushNotifications(
        service,
        { title: 'Hello', body: 'World', url: '/inbox' },
        { recipientType: 'user', recipientId: '00000000-0000-0000-0000-000000000001' },
        'inbox.messageReceived'
      )

      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain(
        'Resolved push recipients for inbox.messageReceived: 00000000-0000-0000-0000-000000000001'
      )
    })

    test('logs when recipient resolution finds no push recipients', async () => {
      await callSendPushNotifications(
        service,
        { title: 'Hello', body: 'World', url: '/inbox' },
        { recipientType: 'agent', recipientId: 'agent-1' },
        'inbox.messageReceived'
      )

      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('Resolved push recipients for inbox.messageReceived: none')
      expect(allLogs).toContain('No push recipients for inbox.messageReceived; skipping push')
    })
  })

  describe('sendWebPush', () => {
    const prefix = `notification-web-push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let user: TestUser
    let otherUser: TestUser

    beforeAll(async () => {
      user = await createTestUser({ prefix })
      otherUser = await createTestUser({ prefix })
    })

    afterAll(async () => {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, otherUser.id))
      await cleanupTestRbac(prefix)
    })

    beforeEach(async () => {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, otherUser.id))
    })

    afterEach(async () => {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, otherUser.id))
    })

    test('logs when recipients have no web push subscriptions', async () => {
      await callSendWebPush(service, [user.id], {
        title: 'Hello',
        body: 'World',
        url: '/inbox',
      })

      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('No web push subscriptions for 1 recipient(s); skipping web push')
    })

    test('delivers once to the current endpoint owner and never to the former owner', async () => {
      const endpoint = 'https://push.example.com/transferred-delivery'
      await registerPushSubscription({
        endpoint,
        p256dh: 'former-key',
        auth: 'former-auth',
        userId: user.id,
      })
      await registerPushSubscription({
        endpoint,
        p256dh: 'current-key',
        auth: 'current-auth',
        userId: otherUser.id,
      })
      const sendSpy = spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as any)

      try {
        const event = { title: 'Current only', body: 'Current owner content', url: '/inbox' }
        await callSendWebPush(service, [user.id, otherUser.id], event)

        expect(sendSpy).toHaveBeenCalledTimes(1)
        expect(sendSpy.mock.calls[0][0]).toEqual({
          endpoint,
          keys: { p256dh: 'current-key', auth: 'current-auth' },
        })

        await callSendWebPush(service, [user.id], event)
        expect(sendSpy).toHaveBeenCalledTimes(1)
      } finally {
        sendSpy.mockRestore()
      }
    })

    test('web push carries the collapse key as the notification tag', async () => {
      await registerPushSubscription({
        endpoint: 'https://push.example.com/tag',
        p256dh: 'k',
        auth: 'a',
        userId: user.id,
      })
      const sendSpy = spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as any)
      try {
        await callSendWebPush(service, [user.id], {
          title: 'Completed: #197 · Validate deletion',
          body: 'Next steps: ship it',
          collapseKey: 'ws:abc',
          url: '/inbox',
        })
        expect(JSON.parse(sendSpy.mock.calls[0][1] as string)).toMatchObject({ tag: 'ws:abc', renotify: true })
        await callSendWebPush(service, [user.id], { title: 'Plain', body: 'No key', url: '/inbox' })
        expect(JSON.parse(sendSpy.mock.calls[1][1] as string)).not.toHaveProperty('tag')
      } finally {
        sendSpy.mockRestore()
      }
    })

    test('does not remove a transferred subscription after a stale 410 response', async () => {
      const endpoint = 'https://push.example.com/stale-410'
      const former = await registerPushSubscription({
        endpoint,
        p256dh: 'same-key',
        auth: 'same-auth',
        userId: user.id,
      })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const sendSpy = spyOn(webpush, 'sendNotification').mockImplementation(async () => {
        entered.resolve()
        await release.promise
        throw Object.assign(new Error('gone'), { statusCode: 410 })
      })

      try {
        const pendingSend = callSendWebPush(service, [user.id], {
          title: 'Stale',
          body: 'Old snapshot',
          url: '/inbox',
        })
        await entered.promise
        const current = await registerPushSubscription({
          endpoint,
          p256dh: 'same-key',
          auth: 'same-auth',
          userId: otherUser.id,
        })
        release.resolve()
        await pendingSend

        expect(current.id).toBe(former.id)
        expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, former.id))).toEqual([
          expect.objectContaining({ id: former.id, userId: otherUser.id }),
        ])
      } finally {
        release.resolve()
        sendSpy.mockRestore()
      }
    })

    test('forwards routing fields in the web-push payload data', async () => {
      await registerPushSubscription({
        endpoint: 'https://push.example.com/routing',
        p256dh: 'test-p256dh-key',
        auth: 'test-auth-secret',
        userId: user.id,
      })
      const sendSpy = spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201 } as any)

      try {
        await callSendWebPush(service, [user.id], {
          title: 'Blocked',
          body: 'needs input',
          url: '/squads/s1/work?ws=ws1',
          squadId: 's1',
          agentId: 'a1',
          workStreamId: 'ws1',
          waitId: 'wait1',
          questionId: 'q1',
          messageId: 'm1',
          actionId: 'agent-question:q1',
        })

        expect(sendSpy).toHaveBeenCalledTimes(1)
        expect(JSON.parse(sendSpy.mock.calls[0][1] as string)).toMatchObject({
          title: 'Blocked',
          body: 'needs input',
          url: '/squads/s1/work?ws=ws1',
          squadId: 's1',
          agentId: 'a1',
          workStreamId: 'ws1',
          waitId: 'wait1',
          questionId: 'q1',
          messageId: 'm1',
          actionId: 'agent-question:q1',
        })
        await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
        await callSendWebPush(service, [user.id], {
          type: 'agent-question.created',
          workStreamNumber: 42,
          title: 'Private work title',
          body: 'Private question text',
          url: '/squads/s1/work?ws=42',
        })
        expect(JSON.parse(sendSpy.mock.calls[1][1] as string)).toMatchObject({
          title: 'Work #42 needs your answer',
          body: 'Open Ficus to see details.',
          workStreamId: '42',
        })
      } finally {
        await UserNotificationPreferences.upsert(user.id, { showPreviews: true })
        sendSpy.mockRestore()
      }
    })
  })

  describe('sendApnsPush', () => {
    const prefix = `notification-apns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let user: TestUser

    beforeAll(async () => {
      user = await createTestUser({ prefix })
    })

    afterAll(async () => {
      await db.delete(apnsDevices).where(eq(apnsDevices.userId, user.id))
      await cleanupTestRbac(prefix)
    })

    beforeEach(async () => {
      await db.delete(apnsDevices).where(eq(apnsDevices.userId, user.id))
      installApnsEnv('production')
    })

    afterEach(async () => {
      await db.delete(apnsDevices).where(eq(apnsDevices.userId, user.id))
    })

    test('Apple Push disable suppresses both relay and direct delivery and can be re-enabled', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'disabled-push-token',
        platform: 'ios',
        environment: 'production',
      })
      await db.update(apnsDevices).set({ relayBindingToken: 'ficus_prd_test' }).where(eq(apnsDevices.userId, user.id))
      const stored = getSettingsStore().getStoredValue.bind(getSettingsStore())
      let enabled = false
      const settings = spyOn(getSettingsStore(), 'getStoredValue').mockImplementation((key) =>
        key === '__integration-enabled:apple-push' ? String(enabled) : stored(key)
      )
      const direct = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })
      const relay = spyOn(relayModule, 'sendRelayAlert').mockResolvedValue({ accepted: true, reason: undefined })
      const config = spyOn(relayModule, 'pushRelayConfig').mockReturnValue({
        token: 'fixture',
        instanceId: 'fixture',
        baseUrl: 'https://example.invalid',
      })
      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })
        expect(relay).not.toHaveBeenCalled()
        expect(direct).not.toHaveBeenCalled()
        enabled = true
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })
        expect(relay).toHaveBeenCalledTimes(1)
        config.mockReturnValue(null)
        enabled = false
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })
        expect(direct).not.toHaveBeenCalled()
        enabled = true
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })
        expect(direct).toHaveBeenCalledTimes(1)
      } finally {
        config.mockRestore()
        relay.mockRestore()
        direct.mockRestore()
        settings.mockRestore()
      }
    })

    test('relay deliveries carry the subtitle inside the preview and the grouping keys beside it', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'relay-presentation-token',
        platform: 'ios',
        environment: 'production',
      })
      await db.update(apnsDevices).set({ relayBindingToken: 'ficus_prd_test' }).where(eq(apnsDevices.userId, user.id))
      const relay = spyOn(relayModule, 'sendRelayAlert').mockResolvedValue({ accepted: true, reason: undefined })
      const config = spyOn(relayModule, 'pushRelayConfig').mockReturnValue({
        token: 'fixture',
        instanceId: 'fixture',
        baseUrl: 'https://example.invalid',
      })
      const event: TestEvent = {
        type: 'inbox.messageReceived',
        workStreamNumber: 197,
        title: 'Completed: #197 · Validate deletion',
        body: 'ship it',
        subtitle: 'Platform',
        collapseKey: 'ws:abc',
        threadKey: 'squad:def',
        interruptionLevel: 'passive',
        url: '/inbox',
      }
      try {
        await callSendApnsPush(service, [user.id], event)
        expect(relay.mock.calls[0][1]).toMatchObject({
          eventType: 'message',
          workStreamNumber: 197,
          preview: { title: 'Completed: #197 · Validate deletion', body: 'ship it', subtitle: 'Platform' },
          collapseKey: 'ws:abc',
          threadKey: 'squad:def',
          interruptionLevel: 'passive',
        })
        await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
        await callSendApnsPush(service, [user.id], event)
        const routing = relay.mock.calls[1][1] as Record<string, unknown>
        expect(routing.preview).toBeUndefined()
        expect(routing).toMatchObject({ collapseKey: 'ws:abc', threadKey: 'squad:def', interruptionLevel: 'passive' })
      } finally {
        await UserNotificationPreferences.upsert(user.id, { showPreviews: true })
        config.mockRestore()
        relay.mockRestore()
      }
    })

    test('logs when recipients have no APNs devices', async () => {
      await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })

      const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
      expect(allLogs).toContain('No APNs devices for 1 recipient(s); skipping APNs')
    })

    test('sends each APNs device using its stored environment', async () => {
      await registerApnsDevice({ userId: user.id, apnsToken: 'sandbox-token', platform: 'ios', environment: 'sandbox' })
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'production-token',
        platform: 'ios',
        environment: 'production',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })

      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })

        expect(sendSpy).toHaveBeenCalledTimes(2)
        const calls = sendSpy.mock.calls.map(([token, , environment]) => ({ token, environment }))
        expect(calls).toContainEqual({ token: 'sandbox-token', environment: 'sandbox' })
        expect(calls).toContainEqual({ token: 'production-token', environment: 'production' })
      } finally {
        sendSpy.mockRestore()
      }
    })

    test('forwards routing fields in the APNs payload data', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'routing-token',
        platform: 'ios',
        environment: 'production',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })

      try {
        await callSendApnsPush(service, [user.id], {
          title: 'Blocked',
          body: 'needs input',
          url: '/squads/s1/work?ws=ws1',
          squadId: 's1',
          agentId: 'a1',
          workStreamId: 'ws1',
          waitId: 'wait1',
          questionId: 'q1',
          messageId: 'm1',
          actionId: 'agent-question:q1',
        })

        expect(sendSpy).toHaveBeenCalledTimes(1)
        const payload = sendSpy.mock.calls[0][1]
        expect(payload.data).toMatchObject({
          type: 'open',
          url: '/squads/s1/work?ws=ws1',
          squadId: 's1',
          agentId: 'a1',
          workStreamId: 'ws1',
          waitId: 'wait1',
          questionId: 'q1',
          messageId: 'm1',
          actionId: 'agent-question:q1',
        })
      } finally {
        sendSpy.mockRestore()
      }
    })

    test('forwards push presentation hints to APNs; previews off keeps grouping but drops the subtitle', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'presentation-token',
        platform: 'ios',
        environment: 'production',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })
      const event: TestEvent = {
        type: 'inbox.messageReceived',
        workStreamNumber: 197,
        title: 'Completed: #197 · Validate deletion',
        body: 'Next steps: ship it',
        subtitle: 'Platform',
        collapseKey: 'ws:abc',
        threadKey: 'squad:def',
        interruptionLevel: 'passive',
        url: '/squads/s1/work?ws=197',
      }

      try {
        await callSendApnsPush(service, [user.id], event)
        expect(sendSpy.mock.calls[0][1]).toMatchObject({
          title: 'Completed: #197 · Validate deletion',
          body: 'Next steps: ship it',
          subtitle: 'Platform',
          collapseId: 'ws:abc',
          threadId: 'squad:def',
          interruptionLevel: 'passive',
        })

        await UserNotificationPreferences.upsert(user.id, { showPreviews: false })
        await callSendApnsPush(service, [user.id], event)
        const withoutPreview = sendSpy.mock.calls[1][1]
        expect(withoutPreview).toMatchObject({
          title: 'Work #197 has a new message',
          body: 'Open Ficus to see details.',
          collapseId: 'ws:abc',
          threadId: 'squad:def',
          interruptionLevel: 'passive',
        })
        expect(withoutPreview.subtitle).toBeUndefined()
      } finally {
        await UserNotificationPreferences.upsert(user.id, { showPreviews: true })
        sendSpy.mockRestore()
      }
    })

    test('includes this instance origin (from APP_URL, normalized) in the APNs payload data', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'origin-token',
        platform: 'ios',
        environment: 'production',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })
      const previousAppUrl = process.env.APP_URL
      process.env.APP_URL = 'https://Ficus.Example.com/'

      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })

        expect(sendSpy).toHaveBeenCalledTimes(1)
        expect(sendSpy.mock.calls[0][1].data).toMatchObject({ origin: 'https://ficus.example.com' })
      } finally {
        if (previousAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = previousAppUrl
        sendSpy.mockRestore()
      }
    })

    test('omits origin from the APNs payload data when APP_URL is not set', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'no-origin-token',
        platform: 'ios',
        environment: 'production',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({ ok: true, status: 200 })
      const previousAppUrl = process.env.APP_URL
      delete process.env.APP_URL

      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World', url: '/inbox' })

        expect(sendSpy).toHaveBeenCalledTimes(1)
        expect(sendSpy.mock.calls[0][1].data).not.toHaveProperty('origin')
      } finally {
        if (previousAppUrl !== undefined) process.env.APP_URL = previousAppUrl
        sendSpy.mockRestore()
      }
    })

    test('does not prune APNs devices on BadDeviceToken rejections', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'bad-device-token',
        platform: 'ios',
        environment: 'sandbox',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({
        ok: false,
        status: 400,
        reason: 'BadDeviceToken',
      })

      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World' })

        const devices = await getApnsDevicesByUser(user.id)
        expect(devices.map((device) => device.apnsToken)).toEqual(['bad-device-token'])
      } finally {
        sendSpy.mockRestore()
      }
    })

    test('prunes APNs devices only when Apple reports them unregistered', async () => {
      await registerApnsDevice({
        userId: user.id,
        apnsToken: 'unregistered-token',
        platform: 'ios',
        environment: 'sandbox',
      })
      const sendSpy = spyOn(apnsModule, 'sendApnsNotification').mockResolvedValue({
        ok: false,
        status: 410,
        reason: 'Unregistered',
      })

      try {
        await callSendApnsPush(service, [user.id], { title: 'Hello', body: 'World' })

        expect(await getApnsDevicesByUser(user.id)).toEqual([])
      } finally {
        sendSpy.mockRestore()
      }
    })
  })
})
