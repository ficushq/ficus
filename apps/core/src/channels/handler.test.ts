import { describe, it, expect, mock, afterEach, spyOn } from 'bun:test'
import { handleChannelEvent } from './handler'
import { ChannelInstance } from '../entities/ChannelInstance'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import type { ChannelProvider, InboundMessage } from './provider'

function trustedInstance(extra: Partial<ChannelInstance> = {}) {
  return Object.assign(
    new ChannelInstance({
      id: 'instance-test',
      defaultSquadId: 'squad-test',
      trustedChannelIds: ['C123', 'chat-1', '12345', 'telegram-chat-1'],
      disabled: false,
    } as any),
    extra
  )
}

describe('handleChannelEvent mention routing', () => {
  let findByProviderSpy: ReturnType<typeof spyOn>
  let findByThreadIdSpy: ReturnType<typeof spyOn>
  let inboxSendSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    findByProviderSpy?.mockRestore()
    findByThreadIdSpy?.mockRestore()
    inboxSendSpy?.mockRestore()
  })

  for (const provider of ['telegram', 'slack', 'discord']) {
    for (const command of [undefined, 'help', 'link', 'squad']) {
      it(`ignores disabled ${provider} DMs before handling ${command ?? 'messages'}`, async () => {
        findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(
          trustedInstance({ allowPrivateChats: false })
        )
        findByThreadIdSpy = spyOn(Agent, 'findByThreadId')
        inboxSendSpy = spyOn(InboxMessage, 'send')
        const postMessage = mock(async () => ({ messageId: 'reply' }))
        const result = await handleChannelEvent(
          { name: provider, postMessage } as any,
          {
            type: command ? 'slash_command' : 'message',
            command,
            text: 'hello',
            channelId: 'C123',
            isDirectMessage: true,
            user: { id: 'user', name: 'User' },
          } as any,
          'platform'
        )
        expect(result.response).toEqual({ ok: true })
        expect(postMessage).not.toHaveBeenCalled()
        expect(findByThreadIdSpy).not.toHaveBeenCalled()
        expect(inboxSendSpy).not.toHaveBeenCalled()
      })
    }
  }

  for (const command of ['help', 'link', 'ask']) {
    it(`ignores ${command} in excluded channels before replying or creating an agent`, async () => {
      const instance = trustedInstance({ deniedChannelIds: ['parent'], trustedChannelIds: ['parent'] })
      findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(instance)
      findByThreadIdSpy = spyOn(Agent, 'findByThreadId')
      const postMessage = mock(async () => ({ messageId: 'reply' }))
      const result = await handleChannelEvent(
        { name: 'discord', postMessage } as any,
        {
          type: 'slash_command',
          command,
          text: 'test',
          channelId: 'thread',
          routingChannelId: 'parent',
          user: { id: 'user', name: 'User' },
        } as any,
        'guild'
      )
      expect(result.response).toEqual({ ok: true })
      expect(postMessage).not.toHaveBeenCalled()
      expect(findByThreadIdSpy).not.toHaveBeenCalled()
    })
  }

  it('queues a Slack app mention in a channel for consultant with a managed thread context', async () => {
    const queueForConsultant = mock(() => Promise.resolve('agent-1'))
    const channelInstance = trustedInstance({ queueForConsultant, allowPrivateChats: false })
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)

    const postMessage = mock(() => Promise.resolve({ messageId: 'unused', threadId: 'unused' }))
    const postMentionThinkingIndicator = mock(() =>
      Promise.resolve({ messageId: '1710000000.000200', threadId: '1710000000.000100' })
    )
    const provider = {
      name: 'slack',
      postMessage,
      postMentionThinkingIndicator,
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
    } as unknown as ChannelProvider

    const result = await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Ficus can you help?',
        channelId: 'C123',
        user: { id: 'U123', name: 'U123' },
        messageId: '1710000000.000100',
        isInThread: false,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(findByProviderSpy).toHaveBeenCalledWith('slack', 'T123')
    expect(postMentionThinkingIndicator).toHaveBeenCalledWith({
      type: 'mention',
      text: '@Ficus can you help?',
      channelId: 'C123',
      user: { id: 'U123', name: 'U123' },
      messageId: '1710000000.000100',
      isInThread: false,
      raw: { teamId: 'T123' },
    })
    expect(postMessage).not.toHaveBeenCalled()
    expect(queueForConsultant).toHaveBeenCalledWith({
      command: 'mention',
      content: '@Ficus can you help?',
      user: { id: 'U123', name: 'U123' },
      responseContext: {
        provider: 'slack',
        channelId: 'C123',
        threadId: '1710000000.000100',
        messageToEdit: '1710000000.000200',
        ficusInitiated: true,
        extras: { teamId: 'T123' },
      },
    })
    expect(result).toEqual({ response: { ok: true } })
  })

  it('processes a mention in a Ficus-created Slack thread instead of relying on regular message handling', async () => {
    const channelInstance = trustedInstance()
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
      context: {
        thread: {
          id: '1710000000.000100',
          channelId: 'C123',
          originalMessageId: '1710000000.000100',
          ficusCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text.replace(/<@UBOT>/g, '@Ficus'),
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1710000000.000100',
            userId: 'U456',
            userName: 'Grace (Grace Hopper, @grace, <@U456>)',
            text: 'Earlier context',
            timestamp: '1710000000.000100',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Ficus current follow-up',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(provider.postMessage).toHaveBeenCalledWith({
      channelId: 'C123',
      text: '_Thinking..._',
      threadId: '1710000000.000100',
    })
    const sent = inboxSendSpy.mock.calls[0]?.[0] as any
    expect(sent.content).toContain('Countess (Ada Lovelace, @ada, <@U123>): @Ficus current follow-up')
    expect(sent).toMatchObject({
      recipientId: 'agent-1',
      senderType: 'system',
      subject: 'Channel: mention',
      metadata: {
        type: 'channel_message',
        channelContext: {
          provider: 'slack',
          channelId: 'C123',
          threadId: '1710000000.000100',
          messageToEdit: '1710000002.000300',
          ficusInitiated: false,
          extras: { teamId: 'T123' },
        },
        userId: 'U123',
        userName: 'Countess (Ada Lovelace, @ada, <@U123>)',
        command: 'mention',
      },
    })
  })

  it('ignores a regular message in a Ficus-created Slack thread when Ficus is not mentioned', async () => {
    const channelInstance = trustedInstance()
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
      context: {
        thread: {
          id: '1710000000.000100',
          channelId: 'C123',
          originalMessageId: '1710000000.000100',
          ficusCreated: true,
        },
      },
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    const result = await handleChannelEvent(
      provider,
      {
        type: 'message',
        text: 'regular follow-up with no Ficus mention',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(provider.postMessage).not.toHaveBeenCalled()
    expect(inboxSendSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ response: { ok: true } })
  })

  it('routes active consultant mentions with history only since the latest Ficus response', async () => {
    const channelInstance = trustedInstance()
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
    } as unknown as Agent)
    inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as InboxMessage)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text,
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1',
            userId: 'U1',
            userName: 'Before',
            text: 'before latest Ficus',
            timestamp: '1',
            isBotMessage: false,
          },
          {
            messageId: '2',
            userId: 'UBOT',
            userName: 'Ficus',
            text: 'latest Ficus response',
            timestamp: '2',
            isBotMessage: true,
          },
          {
            messageId: '3',
            userId: 'U2',
            userName: 'After',
            text: 'after latest Ficus',
            timestamp: '3',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking', threadId: 'thread-1' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Ficus current',
        channelId: 'C123',
        user: { id: 'U3', name: 'Current' },
        threadId: 'thread-1',
        messageId: '4',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    const sent = inboxSendSpy.mock.calls[0]?.[0] as any
    expect(sent.content).not.toContain('before latest Ficus')
    expect(sent.content).toContain('@Ficus: latest Ficus response')
    expect(sent.content).toContain('After: after latest Ficus')
    expect(sent.content).toContain('Current: @Ficus current')
  })

  it('spawns a replacement consultant with full thread history when no active thread agent exists', async () => {
    let queued: InboundMessage | undefined
    const queueForConsultant = mock((inbound: InboundMessage) => {
      queued = inbound
      return Promise.resolve('agent-replacement')
    })
    const channelInstance = trustedInstance({ queueForConsultant })
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue(null)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text,
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1',
            userId: 'U1',
            userName: 'Before',
            text: 'before latest Ficus',
            timestamp: '1',
            isBotMessage: false,
          },
          {
            messageId: '2',
            userId: 'UBOT',
            userName: 'Ficus',
            text: 'latest Ficus response',
            timestamp: '2',
            isBotMessage: true,
          },
          {
            messageId: '3',
            userId: 'U2',
            userName: 'After',
            text: 'after latest Ficus',
            timestamp: '3',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: 'thinking', threadId: 'thread-1' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Ficus current',
        channelId: 'C123',
        user: { id: 'U3', name: 'Current' },
        threadId: 'thread-1',
        messageId: '4',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(queueForConsultant).toHaveBeenCalledTimes(1)
    expect(queued?.content).toContain('Before: before latest Ficus')
    expect(queued?.content).toContain('@Ficus: latest Ficus response')
    expect(queued?.content).toContain('After: after latest Ficus')
    expect(queued?.content).toContain('Current: @Ficus current')
  })

  it('preserves the enriched current Slack sender label in joined thread history', async () => {
    let queued: InboundMessage | undefined
    const queueForConsultant = mock((inbound: InboundMessage) => {
      queued = inbound
      return Promise.resolve('agent-1')
    })
    const channelInstance = trustedInstance({ queueForConsultant })
    findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(channelInstance)
    findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue(null)

    const provider = {
      name: 'slack',
      formatErrorResponse: (message: string) => ({ text: message }),
      formatUserMention: (userId: string) => `<@${userId}>`,
      replaceBotMention: (text: string) => text.replace(/<@UBOT>/g, '@Ficus'),
      getBotUserId: mock(() => Promise.resolve('UBOT')),
      getThreadHistory: mock(() =>
        Promise.resolve([
          {
            messageId: '1710000000.000100',
            userId: 'U456',
            userName: 'Grace (Grace Hopper, @grace, <@U456>)',
            text: 'Earlier context for <@UBOT>',
            timestamp: '1710000000.000100',
            isBotMessage: false,
          },
          {
            messageId: '1710000000.000150',
            userId: 'U789',
            userName: 'Katherine Johnson (@katherine, <@U789>)',
            text: 'Additional historical context',
            timestamp: '1710000000.000150',
            isBotMessage: false,
          },
        ])
      ),
      postMessage: mock(() => Promise.resolve({ messageId: '1710000002.000300', threadId: '1710000000.000100' })),
    } as unknown as ChannelProvider

    await handleChannelEvent(
      provider,
      {
        type: 'mention',
        text: '@Ficus current follow-up',
        channelId: 'C123',
        user: { id: 'U123', name: 'Countess (Ada Lovelace, @ada, <@U123>)' },
        threadId: '1710000000.000100',
        messageId: '1710000001.000200',
        isInThread: true,
        raw: { teamId: 'T123' },
      },
      'T123'
    )

    expect(queueForConsultant).toHaveBeenCalledTimes(1)
    expect(queued?.content).toContain('Grace (Grace Hopper, @grace, <@U456>): Earlier context for @Ficus')
    expect(queued?.content).toContain('Katherine Johnson (@katherine, <@U789>): Additional historical context')
    expect(queued?.content).toContain('Countess (Ada Lovelace, @ada, <@U123>): @Ficus current follow-up')
    expect(queued?.content).not.toContain('<@U123>: @Ficus current follow-up')
  })
})

