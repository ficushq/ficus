import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { DiscordGateway, stopDiscordGateway } from './gateway'
import { discordProvider } from './provider'
import { Agent } from '../../entities/Agent'
import { ChannelInstance } from '../../entities/ChannelInstance'
import { InboxMessage } from '../../entities/InboxMessage'
import { registerProvider, type ChannelProvider } from '../provider'

function createGateway(): DiscordGateway {
  const gateway = new DiscordGateway('test-token')
  ;(gateway as unknown as { botUserId: string }).botUserId = 'UBOT'
  spyOn(gateway as any, 'getChannelRouting').mockResolvedValue({ isThread: true, parentId: 'channel-1' })
  return gateway
}

describe('DiscordGateway mention routing', () => {
  let findByThreadIdSpy: ReturnType<typeof spyOn>
  let findByProviderSpy: ReturnType<typeof spyOn>
  let inboxSendSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    findByThreadIdSpy?.mockRestore()
    findByProviderSpy?.mockRestore()
    inboxSendSpy?.mockRestore()
    registerProvider(discordProvider)
  })

  it('ignores a regular message in a Ficus-created thread when Ficus is not mentioned', async () => {
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
      context: {
        thread: {
          id: 'thread-1',
          channelId: 'thread-1',
          originalMessageId: 'parent-1',
          ficusCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'discord',
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking-1' })),
    } as unknown as ChannelProvider
    registerProvider(provider)

    await (
      createGateway() as unknown as { handleMessageCreate: (message: unknown) => Promise<void> }
    ).handleMessageCreate({
      id: 'message-1',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: 'regular follow-up with no Ficus mention',
      author: { id: 'user-1', username: 'Ada' },
      mentions: [],
    })

    expect(provider.postMessage).not.toHaveBeenCalled()
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })

  it('processes a mention in a Ficus-created thread through the mention path', async () => {
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
      context: {
        thread: {
          id: 'thread-1',
          channelId: 'thread-1',
          originalMessageId: 'parent-1',
          ficusCreated: true,
        },
      },
    } as unknown as Agent)
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(
      new ChannelInstance({
        id: 'instance-test',
        defaultSquadId: 'squad-test',
        trustedChannelIds: ['channel-1'],
        disabled: false,
      } as any)
    )
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'discord',
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: 'parent-1',
            userId: 'user-2',
            text: 'Earlier context',
            timestamp: 'parent-1',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking-1' })),
    } as unknown as ChannelProvider
    registerProvider(provider)

    await (
      createGateway() as unknown as { handleMessageCreate: (message: unknown) => Promise<void> }
    ).handleMessageCreate({
      id: 'message-1',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: '<@UBOT> current follow-up',
      author: { id: 'user-1', username: 'Ada' },
      mentions: [{ id: 'UBOT', username: 'Ficus' }],
    })

    expect(provider.getThreadHistory).toHaveBeenCalledWith('thread-1', 'thread-1', 50)
    expect(provider.postMessage).toHaveBeenCalledWith({
      channelId: 'thread-1',
      text: '_Thinking..._',
    })
    expect(inboxSendSpy).toHaveBeenCalledWith({
      recipientId: 'agent-1',
      senderType: 'system',
      wakeEligible: true,
      subject: 'Channel: mention',
      content: expect.stringContaining('<@user-1>: @Ficus current follow-up'),
      metadata: {
        type: 'channel_message',
        channelContext: {
          provider: 'discord',
          routingChannelId: 'channel-1',
          channelId: 'thread-1',
          messageToEdit: 'thinking-1',
        },
        userId: 'user-1',
        userName: 'Ada',
        command: 'mention',
      },
    })
  })

  it('rejects unlinked users before reading history or waking an existing thread agent', async () => {
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
      context: {
        thread: {
          id: 'thread-1',
          channelId: 'thread-1',
          originalMessageId: 'parent-1',
          ficusCreated: true,
        },
      },
    } as unknown as Agent)
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(
      new ChannelInstance({
        id: 'instance-test',
        defaultSquadId: 'squad-test',
        trustedChannelIds: [],
        disabled: false,
      } as any)
    )
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'discord',
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: 'parent-1',
            userId: 'user-2',
            text: 'Earlier context',
            timestamp: 'parent-1',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking-1' })),
    } as unknown as ChannelProvider
    registerProvider(provider)

    await (
      createGateway() as unknown as { handleMessageCreate: (message: unknown) => Promise<void> }
    ).handleMessageCreate({
      id: 'message-1',
      channel_id: 'thread-1',
      guild_id: 'guild-1',
      content: '<@UBOT> current follow-up',
      author: { id: 'user-1', username: 'Ada' },
      mentions: [{ id: 'UBOT', username: 'Ficus' }],
    })

    expect(provider.getThreadHistory).not.toHaveBeenCalled()
    expect(provider.postMessage).toHaveBeenCalledWith({
      channelId: 'thread-1',
      text: expect.stringContaining('Link your account'),
    })
    expect(inboxSendSpy).not.toHaveBeenCalled()
  })
})

