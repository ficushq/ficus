import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { webhooksRouter } from './webhooks'
import { telegramProvider } from '../channels/telegram/provider'
import { ChannelInstance } from '../entities/ChannelInstance'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import * as channelAccess from '../services/channel-access'
import * as settings from '../services/integrations/channels/settings'

// Exercise the real webhook parser, signature check, handler and Telegram HTTP
// payloads. Only storage/agent execution and external HTTP are replaced.
const app = new Hono().route('/webhooks', webhooksRouter)
app.onError((_error, c) => c.json({ error: 'Internal server error' }, 500))
const chatId = '701234567'
const groupChatId = '-100123456789'
const messageId = 17
const configurationError =
  'This bot needs configuration. Ask an administrator to check the bot connection and select a Default Squad in the integration settings. New conversations without a matching routing override cannot be started.'
let instance: ChannelInstance
let credentials: Record<string, string>
let requests: Array<{ method: string; body: Record<string, unknown> }>
let transportError: 'http' | 'api' | 'network' | undefined
let findInstance: ReturnType<typeof spyOn<typeof ChannelInstance, 'findByProvider'>>
let findAgent: ReturnType<typeof spyOn<typeof Agent, 'findByThreadId'>>
let queue: ReturnType<typeof spyOn<ChannelInstance, 'queueForConsultant'>>
let inbox: ReturnType<typeof spyOn<typeof InboxMessage, 'send'>>
let getSetting: ReturnType<typeof spyOn<typeof settings, 'getChannelIntegrationValue'>>
let botId: ReturnType<typeof spyOn<typeof telegramProvider, 'getBotUserId'>>
let linkedUser: ReturnType<typeof spyOn<typeof channelAccess, 'findLinkedChannelUser'>>
const originalFetch = globalThis.fetch

beforeEach(() => {
  instance = new ChannelInstance({
    id: 'test-telegram',
    name: 'Test bot',
    provider: 'telegram',
    providerConfig: { botId: '42' },
    defaultSquadId: null,
    trustedChannelIds: [chatId, groupChatId],
    allowedChannelIds: [],
    deniedChannelIds: [],
    channelSquadMap: {},
    yamlTemplate: null,
    yamlFieldOverrides: [],
    disabled: false,
    createdAt: null,
    updatedAt: null,
  })
  credentials = {
    TELEGRAM_BOT_ID: '42',
    TELEGRAM_BOT_TOKEN: '42:fixture-token',
    TELEGRAM_WEBHOOK_SECRET: 'fixture-secret',
  }
  linkedUser = spyOn(channelAccess, 'findLinkedChannelUser').mockResolvedValue(null)
  requests = []
  transportError = undefined
  getSetting = spyOn(settings, 'getChannelIntegrationValue').mockImplementation((key) => credentials[key])
  botId = spyOn(telegramProvider, 'getBotUserId').mockResolvedValue('42')
  findInstance = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(instance)
  findAgent = spyOn(Agent, 'findByThreadId').mockResolvedValue(null)
  queue = spyOn(instance, 'queueForConsultant').mockResolvedValue('new-agent')
  inbox = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)
  globalThis.fetch = (async (url, init) => {
    const method = String(url).split('/').at(-1)!
    const body = JSON.parse(String(init?.body))
    requests.push({ method, body })
    if (transportError === 'network') throw new Error('fixture network failure')
    if (transportError || (body.reply_to_message_id !== undefined && body.reply_to_message_id !== messageId)) {
      return Response.json(
        { ok: false, description: 'Bad Request: message to be replied not found' },
        { status: transportError === 'api' ? 200 : 400 }
      )
    }
    return Response.json({ ok: true, result: { message_id: 99 } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  linkedUser.mockRestore()
  getSetting.mockRestore()
  botId.mockRestore()
  findInstance.mockRestore()
  findAgent.mockRestore()
  queue.mockRestore()
  inbox.mockRestore()
})

function update(text = 'hello', chatType = 'private', extra: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      from: { id: 7, is_bot: false, first_name: 'Test' },
      chat: { id: Number(chatType === 'private' ? chatId : groupChatId), type: chatType },
      text,
      ...extra,
    },
  }
}
function receive(payload: unknown = update(), secret = 'fixture-secret') {
  return app.request('/webhooks/channels/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(payload),
  })
}
function expectConfigurationReply(expectedChatId = chatId) {
  expect(requests).toEqual([
    {
      method: 'sendMessage',
      body: {
        chat_id: expectedChatId,
        text: configurationError,
        parse_mode: 'Markdown',
        reply_to_message_id: messageId,
        allow_sending_without_reply: true,
      },
    },
  ])
  expect(queue).not.toHaveBeenCalled()
  expect(inbox).not.toHaveBeenCalled()
}

