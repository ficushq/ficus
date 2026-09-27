import { ChannelInstance } from '../entities/ChannelInstance'
import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test'
import type { ChannelProvider } from '../channels'
import { eq } from 'drizzle-orm'
import { registerProvider } from '../channels/provider'
import { db } from '../db'
import { agents, inbox } from '../db/schema'
import { Agent } from '../entities/Agent'
import { AgentType } from '../entities/AgentType'
import { InboxMessage } from '../entities/InboxMessage'
import { createChannelEditTool, createChannelRespondTool, createChannelSendTool } from './index'

const agentTypeId = 'channel-message-tools-test'
const providerName = 'test-channel-tools'

async function createTestAgent(context: Record<string, unknown>) {
  await AgentType.upsert({
    id: agentTypeId,
    model: 'anthropic:claude-sonnet-4-5',
    name: 'Channel Message Tools Test',
    systemPrompt: 'You are a test agent.',
  })

  return Agent.create({ agentTypeId, name: 'Consultant', context })
}

function registerTestProvider(overrides: Partial<ChannelProvider>) {
  const provider: ChannelProvider = {
    name: providerName,
    configKey: 'testId',
    validateConfig: mock(() => null),
    getPlatformIdFromConfig: mock(() => 'platform-1'),
    verifySignature: mock(async () => true),
    parseWebhook: mock(async () => null),
    extractPlatformId: mock(() => undefined),
    postMessage: mock(async () => ({ messageId: 'provider-msg-1', threadId: 'thread-1' })),
    editMessage: mock(async () => undefined),
    deleteMessage: mock(async () => undefined),
    getThreadHistory: mock(async () => []),
    getBotUserId: mock(async () => 'bot-1'),
    sendResponse: mock(async () => 'thread-1'),
    postThinkingIndicator: mock(async () => null),
    formatMarkdown: mock((text: string) => text),
    replaceBotMention: mock((text: string) => text),
    formatUserMention: mock((userId: string) => `@${userId}`),
    formatSyncResponse: mock((content: string) => content),
    formatErrorResponse: mock((message: string) => message),
    formatDeferredResponse: mock(() => ({})),
    ...overrides,
  }

  registerProvider(provider)
  return provider
}