describe('stopDiscordGateway', () => {
  it('is a safe no-op when the gateway was never started (index.ts Subsystem stop wiring relies on this)', () => {
    expect(() => stopDiscordGateway()).not.toThrow()
  })
})

describe('DiscordGateway slash commands', () => {
  it('dispatches slash interactions from the gateway', async () => {
    const gateway = new DiscordGateway('fixture')
    const handle = spyOn(gateway as any, 'handleInteractionCreate').mockResolvedValue(undefined)
    try {
      ;(gateway as any).handleDispatch('INTERACTION_CREATE', { id: 'interaction' })
      expect(handle).toHaveBeenCalledWith({ id: 'interaction' })
    } finally {
      handle.mockRestore()
    }
  })

  it('acknowledges a link command before claiming the identity, then updates the response', async () => {
    const access = await import('../../services/channel-access')
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; body?: any; method?: string }> = []
    const claim = spyOn(access, 'channelLinkReply').mockImplementation(async (_instance, user, text) => {
      expect(requests[0]?.url).toEndWith('/interactions/interaction/token/callback')
      expect(requests[0]?.body).toEqual({ type: 5, data: { flags: 64 } })
      expect(user.id).toBe('member')
      expect(text).toBe(`link ${'a'.repeat(32)}`)
      return 'Account verified. Return to Ficus and confirm.'
    })
    const instance = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(
      new ChannelInstance({ id: 'bot', provider: 'discord', disabled: false } as any)
    )
    globalThis.fetch = (async (url: any, init: any) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, method: init?.method })
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    try {
      await (new DiscordGateway('fixture') as any).handleInteractionCreate({
        id: 'interaction',
        application_id: 'application',
        token: 'token',
        type: 2,
        guild_id: 'guild',
        channel_id: 'channel',
        member: { user: { id: 'member', username: 'Ada' } },
        data: {
          name: 'ficus',
          options: [{ name: 'link', type: 1, options: [{ name: 'code', type: 3, value: 'a'.repeat(32) }] }],
        },
      })
      expect(claim).toHaveBeenCalledTimes(1)
      expect(requests[1]).toEqual({
        url: 'https://discord.com/api/v10/webhooks/application/token/messages/@original',
        method: 'PATCH',
        body: { content: 'Account verified. Return to Ficus and confirm.' },
      })
    } finally {
      globalThis.fetch = originalFetch
      claim.mockRestore()
      instance.mockRestore()
    }
  })

  it('does not process an interaction when acknowledgement fails', async () => {
    const originalFetch = globalThis.fetch
    const lookup = spyOn(ChannelInstance, 'findByProvider')
    globalThis.fetch = (async () => new Response(null, { status: 400 })) as unknown as typeof fetch
    try {
      await expect(
        (new DiscordGateway('fixture') as any).handleInteractionCreate({
          id: 'interaction',
          application_id: 'application',
          token: 'token',
          type: 2,
          guild_id: 'guild',
          channel_id: 'channel',
          member: { user: { id: 'member', username: 'Ada' } },
          data: { name: 'ficus', options: [{ name: 'help', type: 1 }] },
        })
      ).rejects.toThrow('acknowledgement failed')
      expect(lookup).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      lookup.mockRestore()
    }
  })
})

describe('Discord bot DMs', () => {
  it('routes verified one-to-one DMs without a mention, and excludes group DMs', async () => {
    const settings = await import('../../services/integrations/channels/settings')
    const handler = await import('../handler')
    const setting = spyOn(settings, 'getChannelIntegrationValue').mockImplementation((key) =>
      key === 'DISCORD_GUILD_ID' ? 'configured-server' : undefined
    )
    const dispatch = spyOn(handler, 'handleChannelEvent').mockResolvedValue({ response: { ok: true } })
    const gateway = new DiscordGateway('test-token')
    const routing = spyOn(gateway as any, 'getChannelRouting').mockResolvedValue({ type: 1, isThread: false })
    registerProvider(discordProvider)
    const message = {
      id: 'm',
      channel_id: 'dm',
      author: { id: 'person', username: 'Person' },
      content: 'ficus squad my-team',
      mentions: [],
    }
    try {
      await (gateway as any).handleMessageCreate(message)
      expect(dispatch).toHaveBeenCalledWith(
        discordProvider,
        expect.objectContaining({
          isDirectMessage: true,
          text: 'ficus squad my-team',
          channelId: 'dm',
          user: { id: 'person', name: 'Person' },
        }),
        'configured-server'
      )
      routing.mockResolvedValue({ type: 3, isThread: false })
      await (gateway as any).handleMessageCreate(message)
      expect(dispatch).toHaveBeenCalledTimes(1)
    } finally {
      setting.mockRestore()
      dispatch.mockRestore()
      routing.mockRestore()
    }
  })
})
