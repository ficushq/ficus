import { handleDirectMessage } from './direct-messages'
import { parseDirectCommand } from '../lib/channels'
import { isChannelAllowed } from '../services/channel-policy'
/**
 * Shared Channel Event Handler
 *
 * Contains the common flow logic for handling channel events across providers.
 * Each provider normalizes their webhooks to ChannelEvent, then this handler
 * processes them uniformly.
 */

import { canUseChannel, channelLinkReply, CHANNEL_ACCESS_DENIED } from '../services/channel-access'
import { isFicusSyncCommand } from '../lib/channels'
import type { ChannelProvider, ChannelEvent, ResponseContext, ThreadMessage } from './provider'
import { Agent } from '../entities/Agent'
import { InboxMessage } from '../entities/InboxMessage'
import { ChannelInstance } from '../entities/ChannelInstance'
import { createLogger } from '../lib/infra/logger'

const log = createLogger('channel-handler')

// =============================================================================
// Types
// =============================================================================

export interface HandlerResult {
  /** Response to return to the webhook caller */
  response: unknown
  /** Whether to return empty body (provider posted response via API) */
  emptyResponse?: boolean
}

interface BuiltThreadHistory {
  content: string
  imageIds: string[]
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Handle a channel event.
 *
 * Flow:
 * 1. Slash command → post "Thinking..." parent → create thread → queue for consultant
 * 2. @mention in channel → post "Thinking..." in thread on user's message → queue
 * 3. @mention in any thread → fetch history since last Ficus → respond
 * 4. Message in regular thread → ignore (Ficus only responds to mentions)
 * 5. Message in reusable chat provider → route to the chat consultant
 */
export async function handleChannelEvent(
  provider: ChannelProvider,
  event: ChannelEvent,
  platformId: string
): Promise<HandlerResult> {
  log.info(`${provider.name}: handling ${event.type} from ${event.user.name}`)

  // Find channel instance
  const channelInstance = await ChannelInstance.findByProvider(provider.name, platformId)
  if (!channelInstance) {
    log.warn(`${provider.name}: no channel instance for platform ${platformId}`)
    return sendChannelConfigurationError(provider, event)
  }

  // Ignore ordinary threaded chatter before issuing authorization notices.
  if (event.type === 'message' && !event.isDirectMessage && !provider.reusesThreadForChat)
    return { response: { ok: true } }
  if (!isChannelAllowed(channelInstance, event.routingChannelId ?? event.channelId)) return { response: { ok: true } }
  if (event.isDirectMessage && channelInstance.allowPrivateChats === false) return { response: { ok: true } }
  if (event.isDirectMessage && (!event.command || event.command === 'message')) {
    const command = parseDirectCommand(event.text)
    if (command) event = { ...event, ...command }
  }
  const linkReply = await channelLinkReply(
    channelInstance,
    event.user,
    event.command === 'link' ? `link ${event.text}` : event.text
  )
  if (linkReply) return sendImmediate(provider, event, linkReply)
  if (event.isDirectMessage) return handleDirectMessage(provider, event, channelInstance)
  if (event.command === 'squad')
    return sendImmediate(
      provider,
      event,
      'Squad switching is available in private bot DMs. This channel uses its administrator-defined squad route.'
    )
  if (event.command !== 'help') {
    const targetSquad = channelInstance.resolveTargetSquad({
      responseContext: buildResponseContext(provider, event),
    } as import('./provider').InboundMessage)
    if (!targetSquad) return sendChannelConfigurationError(provider, event)
    if (
      !(await canUseChannel(channelInstance, event.routingChannelId ?? event.channelId, event.user.id, targetSquad))
    ) {
      return sendImmediate(provider, event, CHANNEL_ACCESS_DENIED)
    }
    // Notification commands can name a different squad; authorize that target too.
    if ((event.command === 'notify' || event.command === 'unnotify') && event.text.trim() !== targetSquad) {
      return sendImmediate(
        provider,
        event,
        'Notification commands must target this channel’s routed squad. Configure other notification destinations in Ficus.'
      )
    }
  }

  // Handle sync commands (status, help, notify, unnotify)
  if (event.type === 'slash_command' && isFicusSyncCommand(event.command || '')) {
    // Status resolves a squad too; help and explicit notification subscriptions
    // do not depend on the default route and remain available.
    if (event.command === 'status' && isChatRouteMissing(provider, event, channelInstance)) {
      return sendChannelConfigurationError(provider, event)
    }

    const response = await channelInstance.handleSyncCommand({
      command: event.command!,
      content: event.text,
      user: event.user,
      responseContext: buildResponseContext(provider, event),
    })

    // For providers that send via API (like Telegram), we need to send the message directly
    if (provider.sendsResponseViaApi) {
      await provider.postMessage({
        channelId: event.channelId,
        text: response,
        threadId: event.messageId, // Parent thread for threaded providers
        replyToMessageId: event.messageId,
      })
      return { response: { ok: true }, emptyResponse: true }
    }

    return { response: provider.formatSyncResponse(response) }
  }

  // Dispatch based on event type
  if (event.type === 'slash_command') {
    return handleSlashCommand(provider, event, channelInstance)
  } else if (event.type === 'mention') {
    return handleMention(provider, event, channelInstance, platformId)
  } else if (event.type === 'message') {
    return handleMessage(provider, event, channelInstance)
  }

  return { response: { ok: true } }
}

/**
 * The tail shared by every caller that has already parsed a webhook payload
 * into a `ChannelEvent`: resolve the platform id and run `handleChannelEvent`,
 * or reply with a safe configuration error when the platform id is missing.
 * Used by both the direct channel webhook route and the hosted Slack relay
 * dispatcher so their handling of a parsed event never drifts apart.
 */
export async function dispatchParsedChannelEvent(
  provider: ChannelProvider,
  payload: Record<string, unknown>,
  parsed: ChannelEvent
): Promise<HandlerResult> {
  const platformId = provider.extractPlatformId(payload)
  if (!platformId) {
    log.warn(`${provider.name}: No platform ID found`)
    if (provider.sendsResponseViaApi) {
      await sendChannelConfigurationError(provider, parsed)
      return { response: null, emptyResponse: true }
    }
    return { response: provider.formatErrorResponse('Invalid request') }
  }
  return handleChannelEvent(provider, parsed, platformId)
}

// =============================================================================
// Slash Command
// =============================================================================

async function handleSlashCommand(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  log.info(`${provider.name}: slash command '${event.command}' from ${event.user.name}`)

  // Check if command is in an existing active tracked thread. Terminated
  // consultants are ignored so a later command can start a replacement agent.
  const existingAgent = await findChannelAgent(provider, event, channelInstance, event.channelId)
  if (existingAgent) {
    log.info(`${provider.name}: routing to existing agent ${existingAgent.id}`)

    await InboxMessage.send({
      recipientId: existingAgent.id,
      senderType: 'system',
      wakeEligible: true,
      subject: `Channel: ${event.command}`,
      content: `**${provider.name} ${event.command} from ${event.user.name}:** "${event.text}"`,
      metadata: {
        type: 'channel_message',
        channelContext: buildResponseContext(provider, event),
        userId: event.user.id,
        userName: event.user.name,
        command: event.command,
      },
    })

    return { response: provider.formatDeferredResponse() }
  }

  if (isChatRouteMissing(provider, event, channelInstance)) {
    return sendChannelConfigurationError(provider, event)
  }

  // Post "Thinking..." indicator (provider-specific)
  const thinkingResult = await provider.postThinkingIndicator(event)

  const responseContext = {
    ...buildResponseContext(provider, event),
    ...thinkingResult?.context,
  }

  // If this command is happening inside a previously tracked thread whose
  // consultant was terminated, findByThreadId() returns null. In that case,
  // include the thread history so the replacement consultant has the full
  // conversation context.
  const threadHistory = event.isInThread
    ? await buildThreadHistory(provider, { ...event, threadId: event.threadId ?? event.channelId }, channelInstance, {
        includeAll: true,
      })
    : { content: event.text, imageIds: [] }

  // Queue for consultant
  await channelInstance.queueForConsultant({
    command: event.command || 'ask',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext,
  })

  log.info(`${provider.name}: queued ${event.command} for consultant`)

  // Return based on provider's preference
  if (thinkingResult?.emptyResponse) {
    return { response: null, emptyResponse: true }
  }

  return { response: provider.formatDeferredResponse() }
}

// =============================================================================
// Mention
// =============================================================================

async function handleMention(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance,
  _platformId: string
): Promise<HandlerResult> {
  if (event.isInThread && event.threadId) {
    // Mention in a thread - fetch history and respond, regardless of who created the thread.
    const existingAgent = await findChannelAgent(provider, event, channelInstance!, event.threadId)
    return handleMentionInJoinedThread(provider, event, channelInstance, existingAgent)
  } else {
    // Mention in channel (not in thread) - create thread on user's message
    return handleMentionInChannel(provider, event, channelInstance)
  }
}

async function handleMentionInChannel(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  log.info(`${provider.name}: mention in channel, creating thread`)

  // Post "Thinking..." as reply to user's message (creates thread). Providers
  // can override this to perform provider-specific setup first (for example,
  // Slack joins public channels before posting so app_mention can work even when
  // the bot is not already a member).
  const thinkingMsg = provider.postMentionThinkingIndicator
    ? await provider.postMentionThinkingIndicator(event)
    : await provider.postMessage({
        channelId: event.channelId,
        text: '_Thinking..._',
        threadId: event.messageId, // Parent thread for threaded providers
        replyToMessageId: event.messageId,
      })

  const threadHistory = await buildThreadHistory(provider, { ...event, threadId: event.messageId }, channelInstance, {
    includeAll: true,
  })

  await channelInstance.queueForConsultant({
    command: 'mention',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext: {
      provider: provider.name,
      routingChannelId: event.routingChannelId,
      channelId: event.channelId,
      threadId: event.messageId, // User's message is the thread parent
      messageToEdit: thinkingMsg.messageId,
      ficusInitiated: true, // Ficus is creating this thread
      extras: event.raw,
    },
  })

  return { response: { ok: true } }
}

async function handleMentionInJoinedThread(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance,
  existingAgent: Agent | null
): Promise<HandlerResult> {
  log.info(`${provider.name}: mention in thread, fetching history`)

  // Fetch thread history
  const threadHistory = await buildThreadHistory(provider, event, channelInstance, { includeAll: !existingAgent })

  // Post "Thinking..." in thread
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.threadId,
  })

  const responseContext: ResponseContext = {
    provider: provider.name,
    routingChannelId: event.routingChannelId,
    channelId: event.channelId,
    threadId: event.threadId,
    messageToEdit: thinkingMsg.messageId,
    ficusInitiated: false,
    extras: event.raw,
  }

  const content =
    threadHistory.content || `${event.user.name || provider.formatUserMention(event.user.id)}: ${event.text}`

  if (existingAgent) {
    // Reuse existing agent
    log.info(`${provider.name}: routing to existing agent ${existingAgent.id} (joined thread)`)

    await InboxMessage.send({
      recipientId: existingAgent.id,
      senderType: 'system',
      wakeEligible: true,
      subject: 'Channel: mention',
      content,
      metadata: {
        type: 'channel_message',
        channelContext: responseContext,
        userId: event.user.id,
        userName: event.user.name,
        command: 'mention',
        ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
      },
    })
  } else {
    // Queue for new consultant
    await channelInstance.queueForConsultant({
      command: 'mention',
      content,
      ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
      user: event.user,
      responseContext,
    })
  }

  return { response: { ok: true } }
}

