import { discordProvider } from './provider'
import { handleDiscordInteraction } from './interactions'
import { handleChannelEvent } from '../handler'
import { isChannelAllowed } from '../../services/channel-policy'
/**
 * Discord Gateway Connection
 *
 * Maintains WebSocket connection to Discord Gateway for receiving
 * messages and slash commands without requiring a public interactions webhook.
 */

import { canUseChannel, channelLinkReply, CHANNEL_ACCESS_DENIED } from '../../services/channel-access'
import { createLogger } from '../../lib/infra/logger'
import { getChannelIntegrationValue } from '../../services/integrations/channels/settings'

const log = createLogger('discord-gateway')

// Gateway opcodes
const GatewayOpcode = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

// Gateway intents
const GatewayIntents = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const

interface GatewayPayload {
  op: number
  d: unknown
  s?: number
  t?: string
}

interface DiscordMessage {
  id: string
  channel_id: string
  guild_id?: string
  content: string
  author: {
    id: string
    username: string
    bot?: boolean
  }
  mentions?: Array<{ id: string; username: string }>
  message_reference?: {
    message_id?: string
    channel_id?: string
    guild_id?: string
  }
  // Thread info (present when message is in a thread)
  thread?: {
    id: string
    parent_id: string
  }
}

export class DiscordGateway {
  private ws: WebSocket | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private sequence: number | null = null
  private sessionId: string | null = null
  private resumeGatewayUrl: string | null = null
  private botToken: string
  private botUserId: string | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10

  constructor(botToken: string) {
    this.botToken = botToken
  }

  async connect(): Promise<void> {
    const gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json'

    log.info('Connecting to Discord Gateway...')

    this.ws = new WebSocket(gatewayUrl)

    this.ws.onopen = () => {
      log.info('Discord Gateway WebSocket connected')
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : event.data.toString()
      this.handleMessage(JSON.parse(data))
    }

    this.ws.onclose = (event) => {
      log.warn(`Discord Gateway closed: ${event.code} ${event.reason}`)
      this.cleanup()
      this.scheduleReconnect()
    }

    this.ws.onerror = (error) => {
      log.error('Discord Gateway error:', error)
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnect attempts reached, giving up')
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    setTimeout(() => this.connect(), delay)
  }

  private handleMessage(payload: GatewayPayload): void {
    switch (payload.op) {
      case GatewayOpcode.HELLO:
        this.startHeartbeat((payload.d as { heartbeat_interval: number }).heartbeat_interval)
        this.identify()
        break

      case GatewayOpcode.HEARTBEAT_ACK:
        // Heartbeat acknowledged
        break

      case GatewayOpcode.DISPATCH:
        this.sequence = payload.s ?? this.sequence
        this.handleDispatch(payload.t!, payload.d)
        break

      case GatewayOpcode.RECONNECT:
        log.info('Discord requested reconnect')
        this.ws?.close()
        break

      case GatewayOpcode.INVALID_SESSION:
        log.warn('Invalid session, re-identifying')
        this.sessionId = null
        setTimeout(() => this.identify(), 5000)
        break
    }
  }

  private handleDispatch(eventType: string, data: unknown): void {
    switch (eventType) {
      case 'READY': {
        const ready = data as { session_id: string; resume_gateway_url: string; user: { id: string } }
        this.sessionId = ready.session_id
        this.resumeGatewayUrl = ready.resume_gateway_url
        this.botUserId = ready.user.id
        log.info(`Discord Gateway ready (bot user ID: ${this.botUserId})`)
        break
      }

      case 'INTERACTION_CREATE':
        void this.handleInteractionCreate(data).catch(() => log.error('Discord interaction handling failed'))
        break

      case 'MESSAGE_CREATE':
        void this.handleMessageCreate(data as DiscordMessage).catch((error) =>
          log.error('Discord message handling failed', error)
        )
        break
    }
  }

  private async handleInteractionCreate(payload: unknown): Promise<void> {
    const event = await discordProvider.parseWebhook(payload, {})
    if (!event || event.type !== 'slash_command') return
    await handleDiscordInteraction(payload, event, (id) => this.getChannelRouting(id))
  }

  private async handleMessageCreate(message: DiscordMessage): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return

    // Lazy imports to avoid circular dependency
    const { Agent } = await import('../../entities/Agent')
    const { InboxMessage } = await import('../../entities/InboxMessage')
    const { ChannelInstance } = await import('../../entities/ChannelInstance')
    const { getProvider } = await import('../provider')

    const provider = getProvider('discord')
    if (!provider) return

    if (!message.guild_id) {
      // DM events do not contain a guild. Bind to the configured bot connection,
      // then verify the native channel type (group DMs are deliberately excluded).
      const guildId = getChannelIntegrationValue('DISCORD_GUILD_ID')
      const routing = await this.getChannelRouting(message.channel_id)
      if (!guildId || routing?.type !== 1) return
      await handleChannelEvent(
        provider,
        {
          type: 'message',
          text: message.content,
          channelId: message.channel_id,
          user: { id: message.author.id, name: message.author.username },
          messageId: message.id,
          isInThread: false,
          isDirectMessage: true,
          raw: {},
        },
        guildId
      )
      return
    }

    // Check if bot is mentioned
    const isBotMentioned = !!this.botUserId && !!message.mentions?.some((m) => m.id === this.botUserId)

    // The channel_id IS the thread ID when message is in a thread
    const threadId = message.channel_id

    // Check if we're tracking this thread
    if (!isBotMentioned || !message.guild_id) return
    const channelInstance = await ChannelInstance.findByProvider('discord', message.guild_id)
    if (!channelInstance || channelInstance.disabled) return
    const routing = await this.getChannelRouting(message.channel_id)
    if (!routing) return // Fail closed if Discord cannot establish the channel's parent.
    const routingChannelId = routing.parentId ?? message.channel_id
    if (!isChannelAllowed(channelInstance, routingChannelId)) return
    const targetSquad = channelInstance.resolveTargetSquad({
      responseContext: { provider: 'discord', channelId: routingChannelId },
    } as import('../provider').InboundMessage)
    let agent = await Agent.findByThreadId('discord', threadId, channelInstance.id, message.channel_id)
    if (agent?.squadId !== targetSquad) agent = null

    // Replace bot mentions with @Ficus
    const cleanedContent = this.botUserId
      ? message.content.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '@Ficus').trim()
      : message.content

