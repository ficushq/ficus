/**
 * One agent's private area: browse, view, download and upload files there, and
 * see or start the agent's own sandbox. Requires `agents:private-access` in the
 * agent's squad (Admin and Operator by default); the server answers 403 for
 * everything else.
 */

import { apiFetch } from './client'
import {
  uploadWithProgress,
  type FileContent,
  type TreeNode,
  type UploadOptions,
  type UploadResponse,
} from './workspace'

export interface AgentPrivateStatus {
  agentId: string
  agentStatus: string
  /** False for dormant agents: their box is not started from here. */
  live: boolean
  sandboxId: string
  /** Absolute path of the private area as the agent sees it in its sandbox. */
  privateRoot: string
  sandbox: { status: string; reason?: string }
  /** Whether files can be browsed right now (always on local storage; needs a running box on vm/k8s). */
  filesAvailable: boolean
  canStart: boolean
  /** The caller may open a terminal (also holds terminal:access) and the agent is live. */
  canUseTerminal: boolean
}

const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/private`

export function getAgentPrivateStatus(agentId: string): Promise<AgentPrivateStatus> {
  return apiFetch<AgentPrivateStatus>(`${base(agentId)}/status`)
}

export function startAgentPrivateSandbox(agentId: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`${base(agentId)}/start`, { method: 'POST' })
}

export function getAgentPrivateTree(agentId: string, path = ''): Promise<TreeNode> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  const query = params.toString()
  return apiFetch<TreeNode>(`${base(agentId)}/tree${query ? `?${query}` : ''}`)
}

export function getAgentPrivateFile(agentId: string, path: string): Promise<FileContent> {
  return apiFetch<FileContent>(`${base(agentId)}/file?${new URLSearchParams({ path })}`)
}

export function getAgentPrivateDownloadUrl(agentId: string, path: string): string {
  return `${base(agentId)}/download?${new URLSearchParams({ path })}`
}

export function uploadToAgentPrivate(
  agentId: string,
  files: { file: File; relativePath: string }[],
  options: UploadOptions = {}
): Promise<UploadResponse> {
  return uploadWithProgress(`${base(agentId)}/upload`, files, options)
}