// =============================================================================
// Message (in thread)
// =============================================================================

async function handleMessage(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance?: ChannelInstance
): Promise<HandlerResult> {
  if (!event.isInThread || !event.threadId) {
    log.info(`${provider.name}: message not in thread, ignoring`)
    return { response: { ok: true } }
  }

  const agent = await findChannelAgent(provider, event, channelInstance!, event.threadId)

  // Some providers (like Telegram) reuse a single consultant per chat (no threads)
  const reusesChat = provider.reusesThreadForChat === true

  // For providers that reuse chats: create a consultant if none exists. Since
  // findByThreadId() ignores terminated agents, this also replaces terminated
  // chat consultants and includes available history below.
  if (!agent && reusesChat && channelInstance) {
    log.info(`${provider.name}: first active message in chat, creating consultant`)
    return handleNewChatMessage(provider, event, channelInstance)
  }

  // Threaded providers only respond to explicit mention events. Regular thread
  // messages are ignored even in Ficus-created threads.
  if (!reusesChat) {
    log.info(`${provider.name}: regular thread message without mention, ignoring`)
    return { response: { ok: true } }
  }

  if (!agent) {
    log.info(`${provider.name}: message without existing chat consultant, ignoring`)
    return { response: { ok: true } }
  }

  log.info(`${provider.name}: routing message to agent ${agent.id}`)

  // Post "Thinking..." that will be edited with response
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.threadId,
    replyToMessageId: event.messageId, // Telegram's chat ID is not a reply message ID
  })

  await InboxMessage.send({
    recipientId: agent.id,
    senderType: 'system',
    wakeEligible: true,
    subject: 'Channel: message',
    content: `**${provider.name} message from ${event.user.name || provider.formatUserMention(event.user.id)}:** "${event.text}"`,
    metadata: {
      type: 'channel_message',
      channelContext: {
        provider: provider.name,
        channelId: event.channelId,
        threadId: event.threadId,
        messageToEdit: thinkingMsg.messageId,
      },
      userId: event.user.id,
      userName: event.user.name,
      command: 'message',
    },
  })

  return { response: { ok: true } }
}

