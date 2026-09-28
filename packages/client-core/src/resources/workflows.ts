import type { Transport } from '../transport'
import type {
  CreateWorkStreamInput,
  WorkStream,
  WorkflowCommand,
  WorkflowDefinition,
  WorkflowPreset,
  WorkflowRun,
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
  openWaits?: WorkStreamWait[]
  integrationDeliveries?: IntegrationDeliveryView[]
  usage?: WorkflowUsage
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
    run: (id: string) => t.request<WorkflowRunDetail | null>(runPath(id)),
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
      t.request<{ version: number; stateStatus: WorkflowRun['status']; activeAttemptId: number | null }>(
        `${runPath(id)}/advance`,
        { method: 'POST', body: { command, requestId } }
      ),
    finish: (id: string, version: number) =>
      t.request<WorkStream>(`${runPath(id)}/finish`, { method: 'POST', body: { version } }),
    createStream: (input: CreateWorkStreamInput) =>
      t.request<WorkStream>('/workstreams', { method: 'POST', body: input }),
  }
}
