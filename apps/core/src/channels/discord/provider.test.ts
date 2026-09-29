import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { discordProvider } from './provider'
import type { ChannelInstance } from '../../entities/ChannelInstance'
import type { NotificationEvent } from '../provider'

describe('discordProvider messaging', () => {
  const mockFetch = mock(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: 'discord-msg-1' }),
      text: async () => '',
    })
  )
  const originalEnv = process.env.DISCORD_BOT_TOKEN
  // bun runs the whole suite in ONE process: an unrestored `globalThis.fetch`
  // is handed to whichever file runs next, and these stubs are not Responses.
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockClear()
    process.env.DISCORD_BOT_TOKEN = 'test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.DISCORD_BOT_TOKEN
    else process.env.DISCORD_BOT_TOKEN = originalEnv
  })

  it('returns the thread channel as editChannelId when posting into a thread', async () => {
    const result = await discordProvider.postMessage({
      channelId: 'parent-channel-1',
      threadId: 'thread-channel-1',
      text: 'hello',
    })

    expect(result).toEqual({
      messageId: 'discord-msg-1',
      threadId: 'thread-channel-1',
      editChannelId: 'thread-channel-1',
    })
    const [url] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/thread-channel-1/messages')
  })
})

describe('discordProvider.sendNotification', () => {
  const mockFetch = mock(() => Promise.resolve({ ok: true }))
  const originalEnv = process.env.DISCORD_BOT_TOKEN
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockClear()
    process.env.DISCORD_BOT_TOKEN = 'test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.DISCORD_BOT_TOKEN
    else process.env.DISCORD_BOT_TOKEN = originalEnv
  })

  it('sends notification to channel via Discord API', async () => {
    const instance = {
      providerConfig: {},
    } as unknown as ChannelInstance

    const event: NotificationEvent = {
      type: 'workStream.blocked',
      squadId: 'squad-1',
      squadName: 'Test Squad',
      title: '🚫 Blocked: Test Task',
      body: 'Need input to continue',
      url: 'http://localhost/workstreams/1',
      timestamp: new Date('2026-03-03T12:00:00Z'),
    }

    await discordProvider.sendNotification!({
      instance,
      channelId: '123456789',
      event,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://discord.com/api/v10/channels/123456789/messages')
    expect(opts.method).toBe('POST')
    expect(opts.headers).toMatchObject({
      Authorization: 'Bot test-token',
      'Content-Type': 'application/json',
    })
    const body = JSON.parse(opts.body as string)
    expect(body.embeds[0].title).toBe('🚫 Blocked: Test Task')
    expect(body.embeds[0].color).toBe(0xe74c3c)
  })
})

describe('Discord bot DM classification', () => {
  it('accepts one-to-one bot DMs but never treats group DMs or guild channels as private switching scopes', async () => {
    for (const [type, guildId, expected] of [
      [1, undefined, true],
      [3, undefined, false],
      [0, 'guild', false],
      [11, 'guild', false],
    ] as const) {
      const parsed = await discordProvider.parseWebhook(
        {
          type: 2,
          id: 'interaction',
          token: 'token',
          application_id: 'app',
          channel_id: 'channel',
          channel: { type },
          guild_id: guildId,
          user: { id: 'person', username: 'Person' },
          data: {
            // A registration made before the rename: interactions route by subcommand, not by this name.
            name: 'ficus',
            options: [{ name: 'squad', type: 1, options: [{ name: 'squad', type: 3, value: 'my-squad' }] }],
          },
        },
        {}
      )
      expect(parsed).toMatchObject({ isDirectMessage: expected, command: 'squad', text: 'my-squad' })
    }
  })
})