// =============================================================================
// Chat-based providers (no threads)
// =============================================================================

async function handleNewChatMessage(
  provider: ChannelProvider,
  event: ChannelEvent,
  channelInstance: ChannelInstance
): Promise<HandlerResult> {
  // Resolve before posting: a missing target must never leave orphaned Thinking.
  // Sender authorization and current routing are required for reused chats too.
  if (isChatRouteMissing(provider, event, channelInstance)) {
    return sendChannelConfigurationError(provider, event)
  }

  // Post "Thinking..." as reply to user's message
  const thinkingMsg = await provider.postMessage({
    channelId: event.channelId,
    text: '_Thinking..._',
    threadId: event.messageId,
    replyToMessageId: event.messageId,
  })

  const threadHistory = await buildThreadHistory(provider, { ...event, threadId: event.channelId }, channelInstance, {
    includeAll: true,
  })

  await channelInstance.queueForConsultant({
    command: 'message',
    content: threadHistory.content || event.text,
    ...(threadHistory.imageIds.length ? { imageIds: threadHistory.imageIds } : {}),
    user: event.user,
    responseContext: {
      provider: provider.name,
      routingChannelId: event.routingChannelId,
      channelId: event.channelId,
      threadId: event.channelId, // Use chat ID as thread
      messageToEdit: thinkingMsg.messageId,
      ficusInitiated: true, // Mark as Ficus-initiated so future messages route here
    },
  })

  return { response: { ok: true } }
}

