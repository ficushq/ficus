import type { DeliveryMode, InboxMessage, InboxRecipientType } from '@ficus/shared'
import type { Transport } from '../transport'

// The sender is derived server-side from the authenticated session — you always author as yourself.
// Set asVoiceAssistant to author as your own voice assistant instead of your user identity.
export interface SendInboxMessageInput {
  recipientType?: InboxRecipientType
  recipientId: string
  asVoiceAssistant?: boolean
  subject?: string
  content: string
  metadata?: Record<string, unknown>
  deliveryMode?: DeliveryMode
}

export interface InboxMessageResponse extends Omit<InboxMessage, 'createdAt' | 'deliveredAt' | 'readAt'> {
  createdAt: string
  deliveredAt: string | null
  readAt: string | null
}

export type InboxReadState = 'all' | 'read' | 'unread'

export interface InboxMessagesPage {
  items: InboxMessageResponse[]
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

export interface InboxPageOptions {
  readState?: InboxReadState
  limit?: number
  cursor?: string | null
  /** Case-insensitive substring filter on subject + content. */
  search?: string
}

function inboxPagePath(type: InboxRecipientType, id: string, opts: InboxPageOptions = {}): string {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) })
  if (opts.readState && opts.readState !== 'all') params.set('readState', opts.readState)
  if (opts.readState === 'all') params.set('all', 'true')
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.search) params.set('search', opts.search)
  return `/inbox/${type}/${id}?${params.toString()}`
}

export function inboxResource(t: Transport) {
  return {
    // The authenticated user's own personal inbox. 'me' is resolved server-side to the caller's userId.
    getMyInbox: (includeRead = false): Promise<InboxMessageResponse[]> => {
      const params = includeRead ? '?all=true' : ''
      return t.request(`/inbox/user/me${params}`)
    },

    getMyInboxUnreadCount: (): Promise<{ count: number }> => t.request(`/inbox/user/me/count`),

    // An agent's inbox (e.g. the squad manager's). Unified route: /inbox/agent/:id[?all=true].
    getAgentInbox: (agentId: string, includeRead = false): Promise<InboxMessageResponse[]> => {
      const params = includeRead ? '?all=true' : ''
      return t.request(`/inbox/agent/${agentId}${params}`)
    },

    getAgentInboxPage: (agentId: string, opts: InboxPageOptions = {}): Promise<InboxMessagesPage> =>
      t.request(inboxPagePath('agent', agentId, opts)),

    getMyInboxPage: (opts: InboxPageOptions = {}): Promise<InboxMessagesPage> =>
      t.request(inboxPagePath('user', 'me', opts)),

    getSystemInboxPage: (opts: InboxPageOptions = {}): Promise<InboxMessagesPage> =>
      t.request(inboxPagePath('system', 'system', opts)),

    getAgentInboxUnreadCount: (agentId: string): Promise<{ count: number }> =>
      t.request(`/inbox/agent/${agentId}/count`),

    markMyInboxAllRead: (): Promise<void> => t.request(`/inbox/user/me/read-all`, { method: 'POST' }),

    // The shared system/announcements inbox (requires the inbox:system permission).
    getSystemInbox: (includeRead = false): Promise<InboxMessageResponse[]> => {
      const params = includeRead ? '?all=true' : ''
      return t.request(`/inbox/system/system${params}`)
    },

    getSystemInboxUnreadCount: (): Promise<{ count: number }> => t.request(`/inbox/system/system/count`),

    markSystemInboxAllRead: (): Promise<void> => t.request(`/inbox/system/system/read-all`, { method: 'POST' }),

    // The authenticated user's per-user voice "workspace" inbox. 'me' resolves to workspace:<userId>.
    getVoiceAssistantInbox: (recipientId = 'me', includeRead = false): Promise<InboxMessageResponse[]> => {
      const params = includeRead ? '?all=true' : ''
      return t.request(`/inbox/voice_assistant/${recipientId}${params}`)
    },

    sendInboxMessage: (input: SendInboxMessageInput): Promise<InboxMessageResponse> =>
      t.request('/inbox', {
        method: 'POST',
        body: input,
      }),

    markAsRead: (messageId: string): Promise<void> => t.request(`/inbox/${messageId}/read`, { method: 'POST' }),

    /** Fetch one inbox message (with its real content) by id. */
    getInboxMessage: (messageId: string): Promise<InboxMessageResponse> => t.request(`/inbox/message/${messageId}`),
  }
}