describe('channel sender boundary', () => {
  it('queues Telegram follow-ups using the incoming message ID for the acknowledgement', async () => {
    const instance = trustedInstance()
    const findByProviderSpy = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(instance)
    const findByThreadIdSpy = spyOn(Agent, 'findByThreadId').mockResolvedValue({
      id: 'agent-1',
      squadId: 'squad-test',
      agentTypeId: 'consultant',
    } as Agent)
    const inboxSendSpy = spyOn(InboxMessage, 'send').mockResolvedValue({} as never)
    const postMessage = mock(async (_opts: Parameters<ChannelProvider['postMessage']>[0]) => ({ messageId: '43' }))
    const provider = {
      name: 'telegram',
      reusesThreadForChat: true,
      postMessage,
      formatUserMention: (id: string) => id,
    } as unknown as ChannelProvider
    try {
      await handleChannelEvent(
        provider,
        {
          type: 'message',
          text: 'Follow up',
          channelId: '12345',
          threadId: '12345',
          messageId: '42',
          user: { id: 'user-1', name: 'Ada' },
          isInThread: true,
          raw: {},
        },
        'bot-1'
      )
      expect(postMessage.mock.calls[0][0]).toMatchObject({ channelId: '12345', replyToMessageId: '42' })
      expect(inboxSendSpy).toHaveBeenCalledTimes(1)
      expect(inboxSendSpy.mock.calls[0][0].metadata?.channelContext).toMatchObject({
        threadId: '12345',
        messageToEdit: '43',
      })
    } finally {
      findByProviderSpy.mockRestore()
      findByThreadIdSpy.mockRestore()
      inboxSendSpy.mockRestore()
    }
  })

  it('rejects an unknown sender before fetching history, posting thinking, or creating an agent', async () => {
    const instance = trustedInstance({ trustedChannelIds: [] })
    const lookup = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(instance)
    const queue = spyOn(instance, 'queueForConsultant')
    const history = mock(async () => [])
    const thinking = mock(async () => ({ messageId: 'thinking' }))
    const post = mock(async (_opts: Parameters<ChannelProvider['postMessage']>[0]) => ({ messageId: 'denied' }))
    const provider = {
      name: 'slack',
      getThreadHistory: history,
      postThinkingIndicator: thinking,
      postMessage: post,
    } as unknown as ChannelProvider
    try {
      await handleChannelEvent(
        provider,
        {
          type: 'mention',
          user: { id: 'unlinked', name: 'Unknown' },
          channelId: 'C123',
          messageId: 'M1',
          isInThread: true,
          threadId: 'T1',
          text: 'Do work',
          raw: {},
        },
        'workspace'
      )
      expect(post).toHaveBeenCalledTimes(1)
      expect(post.mock.calls[0][0].text).toContain('Link your account')
      expect(history).not.toHaveBeenCalled()
      expect(thinking).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
    } finally {
      lookup.mockRestore()
      queue.mockRestore()
    }
  })
})
