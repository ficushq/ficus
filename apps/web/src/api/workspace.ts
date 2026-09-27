/**
 * Workspace API Client
 *
 * API functions for the task workspace file browser and terminal sessions.
 */

import type { LocalDeployment, SandboxPressure, SandboxProcesses, SandboxProcessSignal } from '@ficus/shared'
import { apiFetch, apiUrl, authFetch } from './client'
import { CSRF_HEADER } from '@ficus/shared/http-headers'

export type { LocalDeployment, LocalDeploymentStatus } from '@ficus/shared'

export interface TreeNode {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: TreeNode[]
}

export interface FileContent {
  path: string
  content: string
  size: number
  binary: boolean
  error?: string
}

export interface SessionInfo {
  sessionId: string
  lastActivity: number
}

/**
 * Get the directory tree for a task's workspace.
 */
export async function getWorkspaceTree(taskId: string, path = '', depth = 1): Promise<TreeNode> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  params.set('depth', String(depth))

  const queryString = params.toString()
  const url = `/tasks/${taskId}/workspace/tree${queryString ? `?${queryString}` : ''}`

  return apiFetch<TreeNode>(url)
}

/**
 * Get the contents of a file in a task's workspace.
 */
export async function getWorkspaceFile(taskId: string, path: string): Promise<FileContent> {
  const params = new URLSearchParams({ path })
  return apiFetch<FileContent>(`/tasks/${taskId}/workspace/file?${params}`)
}

/**
 * Get active terminal sessions for a task.
 */
export async function getWorkspaceSessions(taskId: string): Promise<SessionInfo[]> {
  return apiFetch<SessionInfo[]>(`/tasks/${taskId}/workspace/sessions`)
}

// --- Squad workspace API ---

/**
 * Get the directory tree for a squad's workspace.
 */
export async function getSquadWorkspaceTree(squadId: string, path = '', depth = 1): Promise<TreeNode> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  params.set('depth', String(depth))

  const queryString = params.toString()
  return apiFetch<TreeNode>(`/squads/${squadId}/workspace/tree${queryString ? `?${queryString}` : ''}`)
}

/**
 * Get the contents of a file in a squad's workspace.
 */
export async function getSquadWorkspaceFile(squadId: string, path: string): Promise<FileContent> {
  const params = new URLSearchParams({ path })
  return apiFetch<FileContent>(`/squads/${squadId}/workspace/file?${params}`)
}

/**
 * Get active terminal sessions for a squad.
 */
export async function getSquadWorkspaceSessions(squadId: string): Promise<SessionInfo[]> {
  return apiFetch<SessionInfo[]>(`/squads/${squadId}/workspace/sessions`)
}

/**
 * Get the directory tree for a squad's memory vault.
 */
export async function getSquadMemoryTree(
  squadId: string,
  path = '/memory',
  depth = 1,
  fetch: typeof apiFetch = apiFetch
): Promise<TreeNode> {
  const params = new URLSearchParams()
  params.set('path', path)
  params.set('depth', String(depth))
  return fetch<TreeNode>(`/squads/${squadId}/memory/tree?${params}`)
}

/**
 * Get the contents of a file in a squad's memory vault.
 */
export async function getSquadMemoryFile(
  squadId: string,
  path: string,
  fetch: typeof apiFetch = apiFetch
): Promise<FileContent> {
  const params = new URLSearchParams({ path })
  return fetch<FileContent>(`/squads/${squadId}/memory/file?${params}`)
}

/**
 * Kill a terminal session.
 */
