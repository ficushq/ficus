import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test'
import { telegramProvider } from './provider'
import type { ChannelInstance } from '../../entities/ChannelInstance'
import type { NotificationEvent } from '../provider'

describe('telegramProvider.sendNotification', () => {
  const mockFetch = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }))
  const originalEnv = process.env.TELEGRAM_BOT_TOKEN
  // bun runs the whole suite in ONE process: an unrestored `globalThis.fetch`
  // is handed to whichever file runs next, and this stub is not a Response.
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockClear()
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABC-test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = originalEnv
  })

  it('sends notification to chat via Telegram API', async () => {
    const instance = {
      providerConfig: {},
    } as unknown as ChannelInstance

    const event: NotificationEvent = {
      type: 'workStream.done',
      squadId: 'squad-1',
      squadName: 'Test Squad',
      title: '✅ Done: Feature X',
      body: 'Implementation complete',
      url: 'http://localhost/workstreams/1',
      timestamp: new Date('2026-03-03T12:00:00Z'),
    }

    await telegramProvider.sendNotification!({
      instance,
      channelId: '-100123456789',
      event,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bot123456:ABC-test-token/sendMessage')
    const body = JSON.parse(opts.body as string)
    expect(body.chat_id).toBe('-100123456789')
    expect(body.parse_mode).toBe('MarkdownV2')
    expect(body.text).toContain('Done: Feature X')
  })
  it('does not use the persistent chat ID as a Telegram reply target', async () => {
    await telegramProvider.postMessage({ channelId: '-100123', threadId: '-100123', text: 'An update' })
    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(opts.body as string).reply_to_message_id).toBeUndefined()
  })

  it('uses the incoming message ID for replies and tolerates a deleted original message', async () => {
    await telegramProvider.postMessage({
      channelId: '-100123',
      threadId: '-100123',
      replyToMessageId: '42',
      text: 'Thinking',
    })
    const [, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(opts.body as string)).toMatchObject({
      chat_id: '-100123',
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    })
  })
  it('recognizes Telegram group command suffixes when linking an account', async () => {
    const bot = spyOn(telegramProvider, 'getBotUserId').mockResolvedValue('99')
    try {
      const event = await telegramProvider.parseWebhook(
        {
          update_id: 1,
          message: {
            message_id: 42,
            from: { id: 123, first_name: 'Ada', is_bot: false },
            chat: { id: -100123, type: 'supergroup' },
            text: '/ficus@example_bot link abcdef0123456789abcdef0123456789',
          },
        },
        {}
      )
      expect(event).toMatchObject({
        type: 'slash_command',
        command: 'link',
        text: 'abcdef0123456789abcdef0123456789',
        threadId: '-100123',
        messageId: '42',
      })
    } finally {
      bot.mockRestore()
    }
  })
})

describe('Telegram command word', () => {
  it('ignores the pre-rename command word in groups (Ruling 39)', async () => {
    const bot = spyOn(telegramProvider, 'getBotUserId').mockResolvedValue('99')
    try {
      const parsed = await telegramProvider.parseWebhook(
        {
          update_id: 1,
          message: {
            message_id: 3,
            chat: { id: -100, type: 'group' },
            from: { id: 7, first_name: 'U' },
            text: '/tau help',
          },
        },
        {}
      )
      expect(parsed).toBeNull()
    } finally {
      bot.mockRestore()
    }
  })
})

describe('Telegram private squad switching', () => {
  it('marks private chats distinctly from group replies', async () => {
    const bot = spyOn(telegramProvider, 'getBotUserId').mockResolvedValue('99')
    try {
      for (const type of ['private', 'group', 'supergroup']) {
        const parsed = await telegramProvider.parseWebhook(
          {
            update_id: 1,
            message: {
              message_id: 2,
              chat: { id: 123, type },
              from: { id: 7, first_name: 'User' },
              text: '/ficus squad my-squad',
            },
          },
          {}
        )
        expect(parsed).toMatchObject({ isDirectMessage: type === 'private', command: 'squad', text: 'my-squad' })
      }
    } finally {
      bot.mockRestore()
    }
  })
})
