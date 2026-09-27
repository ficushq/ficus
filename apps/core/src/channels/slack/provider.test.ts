import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { slackProvider } from './provider'
import type { ChannelInstance } from '../../entities/ChannelInstance'
import type { ChannelEvent, NotificationEvent } from '../provider'

describe('slackProvider.parseWebhook', () => {
  const originalEnv = process.env.SLACK_BOT_TOKEN
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete process.env.SLACK_BOT_TOKEN
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = originalEnv
    globalThis.fetch = originalFetch
  })

  it('parses slash commands without changing existing routing', async () => {
    const parsed = (await slackProvider.parseWebhook(
      {
        team_id: 'T123',
        channel_id: 'C123',
        user_id: 'U123',
        user_name: 'ada',
        command: '/tau',
        text: 'ask ship it',
        response_url: 'https://hooks.slack.com/commands/response',
        trigger_id: 'trigger-1',
      },
      {}
    )) as ChannelEvent

    expect(parsed).toMatchObject({
      type: 'slash_command',
      command: 'ask',
      text: 'ship it',
      channelId: 'C123',
      user: { id: 'U123', name: 'ada' },
      messageId: 'trigger-1',
      isInThread: false,
      raw: { responseUrl: 'https://hooks.slack.com/commands/response', teamId: 'T123' },
    })
  })

  it('verifies slash-command DMs with Slack, excluding group DMs', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    for (const isMulti of [false, true]) {
      globalThis.fetch = (async () =>
        Response.json({ ok: true, channel: { is_im: true, is_mpim: isMulti } })) as unknown as typeof fetch
      const parsed = await slackProvider.parseWebhook(
        {
          team_id: 'T123',
          channel_id: 'D123',
          user_id: 'U123',
          user_name: 'User',
          command: '/tau',
          text: 'squad my-squad',
          trigger_id: 'trigger',
          response_url: 'https://example.test',
        },
        {}
      )
      expect(parsed).toMatchObject({ isDirectMessage: !isMulti, command: 'squad', text: 'my-squad' })
    }
  })

  it('includes best available Slack human name when routing app mentions', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    const mockFetch = mock((url: string, _opts: RequestInit) => {
      if (url === 'https://slack.com/api/auth.test') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, user_id: 'UBOT' }) })
      }
      if (url === 'https://slack.com/api/users.info') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              user: { id: 'U123', name: 'ada', real_name: 'Ada Lovelace', profile: { display_name: 'Countess' } },
            }),
        })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'not found' })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const parsed = (await slackProvider.parseWebhook(
      {
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'app_mention',
          channel: 'C123',
          user: 'U123',
          text: '<@UBOT> can you help?',
          ts: '1710000000.000100',
        },
      },
      {}
    )) as ChannelEvent

    expect(parsed).toMatchObject({
      type: 'mention',
      channelId: 'C123',
      user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
      messageId: '1710000000.000100',
      isInThread: false,
      raw: { teamId: 'T123' },
    })
  })

  it('routes thread follow-up replies as messages', async () => {
    const parsed = (await slackProvider.parseWebhook(
      {
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'more context',
          thread_ts: '1710000000.000100',
          ts: '1710000001.000200',
        },
      },
      {}
    )) as ChannelEvent

    expect(parsed).toMatchObject({
      type: 'message',
      text: 'more context',
      channelId: 'C123',
      user: { id: 'U123', name: '<@U123>' },
      threadId: '1710000000.000100',
      messageId: '1710000001.000200',
      isInThread: true,
      raw: { teamId: 'T123' },
    })
  })

  it('uses cached fallback labels without warning when Slack cannot resolve historical users', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    const warn = mock(() => {})
    const originalWarn = console.warn
    console.warn = warn as unknown as typeof console.warn
    let usersInfoCalls = 0
    const mockFetch = mock((url: string, _opts: RequestInit) => {
      if (url === 'https://slack.com/api/auth.test') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, user_id: 'UBOT' }) })
      }
      if (url.startsWith('https://slack.com/api/conversations.replies')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              messages: [
                { ts: '1710000000.000100', user: 'U404NF', text: 'First from unresolved user' },
                { ts: '1710000001.000200', user: 'U404NF', text: 'Second mentions <@U404NF>' },
              ],
            }),
        })
      }
      if (url === 'https://slack.com/api/users.info') {
        usersInfoCalls += 1
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: false, error: 'user_not_found' }) })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'not found' })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      const history = await slackProvider.getThreadHistory('C123', '1710000000.000100')

      expect(history).toMatchObject([
        { userId: 'U404NF', userName: '<@U404NF>', text: 'First from unresolved user' },
        { userId: 'U404NF', userName: '<@U404NF>', text: 'Second mentions <@U404NF>' },
      ])
      expect(usersInfoCalls).toBe(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      console.warn = originalWarn
    }
  })

  it('enriches every historical Slack human user label in thread history', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    const users: Record<string, unknown> = {
      U456: { id: 'U456', name: 'grace', real_name: 'Grace Hopper', profile: { display_name: 'Amazing Grace' } },
      U789: { id: 'U789', name: 'katherine', real_name: 'Katherine Johnson', profile: { display_name: '' } },
    }
    const mockFetch = mock((url: string, opts: RequestInit) => {
      if (url === 'https://slack.com/api/auth.test') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, user_id: 'UBOT' }) })
      }
      if (url.startsWith('https://slack.com/api/conversations.replies')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              messages: [
                { ts: '1710000000.000100', user: 'U456', text: 'First message' },
                { ts: '1710000001.000200', user: 'U789', text: 'Second message for <@UBOT>' },
              ],
            }),
        })
      }
      if (url === 'https://slack.com/api/users.info') {
        const body = JSON.parse(opts.body as string) as { user: string }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, user: users[body.user] }) })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'not found' })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const history = await slackProvider.getThreadHistory('C123', '1710000000.000100')

    expect(history).toEqual([
      {
        messageId: '1710000000.000100',
        userId: 'U456',
        userName: 'Amazing Grace (Grace Hopper, @grace, <@U456>)',
        text: 'First message',
        timestamp: '1710000000.000100',
        isBotMessage: false,
      },
      {
        messageId: '1710000001.000200',
        userId: 'U789',
        userName: 'Katherine Johnson (@katherine, <@U789>)',
        text: 'Second message for @Ficus',
        timestamp: '1710000001.000200',
        isBotMessage: false,
      },
    ])
  })

  it('recognizes private DMs separately from channel mentions', async () => {
    const parsed = (await slackProvider.parseWebhook(
      {
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel_type: 'im',
          channel: 'D123',
          user: 'U123',
          text: 'can you help?',
          ts: '1710000000.000100',
        },
      },
      {}
    )) as ChannelEvent

    expect(parsed).toMatchObject({
      type: 'message',
      isDirectMessage: true,
      text: 'can you help?',
      channelId: 'D123',
      user: { id: 'U123', name: '<@U123>' },
      messageId: '1710000000.000100',
      isInThread: false,
      raw: { teamId: 'T123' },
    })
  })
})

