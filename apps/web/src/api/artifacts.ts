import type {
  ArtifactManifest,
  ArtifactPublishRecord,
  ArtifactQuestion,
  ArtifactReference,
  ArtifactRequest,
  ArtifactRequestAction,
} from '@ficus/shared'
import { apiFetch } from './client'

export interface ArtifactIndexItem {
  agentId: string
  artifactId: string
  title: string
  summary?: string
  status: 'working' | 'ready' | 'error'
  entry?: {
    type: 'presentation' | 'markdown' | 'html' | 'sandbox_app'
    path: string
  }
  updatedAt: string
}

export interface ListArtifactsParams {
  query?: string
  includeArchived?: boolean
}

export interface ArtifactContext {
  agentId: string
  artifactId: string
  manifest: ArtifactManifest
  history: {
    requests: ArtifactRequest[]
    questions: ArtifactQuestion[]
    publishes: ArtifactPublishRecord[]
  }
  content?: unknown
}

export interface ArtifactRequestInput {
  action: ArtifactRequestAction
  title?: string
  agentId?: string
  artifactId?: string
  brief: string
  references?: ArtifactReference[]
  displayModeHint?: string
  answers?: Array<{ questionId: string; answer: string }>
}

export interface ArtifactRequestResult {
  action: ArtifactRequestAction
  agentId: string
  artifactId: string
  manifest?: ArtifactManifest
  deleted?: boolean
  inboxDeliveryFailed?: boolean
  message?: string
}

export interface ArtifactFileListItem {
  path: string
  type: 'file' | 'directory'
  sizeBytes?: number
}

export interface ArtifactFileReadParams {
  unit?: 'lines' | 'bytes'
  offset?: number
  limit?: number
}

export interface ArtifactFileReadResult {
  path: string
  content: string
  unit: 'lines' | 'bytes'
  offset: number
  limit: number
  sizeBytes: number
  totalLines?: number
  truncated: boolean
  nextOffset?: number
  entryPath?: string
  artifactType?: string
}

export interface ArtifactFileTextEdit {
  oldText: string
  newText: string
}

export interface ArtifactFileEditInput {
  path: string
  oldText?: string
  newText?: string
  edits?: ArtifactFileTextEdit[]
  changeSummary: string
}

export interface ArtifactFileEditResult {
  ok: true
  changed: boolean
  editsApplied: number
  manifest: ArtifactManifest
}

export async function listArtifacts(params: ListArtifactsParams = {}): Promise<ArtifactIndexItem[]> {
  const query = new URLSearchParams()
  if (params.query) query.set('query', params.query)
  if (params.includeArchived) query.set('includeArchived', 'true')
  const suffix = query.toString()
  return apiFetch<ArtifactIndexItem[]>(`/artifacts${suffix ? `?${suffix}` : ''}`)
}

export async function getArtifactContext(agentId: string, artifactId: string): Promise<ArtifactContext> {
  return apiFetch<ArtifactContext>(
    `/artifacts/${encodeURIComponent(agentId)}/${encodeURIComponent(artifactId)}/context`
  )
}

export interface ArtifactPrewarmResult {
  agentId: string
  sandboxId: string
  reused: boolean
}

export async function listArtifactFiles(
  agentId: string,
  artifactId: string
): Promise<{ files: ArtifactFileListItem[] }> {
  return apiFetch<{ files: ArtifactFileListItem[] }>(
    `/artifacts/${encodeURIComponent(agentId)}/${encodeURIComponent(artifactId)}/files`
  )
}

export async function readArtifactFile(
  agentId: string,
  artifactId: string,
  path: string,
  params: ArtifactFileReadParams = {}
): Promise<ArtifactFileReadResult> {
  const query = new URLSearchParams({ path })
  if (params.unit) query.set('unit', params.unit)
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  return apiFetch<ArtifactFileReadResult>(
    `/artifacts/${encodeURIComponent(agentId)}/${encodeURIComponent(artifactId)}/file?${query.toString()}`
  )
}

export async function editArtifactFile(
  agentId: string,
  artifactId: string,
  input: ArtifactFileEditInput
): Promise<ArtifactFileEditResult> {
  return apiFetch<ArtifactFileEditResult>(
    `/artifacts/${encodeURIComponent(agentId)}/${encodeURIComponent(artifactId)}/file`,
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    }
  )
}

export async function requestArtifact(input: ArtifactRequestInput): Promise<ArtifactRequestResult> {
  return apiFetch<ArtifactRequestResult>('/artifacts/request', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function prewarmArtifactBuilder(): Promise<ArtifactPrewarmResult> {
  return apiFetch<ArtifactPrewarmResult>('/artifacts/prewarm', { method: 'POST' })
}
