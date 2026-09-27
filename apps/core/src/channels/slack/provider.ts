/**
 * Slack Channel Provider
 *
 * Implements ChannelProvider for Slack integration.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { FICUS_SLASH_COMMANDS } from '../../lib/channels'
import type { ChannelProvider, ChannelEvent, ThreadMessage, PostMessageResult, ChannelAttachment } from '../provider'
import { Image, type ImageContent } from '../../entities/Image'
import { createLogger } from '../../lib/infra/logger'
import { getChannelIntegrationValue } from '../../services/integrations/channels/settings'

const log = createLogger('slack-provider')

// =============================================================================
// Types
// =============================================================================

interface SlackSlashCommand {
  team_id: string
  channel_id: string
  user_id: string
  user_name: string
  command: string
  text: string
  response_url: string
  trigger_id: string
}

interface SlackEvent {
  type: string
  text?: string
  user?: string
  channel?: string
  thread_ts?: string
  bot_id?: string
  ts?: string
  event_ts?: string
  channel_type?: string
  subtype?: string
  room?: { id: string; huddle_id?: string } | null
  files?: SlackFile[]
  attachments?: SlackAttachment[]
}

interface SlackEventPayload {
  type: string
  challenge?: string
  team_id?: string
  event?: SlackEvent
}

interface SlackApiResponse {
  ok: boolean
  error?: string
  warning?: string
  ts?: string
  channel?: string
  user_id?: string
  user?: SlackUser
  messages?: SlackMessage[]
  permalink?: string
  file?: SlackFileInfo
  response_metadata?: {
    next_cursor?: string
  }
}

interface SlackUser {
  id: string
  name?: string
  real_name?: string
  profile?: {
    display_name?: string
    real_name?: string
  }
}

interface SlackFile {
  id: string
  mimetype?: string
  filetype?: string
  subtype?: string
  title?: string
  name?: string
  permalink?: string
  url_private?: string
  url_private_download?: string
  size?: number
}

interface SlackAttachment {
  file_id?: string
  title?: string
  title_link?: string
  from_url?: string
  service_name?: string
}

export interface SlackFileInfo extends SlackFile {
  canvas?: { document_content?: { markdown?: string } }
  timestamp?: number
  updated_at?: number
}

interface SlackMessage {
  ts: string
  text: string
  user?: string
  bot_id?: string
  subtype?: string
  thread_ts?: string
  room?: { id: string; huddle_id?: string } | null
  files?: SlackFile[]
  attachments?: SlackAttachment[]
}

class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`Slack API error: ${code}`)
    this.name = 'SlackApiError'
  }
}

// =============================================================================
// API Client
// =============================================================================

class SlackApi {
  private baseUrl = 'https://slack.com/api'

  constructor(private botToken: string) {}

  private async request<T = unknown>(method: string, body: Record<string, unknown>): Promise<SlackApiResponse & T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Slack HTTP error: ${response.status} ${response.statusText}`)
    }

    const result = (await response.json()) as SlackApiResponse & T

    if (!result.ok) {
      throw new SlackApiError(result.error || 'unknown_error')
    }

    if (result.warning) {
      log.warn(`Slack API warning: ${result.warning}`)
    }

    return result
  }

  async isDirectMessage(channelId: string): Promise<boolean> {
    const result = await this.request<{ channel?: { is_im?: boolean; is_mpim?: boolean } }>('conversations.info', {
      channel: channelId,
    })
    return result.channel?.is_im === true && result.channel?.is_mpim !== true
  }

  async postMessage(opts: {
    channel: string
    text: string
    threadTs?: string
  }): Promise<{ ts: string; channel: string }> {
    const result = await this.request('chat.postMessage', {
      channel: opts.channel,
      text: opts.text,
      thread_ts: opts.threadTs,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: true,
    })
    return { ts: result.ts!, channel: result.channel! }
  }

  async updateMessage(opts: { channel: string; ts: string; text: string }): Promise<void> {
    await this.request('chat.update', {
      channel: opts.channel,
      ts: opts.ts,
      text: opts.text,
    })
  }

  async deleteMessage(opts: { channel: string; ts: string }): Promise<void> {
    await this.request('chat.delete', {
      channel: opts.channel,
      ts: opts.ts,
    })
  }

  async getThreadReplies(opts: { channel: string; ts: string; limit?: number }): Promise<SlackMessage[]> {
    const params = new URLSearchParams({
      channel: opts.channel,
      ts: opts.ts,
      limit: String(opts.limit ?? 50),
    })

    const response = await fetch(`${this.baseUrl}/conversations.replies?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    })

    if (!response.ok) {
      throw new Error(`Slack HTTP error: ${response.status}`)
    }

    const result = (await response.json()) as SlackApiResponse
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`)
    }

    return result.messages || []
  }

  async getPermalink(opts: { channel: string; messageTs: string }): Promise<string> {
    const result = await this.request('chat.getPermalink', {
      channel: opts.channel,
      message_ts: opts.messageTs,
    })
    return result.permalink!
  }

  async getFileInfo(fileId: string): Promise<SlackFileInfo> {
    const params = new URLSearchParams({ file: fileId })
    const response = await fetch(`${this.baseUrl}/files.info?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.botToken}` },
    })

    if (!response.ok) throw new Error(`Slack HTTP error: ${response.status}`)

    const result = (await response.json()) as SlackApiResponse
    if (!result.ok) throw new SlackApiError(result.error || 'unknown_error')
    return result.file!
  }

  async authTest(): Promise<{ userId: string }> {
    const result = await this.request<{ user_id: string }>('auth.test', {})
    return { userId: result.user_id! }
  }

  async getUserInfo(userId: string): Promise<SlackUser> {
    const result = await this.request<{ user: SlackUser }>('users.info', { user: userId })
    return result.user
  }

  async joinChannel(channelId: string): Promise<void> {
    await this.request('conversations.join', { channel: channelId })
  }
}

// =============================================================================
// Provider Implementation
// =============================================================================

let apiInstance: SlackApi | null = null
let apiToken: string | undefined
let cachedBotUserId: string | null = null
let cachedBotUserIdToken: string | undefined
const userLabelCache = new Map<string, string>()
const userLabelPendingCache = new Map<string, Promise<string>>()

function getApi(): SlackApi {
  const token = getChannelIntegrationValue('SLACK_BOT_TOKEN')
  if (!token) {
    apiInstance = null
    apiToken = undefined
    throw new Error('Enable and configure Slack in Integrations.')
  }
  if (!apiInstance || apiToken !== token) {
    apiInstance = new SlackApi(token)
    apiToken = token
  }
  return apiInstance
}

function hasToken(): boolean {
  return !!getChannelIntegrationValue('SLACK_BOT_TOKEN')
}

function formatSlackUserLabel(userId: string, user?: SlackUser): string {
  if (!user) return `<@${userId}>`

  const displayName = user.profile?.display_name?.trim()
  const realName = (user.profile?.real_name || user.real_name)?.trim()
  const username = user.name?.trim()
  const primary = displayName || realName || username || userId
  const details = [realName && realName !== primary ? realName : null, username ? `@${username}` : null, `<@${userId}>`]
    .filter(Boolean)
    .join(', ')

  return `${primary} (${details})`
}

async function getUserLabel(userId: string): Promise<string> {
  const fallback = `<@${userId}>`
  if (!hasToken()) return fallback
  if (userLabelCache.has(userId)) return userLabelCache.get(userId)!
  if (userLabelPendingCache.has(userId)) return userLabelPendingCache.get(userId)!

  const pending = (async () => {
    try {
      const api = getApi()
      const label = formatSlackUserLabel(userId, await api.getUserInfo(userId))
      userLabelCache.set(userId, label)
      return label
    } catch (e) {
      if (e instanceof SlackApiError && e.code === 'user_not_found') {
        log.debug(`Slack user ${userId} could not be resolved; using fallback label`)
      } else {
        log.warn(`Failed to get Slack user info for ${userId}: ${e}`)
      }
      userLabelCache.set(userId, fallback)
      return fallback
    } finally {
      userLabelPendingCache.delete(userId)
    }
  })()

  userLabelPendingCache.set(userId, pending)
  return pending
}

async function expandUserMentions(text: string, botUserId: string | null): Promise<string> {
  const userIds = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]).filter((id) => id !== botUserId))]
  let expanded = text
  for (const userId of userIds) {
    expanded = expanded.replace(new RegExp(`<@${userId}>`, 'g'), await getUserLabel(userId))
  }
  return expanded
}

function isSupportedSlackImage(file: SlackFile): boolean {
  return !!file.mimetype?.startsWith('image/')
}

async function downloadSlackImage(file: SlackFile): Promise<string | undefined> {
  const url = file.url_private_download ?? file.url_private
  if (!url || !file.mimetype || !isSupportedSlackImage(file)) return undefined

  try {
    const token = getChannelIntegrationValue('SLACK_BOT_TOKEN')
    if (!token) return undefined
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const image = await Image.create({
      content: { type: 'image', data: buffer.toString('base64'), mimeType: file.mimetype } satisfies ImageContent,
    })
    return image.id
  } catch (error) {
    log.warn(`Failed to download Slack image ${file.id}: ${error}`)
    return undefined
  }
}

async function slackAttachmentsFromMessage(message: SlackMessage): Promise<ChannelAttachment[] | undefined> {
  const attachments: ChannelAttachment[] = []

  for (const file of message.files ?? []) {
    const imageId = await downloadSlackImage(file)
    attachments.push({
      id: file.id,
      title: file.title ?? file.name,
      mimeType: file.mimetype,
      fileType: file.filetype,
      size: file.size,
      permalink: file.permalink,
      ...(imageId ? { imageId } : {}),
    })
  }

  for (const attachment of message.attachments ?? []) {
    if (!attachment.file_id && !attachment.title && !attachment.title_link && !attachment.from_url) continue
    attachments.push({
      id: attachment.file_id,
      title: attachment.title,
      permalink: attachment.title_link ?? attachment.from_url,
      fileType: attachment.service_name,
    })
  }

  return attachments.length > 0 ? attachments : undefined
}

async function slackEventRaw(teamId: string | undefined, event: SlackEvent): Promise<Record<string, unknown>> {
  const messageTs = event.ts
  const threadTs = event.thread_ts ?? event.ts
  const raw: Record<string, unknown> = {
    teamId,
    channelId: event.channel,
    messageTs,
    threadTs,
    eventTs: event.event_ts ?? event.ts,
    ...(event.channel && threadTs
      ? { permalink: `https://slack.com/archives/${event.channel}/p${threadTs.replace('.', '')}` }
      : {}),
    ...(event.subtype ? { subtype: event.subtype } : {}),
    ...(event.room ? { room: event.room } : {}),
    ...(event.files ? { files: event.files } : {}),
    ...(event.attachments ? { attachments: event.attachments } : {}),
  }

  if (hasToken() && event.channel && threadTs) {
    try {
      raw.permalink = await getApi().getPermalink({ channel: event.channel, messageTs: threadTs })
    } catch (error) {
      log.warn(`Failed to resolve Slack permalink for ${event.channel}/${threadTs}; using fallback: ${error}`)
    }
  }

  return raw
}

export const slackProvider: ChannelProvider = {
  name: 'slack',
  configKey: 'teamId',

  // ===========================================================================
  // Configuration
  // ===========================================================================

  validateConfig(yaml) {
    if (!yaml.providerConfig?.teamId) {
      return 'Slack requires providerConfig.teamId'
    }
    return null
  },

  getPlatformIdFromConfig(config) {
    return (config.teamId as string) || null
  },

  // ===========================================================================
  // Webhook Handling
  // ===========================================================================

  async verifySignature(rawBody: string, headers: Record<string, string>): Promise<boolean> {
    const secret = getChannelIntegrationValue('SLACK_SIGNING_SECRET')
    if (!secret) {
      log.warn('SLACK_SIGNING_SECRET not configured')
      return false
    }

    const signature = headers['x-slack-signature']
    const timestamp = headers['x-slack-request-timestamp']

    if (!signature || !timestamp) {
      log.warn('Missing signature or timestamp headers')
      return false
    }

    // Prevent replay attacks (5 minute window)
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - parseInt(timestamp)) > 300) {
      log.warn('Request timestamp too old')
      return false
    }

    const baseString = `v0:${timestamp}:${rawBody}`
    const expected = 'v0=' + createHmac('sha256', secret).update(baseString).digest('hex')

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    } catch {
      return false
    }
  },

  async parseWebhook(
    payload: unknown,
    _headers: Record<string, string>
  ): Promise<ChannelEvent | { type: 'pong' } | { type: 'challenge'; value: string } | null> {
    const p = payload as SlackEventPayload | SlackSlashCommand

    // URL verification challenge
    if ('challenge' in p && p.type === 'url_verification') {
      return { type: 'challenge', value: p.challenge as string }
    }

    // Slash command (form data parsed into object)
    if ('command' in p && 'text' in p) {
      const cmd = p as SlackSlashCommand
      const text = (cmd.text || '').trim()
      const parts = text.split(/\s+/)
      const firstWord = parts[0]?.toLowerCase() || 'ask'

      const command = (FICUS_SLASH_COMMANDS as readonly string[]).includes(firstWord) ? firstWord : 'ask'
      const content =
        command === 'ask' && !(FICUS_SLASH_COMMANDS as readonly string[]).includes(firstWord)
          ? text
          : parts.slice(1).join(' ')

      return {
        type: 'slash_command',
        command,
        text: content,
        channelId: cmd.channel_id,
        isDirectMessage: cmd.channel_id.startsWith('D') ? await getApi().isDirectMessage(cmd.channel_id) : false,
        user: { id: cmd.user_id, name: cmd.user_name },
        messageId: cmd.trigger_id,
        isInThread: false,
        raw: {
          responseUrl: cmd.response_url,
          teamId: cmd.team_id,
          channelId: cmd.channel_id,
          messageTs: cmd.trigger_id,
          threadTs: cmd.trigger_id,
          eventTs: cmd.trigger_id,
        },
      }
    }

    // Event callback
    if ('event' in p && p.type === 'event_callback') {
      const event = p.event!
      const botUserId = await this.getBotUserId()

      // App mention
      if (event.type === 'app_mention' && event.text && event.user && event.channel) {
        const cleanedText = botUserId ? event.text.replace(new RegExp(`<@${botUserId}>`, 'g'), '@Ficus') : event.text

        return {
          type: 'mention',
          text: (await expandUserMentions(cleanedText, botUserId)).trim(),
          isDirectMessage: event.channel.startsWith('D') ? await getApi().isDirectMessage(event.channel) : false,
          channelId: event.channel,
          user: { id: event.user, name: await getUserLabel(event.user) },
          threadId: event.thread_ts,
          messageId: event.ts!,
          isInThread: !!event.thread_ts,
          raw: await slackEventRaw(p.team_id, event),
        }
      }

      // Direct message to the app (Slack sends these as message.im events, not app_mention)
      if (
        event.type === 'message' &&
        event.channel_type === 'im' &&
        !event.bot_id &&
        event.text &&
        event.user &&
        event.channel
      ) {
        return {
          type: 'message',
          isDirectMessage: true,
          text: (await expandUserMentions(event.text, botUserId)).trim(),
          channelId: event.channel,
          user: { id: event.user, name: await getUserLabel(event.user) },
          threadId: event.thread_ts,
          messageId: event.ts!,
          isInThread: !!event.thread_ts,
          raw: await slackEventRaw(p.team_id, event),
        }
      }

      // Regular message in thread
      if (event.type === 'message' && event.thread_ts && !event.bot_id && event.text) {
        return {
          type: 'message',
          text: await expandUserMentions(event.text, botUserId),
          channelId: event.channel!,
          user: { id: event.user!, name: await getUserLabel(event.user!) },
          threadId: event.thread_ts,
          messageId: event.ts!,
          isInThread: true,
          raw: await slackEventRaw(p.team_id, event),
        }
      }
    }

    return null
  },

  extractPlatformId(payload: unknown): string | undefined {
    const p = payload as { team_id?: string }
    return p.team_id
  },

  // ===========================================================================
  // Messaging
  // ===========================================================================

  async postMessage(opts): Promise<PostMessageResult> {
    const api = getApi()
    const result = await api.postMessage({
      channel: opts.channelId,
      text: this.formatMarkdown(opts.text),
      threadTs: opts.threadId,
    })
    return { messageId: result.ts, threadId: opts.threadId }
  },

  async editMessage(opts): Promise<void> {
    const api = getApi()
    await api.updateMessage({
      channel: opts.channelId,
      ts: opts.messageId,
      text: this.formatMarkdown(opts.text),
    })
  },

  async deleteMessage(opts): Promise<void> {
    const api = getApi()
    await api.deleteMessage({ channel: opts.channelId, ts: opts.messageId })
  },

  async getThreadHistory(channelId: string, threadId: string, limit = 50): Promise<ThreadMessage[]> {
    const api = getApi()
    const botUserId = await this.getBotUserId()
    const messages = await api.getThreadReplies({ channel: channelId, ts: threadId, limit })

    return Promise.all(
      messages.map(async (m) => {
        const textWithBotMention = botUserId ? m.text.replace(new RegExp(`<@${botUserId}>`, 'g'), '@Ficus') : m.text

        return {
          messageId: m.ts,
          userId: m.user || 'bot',
          userName: m.user ? await getUserLabel(m.user) : undefined,
          text: await expandUserMentions(textWithBotMention, botUserId),
          timestamp: m.ts,
          isBotMessage: !!m.bot_id || (botUserId ? m.user === botUserId : false),
          attachments: await slackAttachmentsFromMessage(m),
        }
      })
    )
  },

  async getBotUserId(): Promise<string | null> {
    const token = getChannelIntegrationValue('SLACK_BOT_TOKEN')
    if (!token) return null
    // Keyed on the active token: a workspace switch (manual reconfigure, or
    // the managed connection becoming active/inactive) must not keep serving
    // the previous workspace's bot user id.
    if (cachedBotUserId && cachedBotUserIdToken === token) return cachedBotUserId

    try {
      const api = getApi()
      const result = await api.authTest()
      cachedBotUserId = result.userId
      cachedBotUserIdToken = token
      log.info(`Slack bot user ID: ${cachedBotUserId}`)
      return cachedBotUserId
    } catch (e) {
      log.warn(`Failed to get Slack bot user ID: ${e}`)
      return null
    }
  },

  // ===========================================================================
  // Response Handling
  // ===========================================================================

  async sendResponse({ context, content, agentContext, updateAgentContext }): Promise<string | undefined> {
    const api = getApi()

    // Empty content = delete the thinking message (consultant chose not to respond)
    if (!content || !content.trim()) {
      if (context.messageToEdit) {
        await api.deleteMessage({ channel: context.channelId, ts: context.messageToEdit })
      }
      return agentContext.thread?.id
    }

    const formatted = this.formatMarkdown(content)
    const truncated = formatted.length > 3000 ? formatted.slice(0, 2997) + '...' : formatted

    // If we already have a thread context, respond in thread
    if (agentContext.thread?.id) {
      if (context.messageToEdit) {
        // Edit the "Thinking..." message
        await api.updateMessage({
          channel: context.channelId,
          ts: context.messageToEdit,
          text: truncated,
        })
      } else {
        // Post new message in thread
        await api.postMessage({
          channel: context.channelId,
          text: truncated,
          threadTs: agentContext.thread.id,
        })
      }
      return agentContext.thread.id
    }

    const extras = context.extras as Record<string, unknown> | undefined
    const parentMessageTs = extras?.parentMessageTs as string | undefined

    // If we have a messageToEdit (from mention flow), edit it and save thread context
    if (context.messageToEdit && context.threadId) {
      await api.updateMessage({
        channel: context.channelId,
        ts: context.messageToEdit,
        text: truncated,
      })

      await updateAgentContext({
        id: context.threadId,
        channelId: context.channelId,
        originalMessageId: context.messageToEdit,
        tauCreated: context.tauInitiated ?? false,
      })

      return context.threadId
    }

    // Slash command flow: edit parent (remove "Thinking...") and post response in thread
    if (parentMessageTs) {
      const userId = extras?.userId as string | undefined
      const question = extras?.question as string | undefined
      const joinedChannel = extras?.joinedChannel as boolean | undefined

      // Edit parent message
      const userMention = userId ? this.formatUserMention(userId) : 'User'
      const joinWarning =
        joinedChannel === false
          ? "\n\n⚠️ _Thread replies won't work in this channel. Please `/invite @Ficus` to enable replies._"
          : ''

      await api.updateMessage({
        channel: context.channelId,
        ts: parentMessageTs,
        text: `${userMention} asked:\n> ${question || 'Question'}${joinWarning}`,
      })

      // Post response in thread
      await api.postMessage({
        channel: context.channelId,
        text: truncated,
        threadTs: parentMessageTs,
      })

      await updateAgentContext({
        id: parentMessageTs,
        channelId: context.channelId,
        originalMessageId: parentMessageTs,
        tauCreated: true,
      })

      return parentMessageTs
    }

    // Fallback: post new message
    const result = await api.postMessage({
      channel: context.channelId,
      text: truncated,
      threadTs: context.threadId,
    })

    return result.ts
  },

  async postThinkingIndicator(event) {
    // Try to join the channel first (for receiving thread events)
    await joinChannel(event.channelId)

    const api = getApi()
    const result = await api.postMessage({
      channel: event.channelId,
      text: `${this.formatUserMention(event.user.id)} asked:\n> ${event.text}\n\n_Thinking..._`,
    })

    return {
      context: {
        threadId: result.ts,
        extras: {
          ...event.raw,
          parentMessageTs: result.ts,
          joinedChannel: true,
        },
      },
      emptyResponse: true, // Return empty body since we used Bot API
    }
  },

  async postMentionThinkingIndicator(event): Promise<PostMessageResult> {
    // App mentions can be delivered for public channels before the bot is a
    // member. Match the slash-command path by attempting to join before posting
    // the thread reply that starts the Ficus-managed conversation.
    await joinChannel(event.channelId)

    return this.postMessage({
      channelId: event.channelId,
      text: '_Thinking..._',
      threadId: event.messageId,
    })
  },

  // ===========================================================================
  // Formatting
  // ===========================================================================

  formatMarkdown(text: string): string {
    return text
      .replace(/\*\*(.+?)\*\*/g, '*$1*') // **bold** → *bold*
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>') // [text](url) → <url|text>
      .replace(/~~(.+?)~~/g, '~$1~') // ~~strike~~ → ~strike~
  },

  replaceBotMention(text: string, botUserId: string): string {
    return text.replace(new RegExp(`<@${botUserId}>`, 'g'), '@Ficus')
  },

  formatUserMention(userId: string): string {
    return `<@${userId}>`
  },

  // ===========================================================================
  // Sync Responses
  // ===========================================================================

  formatSyncResponse(content: string): unknown {
    return { response_type: 'in_channel', text: this.formatMarkdown(content) }
  },

  formatErrorResponse(message: string): unknown {
    return { response_type: 'ephemeral', text: message }
  },

  formatDeferredResponse(): unknown {
    return { response_type: 'ephemeral', text: '_Thinking..._' }
  },

  // ===========================================================================
  // Notifications
  // ===========================================================================

  async sendNotification(opts) {
    const { instance, channelId, event } = opts
    const botToken = getChannelIntegrationValue('SLACK_BOT_TOKEN')

    if (!botToken) {
      throw new Error('SLACK_BOT_TOKEN not configured')
    }

    const { formatNotification } = await import('./formatter')
    const body = formatNotification(event)

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: channelId,
        unfurl_links: false,
        unfurl_media: false,
        ...body,
      }),
    })

    const data = await response.json()
    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`)
    }
  },
}

// =============================================================================
// Exported Helpers
// =============================================================================

export { getApi as getSlackApi, hasToken as hasSlackBotToken }

/**
 * Try to join a channel (for receiving thread events).
 */
export async function joinChannel(channelId: string): Promise<boolean> {
  if (!hasToken()) return false
  try {
    const api = getApi()
    await api.joinChannel(channelId)
    return true
  } catch (e) {
    const msg = String(e)
    if (msg.includes('already_in_channel')) return true
    log.warn(`Could not join channel ${channelId}: ${e}`)
    return false
  }
}