describe('slackProvider.postMentionThinkingIndicator', () => {
  const originalEnv = process.env.SLACK_BOT_TOKEN
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = originalEnv
  })

  it('joins the channel before posting the mention thread reply', async () => {
    const mockFetch = mock((url: string, _opts: RequestInit) => {
      if (url === 'https://slack.com/api/conversations.join') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
      }

      if (url === 'https://slack.com/api/chat.postMessage') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, ts: '1710000000.000200' }) })
      }

      return Promise.resolve({ ok: false, status: 404, statusText: 'not found' })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await slackProvider.postMentionThinkingIndicator!({
      type: 'mention',
      text: '@Ficus can you help?',
      channelId: 'C123',
      user: { id: 'U123', name: 'U123' },
      messageId: '1710000000.000100',
      isInThread: false,
      raw: { teamId: 'T123' },
    })

    expect(result).toEqual({ messageId: '1710000000.000200', threadId: '1710000000.000100' })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe('https://slack.com/api/conversations.join')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({ channel: 'C123' })
    expect(mockFetch.mock.calls[1][0]).toBe('https://slack.com/api/chat.postMessage')
    expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toMatchObject({
      channel: 'C123',
      text: '_Thinking..._',
      thread_ts: '1710000000.000100',
    })
  })
})

