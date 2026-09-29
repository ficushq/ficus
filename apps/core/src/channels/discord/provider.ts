/**
 * Discord Channel Provider
 *
 * Implements ChannelProvider for Discord integration.
 */

import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha2.js'
import { isFicusSlashCommand, FICUS_DISCORD_OPTION_NAMES } from '../../lib/channels'
import type { ChannelProvider, ChannelEvent, ThreadMessage, PostMessageResult } from '../provider'
import { createLogger } from '../../lib/infra/logger'
import { getChannelIntegrationValue } from '../../services/integrations/channels/settings'

const log = createLogger('discord-provider')

// Configure sha512 for @noble/ed25519 v3.x
// @ts-expect-error - configuration property
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m))
// @ts-expect-error - configuration property
ed.etc.sha512Async = (...m: Uint8Array[]) => Promise.resolve(sha512(ed.etc.concatBytes(...m)))

// =============================================================================
// Types
// =============================================================================

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
} as const

const CommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
} as const

interface DiscordInteraction {
  id: string
  application_id: string
  type: number
  data?: {
    name: string
    options?: Array<{
      name: string
      type: number
      value?: string
      options?: Array<{ name: string; type: number; value?: string }>
    }>
  }
  guild_id?: string
  context?: number
  channel_id?: string
  channel?: { type?: number; parent_id?: string }
  member?: { user: { id: string; username: string; global_name?: string } }
  user?: { id: string; username: string; global_name?: string }
  token: string
}

interface DiscordMessage {
  id: string
  channel_id: string
  content: string
  author: { id: string; username: string; bot?: boolean }
  thread?: { id: string }
  timestamp: string
}

// =============================================================================
// Helpers
// =============================================================================

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

type OptionItem = { name: string; type: number; value?: string; options?: OptionItem[] }

function extractOptionValue(options: OptionItem[] | undefined, names: string[]): string {
  if (!options) return ''

  const subcommand = options.find((o: OptionItem) => o.type === CommandOptionType.SUB_COMMAND)
  if (subcommand?.options) {
    const opt = subcommand.options.find((o: OptionItem) => names.includes(o.name))
    return opt?.value?.toString() || ''
  }

  const opt = options.find((o: OptionItem) => names.includes(o.name))
  return opt?.value?.toString() || ''
}

// =============================================================================
// API Client
// =============================================================================

const API_BASE = 'https://discord.com/api/v10'

async function apiRequest<T>(path: string, method: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bot ${token}`

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Discord API error (${response.status}): ${error}`)
  }

  if (response.status === 204) return {} as T
  return response.json()
}

// =============================================================================
// Provider Implementation
// =============================================================================

let cachedBotUserId: string | null = null

