import { z } from 'zod'
import type { AssistantActivityUpdate } from './assistant-activity'

export const assistantEntrySchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(100_000),
  final: z.boolean(),
  channel: z.enum(['text', 'voice']).optional(),
  toolName: z.string().max(100).optional(),
  toolCallId: z.string().max(160).optional(),
  toolArgs: z.string().max(20_000).optional(),
  toolResult: z.string().max(100_000).optional(),
  toolError: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  /** Durable Assistant updates this entry presented; acknowledgment requires a final entry naming them. */
  assistantUpdateIds: z.array(z.uuid()).max(10).optional(),
})
export type AssistantEntry = z.infer<typeof assistantEntrySchema>
/** App-wide Assistant conversations and page-editor drafts carry different tools and surfaces. */
export const ASSISTANT_CONVERSATION_KINDS = ['assistant', 'page-editor'] as const
export type AssistantConversationKind = (typeof ASSISTANT_CONVERSATION_KINDS)[number]
export interface AssistantConversation {
  agentId?: string | null
  id: string
  kind: AssistantConversationKind
  title: string
  createdAt: string
  updatedAt: string
}
/** Stable mailbox identity; transport connections are only temporary consumers. */
export function assistantInboxRecipientId(conversationId: string): string {
  return `assistant:${conversationId}`
}
export function parseAssistantInboxConversationId(id: string | null | undefined): string | null {
  return typeof id === 'string' && /^assistant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id.slice('assistant:'.length)
    : null
}
export type AssistantMessageTargetKind = 'background' | 'squad' | 'agent'
export interface AssistantMessageReceipt {
  id: string
  /** The tracked task this request belongs to: its first request's ID. */
  taskId: string
  agentId: string
  delivered: boolean
  /** background = the conversation's general helper, squad = its owned consultant, agent = an explicit target. */
  kind: AssistantMessageTargetKind
  squadId?: string
}
/** One unprocessed durable update handed to the Realtime consumer; the sender lets tools reply. */
export type AssistantMailboxUpdate = AssistantActivityUpdate & { senderId: string | null }
export interface AssistantMailbox {
  acquired: boolean
  /** Updates Realtime has not presented yet, oldest first. Unread state is tracked separately. */
  messages: AssistantMailboxUpdate[]
  /** Tracked tasks that have not reached a terminal state. */
  pending: number
  unavailable: boolean
}
/** Mailbox acknowledgment: a durable final entry must reference every processed update. */
export interface AssistantMailboxAcknowledgment {
  consumerId: string
  messageIds: string[]
  responseEntryId: string
}