function routedUpdate(text = 'hello') {
  return update(text, 'supergroup', { reply_to_message: { message_id: 10, from: { id: 42, is_bot: true } } })
}

describe('Telegram shared-chat received-message routing', () => {
  for (const text of ['hello', '/ficus ask hello', '/ficus status']) {
    it(`replies with a safe configuration error, not Thinking, for an unmapped new chat (${text})`, async () => {
      instance.channelSquadMap = { 'different-chat': 'other-squad' }
      const response = await receive(routedUpdate(text))
      expect(response.status).toBe(200)
      expectConfigurationReply(groupChatId)
    })
  }

  it('sends a visible configuration reply when no channel instance matches (HTTP ok alone is not a reply)', async () => {
    findInstance.mockResolvedValue(null)
    expect((await receive(routedUpdate())).status).toBe(200)
    expectConfigurationReply(groupChatId)
  })

  it('sends a visible configuration reply when the integration bot ID is absent', async () => {
    delete credentials.TELEGRAM_BOT_ID
    expect((await receive(routedUpdate())).status).toBe(200)
    expect(findInstance).not.toHaveBeenCalled()
    expectConfigurationReply(groupChatId)
  })

  for (const text of ['hello', '/ficus ask hello']) {
    for (const route of ['default', 'override', 'override-without-default']) {
      it(`preserves ${route} routing for ${text}`, async () => {
        instance.defaultSquadId = route === 'override-without-default' ? null : 'default-squad'
        instance.channelSquadMap = route === 'default' ? {} : { [groupChatId]: 'override-squad' }
        expect((await receive(routedUpdate(text))).status).toBe(200)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          method: 'sendMessage',
          body: { text: '_Thinking..._', reply_to_message_id: messageId },
        })
        expect(queue).toHaveBeenCalledTimes(1)
        const inbound = queue.mock.calls[0]![0]
        expect(instance.resolveTargetSquad(inbound)).toBe(route === 'default' ? 'default-squad' : 'override-squad')
        expect(inbound.responseContext).toMatchObject({
          channelId: groupChatId,
          threadId: groupChatId,
          messageToEdit: '99',
        })
      })
    }
  }

  it('reuses an addressable chat consultant with current routing and replies to the message ID, not the chat ID', async () => {
    instance.defaultSquadId = 'default-squad'
    findAgent.mockResolvedValue({ id: 'existing-agent', squadId: 'default-squad' } as Agent)
    expect((await receive(routedUpdate())).status).toBe(200)
    expect(requests[0]).toMatchObject({ body: { text: '_Thinking..._', reply_to_message_id: messageId } })
    expect(queue).not.toHaveBeenCalled()
    expect(inbox).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 'existing-agent',
        metadata: expect.objectContaining({
          channelContext: expect.objectContaining({ threadId: groupChatId, messageToEdit: '99' }),
        }),
      })
    )
  })

  it('keeps help available without a default', async () => {
    expect((await receive(routedUpdate('/ficus help'))).status).toBe(200)
    expect(requests[0]!.body.text).toContain('Commands:')
    expect(queue).not.toHaveBeenCalled()
  })

  it('does not reuse an old chat when current routing is missing', async () => {
    findAgent.mockResolvedValue({ id: 'existing-agent', squadId: 'old-squad' } as Agent)
    expect((await receive(routedUpdate('/ficus ask hello'))).status).toBe(200)
    expectConfigurationReply(groupChatId)
    expect(inbox).not.toHaveBeenCalled()
  })

  for (const failure of ['http', 'api', 'network'] as const) {
    it(`does not claim a visible reply or queue a consultant when sending the config error fails (${failure})`, async () => {
      transportError = failure
      expect((await receive(routedUpdate())).status).toBe(500)
      expect(requests).toHaveLength(1)
      expect(requests[0]!.body.text).toBe(configurationError)
      expect(queue).not.toHaveBeenCalled()
      expect(inbox).not.toHaveBeenCalled()
    })
  }

  it('does not queue when the initial Thinking send fails on a valid route', async () => {
    instance.defaultSquadId = 'default-squad'
    transportError = 'http'
    expect((await receive(routedUpdate())).status).toBe(500)
    expect(requests[0]!.body.text).toBe('_Thinking..._')
    expect(queue).not.toHaveBeenCalled()
  })
})

