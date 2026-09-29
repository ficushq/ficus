/**
 * Telegram Channel Provider
 *
 * Implements ChannelProvider for Telegram integration.
 */

import { timingSafeEqual } from 'crypto'
import { COMMAND_WORD, FICUS_SLASH_COMMANDS } from '../../lib/channels'
import type { ChannelProvider, ChannelEvent, ThreadMessage, PostMessageResult } from '../provider'
import { createLogger } from '../../lib/infra/logger'
import { getChannelIntegrationValue } from '../../services/integrations/channels/settings'

const log = createLogger('telegram-provider')

// =============================================================================
// Types
// =============================================================================

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from: {
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
    }
    chat: {
      id: number
      type: 'private' | 'group' | 'supergroup' | 'channel'
    }
    text?: string
    reply_to_message?: {
      message_id: number
      from?: { id: number; is_bot?: boolean }
    }
  }
}

interface TelegramApiResponse {
  ok: boolean
  result?: {
    message_id: number
  }
  description?: string
}

// =============================================================================
// API Client
// =============================================================================

async function apiRequest<T = TelegramApiResponse>(method: string, body: Record<string, unknown>): Promise<T> {
  const botToken = getChannelIntegrationValue('TELEGRAM_BOT_TOKEN')
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not configured')

  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Telegram API error (${response.status}): ${error}`)
  }

  const result = (await response.json()) as T
  if (!(result as TelegramApiResponse).ok) {
    throw new Error(`Telegram API error: ${(result as TelegramApiResponse).description}`)
  }

  return result
}

// =============================================================================
// Helpers
// =============================================================================

const commandPrefix = new RegExp(String.raw`^\/${COMMAND_WORD}(?:@\w+)?(?:\s+|$)`, 'i')

function parseCommand(text: string): { command: string; content: string } {
  const trimmed = text.trim()

  // Check for /ficus command format
  const prefix = trimmed.match(commandPrefix)
  if (prefix) {
    const commandText = trimmed.slice(prefix[0].length).trim()
    const parts = commandText.split(/\s+/)
    const firstWord = parts[0]?.toLowerCase() || 'help'
    const command = (FICUS_SLASH_COMMANDS as readonly string[]).includes(firstWord) ? firstWord : 'ask'
    const content =
      command === 'ask' && !(FICUS_SLASH_COMMANDS as readonly string[]).includes(firstWord)
        ? commandText
        : parts.slice(1).join(' ')
    return { command, content }
  }

  // Check for direct commands like /status, /ask
  const match = trimmed.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/)
  if (match) {
    return { command: match[1], content: match[2] }
  }

  // Not a command, treat as general message
  return { command: 'ask', content: trimmed }
}

// =============================================================================
// Provider Implementation
// =============================================================================

let cachedBotUserId: string | null = null

export const telegramProvider: ChannelProvider = {
  name: 'telegram',
  configKey: 'botId',
  sendsResponseViaApi: true,
  reusesThreadForChat: true,

  // ===========================================================================
  // Configuration
  // ===========================================================================

  validateConfig(yaml) {
    if (!yaml.providerConfig?.botId) {
      return 'Telegram requires providerConfig.botId'
    }
    return null
  },

  getPlatformIdFromConfig(config) {
    return (config.botId as string) || null
  },

  // ===========================================================================
  // Webhook Handling
  // ===========================================================================

  async verifySignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const secretToken = getChannelIntegrationValue('TELEGRAM_WEBHOOK_SECRET')
    if (!secretToken) {
      log.warn('TELEGRAM_WEBHOOK_SECRET not configured')
      return false
    }

    const headerToken = headers['x-telegram-bot-api-secret-token']
    if (!headerToken) {
      log.warn('Missing secret token header')
      return false
    }

    try {
      const headerBuffer = Buffer.from(headerToken)
      const secretBuffer = Buffer.from(secretToken)

      if (headerBuffer.length !== secretBuffer.length) {
        return false
      }

      return timingSafeEqual(headerBuffer, secretBuffer)
    } catch {
      return false
    }
  },

  async parseWebhook(
    payload: unknown,
    _headers: Record<string, string>
  ): Promise<ChannelEvent | { type: 'pong' } | { type: 'challenge'; value: string } | null> {
    const update = payload as TelegramUpdate

    const message = update.message
    const messageText = message?.text
    if (!message || !messageText) {
      return null
    }

    const from = message.from
    const chatType = message.chat.type
    const isPrivate = chatType === 'private'
    const isCommand =
      commandPrefix.test(messageText.trim()) ||
      (isPrivate && /^\/(?:help|status|squad|link|ask|notify|unnotify)(?:@\w+)?(?:\s|$)/i.test(messageText.trim()))
    const botUserId = await this.getBotUserId()

    // Check if this is a reply to a bot message
    const isReplyToBot =
      message.reply_to_message?.from?.is_bot === true ||
      (botUserId && message.reply_to_message?.from?.id === parseInt(botUserId))

    // Determine if we should respond:
    // - Private chat: always respond
    // - Group/supergroup: only /ficus commands or replies to bot
    const shouldRespond = isPrivate || isCommand || isReplyToBot

    if (!shouldRespond) {
      log.info(`Telegram: ignoring message in ${chatType} (not command or reply to bot)`)
      return null
    }

    const { command, content } = parseCommand(messageText)
    const chatId = String(message.chat.id)

    // Use chat ID as "thread" since Telegram doesn't have threads
    // This means one consultant per chat
    return {
      type: isCommand ? 'slash_command' : 'message',
      command: isCommand ? command : 'message',
      text: isCommand ? content : messageText,
      isDirectMessage: isPrivate,
      channelId: chatId,
      user: {
        id: String(from.id),
        name: from.username || `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`,
      },
      threadId: chatId, // Use chat ID as thread - one consultant per chat
      messageId: String(message.message_id),
      isInThread: true, // Always "in thread" since we reuse the chat's consultant
      raw: { chatType, isReplyToBot },
    }
  },

  extractPlatformId(_payload: unknown): string | undefined {
    return getChannelIntegrationValue('TELEGRAM_BOT_ID')
  },

  // ===========================================================================
  // Messaging
  // ===========================================================================

  async postMessage(opts): Promise<PostMessageResult> {
    const truncated = opts.text.length > 4096 ? opts.text.slice(0, 4093) + '...' : opts.text

    const result = await apiRequest<TelegramApiResponse>('sendMessage', {
      chat_id: opts.channelId,
      text: truncated,
      parse_mode: 'Markdown',
      // A Ficus conversation ID is the chat ID, not a Telegram message to reply to.
      reply_to_message_id: opts.replyToMessageId ? Number(opts.replyToMessageId) : undefined,
      allow_sending_without_reply: opts.replyToMessageId ? true : undefined,
    })

    return {
      messageId: String(result.result?.message_id),
      threadId: opts.threadId,
    }
  },

  async editMessage(opts): Promise<void> {
    const truncated = opts.text.length > 4096 ? opts.text.slice(0, 4093) + '...' : opts.text

    await apiRequest('editMessageText', {
      chat_id: opts.channelId,
      message_id: parseInt(opts.messageId),
      text: truncated,
      parse_mode: 'Markdown',
    })
  },

  async deleteMessage(opts): Promise<void> {
    await apiRequest('deleteMessage', {
      chat_id: opts.channelId,
      message_id: parseInt(opts.messageId),
    })
  },

  async getThreadHistory(_channelId: string, _threadId: string, _limit?: number): Promise<ThreadMessage[]> {
    // Telegram doesn't have a simple way to fetch message history via Bot API
    // Would need to track messages ourselves or use MTProto
    return []
  },

  async getBotUserId(): Promise<string | null> {
    if (cachedBotUserId) return cachedBotUserId

    try {
      const result = await apiRequest<{ ok: boolean; result: { id: number } }>('getMe', {})
      cachedBotUserId = String(result.result.id)
      log.info(`Telegram bot user ID: ${cachedBotUserId}`)
      return cachedBotUserId
    } catch (e) {
      log.warn(`Failed to get Telegram bot user ID: ${e}`)
      return null
    }
  },

  // ===========================================================================
  // Response Handling
  // ===========================================================================

  async sendResponse({ context, content, agentContext, updateAgentContext }): Promise<string | undefined> {
    // Empty content = delete the thinking message
    if (!content || !content.trim()) {
      if (context.messageToEdit) {
        await this.deleteMessage({ channelId: context.channelId, messageId: context.messageToEdit })
      }
      return undefined
    }

    // Edit thinking message if we have one
    if (context.messageToEdit) {
      await this.editMessage({
        channelId: context.channelId,
        messageId: context.messageToEdit,
        text: content,
      })

      // Update agent context to mark this chat as active
      // For Telegram, threadId = chatId (no real threads)
      if (context.threadId) {
        await updateAgentContext({
          id: context.threadId,
          channelId: context.channelId,
          originalMessageId: context.messageToEdit,
          ficusCreated: true, // Always true for Telegram - we own this chat
        })
      }

      return context.messageToEdit
    }

    // Otherwise post new message
    const result = await this.postMessage({
      channelId: context.channelId,
      text: content,
      threadId: context.threadId,
    })

    // Update agent context
    if (context.threadId) {
      await updateAgentContext({
        id: context.threadId,
        channelId: context.channelId,
        originalMessageId: result.messageId,
        ficusCreated: true,
      })
    }

    return result.messageId
  },

  async postThinkingIndicator(event): Promise<{
    context: Partial<import('../provider').ResponseContext>
    emptyResponse?: boolean
  } | null> {
    // Post "Thinking..." as a reply to user's message
    const result = await this.postMessage({
      channelId: event.channelId,
      text: '_Thinking..._',
      replyToMessageId: event.messageId,
    })

    return {
      context: {
        messageToEdit: result.messageId,
        threadId: event.channelId, // Use chat ID as thread
        ficusInitiated: false, // Reuse existing consultant for this chat
      },
      emptyResponse: true, // Return empty body since we used Bot API
    }
  },

  // ===========================================================================
  // Formatting
  // ===========================================================================

  formatMarkdown(text: string): string {
    // Telegram uses standard Markdown with some quirks
    // Bold: *text* or **text**
    // Italic: _text_
    // We'll keep it simple
    return text
  },

  replaceBotMention(text: string, botUserId: string): string {
    // Telegram mentions are @username, not ID-based in message text
    return text
  },

  formatUserMention(userId: string): string {
    // Telegram uses tg://user?id=123 for mentions, but in text we just use the name
    return `[user](tg://user?id=${userId})`
  },

  // ===========================================================================
  // Sync Responses
  // ===========================================================================

  formatSyncResponse(_content: string): unknown {
    return { ok: true }
  },

  formatErrorResponse(_message: string): unknown {
    return { ok: true }
  },

  formatDeferredResponse(): unknown {
    return { ok: true }
  },

  async sendNotification(opts) {
    const { instance, channelId, event } = opts
    const botToken = getChannelIntegrationValue('TELEGRAM_BOT_TOKEN')

    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN not configured')
    }

    const { formatNotification } = await import('./formatter')
    const body = formatNotification(event)

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: channelId,
        ...body,
      }),
    })

    const data = await response.json()
    if (!data.ok) {
      throw new Error(`Telegram API error: ${data.description}`)
    }
  },
}