// =============================================================================
// Helpers
// =============================================================================

async function sendImmediate(provider: ChannelProvider, event: ChannelEvent, text: string): Promise<HandlerResult> {
  if (provider.sendsResponseViaApi || event.type !== 'slash_command') {
    await provider.postMessage({
      channelId: event.channelId,
      text,
      threadId: event.isDirectMessage && provider.name !== 'slack' ? undefined : (event.threadId ?? event.messageId),
      replyToMessageId: event.messageId,
    })
    return { response: { ok: true }, emptyResponse: true }
  }
  return { response: provider.formatSyncResponse(text) }
}

async function findChannelAgent(
  provider: ChannelProvider,
  event: ChannelEvent,
  instance: ChannelInstance,
  threadId: string
) {
  const agent = await Agent.findByThreadId(provider.name, threadId, instance.id, event.channelId)
  if (!agent) return null
  const target = instance.resolveTargetSquad({
    responseContext: buildResponseContext(provider, event),
  } as import('./provider').InboundMessage)
  return agent.squadId === target ? agent : null
}

/** Telegram ignores formatted HTTP error bodies; acknowledge only after the API
 * accepts the in-chat reply. Transport errors propagate instead of claiming success. */
export async function sendChannelConfigurationError(
  provider: ChannelProvider,
  event: ChannelEvent
): Promise<HandlerResult> {
  if (!provider.sendsResponseViaApi) {
    return { response: provider.formatErrorResponse('This server/workspace is not configured.') }
  }

  await provider.postMessage({
    channelId: event.channelId,
    replyToMessageId: event.messageId,
    text: 'This bot needs configuration. Ask an administrator to check the bot connection and select a Default Squad in the integration settings. New conversations without a matching routing override cannot be started.',
  })
  return { response: { ok: true }, emptyResponse: true }
}