    const linking = await channelLinkReply(
      channelInstance,
      { id: message.author.id, name: message.author.username },
      cleanedContent
    )
    if (linking) {
      await provider.postMessage({ channelId: message.channel_id, text: linking })
      return
    }
    if (!targetSquad || !(await canUseChannel(channelInstance, routingChannelId, message.author.id, targetSquad))) {
      await provider.postMessage({ channelId: message.channel_id, text: CHANNEL_ACCESS_DENIED })
      return
    }

    // Threaded Discord conversations only respond to explicit mentions, even
    // when Ficus created the thread.
    if (!isBotMentioned) {
      if (agent) {
        log.info(`Discord: regular thread message without mention in ${threadId}, ignoring`)
      }
      return
    }

    // Bot mentioned - handle like Slack app_mention
    if (isBotMentioned) {
      log.info(`Discord: @mention from ${message.author.username} in channel ${message.channel_id}`)

      // Find channel instance

      // Check if this is a mention in a thread (tracked or user-created)
      const isThread = routing.isThread

      if (agent || isThread) {
        // Mention in thread - fetch history FIRST, then post thinking
        log.info(`Discord: mention in thread ${threadId}`)

        // Fetch history BEFORE posting thinking message
        const history = await this.buildThreadHistory(
          provider,
          threadId,
          message.id,
          cleanedContent,
          message.author,
          channelInstance,
          routingChannelId,
          targetSquad
        )

        // Now post thinking message
        const thinkingMsg = await provider.postMessage({
          channelId: threadId,
          text: '_Thinking..._',
        })

        const content = history || `<@${message.author.id}>: ${cleanedContent}`

        if (agent) {
          // Reuse existing agent
          await InboxMessage.send({
            recipientId: agent.id,
            senderType: 'system',
            wakeEligible: true,
            subject: 'Channel: mention',
            content,
            metadata: {
              type: 'channel_message',
              channelContext: {
                provider: 'discord',
                routingChannelId,
                channelId: threadId,
                messageToEdit: thinkingMsg.messageId,
              },
              userId: message.author.id,
              userName: message.author.username,
              command: 'mention',
            },
          })
        } else {
          // First time in this thread - queue for consultant
          await channelInstance.queueForConsultant({
            command: 'mention',
            content,
            user: { id: message.author.id, name: message.author.username },
            responseContext: {
              provider: 'discord',
              routingChannelId,
              channelId: threadId,
              messageToEdit: thinkingMsg.messageId,
              ficusInitiated: false, // User created this thread, not Ficus
            },
          })
        }
        return
      }

      // Mention in channel (not in thread) - create thread
      log.info(`Discord: creating thread for mention`)

      // Create thread on user's message
      const thread = await this.createThreadOnMessage(message.channel_id, message.id, 'Ficus Response')

      // Post "Thinking..." in thread
      const thinkingMsg = await provider.postMessage({
        channelId: thread.id,
        text: '_Thinking..._',
      })

      await channelInstance.queueForConsultant({
        command: 'mention',
        content: cleanedContent,
        user: { id: message.author.id, name: message.author.username },
        responseContext: {
          provider: 'discord',
          routingChannelId,
          channelId: thread.id,
          messageToEdit: thinkingMsg.messageId,
          ficusInitiated: true,
        },
      })
    }
  }

  private async buildThreadHistory(
    provider: import('../provider').ChannelProvider,
    threadId: string,
    currentMessageId: string,
    currentMessageText: string,
    currentAuthor: { id: string; username: string },
    instance: import('../../entities/ChannelInstance').ChannelInstance,
    routingChannelId: string,
    squadId: string
  ): Promise<string> {
    try {
      const messages = await provider.getThreadHistory(threadId, threadId, 50)

      // Find last bot message
      let startIndex = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isBotMessage) {
          startIndex = i
          break
        }
      }

      // Filter out current message from history, then add it at the end
      const historyMessages = messages.slice(startIndex).filter((m) => m.messageId !== currentMessageId)

      // Add current message at the end
      const allMessages = [
        ...historyMessages,
        {
          messageId: currentMessageId,
          userId: currentAuthor.id,
          text: currentMessageText,
          timestamp: '',
          isBotMessage: false,
        },
      ]

      const allowedMessages = []
      for (const item of allMessages) {
        if (item.userId === this.botUserId || (await canUseChannel(instance, routingChannelId, item.userId, squadId)))
          allowedMessages.push(item)
      }
      const formatted = allowedMessages
        .filter((m) => m.text && m.text.trim()) // Skip empty messages
        .map((m) => {
          const label = m.isBotMessage ? '@Ficus' : `<@${m.userId}>`
          return `${label}: ${m.text}`
        })
        .join('\n\n')

      if (formatted) {
        return `**Thread history** (you are referenced as @Ficus):\n\n${formatted}`
      }
    } catch (e) {
      log.warn(`Failed to fetch thread history: ${e}`)
    }
    return ''
  }

  private async createThreadOnMessage(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/threads`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, auto_archive_duration: 1440 }),
    })

    if (!response.ok) {
      throw new Error(`Failed to create thread: ${await response.text()}`)
    }

    return response.json()
  }

  private async getChannelRouting(
    channelId: string
  ): Promise<{ isThread: boolean; parentId?: string; type: number } | null> {
    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
        headers: { Authorization: `Bot ${this.botToken}` },
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) return null

      const channel = (await response.json()) as { type: number; parent_id?: string }
      // Thread types: 10 = news thread, 11 = public thread, 12 = private thread
      const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12
      if (isThread && !channel.parent_id) return null
      return { type: channel.type, isThread, parentId: isThread ? channel.parent_id : undefined }
    } catch {
      return null
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    this.heartbeatInterval = setInterval(() => {
      this.ws?.send(
        JSON.stringify({
          op: GatewayOpcode.HEARTBEAT,
          d: this.sequence,
        })
      )
    }, intervalMs)
  }

  private identify(): void {
    const intents =
      GatewayIntents.GUILDS |
      GatewayIntents.GUILD_MESSAGES |
      GatewayIntents.DIRECT_MESSAGES |
      GatewayIntents.MESSAGE_CONTENT

    this.ws?.send(
      JSON.stringify({
        op: GatewayOpcode.IDENTIFY,
        d: {
          token: this.botToken,
          intents,
          properties: {
            os: 'linux',
            browser: 'ficus',
            device: 'ficus',
          },
        },
      })
    )
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  disconnect(): void {
    this.cleanup()
    this.ws?.close()
    this.ws = null
  }
}

// Singleton instance
let gateway: DiscordGateway | null = null

export function startDiscordGateway(): void {
  const botToken = getChannelIntegrationValue('DISCORD_BOT_TOKEN')
  if (!botToken) {
    log.warn('DISCORD_BOT_TOKEN not set, Discord Gateway disabled')
    return
  }

  if (gateway) {
    log.warn('Discord Gateway already running')
    return
  }

  gateway = new DiscordGateway(botToken)
  gateway.connect()
}

export function stopDiscordGateway(): void {
  gateway?.disconnect()
  gateway = null
}
