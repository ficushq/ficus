import type { AgentTypeIntegrationPolicyV1 } from '@ficus/shared'
import { apiFetch } from './client'

export interface AgentType {
  systemOnly?: boolean
  disabled?: boolean
  id: string
  name: string
  description: string | null
  model: string | null
  systemPrompt: string
  toolsAllow: string[] | null
  toolsDeny: string[] | null
  integrationCapabilities: AgentTypeIntegrationPolicyV1 | null
  createdAt: string
  updatedAt: string
}

export async function listAgentTypes(): Promise<AgentType[]> {
  return apiFetch<AgentType[]>('/agent-types')
}

export async function getAgentType(id: string): Promise<AgentType> {
  return apiFetch<AgentType>(`/agent-types/${id}`)
}
