import type { AssistantConversation } from '@ficus/shared'
import { client } from './client'

/**
 * The Assistant's REST surface isn't in @ficus/client-core yet (the web app
 * keeps it in apps/web/src/api/assistant.ts), so the garden calls the same
 * existing routes through its own transport. No new server API.
 */
const t = client.transport

export const assistantApi = {
  list: (q = '', offset = 0) =>
    t.request<{ conversations: AssistantConversation[]; hasMore: boolean }>(
      `/assistant?${new URLSearchParams({ q, offset: String(offset) })}`
    ),
  ensureAgent: (id: string) => t.request<{ agentId: string }>(`/assistant/${id}/agent`, { method: 'POST', body: {} }),
}
