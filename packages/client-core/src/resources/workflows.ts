import type { Transport } from '../transport'
import type {
  CreateWorkStreamInput,
  WorkStream,
  WorkflowCommand,
  WorkflowDefinition,
  WorkflowPreset,
  WorkflowRun,
  WorkflowOutcomeBinding,
  WorkflowAttemptAttachment,
  WorkflowUsage,
  WorkflowSource,
  WorkStreamWait,
  IntegrationOutputDescriptor,
  IntegrationDeliveryView,
} from '@ficus/shared'

export interface WorkflowCatalogEntry extends WorkflowPreset {
  revision: string
  disabled: boolean
  hasTemplate: boolean
}
export interface WorkflowRunDetail {
  workStreamId: string
  source: unknown
  state: WorkflowRun
  version: number
  attemptAgents: Record<string, string>
  activeOutcomes?: WorkflowOutcomeBinding[]
  openWaits?: WorkStreamWait[]
  integrationDeliveries?: IntegrationDeliveryView[]
  usage?: WorkflowUsage
  /** Files each attempt handed off, keyed by attempt id (absent on servers without attachments). */
  attachments?: Record<string, WorkflowAttemptAttachment[]>
}

/** Read a whole response body; the transport's stream reader is the one binary seam both hosts implement. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
export function workflowsResource(t: Transport) {
  const runPath = (id: string) => `/workflows/runs/${encodeURIComponent(id)}`
  return {
    assignReviewers: (id: string, assignedReviewerIds: string[]) =>
      t.request<WorkStream>(`/workstreams/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { assignedReviewerIds },
      }),
    reviewers: (squadId: string) =>
      t.request<Array<{ id: string; name: string }>>(`/workflows/reviewers?squadId=${encodeURIComponent(squadId)}`),
    outputs: () => t.request<IntegrationOutputDescriptor[]>('/integrations/outputs'),
    list: () => t.request<WorkflowCatalogEntry[]>('/workflows'),
    /** `integrationDeliveries: false` skips the delivery history (the field is then omitted). */
    run: (id: string, options: { integrationDeliveries?: boolean } = {}) =>
      t.request<WorkflowRunDetail | null>(
        options.integrationDeliveries === false ? `${runPath(id)}?integrationDeliveries=0` : runPath(id)
      ),
    /** The bytes of a file an attempt handed off (see `WorkflowRunDetail.attachments`). */
    downloadAttachment: async (id: string, attachmentId: string, signal?: AbortSignal) =>
      readAll(
        await t.openStream(`${runPath(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'GET', signal })
      ),
    create: (preset: WorkflowPreset) => t.request<WorkflowCatalogEntry>('/workflows', { method: 'POST', body: preset }),
    update: (id: string, revision: string, preset: WorkflowPreset) =>
      t.request<WorkflowCatalogEntry>(`/workflows/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { revision, preset },
      }),
    setDisabled: (id: string, revision: string, disabled: boolean) =>
      t.request<WorkflowCatalogEntry>(`/workflows/${encodeURIComponent(id)}/disabled`, {
        method: 'POST',
        body: { revision, disabled },
      }),
    delete: (id: string, revision: string) =>
      t.request<{ ok: true }>(`/workflows/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision } }),
    parse: (squadId: string, text: string) =>
      t.request<WorkflowDefinition>('/workflows/parse', { method: 'POST', body: { squadId, text } }),
    resolve: (squadId: string, source: WorkflowSource) =>
      t.request<{ definition: WorkflowDefinition }>('/workflows/resolve', {
        method: 'POST',
        body: { squadId, source },
      }),
    advance: (id: string, command: WorkflowCommand, requestId: string) =>
      t.request<{
        version: number
        stateStatus: WorkflowRun['status']
        activeAttemptId: number | null
        outcomeUpdates?: WorkflowOutcomeBinding[]
      }>(`${runPath(id)}/advance`, { method: 'POST', body: { command, requestId } }),
    finish: (id: string, version: number) =>
      t.request<WorkStream>(`${runPath(id)}/finish`, { method: 'POST', body: { version } }),
    createStream: (input: CreateWorkStreamInput) =>
      t.request<WorkStream>('/workstreams', { method: 'POST', body: input }),
  }
}
