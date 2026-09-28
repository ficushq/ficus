import type { Agent, DeliveryMode, ExecutionStatus, Message } from '@ficus/shared'
import { parseSSEStream, type SSECallbacks } from '../sse'
import type { Transport } from '../transport'

export interface MessagesResponse {
  messages: Message[]
  pagination: {
    hasMore: boolean
    totalCount: number
    oldestId?: string
    newestId?: string
    nextCursor?: string
  }
}

export type AgentStreamCallbacks = SSECallbacks & { onReconnect?: () => void; onDisconnect?: () => void }

export interface ActiveExecution {
  active: boolean
  executionId?: string
  agentId?: string
  status?: ExecutionStatus
  sandboxRecovery?: {
    reason: 'capacity' | 'unavailable'
    nextAttemptAt: string
    deadlineAt: string
    attemptCount: number
    maxAttempts: number
  }
}

export interface ListAgentsFilters {
  scopeType?: string
  scopeId?: string
  status?: string
  topLevelOnly?: boolean
  parentAgentId?: string
}

export interface AgentSendMessageResult {
  /** Whether this accepted send is queued for consumption in an existing execution. */
  queued?: boolean
  success: boolean
  status: ExecutionStatus
}

export interface ContinueHaltedActionsResult {
  resumed: number
  resumedActionIds: string[]
  staleActionIds: string[]
}

export interface SendAgentMessageOptions {
  pagePath?: string
  imageIds?: string[]
  deliveryMode?: DeliveryMode
  clientId?: string
}

function openReconnectableAgentStream(
  t: Transport,
  agentId: string,
  callbacks: AgentStreamCallbacks,
  executionId?: string
): () => void {
  const controller = new AbortController()
  const retryDelayMs = 2000
  const maxRetries = 15
  let reconnecting = false

  async function connect(retries: number): Promise<void> {
    if (controller.signal.aborted) return

    try {
      const path = executionId ? `/agents/${agentId}/executions/${executionId}/stream` : `/agents/${agentId}/stream`
      const reader = await t.openStream(path, { method: 'GET', signal: controller.signal })
      if (controller.signal.aborted) {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
        return
      }
      if (reconnecting) callbacks.onReconnect?.()

      let receivedDone = false
      let doneCallbackDelivered = false
      let terminalSnapshot = false
      await parseSSEStream(
        reader,
        {
          onEvent: (event) => {
            if (event.type === 'execution_snapshot' && ['completed', 'failed', 'stopped'].includes(event.status)) {
              receivedDone = true
              terminalSnapshot = true
            }
            callbacks.onEvent(event)
          },
          onCatchup: callbacks.onCatchup,
          onError: callbacks.onError,
          onDone: () => {
            receivedDone = true
            if (!doneCallbackDelivered) {
              doneCallbackDelivered = true
              callbacks.onDone?.()
            }
          },
        },
        controller.signal
      )

      if (terminalSnapshot && !controller.signal.aborted && !doneCallbackDelivered) {
        doneCallbackDelivered = true
        callbacks.onDone?.()
      }

      if (!receivedDone && !controller.signal.aborted) {
        if (retries < maxRetries) {
          reconnecting = true
          callbacks.onDisconnect?.()
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
          return connect(retries + 1)
        }
        callbacks.onDone?.()
      }
    } catch (err) {
      if (controller.signal.aborted) return
      if (retries < maxRetries) {
        reconnecting = true
        callbacks.onDisconnect?.()
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
        return connect(retries + 1)
      }
      callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
      if (!controller.signal.aborted) callbacks.onDone?.()
    }
  }

  void connect(0)
  return () => controller.abort()
}

