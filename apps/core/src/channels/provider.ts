/**
 * Channel Provider Abstraction
 *
 * Defines a common interface for channel providers (Slack, Discord, etc.)
 * that normalizes webhook events and response handling.
 */

// =============================================================================
// Normalized Event Types
// =============================================================================

/**
 * Normalized channel event from any provider.
 * Webhooks are parsed into this common format.
 */
export interface ChannelEvent {
  /** Event type */
  type: 'slash_command' | 'mention' | 'message'

  /** Subcommand (e.g., 'ask', 'status', 'help') */
  command?: string

  /** Message content (with bot mentions replaced by @Ficus) */
  text: string

  /** Channel/conversation ID */
  channelId: string
  /** Verified parent channel ID for providers whose threads are separate channels. */
  routingChannelId?: string

  /** Verified one-to-one conversation with the bot, never a group DM or private channel. */
  isDirectMessage?: boolean

  /** User who triggered the event */
  user: {
    id: string
    name: string
  }

  /** Thread ID if in a thread */
  threadId?: string

  /** Message ID (for creating threads, editing) */
  messageId: string

  /** Whether this event is in a thread */
  isInThread: boolean

  /** Raw provider-specific data (for edge cases) */
  raw: Record<string, unknown>
}

/**
 * Message in a thread (for history fetching).
 */
export interface ChannelAttachment {
  id?: string
  title?: string
  mimeType?: string
  fileType?: string
  size?: number
  permalink?: string
  imageId?: string
}

export interface ThreadMessage {
  messageId: string
  userId: string
  /** Human-readable label/name when the provider can supply it. */
  userName?: string
  text: string
  timestamp: string
  isBotMessage: boolean
  attachments?: ChannelAttachment[]
}

/**
 * Result of posting a message.
 */
export interface PostMessageResult {
  messageId: string
  threadId?: string
  /** Provider channel/conversation ID required to edit this message later. */
  editChannelId?: string
}

/**
 * Thread context stored in agent.
 */
export interface ThreadContext {
  id: string
  channelId: string
  originalMessageId: string
  /** true if Ficus created this thread; threaded providers still require @mentions for follow-ups. */
  ficusCreated: boolean
}

/**
 * Inbound message from a channel (for queueing to consultant).
 */
export interface InboundMessage {
  command: string
  content: string
  user: {
    id: string
    name: string
  }
  threadId?: string
  imageIds?: string[]
  responseContext: ResponseContext
}

/**
 * Response context passed through the system.
 */
export interface ResponseContext {
  routingChannelId?: string
  provider: string
  channelId: string
  threadId?: string
  /** Message ID to edit (e.g., "Thinking..." message) */
  messageToEdit?: string
  /** Whether Ficus initiated this thread */
  ficusInitiated?: boolean
  /** Provider-specific extras */
  extras?: Record<string, unknown>
}

// =============================================================================
// Notification Types
// =============================================================================

/**
 * Notification event for outbound notifications.
 */
export interface NotificationEvent {
  notificationKind?: string
  /** Origin marker for inbox-derived events, e.g. 'fleet-alert'. */
  source?: string
  workStreamNumber?: number
  type: string
  squadId?: string
  squadName?: string
  /** Agent to deep-link to (agent chat). */
  agentId?: string
  /** Pending Action Center item to deep-link to (Feed fallback on mobile). */
  actionId?: string
  /** Work stream to deep-link to (work tab + detail sheet). */
  workStreamId?: string
  /** Exact open wait to focus within a work stream action. */
  waitId?: string
  /** Exact async agent question to focus. */
  questionId?: string
  /** Inbox message to deep-link to (Feed/inbox). */
  messageId?: string
  title: string
  body: string
  /** Push-only presentation hints (see InboxPushPresentation); external channels ignore them. */
  subtitle?: string
  collapseKey?: string
  threadKey?: string
  interruptionLevel?: 'passive' | 'active' | 'time-sensitive'
  url?: string
  timestamp: Date
}

/**
 * Options for sending a notification.
 */
export interface SendNotificationOpts {
  instance: import('../entities/ChannelInstance').ChannelInstance
  channelId: string
  event: NotificationEvent
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Channel provider implementation.
 * Each provider (Slack, Discord, etc.) implements this interface.
 */
/**
 * Channel instance YAML configuration (from config/channels/*.yaml).
 */
export interface ChannelInstanceYaml {
  id: string
  name: string
  provider: string
  providerConfig?: ProviderConfig
  trustedChannelIds?: string[]
  allowedChannelIds?: string[]
  deniedChannelIds?: string[]
  allowPrivateChats?: boolean
  channelSquadMap?: Record<string, string>
  defaultSquadId?: string
}

/**
 * Provider configuration stored in channel instances.
 */
export type ProviderConfig = Record<string, unknown>

export interface ChannelProvider {
  /** Provider name */
  readonly name: string

  /**
   * The key in providerConfig used to identify this channel instance.
   * Used for database lookups (e.g., 'guildId' for Discord, 'teamId' for Slack).
   */
  readonly configKey: string