export const discordProvider: ChannelProvider = {
  name: 'discord',
  configKey: 'guildId',

  // ===========================================================================
  // Configuration
  // ===========================================================================

  validateConfig(yaml) {
    if (!yaml.providerConfig?.guildId) {
      return 'Discord requires providerConfig.guildId'
    }
    return null
  },

  getPlatformIdFromConfig(config) {
    return (config.guildId as string) || null
  },

  // ===========================================================================
  // Webhook Handling
  // ===========================================================================

  async verifySignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const publicKey = getChannelIntegrationValue('DISCORD_PUBLIC_KEY')
    if (!publicKey) {
      log.warn('DISCORD_PUBLIC_KEY not configured')
      return false
    }

    const signature = headers['x-signature-ed25519']
    const timestamp = headers['x-signature-timestamp']

    if (!signature || !timestamp) {
      log.warn('Missing signature or timestamp headers')
      return false
    }

    try {
      const message = new TextEncoder().encode(timestamp + rawBody)
      const sig = hexToBytes(signature)
      const key = hexToBytes(publicKey)
      return await ed.verifyAsync(sig, message, key)
    } catch (e) {
      log.error('Signature verification error:', e)
      return false
    }
  },

  async parseWebhook(
    payload: unknown,
    _headers: Record<string, string>
  ): Promise<ChannelEvent | { type: 'pong' } | { type: 'challenge'; value: string } | null> {
    const interaction = payload as DiscordInteraction

    // Ping verification
    if (interaction.type === InteractionType.PING) {
      return { type: 'pong' }
    }

    // Slash command
    if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data) {
      const options = interaction.data.options || []
      const subcommand = options.find((o) => o.type === CommandOptionType.SUB_COMMAND)
      const user = interaction.member?.user || interaction.user
      const rawCommand = subcommand?.name || interaction.data.name || 'ask'
      const command = isFicusSlashCommand(rawCommand) ? rawCommand : 'ask'

      return {
        type: 'slash_command',
        command,
        text: extractOptionValue(options, [...FICUS_DISCORD_OPTION_NAMES]),
        channelId: interaction.channel_id || '',
        routingChannelId: [10, 11, 12].includes(interaction.channel?.type ?? -1)
          ? interaction.channel?.parent_id
          : undefined,
        user: {
          id: user?.id || '',
          name: user?.global_name || user?.username || 'User',
        },
        messageId: interaction.id,
        isDirectMessage: !interaction.guild_id && (interaction.channel?.type === 1 || interaction.context === 1),
        isInThread: [10, 11, 12].includes(interaction.channel?.type ?? -1),
        raw: {
          interactionToken: interaction.token,
          applicationId: interaction.application_id,
          guildId: interaction.guild_id,
          userId: user?.id,
          question: extractOptionValue(options, [...FICUS_DISCORD_OPTION_NAMES]),
        },
      }
    }

    return null
  },

  extractPlatformId(payload: unknown): string | undefined {
    const interaction = payload as DiscordInteraction
    return (
      interaction.guild_id ??
      (!interaction.guild_id && (interaction.channel?.type === 1 || interaction.context === 1)
        ? getChannelIntegrationValue('DISCORD_GUILD_ID')
        : undefined)
    )
  },

  // ===========================================================================
  // Messaging
  // ===========================================================================

  async postMessage(opts): Promise<PostMessageResult> {
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

    const truncated = opts.text.length > 2000 ? opts.text.slice(0, 1997) + '...' : opts.text
    const channelId = opts.threadId || opts.channelId

    const result = await apiRequest<DiscordMessage>(
      `/channels/${channelId}/messages`,
      'POST',
      { content: truncated },
      token
    )

    return { messageId: result.id, threadId: opts.threadId, editChannelId: channelId }
  },

  async editMessage(opts): Promise<void> {
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

    const truncated = opts.text.length > 2000 ? opts.text.slice(0, 1997) + '...' : opts.text

    await apiRequest(`/channels/${opts.channelId}/messages/${opts.messageId}`, 'PATCH', { content: truncated }, token)
  },

  async deleteMessage(opts): Promise<void> {
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

    await apiRequest(`/channels/${opts.channelId}/messages/${opts.messageId}`, 'DELETE', undefined, token)
  },

  async getThreadHistory(channelId: string, threadId: string, limit = 50): Promise<ThreadMessage[]> {
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

    const botUserId = await this.getBotUserId()

    const messages = await apiRequest<DiscordMessage[]>(
      `/channels/${threadId}/messages?limit=${limit}`,
      'GET',
      undefined,
      token
    )

    // Handle thread starter messages (type 21) - they reference the original message
    const resolvedMessages = await Promise.all(
      messages.map(async (m) => {
        const msgType = (m as { type?: number }).type
        const msgRef = (m as { message_reference?: { message_id?: string; channel_id?: string } }).message_reference

        // Type 21 = THREAD_STARTER_MESSAGE - fetch the original message content
        if (msgType === 21 && msgRef?.message_id && msgRef?.channel_id) {
          try {
            const original = await apiRequest<DiscordMessage>(
              `/channels/${msgRef.channel_id}/messages/${msgRef.message_id}`,
              'GET',
              undefined,
              token
            )
            return { ...m, content: original.content, author: original.author }
          } catch {
            // If we can't fetch, skip this message
            return null
          }
        }
        return m
      })
    )

    return resolvedMessages
      .filter((m): m is DiscordMessage => m !== null)
      .reverse()
      .map((m) => ({
        messageId: m.id,
        userId: m.author.id,
        text: m.content,
        timestamp: m.timestamp,
        isBotMessage: m.author.bot || (botUserId ? m.author.id === botUserId : false),
      }))
  },

  async getBotUserId(): Promise<string | null> {
    if (cachedBotUserId) return cachedBotUserId

    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) return null

    try {
      const user = await apiRequest<{ id: string }>('/users/@me', 'GET', undefined, token)
      cachedBotUserId = user.id
      log.info(`Discord bot user ID: ${cachedBotUserId}`)
      return cachedBotUserId
    } catch (e) {
      log.warn(`Failed to get Discord bot user ID: ${e}`)
      return null
    }
  },

  // ===========================================================================
  // Response Handling
  // ===========================================================================

  async sendResponse({ context, content, agentContext, updateAgentContext }): Promise<string | undefined> {
    const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
    if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

    // Empty content = delete the thinking message (consultant chose not to respond)
    if (!content || !content.trim()) {
      if (context.messageToEdit) {
        const channelId = agentContext.thread?.id || context.channelId
        if (channelId) {
          await this.deleteMessage({ channelId, messageId: context.messageToEdit })
        }
      }
      return agentContext.thread?.id || context.channelId
    }

    const truncated = content.length > 2000 ? content.slice(0, 1997) + '...' : content
    const extras = context.extras as Record<string, unknown> | undefined

    // If thread exists in agent context, respond in thread
    if (agentContext.thread?.id) {
      if (context.messageToEdit) {
        await this.editMessage({
          channelId: agentContext.thread.id,
          messageId: context.messageToEdit,
          text: truncated,
        })
      } else if (extras?.interactionToken && extras?.applicationId) {
        // Try to edit interaction response
        try {
          await editInteractionResponse(extras.applicationId as string, extras.interactionToken as string, truncated)
          return agentContext.thread.id
        } catch {
          // Token expired, post new message
          await this.postMessage({
            channelId: agentContext.thread.id,
            text: truncated,
          })
        }
      } else {
        await this.postMessage({
          channelId: agentContext.thread.id,
          text: truncated,
        })
      }
      return agentContext.thread.id
    }

    // @mention flow: thread already created by gateway, just edit thinking message
    if (context.messageToEdit && context.channelId) {
      await this.editMessage({
        channelId: context.channelId,
        messageId: context.messageToEdit,
        text: truncated,
      })

      // Save thread context for future replies
      await updateAgentContext({
        id: context.channelId, // channelId IS the thread ID for mentions
        channelId: context.channelId,
        originalMessageId: context.messageToEdit,
        ficusCreated: context.ficusInitiated ?? false,
      })

      return context.channelId
    }

    // Slash command flow: create thread from interaction
    const interactionToken = extras?.interactionToken as string | undefined
    const applicationId = extras?.applicationId as string | undefined

    if (!interactionToken || !applicationId) {
      throw new Error('Missing interaction token for first Discord response')
    }

    // Edit deferred message with user's question
    const userId = extras?.userId as string | undefined
    const question = extras?.question as string | undefined
    const userMention = userId ? this.formatUserMention(userId) : 'User'
    await editInteractionResponse(applicationId, interactionToken, `${userMention} asked:\n> ${question || 'Question'}`)

    // Get message and create thread
    const message = await getInteractionMessage(applicationId, interactionToken)
    const thread = await createThread(message.channel_id, message.id, 'Ficus Response')

    // Post in thread
    await this.postMessage({
      channelId: thread.id,
      text: truncated,
    })

    // Save thread context
    await updateAgentContext({
      id: thread.id,
      channelId: message.channel_id,
      originalMessageId: message.id,
      ficusCreated: true,
    })

    return thread.id
  },

  async postThinkingIndicator(_event) {
    // Discord uses deferred response, no need to post anything
    return null
  },

  // ===========================================================================
  // Formatting
  // ===========================================================================

  formatMarkdown(text: string): string {
    // Discord uses standard markdown, no conversion needed
    return text
  },

  replaceBotMention(text: string, botUserId: string): string {
    // Discord mentions can be <@123> or <@!123>
    return text.replace(new RegExp(`<@!?${botUserId}>`, 'g'), '@Ficus')
  },

  formatUserMention(userId: string): string {
    return `<@${userId}>`
  },

  // ===========================================================================
  // Sync Responses
  // ===========================================================================

  formatSyncResponse(content: string): unknown {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE,
      data: { content },
    }
  },

  formatErrorResponse(message: string): unknown {
    return {
      type: InteractionResponseType.CHANNEL_MESSAGE,
      data: { content: `❌ ${message}` },
    }
  },

  formatDeferredResponse(): unknown {
    return { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE }
  },

  // ===========================================================================
  // Notifications
  // ===========================================================================

  async sendNotification(opts) {
    const { instance, channelId, event } = opts
    const botToken = getChannelIntegrationValue('DISCORD_BOT_TOKEN')

    if (!botToken) {
      throw new Error('DISCORD_BOT_TOKEN not configured')
    }

    const { formatNotification } = await import('./formatter')
    const body = formatNotification(event)

    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Discord API error ${response.status}: ${text}`)
    }
  },
}

// =============================================================================
// Exported Helpers
// =============================================================================

// Export for external use
export const InteractionResponseTypes = InteractionResponseType
export { InteractionResponseType }

/**
 * Edit the original interaction response (deferred message).
 */
export async function editInteractionResponse(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const truncated = content.length > 2000 ? content.slice(0, 1997) + '...' : content

  const response = await fetch(`${API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: truncated }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Discord interaction response failed (HTTP ${response.status})`)
}

/**
 * Get the original interaction message.
 */
export async function getInteractionMessage(applicationId: string, interactionToken: string): Promise<DiscordMessage> {
  const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
  return apiRequest<DiscordMessage>(
    `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    'GET',
    undefined,
    token
  )
}

/**
 * Create a thread on a message.
 */
export async function createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
  const token = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
  if (!token) throw new Error('DISCORD_BOT_TOKEN not configured')

  return apiRequest<{ id: string }>(
    `/channels/${channelId}/messages/${messageId}/threads`,
    'POST',
    { name, auto_archive_duration: 1440 },
    token
  )
}
