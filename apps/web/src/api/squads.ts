import type {
  Attention,
  Squad,
  SquadWithRelationships,
  SquadRelationship,
  CreateSquadInput,
  UpdateSquadInput,
  CreateSquadRelationshipInput,
  WorkStream,
  WorkStreamMetrics,
  InboxMessage,
  Agent,
  SquadActivityPage,
  SquadActivityKind,
  NormalizedSquadActivityFilters,
  ResolvedTrackedResource,
  TrackedResource,
  TrackedResourcesView,
} from '@ficus/shared'
// The payload shapes live with the transport in @ficus/client-core; web re-exports them so
// components keep importing their api-layer types from one place, with one definition behind it.
import type { SquadSubscription, WorkStreamSubscription } from '@ficus/client-core'
export type { SquadSubscription, WorkStreamSubscription }
import { apiFetch } from './client'
import { client } from './clientInstance'

// Squad CRUD

export interface ListSquadActivityOptions extends Partial<NormalizedSquadActivityFilters> {
  limit?: number
  cursor?: string | null
  signal?: AbortSignal
}

export async function listSquadActivity(
  squadId: string,
  options: ListSquadActivityOptions = {},
  fetch: typeof apiFetch = apiFetch
): Promise<SquadActivityPage> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.verbose) params.set('verbose', 'true')
  for (const agentId of [...new Set(options.agentIds ?? [])].sort()) params.append('agentId', agentId)
  for (const kind of [...new Set<SquadActivityKind>(options.kinds ?? [])].sort()) params.append('kind', kind)
  const query = params.toString()
  return fetch<SquadActivityPage>(
    `/squads/${squadId}/activity${query ? `?${query}` : ''}`,
    options.signal ? { signal: options.signal } : undefined
  )
}

export async function listSquads(status?: string, fetch: typeof apiFetch = apiFetch): Promise<Squad[]> {
  const params = status ? `?status=${status}` : ''
  return fetch<Squad[]>(`/squads${params}`)
}

export async function getSquad(id: string): Promise<Squad> {
  return apiFetch<Squad>(`/squads/${id}`)
}

export async function getSquadWithRelationships(id: string): Promise<SquadWithRelationships> {
  return apiFetch<SquadWithRelationships>(`/squads/${id}?includeRelationships=true`)
}

export interface SquadCreateOptions {
  runtime: 'docker-sysbox' | 'docker-socket' | 'k8s' | 'vm' | 'host'
  defaultHostWorkspaceRoot?: string
}

export async function getSquadCreateOptions(): Promise<SquadCreateOptions> {
  return apiFetch<SquadCreateOptions>('/squads/create-options')
}