export async function killWorkspaceSession(taskId: string, sessionId: string): Promise<void> {
  await apiFetch(`/tasks/${taskId}/workspace/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

/**
 * Sandbox pod status response.
 */
/**
 * Chain-health breakdown for a VM-mode sandbox: which link in
 * machine → box provisioned → box server is up, backing the VM chain-health
 * status display. Sourced server-side from data core already tracks (machine
 * health rows, the box's DB row, its live /healthz probe) — never a new probe.
 * A fact reads 'unknown' when it genuinely isn't available at that point in
 * the chain (e.g. a parked box's server is never probed).
 */
export interface SandboxChainHealth {
  boxProvisioned: boolean
  machine: 'reachable' | 'unreachable' | 'unknown'
  /**
   * 'idle' = a socket-activated box whose server has stood down but whose
   * socket is listening: reachable, and deliberately NOT probed (a probe would
   * wake it). Treated as healthy — the coarse `status` is 'running'.
   */
  boxServer: 'up' | 'down' | 'idle' | 'unknown'
}

export interface SandboxStatus {
  status: 'not_found' | 'pending' | 'starting' | 'running' | 'succeeded' | 'failed' | 'terminating' | 'unknown'
  phase?: string
  reason?: string
  containerReady?: boolean
  startedAt?: string
  devboxReady?: boolean
  readiness?: 'pending' | 'reconciling' | 'ready' | 'ready_degraded'
  degradation?: {
    reasons: Array<
      | 'devbox_unavailable'
      | 'bashrc_unavailable'
      | 'git_credentials_unavailable'
      | 'transport_recovery_failed'
      | 'callback_transport_degraded'
      | 'command_outcome_ambiguous'
    >
    attemptCount: number
    nextAttemptAt?: string
  }
  /**
   * Set on the per-agent status endpoint: true when the sandbox is this agent's
   * own box (so it may be stopped/restarted individually), false when it is a
   * shared box (squad/system-manager/consultant). Absent on the squad endpoint.
   */
  controllable?: boolean
  /**
   * Server-driven runtime this sandbox is running under (FICUS_SANDBOX_RUNTIME)
   * — never inferred client-side. Docker/k8s keep the classic Start/Stop
   * controls; VM mode replaces them with the chain-health status (see
   * {@link SandboxChainHealth}) since Stop is not a meaningful goal state there
   * (the box account persists and lazily restarts on next use).
   */
  runtime?: 'docker' | 'k8s' | 'vm' | 'host'
  /**
   * Host runtime only: the fully resolved workspace directory the squad's
   * agents, terminal and file routes are using right now — the path the last
   * sandbox ensure actually applied, falling back to the resolved path when no
   * ensure has run yet.
   */
  workspacePath?: string
  /**
   * Host runtime only: true when {@link workspacePath} is the path a sandbox
   * ensure really applied, false when it is the yet-to-be-applied resolution of
   * the current override.
   */
  workspacePathApplied?: boolean
  toolchain?: {
    status: 'pending' | 'installing' | 'running_setup' | 'ready' | 'failed'
    desiredFingerprint: string
    appliedFingerprint?: string
    errorCode?: string
    exitCode?: number
    reason?: string
    updatedAt?: string
  }
  /** VM runtime only — see {@link SandboxChainHealth}. */
  chain?: SandboxChainHealth
  /** Load and memory from the sandbox's last health check (VM runtime). */
  pressure?: SandboxPressure
}

/**
 * Get live sandbox pod status for a squad.
 */
export async function getSandboxStatus(squadId: string): Promise<SandboxStatus> {
  return apiFetch<SandboxStatus>(`/squads/${squadId}/sandbox/status`)
}

/**
 * Start the sandbox pod for a squad.
 */
export async function startSandbox(squadId: string): Promise<void> {
  await apiFetch(`/squads/${squadId}/sandbox/start`, { method: 'POST' })
}

/**
 * Stop the sandbox pod for a squad.
 */
export async function stopSandbox(squadId: string): Promise<void> {
  await apiFetch(`/squads/${squadId}/sandbox/stop`, { method: 'POST' })
}

/** What the squad's sandbox is running (samples CPU for about a second). */
export async function getSandboxProcesses(squadId: string): Promise<SandboxProcesses> {
  return apiFetch<SandboxProcesses>(`/squads/${squadId}/sandbox/processes`)
}

export async function signalSandboxProcess(squadId: string, pid: number, signal: SandboxProcessSignal): Promise<void> {
  await apiFetch(`/squads/${squadId}/sandbox/processes/${pid}/signal`, {
    method: 'POST',
    body: JSON.stringify({ signal }),
  })
}

export async function stopSandboxContainer(squadId: string, containerId: string): Promise<void> {
  await apiFetch(`/squads/${squadId}/sandbox/containers/${encodeURIComponent(containerId)}/stop`, { method: 'POST' })
}

export async function applySquadToolchain(squadId: string): Promise<void> {
  await apiFetch(`/squads/${squadId}/toolchain/apply`, { method: 'POST' })
}

export interface AppDeployment {
  id: string
  squadId: string
  name: string
  provider: string
  externalProjectId?: string | null
  url?: string | null
  providerProjectUrl?: string | null
  environment: string
  status: string
  costRisk: string
  logsCommand?: string | null
  rollbackCommand?: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
}

export async function listAppDeployments(squadId: string): Promise<AppDeployment[]> {
  return apiFetch<AppDeployment[]>(`/squads/${squadId}/deployments?includeArchived=true`)
}

export async function archiveAppDeployment(deploymentId: string): Promise<AppDeployment> {
  return apiFetch<AppDeployment>(`/deployments/${deploymentId}`, { method: 'DELETE' })
}

export async function listLocalDeployments(squadId: string): Promise<LocalDeployment[]> {
  return apiFetch<LocalDeployment[]>(`/squads/${squadId}/local-deployments?includeArchived=true`)
}

export async function stopLocalDeployment(localDeploymentId: string): Promise<void> {
  await apiFetch(`/local-deployments/${localDeploymentId}/stop`, { method: 'POST' })
}

export async function restartLocalDeployment(localDeploymentId: string): Promise<LocalDeployment> {
  return apiFetch<LocalDeployment>(`/local-deployments/${localDeploymentId}/restart`, { method: 'POST' })
}

export async function archiveLocalDeployment(localDeploymentId: string): Promise<LocalDeployment> {
  return apiFetch<LocalDeployment>(`/local-deployments/${localDeploymentId}`, { method: 'DELETE' })
}

export async function getLocalDeploymentLogs(
  localDeploymentId: string,
  tail = 200
): Promise<{ localDeploymentId: string; lines: string[] }> {
  return apiFetch<{ localDeploymentId: string; lines: string[] }>(
    `/local-deployments/${localDeploymentId}/logs?tail=${tail}`
  )
}

export function subscribeToLocalDeploymentLogs(
  localDeploymentId: string,
  callbacks: { onLines: (lines: string[]) => void; onDone?: () => void; onError?: (error: Error) => void },
  tail = 200
): () => void {
  const controller = new AbortController()

  async function connect(): Promise<void> {
    try {
      const response = await authFetch(`/local-deployments/${localDeploymentId}/logs/stream?tail=${tail}`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`Log stream failed: ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const rows = buffer.split('\n')
        buffer = rows.pop() || ''
        for (const row of rows) {
          if (row.startsWith('event: ')) currentEvent = row.slice(7)
          else if (row.startsWith('data: ') && currentEvent === 'lines') {
            const payload = JSON.parse(row.slice(6)) as { lines: string[] }
            callbacks.onLines(payload.lines)
          }
        }
      }
      callbacks.onDone?.()
    } catch (err) {
      if (!controller.signal.aborted) callbacks.onError?.(err as Error)
    }
  }

  connect()
  return () => controller.abort()
}

