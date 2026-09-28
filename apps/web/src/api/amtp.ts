import { apiFetch } from './client'
import type {
  AgentAmtpAllowRuleResponse,
  AgentFederationStatusResponse,
  AgentRegisterResponse,
  InstanceIdentityResponse,
  PeerResponse,
} from '@ficus/shared'

export function getInstanceIdentity(): Promise<InstanceIdentityResponse> {
  return apiFetch<InstanceIdentityResponse>('/amtp/instance-identity')
}

export function listPeers(): Promise<PeerResponse[]> {
  return apiFetch<PeerResponse[]>('/amtp/peers')
}

export function addPeer(body: {
  localAlias: string
  instanceId: string
  baseUrl: string
  publicKeyPem: string
}): Promise<PeerResponse> {
  return apiFetch<PeerResponse>('/amtp/peers', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updatePeer(
  id: string,
  body: { localAlias?: string; baseUrl?: string; publicKeyPem?: string; status?: 'active' | 'disabled' },
  fetch: typeof apiFetch = apiFetch
): Promise<PeerResponse> {
  return fetch<PeerResponse>('/amtp/peers/' + id, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function removePeer(id: string): Promise<void> {
  return apiFetch('/amtp/peers/' + id, { method: 'DELETE' })
}

// ── Per-agent federation (Plan A routes under /api/amtp/agents/:id/...) ──

export type AgentAmtpAllowRule = AgentAmtpAllowRuleResponse
export type AgentFederationStatus = AgentFederationStatusResponse
export type { AgentRegisterResponse }

export function getAgentFederationStatus(
  agentId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<AgentFederationStatus> {
  return fetch<AgentFederationStatus>(`/amtp/agents/${agentId}/status`)
}

export function registerAgentFederation(
  agentId: string,
  handle: string,
  fetch: typeof apiFetch = apiFetch
): Promise<AgentRegisterResponse> {
  return fetch<AgentRegisterResponse>(`/amtp/agents/${agentId}/register`, {
    method: 'POST',
    body: JSON.stringify({ handle }),
  })
}

export function unregisterAgentFederation(agentId: string, fetch: typeof apiFetch = apiFetch): Promise<void> {
  return fetch(`/amtp/agents/${agentId}/register`, { method: 'DELETE' })
}

export function openAgentMailbox(agentId: string, fetch: typeof apiFetch = apiFetch): Promise<void> {
  return fetch(`/amtp/agents/${agentId}/open`, { method: 'POST' })
}

export function closeAgentMailbox(agentId: string, fetch: typeof apiFetch = apiFetch): Promise<void> {
  return fetch(`/amtp/agents/${agentId}/close`, { method: 'POST' })
}

export function listAgentAllowRules(agentId: string): Promise<AgentAmtpAllowRule[]> {
  return apiFetch<AgentAmtpAllowRule[]>(`/amtp/agents/${agentId}/allow-rules`)
}

export function addAgentAllowRule(
  agentId: string,
  body: { peerInstanceId: string; principalKind: 'any' | 'handle'; principalValue?: string },
  fetch: typeof apiFetch = apiFetch
): Promise<AgentAmtpAllowRule> {
  return fetch<AgentAmtpAllowRule>(`/amtp/agents/${agentId}/allow-rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function deleteAgentAllowRule(
  agentId: string,
  ruleId: string,
  fetch: typeof apiFetch = apiFetch
): Promise<void> {
  return fetch(`/amtp/agents/${agentId}/allow-rules/${ruleId}`, { method: 'DELETE' })
}