export async function createSquad(input: CreateSquadInput): Promise<Squad> {
  return apiFetch<Squad>('/squads', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function updateSquad(id: string, input: UpdateSquadInput): Promise<Squad> {
  return apiFetch<Squad>(`/squads/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export interface AvatarImageInput {
  type: 'image'
  data: string // base64, no data: prefix
  mimeType: string
}

export async function uploadSquadAvatar(id: string, image: AvatarImageInput): Promise<Squad> {
  return apiFetch<Squad>(`/squads/${id}/avatar`, { method: 'POST', body: JSON.stringify({ image }) })
}

export async function removeSquadAvatar(id: string): Promise<Squad> {
  return apiFetch<Squad>(`/squads/${id}/avatar`, { method: 'DELETE' })
}

/** Read a picked file into the base64 ImageContent the avatar endpoint expects. */
export function fileToAvatarImage(file: File): Promise<AvatarImageInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      const result = reader.result as string
      resolve({ type: 'image', data: result.split(',')[1] ?? '', mimeType: file.type })
    }
    reader.readAsDataURL(file)
  })
}

export async function deleteSquad(id: string, deleteWorkspace = false): Promise<void> {
  const url = `/squads/${id}${deleteWorkspace ? '?deleteWorkspace=true' : ''}`
  return apiFetch<void>(url, {
    method: 'DELETE',
  })
}

export async function reorderSquads(ids: string[]): Promise<Squad[]> {
  return apiFetch<Squad[]>('/squads/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ ids }),
  })
}

// Squad Agents

export interface SquadAgentsResponse {
  agents: Agent[]
}

export interface SquadAgentsWithRecentResponse {
  agents: Agent[]
  recentlyTerminated: Agent[]
  recentlyTerminatedHasMore?: boolean
  recentlyTerminatedTotalCount?: number
}

export interface ListSquadAgentsWithRecentOptions {
  terminatedLimit?: number
  terminatedOffset?: number
}

export async function listSquadAgents(squadId: string): Promise<Agent[]> {
  const response = await apiFetch<SquadAgentsResponse>(`/squads/${squadId}/agents`)
  return response.agents
}

export async function listSquadAgentsWithRecent(
  squadId: string,
  options: ListSquadAgentsWithRecentOptions = {},
  fetch: typeof apiFetch = apiFetch
): Promise<SquadAgentsWithRecentResponse> {
  const params = new URLSearchParams({ includeRecentlyTerminated: 'true' })
  if (options.terminatedLimit !== undefined) params.set('terminatedLimit', String(options.terminatedLimit))
  if (options.terminatedOffset !== undefined) params.set('terminatedOffset', String(options.terminatedOffset))
  return fetch<SquadAgentsWithRecentResponse>(`/squads/${squadId}/agents?${params.toString()}`)
}

export async function spawnSquadAgent(squadId: string, agentTypeId: string): Promise<Agent> {
  return apiFetch<Agent>(`/squads/${squadId}/spawn`, {
    method: 'POST',
    body: JSON.stringify({ agentTypeId }),
  })
}

export async function terminateSquadAgent(squadId: string, agentId: string): Promise<void> {
  return apiFetch<void>(`/squads/${squadId}/agents/${agentId}`, {
    method: 'DELETE',
  })
}

export interface BulkTerminateResult {
  terminated: string[]
  deferred: string[]
  skipped: { id: string; reason: string }[]
}

export async function terminateSquadAgentsBulk(squadId: string, agentTypeId: string): Promise<BulkTerminateResult> {
  return apiFetch<BulkTerminateResult>(`/squads/${squadId}/agents/terminate-bulk`, {
    method: 'POST',
    body: JSON.stringify({ agentTypeId }),
  })
}

// Squad Relationships

export async function listSquadRelationships(squadId: string): Promise<SquadRelationship[]> {
  return apiFetch<SquadRelationship[]>(`/squads/${squadId}/relationships`)
}

export async function createSquadRelationship(input: CreateSquadRelationshipInput): Promise<SquadRelationship> {
  return apiFetch<SquadRelationship>('/squad-relationships', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteSquadRelationship(id: string): Promise<void> {
  return apiFetch<void>(`/squad-relationships/${id}`, {
    method: 'DELETE',
  })
}

// Work Streams

export const WS_ACTIVE_STATUSES = ['queued', 'active'] as const
export const WS_DONE_STATUSES = ['done', 'canceled'] as const
export const workStreamStatusesKey = (statuses: readonly string[]) => [...statuses].sort().join(',')
export const DONE_WORK_STREAM_STATUSES_KEY = workStreamStatusesKey(WS_DONE_STATUSES)

export interface DoneWorkStreamsPage {
  items: WorkStream[]
  hasMore: boolean
  nextCursor: string | null
  totalCount: number
}

export async function listWorkStreams(squadId: string): Promise<WorkStream[]> {
  return apiFetch<WorkStream[]>(`/workstreams?squadId=${squadId}`)
}

export async function listAllWorkStreams(): Promise<WorkStream[]> {
  return apiFetch<WorkStream[]>('/workstreams')
}

export async function listActiveWorkStreams(
  squadId?: string,
  fetch: typeof apiFetch = apiFetch
): Promise<WorkStream[]> {
  const params = new URLSearchParams({ statuses: WS_ACTIVE_STATUSES.join(',') })
  if (squadId) params.set('squadId', squadId)
  return fetch<WorkStream[]>(`/workstreams?${params.toString()}`)
}

/** The feed's active-work list, server-filtered to what this user has not muted for progress. */
export async function listAttentionWorkStreams(fetch: typeof apiFetch = apiFetch): Promise<WorkStream[]> {
  const params = new URLSearchParams({ statuses: WS_ACTIVE_STATUSES.join(','), respectAttention: 'true' })
  return fetch<WorkStream[]>(`/workstreams?${params.toString()}`)
}

export async function listDoneWorkStreams(
  opts: {
    squadId?: string
    squadIds?: readonly string[]
    statuses?: readonly string[]
    limit?: number
    completedAfter?: string
    completedBefore?: string
    cursor?: string | null
  },
  fetch: typeof apiFetch = apiFetch
): Promise<DoneWorkStreamsPage> {
  const params = new URLSearchParams({
    statuses: (opts.statuses ?? WS_DONE_STATUSES).join(','),
    limit: String(opts.limit ?? 50),
  })
  if (opts.squadId) params.set('squadId', opts.squadId)
  else if (opts.squadIds?.length) params.set('squadIds', [...new Set(opts.squadIds)].sort().join(','))
  if (opts.completedAfter) params.set('completedAfter', opts.completedAfter)
  if (opts.completedBefore) params.set('completedBefore', opts.completedBefore)
  if (opts.cursor) params.set('cursor', opts.cursor)
  return fetch<DoneWorkStreamsPage>(`/workstreams?${params.toString()}`)
}

export async function getWorkStream(id: string): Promise<WorkStream> {
  return apiFetch<WorkStream>(`/workstreams/${encodeURIComponent(id)}`)
}

/** Issues and pull requests this work stream follows alongside its delivery change request. */
export async function getWorkStreamTracked(id: string): Promise<TrackedResourcesView> {
  return apiFetch<TrackedResourcesView>(`/workstreams/${encodeURIComponent(id)}/tracked`)
}

/** Track a link, or designate an already tracked pull request as part of the delivery. */
export type AddWorkStreamTrackedBody = { delivery?: true } & (
  | { url: string }
  | { resource: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number'> }
)

/** Track one more link; the server resolves the URL against the squad's connections. */
export async function addWorkStreamTracked(
  id: string,
  body: AddWorkStreamTrackedBody
): Promise<TrackedResourcesView & { added: ResolvedTrackedResource[]; changed: boolean }> {
  return apiFetch(`/workstreams/${encodeURIComponent(id)}/tracked`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Untrack by identity rather than URL — a resource stays removable without a resolvable link. */
export async function removeWorkStreamTracked(
  id: string,
  resource: Pick<TrackedResource, 'integration' | 'repository' | 'kind' | 'number'>
): Promise<TrackedResourcesView & { removed: boolean }> {
  return apiFetch(`/workstreams/${encodeURIComponent(id)}/tracked`, {
    method: 'DELETE',
    body: JSON.stringify({ resource }),
  })
}

export async function getWorkStreamMetrics(id: string): Promise<WorkStreamMetrics | null> {
  const result = await apiFetch<WorkStream & { metrics: WorkStreamMetrics | null }>(
    `/workstreams/${encodeURIComponent(id)}?metrics=true`
  )
  return result.metrics
}

export async function getWorkStreamSubscription(id: string): Promise<WorkStreamSubscription> {
  return apiFetch<WorkStreamSubscription>(`/workstreams/${encodeURIComponent(id)}/subscription`)
}

export async function getSquadSubscription(id: string): Promise<SquadSubscription> {
  return apiFetch<SquadSubscription>(`/squads/${id}/subscription`)
}

export async function subscribeSquad(
  id: string,
  attention?: Attention,
  fetch: typeof apiFetch = apiFetch
): Promise<SquadSubscription> {
  return fetch<SquadSubscription>(`/squads/${id}/subscribe`, {
    method: 'POST',
    ...(attention ? { body: JSON.stringify({ attention }) } : {}),
  })
}

export async function unsubscribeSquad(id: string): Promise<SquadSubscription> {
  return apiFetch<SquadSubscription>(`/squads/${id}/subscribe`, { method: 'DELETE' })
}

export async function subscribeWorkStream(id: string, attention?: Attention): Promise<WorkStreamSubscription> {
  return apiFetch<WorkStreamSubscription>(`/workstreams/${encodeURIComponent(id)}/subscribe`, {
    method: 'POST',
    ...(attention ? { body: JSON.stringify({ attention }) } : {}),
  })
}

export async function unsubscribeWorkStream(id: string): Promise<WorkStreamSubscription> {
  return apiFetch<WorkStreamSubscription>(`/workstreams/${encodeURIComponent(id)}/subscribe`, { method: 'DELETE' })
}

export const resolveWorkStreamWait = client.squads.resolveWorkStreamWait

// Agent Inbox

export async function getInboxMessages(agentId: string, includeRead = false): Promise<InboxMessage[]> {
  const params = includeRead ? '?all=true' : ''
  return apiFetch<InboxMessage[]>(`/inbox/agent/${agentId}${params}`)
}

export async function markInboxMessageAsRead(messageId: string): Promise<void> {
  return apiFetch<void>(`/inbox/${messageId}/read`, {
    method: 'POST',
  })
}

export async function markAllInboxMessagesAsRead(agentId: string): Promise<void> {
  return apiFetch<void>(`/inbox/agent/${agentId}/read-all`, {
    method: 'POST',
  })
}

// SSH Keys

export interface SshKey {
  name: string
  type?: string
  createdAt?: string
}

export async function listSshKeys(squadId: string): Promise<SshKey[]> {
  return apiFetch<SshKey[]>(`/squads/ssh/${squadId}/keys`)
}

export async function addSshKey(
  squadId: string,
  input: { name: string; privateKey: string; publicKey?: string }
): Promise<void> {
  return apiFetch<void>(`/squads/ssh/${squadId}/keys`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getSshPublicKey(squadId: string, keyName: string): Promise<string> {
  return apiFetch<{ publicKey: string }>(`/squads/ssh/${squadId}/keys/${keyName}/public`).then((res) => res.publicKey)
}

export async function deleteSshKey(squadId: string, keyName: string): Promise<void> {
  return apiFetch<void>(`/squads/ssh/${squadId}/keys/${keyName}`, {
    method: 'DELETE',
  })
}

// SSH Config

export async function getSshConfig(squadId: string): Promise<{ config: string }> {
  return apiFetch<{ config: string }>(`/squads/ssh/${squadId}/config`)
}

export async function setSshConfig(squadId: string, config: string): Promise<void> {
  return apiFetch<void>(`/squads/ssh/${squadId}/config`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  })
}

export async function getKnownHosts(squadId: string): Promise<{ knownHosts: string }> {
  return apiFetch<{ knownHosts: string }>(`/squads/ssh/${squadId}/known-hosts`)
}

export async function setKnownHosts(squadId: string, knownHosts: string): Promise<void> {
  return apiFetch<void>(`/squads/ssh/${squadId}/known-hosts`, {
    method: 'PUT',
    body: JSON.stringify({ knownHosts }),
  })
}

// Workspace Environment

export interface SquadEnvSecretStatus {
  key: string
  isSet: boolean
  exposed: boolean
  globallyExposed: boolean
  updatedAt: string | null
  updatedBy: string | null
}

export async function getWorkspaceEnv(squadId: string): Promise<{ content: string; exposedSecretKeys: string[] }> {
  return apiFetch<{ content: string; exposedSecretKeys: string[] }>(`/squads/workspace/${squadId}/env`)
}

export async function setWorkspaceEnv(squadId: string, content: string): Promise<void> {
  return apiFetch<void>(`/squads/workspace/${squadId}/env`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

export async function getWorkspaceEnvSecrets(squadId: string): Promise<{ secrets: SquadEnvSecretStatus[] }> {
  return apiFetch<{ secrets: SquadEnvSecretStatus[] }>(`/squads/workspace/${squadId}/env/secrets`)
}

export async function setWorkspaceEnvSecrets(
  squadId: string,
  keys: string[]
): Promise<{ success: boolean; exposedSecretKeys: string[] }> {
  return apiFetch<{ success: boolean; exposedSecretKeys: string[] }>(`/squads/workspace/${squadId}/env/secrets`, {
    method: 'POST',
    body: JSON.stringify({ keys }),
  })
}

export async function getGlobalWorkspaceEnvSecrets(): Promise<{ globallyExposedSecretKeys: string[] }> {
  return apiFetch<{ globallyExposedSecretKeys: string[] }>('/squads/workspace/env/global-secrets')
}

export async function setGlobalWorkspaceEnvSecrets(
  keys: string[]
): Promise<{ success: boolean; globallyExposedSecretKeys: string[] }> {
  return apiFetch<{ success: boolean; globallyExposedSecretKeys: string[] }>('/squads/workspace/env/global-secrets', {
    method: 'POST',
    body: JSON.stringify({ keys }),
  })
}

// Workspace Search

export async function searchWorkspaceFiles(squadId: string, query: string): Promise<{ files: string[] }> {
  return apiFetch<{ files: string[] }>(`/squads/${squadId}/workspace/search?q=${encodeURIComponent(query)}`)
}

// Memory API

export interface MemorySyncStatus {
  enabled: boolean
  providers: Array<{
    type: 'git' | 's3'
    initialized: boolean
    lastPull: string | null
    lastPush: string | null
    error?: string
  }>
  lastPull: string | null
  lastPush: string | null
  error?: string
}

export interface MemoryConfig {
  enabled: boolean
  embeddingModel?: string
  workspacePaths?: {
    include: string[]
    exclude?: string[]
  }
  workspaceScanStatus?: {
    lastScan: string
    filesIndexed: number
    skipped: Array<{
      path: string
      reason: 'file_too_large' | 'binary' | 'max_files_exceeded' | 'unreadable'
      detail?: string
    }>
  }
  sync?: {
    providers: Array<GitSyncProvider | S3SyncProvider>
    conflictPolicy: 'manual' | 'last_write_wins'
    pushDebounceSeconds?: number
    pullIntervalMinutes?: number
  }
}

export interface GitSyncProvider {
  type: 'git'
  repoUrl: string
  branch: string
  pathPrefix?: string
  sshKeyName: string
  autoPull: boolean
  autoPush: boolean
}

export interface S3SyncProvider {
  type: 's3'
  bucket: string
  region: string
  endpoint?: string
  pathPrefix?: string
  credentialsRef: string
  autoPull: boolean
  autoPush: boolean
}

export async function getMemorySyncStatus(squadId: string): Promise<MemorySyncStatus> {
  return apiFetch<MemorySyncStatus>(`/memory/${squadId}/sync/status`)
}

export async function syncMemoryPull(
  squadId: string
): Promise<{ success: boolean; filesChanged?: number; conflicts?: string[]; error?: string }> {
  return apiFetch(`/memory/${squadId}/sync/pull`, {
    method: 'POST',
  })
}

export async function syncMemoryPush(
  squadId: string
): Promise<{ success: boolean; filesPushed?: number; error?: string }> {
  return apiFetch(`/memory/${squadId}/sync/push`, {
    method: 'POST',
  })
}

export async function reindexMemory(
  squadId: string,
  source: 'memory_file' | 'workspace_file' | 'slack_thread' | 'slack_canvas' | 'github_issue' | 'all' = 'all'
): Promise<{
  success: boolean
  filesIndexed: number
  workspaceFilesScanned: number
  workspaceFilesScanError: string | undefined
  externalSources?: Partial<
    Record<
      'slack_thread' | 'slack_canvas' | 'github_issue',
      { indexed: number; skipped: number; failed: number; disabled: boolean }
    >
  >
}> {
  return apiFetch(`/memory/${squadId}/reindex`, {
    method: 'POST',
    body: JSON.stringify({ source }),
  })
}

export function countCompletedWorkStreams(
  completedAfter: string,
  completedBefore: string
): Promise<{ totalCount: number }> {
  const params = new URLSearchParams({
    statuses: 'done',
    limit: '1',
    countOnly: 'true',
    completedAfter,
    completedBefore,
  })
  return apiFetch(`/workstreams?${params}`)
}
