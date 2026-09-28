import type { Transport } from '@ficus/client-core'
import type {
  AssistantActivityPage,
  AssistantActivityUpdate,
  AssistantConversation,
  AssistantConversationActivityDetail,
  AssistantConversationKind,
  AssistantEditorReadState,
  AssistantEditorState,
  AssistantEditorSync,
  AssistantEntry,
  AssistantMailbox,
  AssistantMessageReceipt,
} from '@ficus/shared'

/**
 * The Assistant's REST surface, mirroring apps/web/src/api/assistant.ts route
 * for route (it isn't in @ficus/client-core yet). Built over a transport so the
 * chat can take the one from its conversation environment (tests inject a fake).
 * No new server API.
 */
export function createAssistantApi(t: Transport) {
  return {
    readUpdates: (id: string, messageIds: string[]) =>
      t.request<Array<AssistantActivityUpdate & { taskLabel: string | null }>>(`/assistant/${id}/updates/read`, {
        method: 'POST',
        body: { messageIds },
      }),
    ensureAgent: (id: string) => t.request<{ agentId: string }>(`/assistant/${id}/agent`, { method: 'POST', body: {} }),
    editor: (id: string) => t.request<AssistantEditorReadState>(`/assistant/${id}/editor`),
    syncEditor: (id: string, value: AssistantEditorSync) =>
      t.request<AssistantEditorState>(`/assistant/${id}/editor`, { method: 'PUT', body: value }),
    proposeEditor: (id: string, value: unknown) =>
      t.request<AssistantEditorState>(`/assistant/${id}/editor/propose`, { method: 'POST', body: value }),
    closeEditor: (id: string) => t.request(`/assistant/${id}/editor`, { method: 'DELETE' }),
    list: (q = '', offset = 0) =>
      t.request<{ conversations: AssistantConversation[]; hasMore: boolean }>(
        `/assistant?${new URLSearchParams({ q, offset: String(offset) })}`
      ),
    create: (id: string, title?: string, kind: AssistantConversationKind = 'assistant') =>
      t.request<AssistantConversation>('/assistant', { method: 'POST', body: { id, title, kind } }),
    history: (id: string, before?: number) =>
      t.request<{
        conversation: AssistantConversation
        entries: AssistantEntry[]
        hasMore: boolean
        before?: number
      }>(`/assistant/${id}${before ? `?before=${before}` : ''}`),
    append: (id: string, entries: AssistantEntry[]) =>
      t.request(`/assistant/${id}/entries`, { method: 'POST', body: { entries } }),
    message: (
      id: string,
      request: string,
      clientId: string,
      options: {
        pagePath?: string
        agentId?: string
        squadId?: string
        label?: string
        mode?: 'steer' | 'follow-up'
        inReplyTo?: string
      } = {}
    ) =>
      t.request<AssistantMessageReceipt>(`/assistant/${id}/messages`, {
        method: 'POST',
        body: { request, clientId, ...options },
      }),
    /** Lightweight discovery across every owned conversation; never leases a mailbox or starts a model. */
    activity: (limit = 30, offset = 0) =>
      t.request<AssistantActivityPage>(
        `/assistant/activity?${new URLSearchParams({ limit: String(limit), offset: String(offset) })}`
      ),
    conversationActivity: (id: string, beforeSequence?: number) =>
      t.request<AssistantConversationActivityDetail>(
        `/assistant/${id}/activity${beforeSequence ? `?beforeSequence=${beforeSequence}` : ''}`
      ),
    seen: (id: string, messageIds: string[]) =>
      t.request<{ success: true }>(`/assistant/${id}/updates/seen`, { method: 'POST', body: { messageIds } }),
    seenThrough: (id: string, sequence: number) =>
      t.request<{ success: true }>(`/assistant/${id}/updates/seen-through`, { method: 'POST', body: { sequence } }),
    inbox: (id: string, consumerId: string) =>
      t.request<AssistantMailbox>(`/assistant/${id}/inbox`, { method: 'POST', body: { consumerId } }),
    /** Marks updates processed only after a final entry naming them is saved; never marks them seen. */
    acknowledge: (id: string, consumerId: string, messageIds: string[], responseEntryId: string) =>
      t.request(`/assistant/${id}/inbox/ack`, {
        method: 'POST',
        body: { consumerId, messageIds, responseEntryId },
      }),
    release: (id: string, consumerId: string) =>
      t.request(`/assistant/${id}/inbox/release`, { method: 'POST', body: { consumerId } }),
  }
}

export type AssistantApi = ReturnType<typeof createAssistantApi>
