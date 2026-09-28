// Thin shim over @ficus/client-core (see ./clientInstance).
import { client } from './clientInstance'

export type { SendInboxMessageInput, InboxMessageResponse } from '@ficus/client-core'

export const getMyInbox = client.inbox.getMyInbox
export const getMyInboxUnreadCount = client.inbox.getMyInboxUnreadCount
export const markMyInboxAllRead = client.inbox.markMyInboxAllRead
export const getSystemInbox = client.inbox.getSystemInbox
export const getSystemInboxUnreadCount = client.inbox.getSystemInboxUnreadCount
export const markSystemInboxAllRead = client.inbox.markSystemInboxAllRead
export const getVoiceAssistantInbox = client.inbox.getVoiceAssistantInbox
export const sendInboxMessage = client.inbox.sendInboxMessage
export const markAsRead = client.inbox.markAsRead