describe('slackProvider.sendNotification', () => {
  const mockFetch = mock(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }))
  const originalEnv = process.env.SLACK_BOT_TOKEN
  // bun runs the whole suite in ONE process. This file's last test installs its
  // own permalink mock, so without this restore the file HANDED that mock to
  // whichever file ran next — which is how lib/infra/local-events.test.ts ended
  // up asserting against a Slack stub.
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = mockFetch as unknown as typeof fetch
    mockFetch.mockClear()
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnv === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = originalEnv
  })

  it('sends notification to channel via Slack API', async () => {
    const instance = {
      providerConfig: {},
    } as unknown as ChannelInstance

    const event: NotificationEvent = {
      type: 'workStream.review',
      squadId: 'squad-1',
      squadName: 'Test Squad',
      title: '👀 Ready for review: Feature X',
      body: 'Please review the implementation',
      url: 'http://localhost/workstreams/1',
      timestamp: new Date('2026-03-03T12:00:00Z'),
    }

    await slackProvider.sendNotification!({
      instance,
      channelId: 'C0123ABCD',
      event,
    })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = mockFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    expect(opts.headers).toMatchObject({
      Authorization: 'Bearer xoxb-test-token',
    })
    const body = JSON.parse(opts.body as string)
    expect(body.channel).toBe('C0123ABCD')
    expect(body.blocks[0].text.text).toBe('👀 Ready for review: Feature X')
  })

  it('propagates Slack thread identifiers and huddle/canvas fields in raw context', async () => {
    const parsed = (await slackProvider.parseWebhook(
      {
        type: 'event_callback',
        team_id: 'T123',
        event: {
          type: 'message',
          channel: 'C123',
          user: 'U123',
          text: 'index this thread',
          thread_ts: '1710000000.000100',
          ts: '1710000001.000200',
          subtype: 'huddle_thread',
          room: { id: 'R1', huddle_id: 'H1' },
          files: [{ id: 'F1', mimetype: 'application/vnd.slack-docs', filetype: 'canvas' }],
        },
      },
      {}
    )) as ChannelEvent

    expect(parsed.raw).toMatchObject({
      teamId: 'T123',
      channelId: 'C123',
      messageTs: '1710000001.000200',
      threadTs: '1710000000.000100',
      eventTs: '1710000001.000200',
      subtype: 'huddle_thread',
      room: { id: 'R1', huddle_id: 'H1' },
      files: [{ id: 'F1' }],
    })
  })

  it('resolves Slack permalinks through chat.getPermalink', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token'
    const mockFetch = mock((url: string, opts: RequestInit) => {
      expect(url).toBe('https://slack.com/api/chat.getPermalink')
      expect(JSON.parse(opts.body as string)).toEqual({ channel: 'C123', message_ts: '1710000000.000100' })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, permalink: 'https://acme.slack.com/archives/C123/p1710000000000100' }),
      })
    })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const { getSlackApi } = await import('./provider')
    await expect(getSlackApi().getPermalink({ channel: 'C123', messageTs: '1710000000.000100' })).resolves.toBe(
      'https://acme.slack.com/archives/C123/p1710000000000100'
    )
  })
})

describe('slackProvider.getBotUserId', () => {
  const originalEnv = process.env.SLACK_BOT_TOKEN
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    delete process.env.SLACK_BOT_TOKEN
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SLACK_BOT_TOKEN
    else process.env.SLACK_BOT_TOKEN = originalEnv
    globalThis.fetch = originalFetch
  })

  it('resolves a fresh bot user id when the active token changes, instead of serving a stale cached one', async () => {
    // A workspace switch — the manual token replaced, or the managed
    // connection becoming/ceasing to be active — must not keep answering
    // with the previous workspace's bot user id.
    const usersByToken: Record<string, string> = {
      'xoxb-cache-workspace-a': 'U-CACHE-WORKSPACE-A',
      'xoxb-cache-workspace-b': 'U-CACHE-WORKSPACE-B',
    }
    globalThis.fetch = (async (_url: string, opts?: RequestInit) => {
      const auth = new Headers(opts?.headers).get('Authorization') ?? ''
      const token = auth.replace('Bearer ', '')
      const userId = usersByToken[token]
      return Response.json(userId ? { ok: true, user_id: userId } : { ok: false, error: 'invalid_auth' })
    }) as unknown as typeof fetch

    process.env.SLACK_BOT_TOKEN = 'xoxb-cache-workspace-a'
    expect(await slackProvider.getBotUserId()).toBe('U-CACHE-WORKSPACE-A')
    // A second call with the same token is served from cache: exactly one auth.test so far.
    expect(await slackProvider.getBotUserId()).toBe('U-CACHE-WORKSPACE-A')

    process.env.SLACK_BOT_TOKEN = 'xoxb-cache-workspace-b'
    expect(await slackProvider.getBotUserId()).toBe('U-CACHE-WORKSPACE-B')
  })
})