  /** If true, responses must be sent via API (not webhook response body) */
  readonly sendsResponseViaApi?: boolean

  /**
   * If true, this provider reuses a single agent/thread per chat (no real threads).
   * Used by Telegram where all messages in a chat go to one consultant.
   */
  readonly reusesThreadForChat?: boolean

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Validate that required provider-specific config is present in providerConfig.
   * Returns an error message if invalid, or null if valid.
   */
  validateConfig(yaml: ChannelInstanceYaml): string | null

  /**
   * Get the platform identifier from a providerConfig object.
   * Used by ChannelInstance.platformId getter.
   */
  getPlatformIdFromConfig(config: ProviderConfig): string | null

  // ===========================================================================
  // Webhook Handling
  // ===========================================================================

  /**
   * Verify webhook signature.
   */
  verifySignature(rawBody: string, headers: Record<string, string>): Promise<boolean>

  /**
   * Parse webhook payload into normalized events.
   * Returns null for non-message events (pings, challenges, etc.)
   * Returns 'pong' for Discord ping verification.
   * Returns 'challenge' with value for Slack URL verification.
   */
  parseWebhook(
    payload: unknown,
    headers: Record<string, string>
  ): Promise<ChannelEvent | { type: 'pong' } | { type: 'challenge'; value: string } | null>

  /**
   * Get the platform ID from a webhook payload (e.g., team_id for Slack, guild_id for Discord).
   */
  extractPlatformId(payload: unknown): string | undefined

  // ===========================================================================
  // Messaging
  // ===========================================================================

  /**
   * Post a message to a channel or thread.
   */
  postMessage(opts: {
    channelId: string
    text: string
    threadId?: string
    replyToMessageId?: string
  }): Promise<PostMessageResult>

  /**
   * Edit an existing message.
   */
  editMessage(opts: { channelId: string; messageId: string; text: string }): Promise<void>

  /**
   * Delete a message.
   */
  deleteMessage(opts: { channelId: string; messageId: string }): Promise<void>

  /**
   * Get messages in a thread.
   */
  getThreadHistory(channelId: string, threadId: string, limit?: number): Promise<ThreadMessage[]>

  /**
   * Get the bot's user ID.
   */
  getBotUserId(): Promise<string | null>

  // ===========================================================================
  // Response Handling
  // ===========================================================================

  /**
   * Send a response back to the channel.
   * Handles thread creation, message editing, and context updates.
   * Returns the thread ID if applicable.
   */
  sendResponse(opts: {
    context: ResponseContext
    content: string
    agentContext: { thread?: ThreadContext | null }
    /** Callback to update agent context with new thread info */
    updateAgentContext: (thread: ThreadContext) => Promise<void>
  }): Promise<string | undefined>

  /**
   * Post initial "Thinking..." indicator for a slash command.
   * Returns updated context with thread/message info, or null if using deferred response.
   */
  postThinkingIndicator(event: ChannelEvent): Promise<{
    /** Updated response context */
    context: Partial<ResponseContext>
    /** Whether to return empty body (vs deferred response) */
    emptyResponse?: boolean
  } | null>

  /**
   * Post initial "Thinking..." indicator for a mention-created thread.
   * Providers can use this hook for provider-specific preparation such as
   * joining a Slack channel before posting into a public-channel thread.
   */
  postMentionThinkingIndicator?(event: ChannelEvent): Promise<PostMessageResult>

  // ===========================================================================
  // Formatting
  // ===========================================================================

  /**
   * Convert standard markdown to provider-specific format.
   */
  formatMarkdown(text: string): string

  /**
   * Replace bot mentions with @Ficus in text.
   */
  replaceBotMention(text: string, botUserId: string): string

  /**
   * Format a user mention.
   */
  formatUserMention(userId: string): string

  // ===========================================================================
  // Sync Command Responses
  // ===========================================================================

  /**
   * Format a sync response (status, help) for immediate return.
   */
  formatSyncResponse(content: string): unknown

  /**
   * Format an error response.
   */
  formatErrorResponse(message: string): unknown

  /**
   * Format a deferred/thinking response.
   */
  formatDeferredResponse(): unknown

  // ===========================================================================
  // Notifications
  // ===========================================================================

  /**
   * Send a notification to a channel.
   * Optional — not all providers support outbound notifications.
   */
  sendNotification?(opts: SendNotificationOpts): Promise<void>
}

// =============================================================================
// Provider Registry
// =============================================================================

const providers = new Map<string, ChannelProvider>()

export function registerProvider(provider: ChannelProvider): void {
  providers.set(provider.name, provider)
}

export function getProvider(name: string): ChannelProvider | undefined {
  return providers.get(name)
}

export function hasProvider(name: string): boolean {
  return providers.has(name)
}

/**
 * Check if a channel name corresponds to an external provider with notification support.
 * Returns the provider if it exists and has sendNotification, otherwise undefined.
 */
export function getNotificationProvider(name: string): ChannelProvider | undefined {
  const provider = providers.get(name)
  if (provider?.sendNotification) {
    return provider
  }
  return undefined
}