describe('channel message tools', () => {
  let connection: ReturnType<typeof spyOn>
  beforeEach(() => {
    connection = spyOn(ChannelInstance, 'find').mockResolvedValue(
      new ChannelInstance({ id: 'instance-1', provider: providerName, disabled: false } as any)
    )
  })
  afterEach(() => connection.mockRestore())

  it('blocks delayed replies after a channel is excluded', async () => {
    const postMessage = mock(async () => ({ messageId: 'reply' }))
    registerTestProvider({ postMessage })
    connection.mockResolvedValue(
      new ChannelInstance({
        id: 'instance-1',
        provider: providerName,
        deniedChannelIds: ['C1'],
        disabled: false,
      } as any)
    )
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'thread-1', channelId: 'C1', originalMessageId: 'm0', tauCreated: true },
    })
    try {
      const result = await createChannelSendTool(agent.id).execute(
        'call',
        { content: 'Delayed result' },
        undefined,
        undefined,
        {} as any
      )
      expect((result.details as { success: boolean }).success).toBe(false)
      expect(postMessage).not.toHaveBeenCalled()
    } finally {
      await agent.delete()
    }
  })

  it('channel_send tracks the provider edit channel id when posting into a provider thread', async () => {
    const postMessage = mock(async () => ({
      messageId: 'provider-msg-1',
      threadId: 'discord-thread-1',
      editChannelId: 'discord-thread-1',
    }))
    registerTestProvider({ postMessage })
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'discord-thread-1', channelId: 'discord-parent-1', originalMessageId: 'm0', tauCreated: true },
    })

    try {
      await createChannelSendTool(agent.id).execute('call-1', { content: 'update' }, undefined, undefined, {} as any)

      await agent.reload()
      expect((agent.context as any).channelMessages).toContainEqual(
        expect.objectContaining({
          channelId: 'discord-thread-1',
          threadId: 'discord-thread-1',
          messageId: 'provider-msg-1',
        })
      )
    } finally {
      await agent.delete()
    }
  })

  it('channel_send posts to the active consultant thread and tracks the provider message id', async () => {
    const postMessage = mock(async () => ({ messageId: 'provider-msg-1', threadId: 'thread-1' }))
    registerTestProvider({ postMessage })
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'thread-1', channelId: 'C1', originalMessageId: 'm0', tauCreated: true },
    })

    try {
      const result = await createChannelSendTool(agent.id).execute(
        'call-1',
        { content: 'update' },
        undefined,
        undefined,
        {} as any
      )

      await agent.reload()
      expect((result.details as { success: boolean }).success).toBe(true)
      expect(postMessage).toHaveBeenCalledWith({ channelId: 'C1', threadId: 'thread-1', text: 'update' })
      expect((agent.context as any).channelMessages).toContainEqual(
        expect.objectContaining({
          provider: providerName,
          channelId: 'C1',
          threadId: 'thread-1',
          messageId: 'provider-msg-1',
          source: 'channel_send',
        })
      )
    } finally {
      await agent.delete()
    }
  })

  it('channel_edit edits a tracked Ficus-sent message', async () => {
    const editMessage = mock(async () => undefined)
    registerTestProvider({ editMessage })
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'thread-1', channelId: 'C1', originalMessageId: 'm0', tauCreated: true },
      channelMessages: [
        {
          provider: providerName,
          channelId: 'C1',
          threadId: 'thread-1',
          messageId: 'provider-msg-1',
          source: 'channel_send',
          createdAt: new Date().toISOString(),
        },
      ],
    })

    try {
      const result = await createChannelEditTool(agent.id).execute(
        'call-1',
        { messageId: 'provider-msg-1', content: 'replacement' },
        undefined,
        undefined,
        {} as any
      )

      expect((result.details as { success: boolean }).success).toBe(true)
      expect(editMessage).toHaveBeenCalledWith({ channelId: 'C1', messageId: 'provider-msg-1', text: 'replacement' })
    } finally {
      await agent.delete()
    }
  })

  it('channel_edit refuses an unknown message id', async () => {
    const editMessage = mock(async () => undefined)
    registerTestProvider({ editMessage })
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'thread-1', channelId: 'C1', originalMessageId: 'm0', tauCreated: true },
      channelMessages: [],
    })

    try {
      const result = await createChannelEditTool(agent.id).execute(
        'call-1',
        { messageId: 'unknown-msg', content: 'replacement' },
        undefined,
        undefined,
        {} as any
      )

      expect((result.details as { success: boolean }).success).toBe(false)
      expect((result.details as { error: string }).error).toContain('Unknown or untracked')
      expect(editMessage).not.toHaveBeenCalled()
    } finally {
      await agent.delete()
    }
  })

  it('channel_respond tracks editable placeholder message ids', async () => {
    const sendResponse = mock(async () => 'thread-1')
    registerTestProvider({ sendResponse })
    const agent = await createTestAgent({
      channelInstance: { id: 'instance-1', provider: providerName },
      thread: { id: 'thread-1', channelId: 'C1', originalMessageId: 'm0', tauCreated: true },
    })
    const message = await InboxMessage.send({
      recipientId: agent.id,
      recipientType: 'agent',
      senderType: 'system',
      content: 'Question',
      metadata: {
        channelContext: {
          provider: providerName,
          channelId: 'C1',
          threadId: 'thread-1',
          messageToEdit: 'placeholder-1',
        },
      },
    })

    try {
      const result = await createChannelRespondTool().execute(
        'call-1',
        { messageId: message.id, content: 'answer' },
        undefined,
        undefined,
        {} as any
      )

      await agent.reload()
      expect((result.details as { success: boolean }).success).toBe(true)
      expect((agent.context as any).channelMessages).toContainEqual(
        expect.objectContaining({
          provider: providerName,
          channelId: 'C1',
          threadId: 'thread-1',
          messageId: 'placeholder-1',
          source: 'channel_respond',
        })
      )
    } finally {
      await db.delete(inbox).where(eq(inbox.id, message.id))
      await db.delete(agents).where(eq(agents.id, agent.id))
    }
  })
})
