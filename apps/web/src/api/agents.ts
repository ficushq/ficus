import type {
  Agent,
  DeliveryMode,
  Execution,
  Message,
  SandboxProcesses,
  SandboxProcessSignal,
  StreamEvent,
} from '@ficus/shared'
import type { SandboxStatus } from './workspace'
import { apiFetch, authFetch } from './client'
import { parseSSEStream } from './sse'
import { client } from './clientInstance'

export interface MessagesResponse {
  messages: Message[]
  pagination: {
    hasMore: boolean
    totalCount: number
    oldestId?: string
    nextCursor?: string
    newestId?: string
  }
}

export async function getMessages(
  agentId: string,
  options?: { cursor?: string; beforeId?: string; limit?: number }
): Promise<MessagesResponse> {
  const params = new URLSearchParams()
  if (options?.cursor) params.set('cursor', options.cursor)
  else if (options?.beforeId) params.set('beforeId', options.beforeId)
  if (options?.limit) params.set('limit', String(options.limit))

  const query = params.toString()
  return apiFetch<MessagesResponse>(`/agents/${agentId}/messages${query ? `?${query}` : ''}`)
}

export async function getMessage(agentId: string, messageId: string): Promise<Message> {
  return apiFetch<Message>(`/agents/${agentId}/messages/${messageId}`)
}

export interface ListAgentsFilters {
  agentTypeId?: string
  status?: string
  scopeType?: string
  scopeId?: string
  taskId?: string
  parentAgentId?: string
  topLevelOnly?: boolean
}

export function buildListAgentsPath(filters?: ListAgentsFilters): string {
  const params = new URLSearchParams()
  if (filters?.agentTypeId) params.set('agentTypeId', filters.agentTypeId)
  if (filters?.status) params.set('status', filters.status)
  if (filters?.scopeType) params.set('scopeType', filters.scopeType)
  if (filters?.scopeId) params.set('scopeId', filters.scopeId)
  if (filters?.taskId) params.set('taskId', filters.taskId)
  if (filters?.parentAgentId) params.set('parentAgentId', filters.parentAgentId)
  if (filters?.topLevelOnly) params.set('topLevelOnly', 'true')

  const query = params.toString()
  return `/agents${query ? `?${query}` : ''}`
}

export async function listAgents(filters?: ListAgentsFilters): Promise<Agent[]> {
  return apiFetch<Agent[]>(buildListAgentsPath(filters))
}

export async function getAgent(id: string): Promise<Agent> {
  return apiFetch<Agent>(`/agents/${id}`)
}

export interface ActiveExecution {
  active: boolean
  executionId?: string
  agentId?: string
  status?: string
}

export async function getActiveExecution(agentId: string): Promise<ActiveExecution> {
  return apiFetch<ActiveExecution>(`/agents/${agentId}/active`)
}

export async function getAgentSandboxStatus(agentId: string): Promise<SandboxStatus> {
  return apiFetch<SandboxStatus>(`/agents/${agentId}/sandbox/status`)
}

/** What this agent's own sandbox is running (samples CPU for about a second). */
export async function getAgentSandboxProcesses(agentId: string): Promise<SandboxProcesses> {
  return apiFetch<SandboxProcesses>(`/agents/${agentId}/sandbox/processes`)
}

export async function signalAgentSandboxProcess(
  agentId: string,
  pid: number,
  signal: SandboxProcessSignal
): Promise<void> {
  await apiFetch(`/agents/${agentId}/sandbox/processes/${pid}/signal`, {
    method: 'POST',
    body: JSON.stringify({ signal }),
  })
}

export async function stopAgentSandboxContainer(agentId: string, containerId: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/sandbox/containers/${encodeURIComponent(containerId)}/stop`, { method: 'POST' })
}

export interface AgentScope {
  id: string
  agentId: string
  permission: string
  grantedBy: string | null
  createdAt: string
}

export async function listAgentScopes(agentId: string): Promise<AgentScope[]> {
  const { scopes } = await apiFetch<{ scopes: AgentScope[] }>(`/agents/${agentId}/scopes`)
  return scopes
}

export async function grantAgentScope(agentId: string, permission: string): Promise<AgentScope> {
  return apiFetch<AgentScope>(`/agents/${agentId}/scopes`, {
    method: 'POST',
    body: JSON.stringify({ permission }),
  })
}

export async function revokeAgentScope(agentId: string, permission: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/scopes/${encodeURIComponent(permission)}`, { method: 'DELETE' })
}