/** Lean agents surface used by mobile (conversation history + agent lookup). */
export function agentsResource(t: Transport) {
  return {
    listAgents: (filters?: ListAgentsFilters): Promise<Agent[]> => {
      const p = new URLSearchParams()
      if (filters?.scopeType) p.set('scopeType', filters.scopeType)
      if (filters?.scopeId) p.set('scopeId', filters.scopeId)
      if (filters?.status) p.set('status', filters.status)
      if (filters?.topLevelOnly) p.set('topLevelOnly', 'true')
      if (filters?.parentAgentId) p.set('parentAgentId', filters.parentAgentId)
      const q = p.toString()
      return t.request(`/agents${q ? `?${q}` : ''}`)
    },
    getAgent: (id: string): Promise<Agent> => t.request(`/agents/${id}`),
    getActiveExecution: (agentId: string): Promise<ActiveExecution> => t.request(`/agents/${agentId}/active`),
    getExecution: (agentId: string, executionId: string, signal?: AbortSignal) =>
      t.request<{
        executionId: string
        agentId: string
        status: import('@ficus/shared').ExecutionStatus
        executionVersion: number
        active: boolean
      }>(`/agents/${agentId}/executions/${executionId}`, signal ? { signal } : undefined),
    subscribeToAgentStream: (agentId: string, callbacks: AgentStreamCallbacks, executionId?: string): (() => void) =>
      openReconnectableAgentStream(t, agentId, callbacks, executionId),
    getMessage: (agentId: string, messageId: string): Promise<Message> =>
      t.request(`/agents/${agentId}/messages/${messageId}`),
    getMessages: (
      agentId: string,
      options?: { cursor?: string; beforeId?: string; limit?: number }
    ): Promise<MessagesResponse> => {
      const p = new URLSearchParams()
      if (options?.cursor) p.set('cursor', options.cursor)
      else if (options?.beforeId) p.set('beforeId', options.beforeId)
      if (options?.limit) p.set('limit', String(options.limit))
      const q = p.toString()
      return t.request(`/agents/${agentId}/messages${q ? `?${q}` : ''}`)
    },
    // Unified state-aware send path. deliveryMode is an intent used only when a turn is running.
    sendMessage: (
      agentId: string,
      content: string,
      options?: SendAgentMessageOptions
    ): Promise<AgentSendMessageResult> =>
      t.request(`/agents/${agentId}/message`, {
        method: 'POST',
        body: {
          content,
          pagePath: options?.pagePath,
          imageIds: options?.imageIds,
          deliveryMode: options?.deliveryMode,
          clientId: options?.clientId,
        },
      }),
    /** @deprecated Use sendMessage(agentId, message, { deliveryMode: 'steer' }) instead. */
    steer: (agentId: string, message: string, imageIds?: string[]): Promise<{ success: boolean }> =>
      t.request(`/agents/${agentId}/steer`, { method: 'POST', body: { message, imageIds } }),
    /** @deprecated Use sendMessage(agentId, message, { deliveryMode: 'follow-up' }) instead. */
    followUp: (agentId: string, message: string, imageIds?: string[]): Promise<{ success: boolean }> =>
      t.request(`/agents/${agentId}/follow-up`, { method: 'POST', body: { message, imageIds } }),
    stream: async (agentId: string, callbacks: AgentStreamCallbacks): Promise<void> => {
      openReconnectableAgentStream(t, agentId, callbacks)
    },
    // Clear all queued (pending) steer/follow-up messages.
    clearQueue: (agentId: string): Promise<{ success: boolean }> =>
      t.request(`/agents/${agentId}/clear-queue`, { method: 'POST' }),
    continueAgent: (agentId: string): Promise<{ resumed: boolean }> =>
      t.request(`/agents/${agentId}/continue`, { method: 'POST' }),
    continueHaltedActions: (actionIds: string[]): Promise<ContinueHaltedActionsResult> =>
      t.request('/agents/continue-halted', { method: 'POST', body: { actionIds } }),
    // Stop the active execution (graceful).
    stopAgent: (agentId: string): Promise<{ success: boolean }> =>
      t.request(`/agents/${agentId}/stop`, { method: 'POST' }),
    // Abort the currently-running tool call (leaves the turn going).
    abortTool: (agentId: string): Promise<{ success: boolean }> =>
      t.request(`/agents/${agentId}/abort-tool`, { method: 'POST' }),
  }
}
