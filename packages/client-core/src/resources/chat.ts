import type { DeliveryMode } from '@ficus/shared'
import type { Transport } from '../transport'
import { parseSSEStream, type SSECallbacks } from '../sse'

export type ChatSSECallbacks = SSECallbacks

export interface SendChatParams {
  pagePath?: string
  message: string
  agentId?: string
  scope?: { type: string; id?: string }
  imageIds?: string[]
  deliveryMode?: DeliveryMode
  clientId?: string
}

export function chatResource(t: Transport) {
  return {
    /**
     * Send a chat message. Resolves once the server accepts the request; the SSE
     * stream then processes in the background via callbacks. Throws if the request
     * itself fails (network or non-2xx) — Transport.openStream rejects on !ok.
     */
    sendChatMessage: async (params: SendChatParams, callbacks: ChatSSECallbacks): Promise<void> => {
      const reader = await t.openStream('/chat', { method: 'POST', body: params })
      // Don't await — stream processes in background via callbacks.
      void parseSSEStream(reader, callbacks)
    },
  }
}