/** Stop this agent's individual sandbox. */
export async function stopAgentSandbox(agentId: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/sandbox/stop`, { method: 'POST' })
}

/** Stop and re-provision this agent's individual sandbox. */
export async function restartAgentSandbox(agentId: string): Promise<void> {
  await apiFetch(`/agents/${agentId}/sandbox/restart`, { method: 'POST' })
}

export async function listExecutions(agentId: string): Promise<Execution[]> {
  return apiFetch<Execution[]>(`/agents/${agentId}/executions`)
}

export async function stopAgent(agentId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/stop`, { method: 'POST' })
}

export async function abortAgentTool(agentId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/abort-tool`, { method: 'POST' })
}

export async function compactAgent(agentId: string, instructions?: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/compact`, {
    method: 'POST',
    body: JSON.stringify({ instructions }),
  })
}

export async function resetAgent(agentId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/reset`, {
    method: 'POST',
  })
}

export async function deleteAgent(agentId: string): Promise<void> {
  await apiFetch<void>(`/agents/${agentId}`, { method: 'DELETE' })
}

/** @deprecated Use sendAgentMessage(agentId, message, imageIds, 'steer') instead. */
export async function steerAgent(agentId: string, message: string, imageIds?: string[]): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/steer`, {
    method: 'POST',
    body: JSON.stringify({ message, imageIds }),
  })
}

/** @deprecated Use sendAgentMessage(agentId, message, imageIds, 'follow-up') instead. */
export async function followUpAgent(
  agentId: string,
  message: string,
  imageIds?: string[]
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/follow-up`, {
    method: 'POST',
    body: JSON.stringify({ message, imageIds }),
  })
}

export async function clearAgentQueue(agentId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/agents/${agentId}/clear-queue`, {
    method: 'POST',
  })
}

export function sendAgentMessage(agentId: string, content: string, imageIds?: string[], deliveryMode?: DeliveryMode) {
  return client.agents.sendMessage(agentId, content, { imageIds, deliveryMode })
}

export async function getTaskAgents(taskId: string): Promise<Agent[]> {
  return apiFetch<Agent[]>(`/tasks/${taskId}/agents`)
}

/** Resume a single agent halted by a provider/rate-limit error. */
export const continueAgent = client.agents.continueAgent

/** Resume exactly the currently rendered, respondable halted-agent actions. */
export const continueHaltedAgents = client.agents.continueHaltedActions

/**
 * Subscribe to an agent's execution stream via SSE.
 * Returns an abort function to close the connection.
 */
export function subscribeToAgentStream(
  agentId: string,
  callbacks: {
    onEvent: (event: StreamEvent) => void
    onDone: () => void
    onReconnect?: () => void
  }
): () => void {
  const controller = new AbortController()
  const RETRY_DELAY = 2000
  const MAX_RETRIES = 15
  let isReconnect = false

  async function connect(retries: number): Promise<void> {
    if (controller.signal.aborted) return

    try {
      const response = await authFetch(`/agents/${agentId}/stream`, {
        signal: controller.signal,
      })

      if (!response.ok || !response.body) {
        if (retries < MAX_RETRIES && !controller.signal.aborted) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY))
          return connect(retries + 1)
        }
        callbacks.onDone()
        return
      }

      if (isReconnect) {
        callbacks.onReconnect?.()
      }

      const reader = response.body.getReader()
      let receivedDone = false

      await parseSSEStream(reader, {
        onEvent: callbacks.onEvent,
        onDone: () => {
          receivedDone = true
          callbacks.onDone()
        },
      })

      if (!receivedDone && !controller.signal.aborted) {
        isReconnect = true
        await new Promise((r) => setTimeout(r, RETRY_DELAY))
        return connect(0)
      }

      if (!receivedDone) {
        callbacks.onDone()
      }
    } catch {
      if (controller.signal.aborted) return
      if (retries < MAX_RETRIES) {
        isReconnect = true
        await new Promise((r) => setTimeout(r, RETRY_DELAY))
        return connect(retries + 1)
      }
      callbacks.onDone()
    }
  }

  connect(0)
  return () => controller.abort()
}

export interface AgentContext {
  shortTermMemory: string
  todos: { text: string; completed: boolean; depends: number[] }[]
}

export async function getAgentContext(agentId: string): Promise<AgentContext> {
  return apiFetch<AgentContext>(`/agents/${agentId}/context`)
}

export interface AgentSlotWait {
  waiterId: string
  poolKey: string
  queuedAt: string
}

export function getAgentSlotWaits(agentId: string): Promise<AgentSlotWait[]> {
  return apiFetch<AgentSlotWait[]>(`/agents/${agentId}/slot-waits`)
}
