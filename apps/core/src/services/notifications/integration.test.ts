import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test'
import { join } from 'path'
import { mkdir, writeFile, rm, readFile } from 'fs/promises'
import { NotificationService } from './service'
import { notificationSync } from '../config-sync'
import type { NotificationConfig } from './types'
import { Squad } from '../../entities/Squad'
import { WorkStream } from '../../entities/WorkStream'
import { ChannelInstance } from '../../entities/ChannelInstance'
import * as channelProvider from '../../channels/provider'
import * as eventBuilders from './event-builders'

/** Helper: load notification config from a YAML file (replaces old config-loader) */
async function loadNotificationConfig(configPath: string): Promise<NotificationConfig> {
  const content = await readFile(configPath, 'utf-8')
  const filename = configPath.split('/').pop() || 'unknown'
  const parsed = notificationSync.parse(content, filename)
  return { rules: parsed.rules, channels: parsed.channels }
}

// Mock event emitter with onAny support
class MockEventEmitter {
  private anyHandlers: Set<(event: string, data: unknown) => void | Promise<void>> = new Set()

  on(_event: string, _handler: (data: unknown) => void): () => void {
    return () => {}
  }

  onAny(handler: (event: string, data: unknown) => void | Promise<void>): () => void {
    this.anyHandlers.add(handler)
    return () => {
      this.anyHandlers.delete(handler)
    }
  }

  // Unlike the synchronous production emitter, await handlers here so tests synchronize deterministically.
  async emit(event: string, data: unknown): Promise<void> {
    await Promise.all([...this.anyHandlers].map((handler) => handler(event, data)))
  }
}

const TEST_DIR = '/tmp/ficus-notification-integration'

describe('Notification Service Integration', () => {
  let service: NotificationService
  let emitter: MockEventEmitter
  let unregister: (() => void) | undefined
  let consoleSpy: ReturnType<typeof spyOn>
  let buildEventSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true })
    service = new NotificationService()
    emitter = new MockEventEmitter()
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    unregister?.()
    consoleSpy.mockRestore()
    buildEventSpy?.mockRestore()
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  test('full flow: config -> service -> listener -> notification', async () => {
    // Mock the event builder to return a test notification
    buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'inbox.messageReceived',
      title: 'New message',
      body: 'Test Message Content',
      url: '/inbox',
      timestamp: new Date(),
    })

    // Create config file
    const configPath = join(TEST_DIR, 'rules.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "inbox.messageReceived"
    channels:
      - console
channels:
  console:
    enabled: true
`
    )

    // Load config
    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)

    // Setup listeners
    unregister = service.register(emitter as any)

    // Emit inbox.messageReceived event and wait for all listeners to finish.
    await emitter.emit('inbox.messageReceived', { messageId: 'msg-123' })

    // Verify notification was logged
    expect(consoleSpy).toHaveBeenCalled()
    const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(allLogs).toContain('[notify]')
    expect(allLogs).toContain('inbox.messageReceived')
    expect(allLogs).toContain('Test Message Content')
  })

  test('event filtering works correctly', async () => {
    // Mock the event builder
    buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'execution.failed',
      title: 'Execution failed',
      body: 'Agent failed: Something went wrong',
      timestamp: new Date(),
    })

    const configPath = join(TEST_DIR, 'event-rules.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "execution.failed"
    channels:
      - console
channels:
  console:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    // execution.failed should match - logs routing message and content
    await emitter.emit('execution.failed', { executionId: 'exec-1', agentId: 'agent-1' })
    expect(consoleSpy).toHaveBeenCalledTimes(2)

    // unknown.event should NOT match (no catch-all). It logs a debug reason
    // but sends no notification content.
    consoleSpy.mockClear()
    await emitter.emit('unknown.event', { data: 'test' })
    const unmatchedLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(unmatchedLogs).toContain('Event unknown.event matched no notification rule')
    expect(unmatchedLogs).not.toContain('unknown.event →')
  })

  test('disabled channel prevents notification', async () => {
    const configPath = join(TEST_DIR, 'disabled.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "inbox.messageReceived"
    channels:
      - console
channels:
  console:
    enabled: false
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent')

    await service.notify('inbox.messageReceived', { messageId: 'msg-1' })

    expect(buildEventSpy).not.toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  test('catch-all rule matches any event', async () => {
    // Mock the event builder to return notifications for any event
    buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'test',
      title: 'Test',
      body: 'Test body',
      timestamp: new Date(),
    })

    const configPath = join(TEST_DIR, 'catchall.yaml')
    await writeFile(
      configPath,
      `rules:
  - channels:
      - console
channels:
  console:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    await Promise.all([
      emitter.emit('custom.event1', { data: '1' }),
      emitter.emit('custom.event2', { data: '2' }),
      emitter.emit('custom.event3', { data: '3' }),
    ])

    // Each event produces 2 logs: routing message and content
    expect(consoleSpy).toHaveBeenCalledTimes(6)
  })

  test('multi-channel routing sends to all enabled channels', async () => {
    // Mock the event builder
    buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'execution.failed',
      title: 'Execution failed',
      body: 'Agent failed with error',
      timestamp: new Date(),
    })

    const configPath = join(TEST_DIR, 'multi-channel.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "execution.failed"
    channels:
      - console
channels:
  console:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    await emitter.emit('execution.failed', { executionId: 'exec-1', agentId: 'agent-1' })

    expect(buildEventSpy).toHaveBeenCalledTimes(1)
    const allLogs = consoleSpy.mock.calls.map((c: any[]) => c.join(' ')).join('\n')
    expect(allLogs).toContain('execution.failed → console')
    expect(allLogs).toContain('Agent failed with error')
  })
})