function isChatRouteMissing(provider: ChannelProvider, event: ChannelEvent, instance: ChannelInstance): boolean {
  return (
    provider.reusesThreadForChat === true &&
    !instance.resolveTargetSquad({
      command: event.command || 'ask',
      content: event.text,
      user: event.user,
      responseContext: buildResponseContext(provider, event),
    })
  )
}

function buildResponseContext(provider: ChannelProvider, event: ChannelEvent): ResponseContext {
  return {
    provider: provider.name,
    routingChannelId: event.routingChannelId,
    channelId: event.channelId,
    threadId: event.threadId,
    extras: event.raw,
  }
}

async function buildThreadHistory(
  provider: ChannelProvider,
  event: ChannelEvent,
  instance: ChannelInstance,
  options: { includeAll?: boolean } = {}
): Promise<BuiltThreadHistory> {
  if (!event.threadId) return { content: '', imageIds: [] }

  try {
    const messages = await provider.getThreadHistory(event.channelId, event.threadId, 50)
    const botUserId = await provider.getBotUserId()

    // Existing active consultants only need the messages since the last Ficus
    // response. Replacement consultants need the full thread to recover context.
    let startIndex = 0
    if (!options.includeAll) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isBotMessage) {
          startIndex = i
          break
        }
      }
    }

    // Filter out current message and build history
    const currentMessage = messages.find((m) => m.messageId === event.messageId)
    const historyMessages: ThreadMessage[] = [
      ...messages.slice(startIndex).filter((m) => m.messageId !== event.messageId),
      {
        messageId: event.messageId,
        userId: event.user.id,
        userName: event.user.name,
        text: currentMessage?.text ?? event.text,
        timestamp: currentMessage?.timestamp ?? '',
        isBotMessage: false,
        attachments: currentMessage?.attachments,
      },
    ]

    const targetSquad = instance.resolveTargetSquad({
      responseContext: buildResponseContext(provider, event),
    } as import('./provider').InboundMessage)
    const allowedMessages: ThreadMessage[] = []
    for (const message of historyMessages) {
      // Do not treat unrelated bots as Ficus, or import unauthorized human instructions.
      if (
        (botUserId && message.userId === botUserId) ||
        (targetSquad &&
          (await canUseChannel(instance, event.routingChannelId ?? event.channelId, message.userId, targetSquad)))
      )
        allowedMessages.push(message)
    }
    const imageIds = allowedMessages.flatMap((m) =>
      (m.attachments ?? []).flatMap((attachment) => (attachment.imageId ? [attachment.imageId] : []))
    )

    const formatted = allowedMessages
      .map((m) => {
        const userLabel = m.isBotMessage ? '@Ficus' : m.userName || provider.formatUserMention(m.userId)
        const text = botUserId ? provider.replaceBotMention(m.text, botUserId) : m.text
        const attachments = formatThreadAttachments(m)
        return `${userLabel}: ${text}${attachments ? `\n\n${attachments}` : ''}`
      })
      .join('\n\n')

    if (formatted) {
      return { content: `**Thread history** (you are referenced as @Ficus):\n\n${formatted}`, imageIds }
    }
  } catch (e) {
    log.warn(`Failed to fetch thread history: ${e}`)
  }

  return { content: '', imageIds: [] }
}

function formatThreadAttachments(message: ThreadMessage): string {
  const attachments = message.attachments ?? []
  if (attachments.length === 0) return ''

  const lines = attachments.map((attachment) => {
    const details = [
      attachment.title || attachment.id || 'attached file',
      attachment.mimeType,
      attachment.size ? `${Math.round(attachment.size / 1024)} KB` : undefined,
      attachment.imageId ? `available as image input ${attachment.imageId}` : undefined,
      attachment.permalink,
    ].filter(Boolean)
    return `- ${details.join(' — ')}`
  })

  return `Attachments:\n${lines.join('\n')}`
}