/**
 * Get active terminal sessions for a sandbox.
 */
export async function getTerminalSessions(sandboxId: string): Promise<SessionInfo[]> {
  return apiFetch<SessionInfo[]>(`/terminal/sessions?sandboxId=${encodeURIComponent(sandboxId)}`)
}

/**
 * Kill a terminal session by session ID.
 */
export async function killTerminalSession(sessionId: string): Promise<void> {
  await apiFetch(`/terminal/sessions/${sessionId}`, { method: 'DELETE' })
}

/**
 * Download a file from a task's workspace.
 * Returns a URL that can be used for download.
 */
export function getWorkspaceDownloadUrl(taskId: string, path: string): string {
  const params = new URLSearchParams({ path })
  return `/tasks/${taskId}/workspace/download?${params}`
}

/**
 * Download a file from a squad's workspace.
 * Returns a URL that can be used for download.
 */
export function getSquadWorkspaceDownloadUrl(squadId: string, path: string): string {
  const params = new URLSearchParams({ path })
  return `/squads/${squadId}/workspace/download?${params}`
}

/**
 * Download a file from a squad's memory vault.
 * Returns a URL that can be used for download.
 */
export function getSquadMemoryDownloadUrl(squadId: string, path: string): string {
  const params = new URLSearchParams({ path })
  return `/squads/${squadId}/memory/download?${params}`
}

export interface UploadResult {
  path: string
  status: 'created' | 'overwritten' | 'skipped' | 'error'
  error?: string
}

export interface UploadResponse {
  uploaded: number
  results: UploadResult[]
}

export interface UploadOptions {
  targetDir?: string
  overwrite?: boolean
  signal?: AbortSignal
  onProgress?: (progress: number) => void // 0-100
}

/**
 * Upload files with progress tracking using XMLHttpRequest.
 */
function uploadWithProgress(
  url: string,
  files: { file: File; relativePath: string }[],
  options: UploadOptions = {}
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const formData = new FormData()
    files.forEach(({ file, relativePath }, index) => {
      const key = `file_${index}`
      formData.append(key, file)
      formData.append(`path_${key}`, relativePath)
    })

    const xhr = new XMLHttpRequest()

    // Handle abort signal
    if (options.signal) {
      options.signal.addEventListener('abort', () => xhr.abort())
    }

    // Progress tracking
    if (options.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100)
          options.onProgress!(progress)
        }
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid response'))
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText)
          reject(new Error(error.error || `Upload failed: ${xhr.status} ${xhr.statusText}`))
        } catch {
          reject(new Error(`Upload failed: ${xhr.status} ${xhr.statusText}`))
        }
      }
    }

    xhr.onerror = () => reject(new Error('Network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))

    // Build URL with query params
    const params = new URLSearchParams()
    if (options.targetDir) params.set('dir', options.targetDir)
    if (options.overwrite) params.set('overwrite', 'true')
    const query = params.toString() ? `?${params}` : ''

    xhr.open('POST', apiUrl(`${url}${query}`))
    xhr.withCredentials = true // send the HttpOnly session cookie cross-origin
    xhr.setRequestHeader(CSRF_HEADER, '1')

    xhr.send(formData)
  })
}

/**
 * Upload files to a task's workspace.
 */
export function uploadToWorkspace(
  taskId: string,
  files: { file: File; relativePath: string }[],
  options: UploadOptions = {}
): Promise<UploadResponse> {
  return uploadWithProgress(`/tasks/${taskId}/workspace/upload`, files, options)
}

/**
 * Upload files to a squad's workspace.
 */
export function uploadToSquadWorkspace(
  squadId: string,
  files: { file: File; relativePath: string }[],
  options: UploadOptions = {}
): Promise<UploadResponse> {
  return uploadWithProgress(`/squads/${squadId}/workspace/upload`, files, options)
}