describe('NotificationService external channel integration', () => {
  let service: NotificationService
  let emitter: MockEventEmitter
  let unregister: (() => void) | undefined
  let consoleSpy: ReturnType<typeof spyOn>
  let squadFindSpy: ReturnType<typeof spyOn>
  let workStreamFindSpy: ReturnType<typeof spyOn>
  let channelInstanceFindSpy: ReturnType<typeof spyOn>
  let getProviderSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true })
    service = new NotificationService()
    emitter = new MockEventEmitter()
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    unregister?.()
    consoleSpy.mockRestore()
    squadFindSpy?.mockRestore()
    workStreamFindSpy?.mockRestore()
    channelInstanceFindSpy?.mockRestore()
    getProviderSpy?.mockRestore()
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  test('does not route workStream.blocked from squad config without an explicit rule', async () => {
    const mockSendNotification = mock(() => Promise.resolve())

    // Mock Squad with discord notification config
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: 'squad-1',
      name: 'Test Squad',
      metadata: {
        notifications: {
          discord: { instanceId: 'discord-instance-1', channelId: 'channel-123' },
        },
      },
    } as any)

    // Mock WorkStream
    workStreamFindSpy = spyOn(WorkStream, 'find').mockResolvedValue({
      id: 'ws-1',
      squadId: 'squad-1',
      title: 'Test WorkStream',
      blockedPrompt: { message: 'Need input' },
    } as any)

    // Mock ChannelInstance
    channelInstanceFindSpy = spyOn(ChannelInstance, 'find').mockResolvedValue({
      id: 'discord-instance-1',
      name: 'Test Discord',
      provider: 'discord',
    } as any)

    // Mock discord provider
    getProviderSpy = spyOn(channelProvider, 'getNotificationProvider').mockReturnValue({
      name: 'discord',
      sendNotification: mockSendNotification,
    } as any)

    // A squad destination alone is not a routing rule (the bundled blocked rule was removed).
    const configPath = join(TEST_DIR, 'discord-rules.yaml')
    await writeFile(
      configPath,
      `rules: []
channels:
  discord:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    // Emit workStream.blocked event
    await emitter.emit('workStream.blocked', {
      workStreamId: 'ws-1',
      squadId: 'squad-1',
    })

    expect(mockSendNotification).toHaveBeenCalledTimes(0)
  })

  test('skips external channels when squad has no notification config', async () => {
    const mockSendNotification = mock(() => Promise.resolve())

    // Mock Squad WITHOUT notification config
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: 'squad-2',
      name: 'Squad Without Config',
      metadata: {}, // No notifications configured
    } as any)

    // Mock WorkStream
    workStreamFindSpy = spyOn(WorkStream, 'find').mockResolvedValue({
      id: 'ws-2',
      title: 'Another WorkStream',
      blockedPrompt: { message: 'Blocked' },
    } as any)

    // Mock discord provider (should not be called)
    getProviderSpy = spyOn(channelProvider, 'getNotificationProvider').mockReturnValue({
      name: 'discord',
      sendNotification: mockSendNotification,
    } as any)

    // Setup config
    const configPath = join(TEST_DIR, 'discord-no-squad-config.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "workStream.blocked"
    channels:
      - discord
channels:
  discord:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    // Emit workStream.blocked event
    await emitter.emit('workStream.blocked', {
      workStreamId: 'ws-2',
      squadId: 'squad-2',
    })

    // Verify sendNotification was NOT called (squad has no discord config)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  test('fleet alert first match fans out once without also applying the generic inbox rule', async () => {
    const sendPushSpy = spyOn(service as any, 'sendPushNotifications').mockResolvedValue(undefined)
    const mockDiscordSend = mock(() => Promise.resolve())
    const fleetBuildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'inbox.messageReceived',
      source: 'fleet-alert',
      squadId: 'squad-fleet',
      squadName: 'Fleet Squad',
      messageId: 'fleet-message',
      title: 'Execution fleet stalled',
      body: 'No execution starts while actionable work is waiting.',
      timestamp: new Date(),
    } as any)
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: 'squad-fleet',
      name: 'Fleet Squad',
      metadata: { notifications: { discord: { instanceId: 'discord-fleet', channelId: 'alerts' } } },
    } as any)
    channelInstanceFindSpy = spyOn(ChannelInstance, 'find').mockResolvedValue({
      id: 'discord-fleet',
      name: 'Fleet Discord',
      provider: 'discord',
    } as any)
    getProviderSpy = spyOn(channelProvider, 'getNotificationProvider').mockReturnValue({
      name: 'discord',
      sendNotification: mockDiscordSend,
    } as any)

    const config: NotificationConfig = {
      rules: [
        {
          event: 'inbox.messageReceived',
          match: { source: 'fleet-alert' },
          channels: ['push', 'discord'],
        },
        {
          event: 'inbox.messageReceived',
          match: { recipientType: ['user', 'system'] },
          channels: ['push'],
        },
      ],
      channels: {
        push: { enabled: true },
        discord: { enabled: true },
      },
    }
    service.setConfig(config)

    try {
      await service.notify('inbox.messageReceived', {
        messageId: 'fleet-message',
        recipientType: 'system',
        source: 'fleet-alert',
        squadId: 'squad-fleet',
      })

      expect(fleetBuildEventSpy).toHaveBeenCalledTimes(1)
      expect(sendPushSpy).toHaveBeenCalledTimes(1)
      expect(mockDiscordSend).toHaveBeenCalledTimes(1)
    } finally {
      fleetBuildEventSpy.mockRestore()
      sendPushSpy.mockRestore()
    }
  })

  test('manager fleet messages are rejected before event construction and external routing', async () => {
    const sendPushSpy = spyOn(service as any, 'sendPushNotifications').mockResolvedValue(undefined)
    const providerSend = mock(() => Promise.resolve())
    const buildEventSpy = spyOn(eventBuilders, 'buildNotificationEvent').mockResolvedValue({
      type: 'inbox.messageReceived',
      messageId: 'manager-fleet-message',
      title: 'Manager fleet alert',
      body: 'Manager-only work injection.',
      timestamp: new Date(),
    } as any)
    getProviderSpy = spyOn(channelProvider, 'getNotificationProvider').mockReturnValue({
      name: 'discord',
      sendNotification: providerSend,
    } as any)
    service.setConfig({
      rules: [
        {
          event: 'inbox.messageReceived',
          match: { source: 'fleet-alert' },
          channels: ['push', 'discord', 'slack', 'telegram'],
        },
        {
          event: 'inbox.messageReceived',
          match: { recipientType: ['user', 'system'] },
          channels: ['push'],
        },
      ],
      channels: {
        push: { enabled: true },
        discord: { enabled: true },
        slack: { enabled: true },
        telegram: { enabled: true },
      },
    })

    try {
      await service.notify('inbox.messageReceived', {
        messageId: 'manager-fleet-message',
        recipientType: 'agent',
        recipientId: 'manager-1',
        source: 'fleet-incident-manager',
      })
      expect(buildEventSpy).not.toHaveBeenCalled()
      expect(sendPushSpy).not.toHaveBeenCalled()
      expect(providerSend).not.toHaveBeenCalled()
    } finally {
      buildEventSpy.mockRestore()
      sendPushSpy.mockRestore()
    }
  })

  test('an explicit blocked rule reaches Discord, Slack, and Telegram', async () => {
    const mockDiscordSend = mock(() => Promise.resolve())
    const mockSlackSend = mock(() => Promise.resolve())
    const mockTelegramSend = mock(() => Promise.resolve())

    // Mock Squad with explicit external-channel destinations
    squadFindSpy = spyOn(Squad, 'find').mockResolvedValue({
      id: 'squad-3',
      name: 'Multi-Channel Squad',
      metadata: {
        notifications: {
          discord: { instanceId: 'discord-inst', channelId: 'discord-ch' },
          slack: { instanceId: 'slack-inst', channelId: 'slack-ch' },
          telegram: { instanceId: 'telegram-inst', channelId: 'telegram-ch' },
        },
      },
    } as any)

    // Mock WorkStream
    workStreamFindSpy = spyOn(WorkStream, 'find').mockResolvedValue({
      id: 'ws-3',
      squadId: 'squad-3',
      title: 'Multi-Channel WorkStream',
      blockedPrompt: { message: 'Help needed' },
    } as any)

    // Mock ChannelInstance to return appropriate instances
    channelInstanceFindSpy = spyOn(ChannelInstance, 'find').mockImplementation(async (id: string) => {
      if (id === 'discord-inst') {
        return { id: 'discord-inst', name: 'Discord', provider: 'discord' } as any
      }
      if (id === 'slack-inst') {
        return { id: 'slack-inst', name: 'Slack', provider: 'slack' } as any
      }
      if (id === 'telegram-inst') {
        return { id: 'telegram-inst', name: 'Telegram', provider: 'telegram' } as any
      }
      return null
    })

    // Mock providers
    getProviderSpy = spyOn(channelProvider, 'getNotificationProvider').mockImplementation((name: string) => {
      if (name === 'discord') {
        return { name: 'discord', sendNotification: mockDiscordSend } as any
      }
      if (name === 'slack') {
        return { name: 'slack', sendNotification: mockSlackSend } as any
      }
      if (name === 'telegram') {
        return { name: 'telegram', sendNotification: mockTelegramSend } as any
      }
      return undefined
    })

    // Setup an explicit custom rule for all three external providers
    const configPath = join(TEST_DIR, 'multi-external.yaml')
    await writeFile(
      configPath,
      `rules:
  - event: "workStream.blocked"
    channels:
      - discord
      - slack
      - telegram
channels:
  discord:
    enabled: true
  slack:
    enabled: true
  telegram:
    enabled: true
`
    )

    const config = await loadNotificationConfig(configPath)
    service.setConfig(config)
    unregister = service.register(emitter as any)

    // Emit workStream.blocked event
    await emitter.emit('workStream.blocked', {
      workStreamId: 'ws-3',
      squadId: 'squad-3',
    })

    // Verify every explicitly configured provider was called
    expect(mockDiscordSend).toHaveBeenCalledTimes(1)
    expect(mockSlackSend).toHaveBeenCalledTimes(1)
    expect(mockTelegramSend).toHaveBeenCalledTimes(1)

    // Verify correct channel IDs
    const discordCalls = mockDiscordSend.mock.calls as unknown[][]
    const slackCalls = mockSlackSend.mock.calls as unknown[][]
    const telegramCalls = mockTelegramSend.mock.calls as unknown[][]
    expect(discordCalls[0][0]).toMatchObject({
      channelId: 'discord-ch',
    })
    expect(slackCalls[0][0]).toMatchObject({
      channelId: 'slack-ch',
    })
    expect(telegramCalls[0][0]).toMatchObject({
      channelId: 'telegram-ch',
    })

    // Even an explicit rule fails closed when the event scope disagrees with the persisted stream.
    await emitter.emit('workStream.blocked', { workStreamId: 'ws-3', squadId: 'wrong-squad' })
    expect(mockDiscordSend).toHaveBeenCalledTimes(1)
    expect(mockSlackSend).toHaveBeenCalledTimes(1)
    expect(mockTelegramSend).toHaveBeenCalledTimes(1)
  })
})
