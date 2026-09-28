import type { Attention, WorkStream } from '@ficus/shared'
import type { Transport } from '../transport'

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
  }
}