describe('Telegram private-chat access', () => {
  it('requires a linked user even when the DM is trusted and has a default squad', async () => {
    instance.defaultSquadId = 'default-squad'
    expect((await receive()).status).toBe(200)
    expect(requests[0]?.body.text).toContain('Link your account')
    expect(queue).not.toHaveBeenCalled()
    expect(inbox).not.toHaveBeenCalled()
    expect(findAgent).not.toHaveBeenCalled()
  })

  for (const command of ['/help', '/help@FicusBot', '/ficus help', '/ficus@FicusBot help', '/ficus']) {
    it(`shows the full menu for ${command} without linkage or a selected squad`, async () => {
      expect((await receive(update(command))).status).toBe(200)
      expect(requests[0]?.body.text).toContain('Commands:')
      expect(requests[0]?.body.text).toContain('/ficus status')
      expect(requests[0]?.body.text).toContain('/ficus ask')
      expect(requests[0]?.body.text).toContain('/ficus link')
      expect(linkedUser).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
      expect(inbox).not.toHaveBeenCalled()
    })
  }
})

describe('Telegram silence before Thinking', () => {
  for (const [name, payload] of [
    ['non-message update', { update_id: 1 }],
    ['photo without text', update('', 'private', { photo: [{ file_id: 'fixture' }] })],
    ['plain group text', update('hello', 'group')],
    ['plain supergroup text', update('hello', 'supergroup')],
  ] as const) {
    it(`ignores ${name} without attempting a bot reply`, async () => {
      expect((await receive(payload)).status).toBe(200)
      expect(requests).toEqual([])
      expect(findInstance).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
    })
  }

  it('rejects a bad webhook signature without sending to an untrusted chat', async () => {
    expect((await receive(update(), 'wrong-secret')).status).toBe(401)
    expect(requests).toEqual([])
    expect(findInstance).not.toHaveBeenCalled()
  })

  it('cannot send a configuration reply without this integration bot token', async () => {
    delete credentials.TELEGRAM_BOT_TOKEN
    findInstance.mockResolvedValue(null)
    expect((await receive()).status).toBe(500)
    expect(requests).toEqual([])
    expect(queue).not.toHaveBeenCalled()
  })

  it('rejects a webhook when the integration is disabled or its secret is unavailable', async () => {
    credentials = {}
    expect((await receive()).status).toBe(401)
    expect(requests).toEqual([])
    expect(findInstance).not.toHaveBeenCalled()
  })

  for (const [name, payload] of [
    ['command', update('/ficus ask hello', 'group')],
    ['reply', update('hello', 'group', { reply_to_message: { message_id: 10, from: { id: 42, is_bot: true } } })],
  ] as const) {
    it(`responds to a group ${name} when routing is missing`, async () => {
      expect((await receive(payload)).status).toBe(200)
      expectConfigurationReply(groupChatId)
    })
  }
})
