import type { Attention, WorkStream, WorkStreamAssetAttachments } from '@ficus/shared'
import type { Transport } from '../transport'
import { readAll } from './workflows'

/** The caller's attention for one stream. `inherited` means the levels came from the squad row. */
export interface WorkStreamSubscription {
  subscribed: boolean
  count: number
  attention: Attention
  inherited: boolean
}

export function workStreamsResource(t: Transport) {
  const path = (id: string) => `/workstreams/${encodeURIComponent(id)}`
  return {
    setAutoCleanupWorktree: (id: string, autoCleanupWorktree: boolean) =>
      t.request<WorkStream>(path(id), { method: 'PATCH', body: { autoCleanupWorktree } }),
    pause: (id: string, options: { reason?: string; parkAfterMinutes?: number | null } = {}) =>
      t.request<WorkStream>(`${path(id)}/pause`, { method: 'POST', body: options }),
    resume: (id: string) => t.request<WorkStream>(`${path(id)}/resume`, { method: 'POST', body: {} }),
    park: (id: string) => t.request<WorkStream>(`${path(id)}/park`, { method: 'POST', body: { preemptRunning: true } }),
    getSubscription: (id: string): Promise<WorkStreamSubscription> => t.request(`${path(id)}/subscription`),
    subscribe: (id: string, attention?: Attention): Promise<WorkStreamSubscription> =>
      t.request(`${path(id)}/subscribe`, { method: 'POST', ...(attention ? { body: { attention } } : {}) }),
    unsubscribe: (id: string): Promise<WorkStreamSubscription> =>
      t.request(`${path(id)}/subscribe`, { method: 'DELETE' }),
    /** Stored chat images and files shared with the stream by ID: inputs and each attempt's results. */
    assetAttachments: (id: string) => t.request<WorkStreamAssetAttachments>(`${path(id)}/asset-attachments`),
    /** The bytes of one stored-asset attachment. Never cached by the server: removal and revocation apply at once. */
    downloadAssetAttachment: async (id: string, attachmentId: string, signal?: AbortSignal) =>
      readAll(
        await t.openStream(`${path(id)}/asset-attachments/${encodeURIComponent(attachmentId)}`, {
          method: 'GET',
          signal,
        })
      ),
  }
}
