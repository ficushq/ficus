import type { Monitor, MonitorLogs, MonitorStatus } from '@ficus/shared'
import type { Transport } from '../transport'

export interface ListMonitorsParams {
  agentId?: string
  squadId?: string
  status?: MonitorStatus[]
}

/** Agent-owned background monitors. Reads require `monitors:read`; cancel requires `monitors:write`. */
export function monitorsResource(t: Transport) {
  const path = (id: string) => `/monitors/${encodeURIComponent(id)}`
  return {
    /** Statuses are sent comma-joined (e.g. `status=starting,running,canceling`). */
    list: (params?: ListMonitorsParams, signal?: AbortSignal) => {
      const search = new URLSearchParams()
      if (params?.agentId) search.set('agentId', params.agentId)
      if (params?.squadId) search.set('squadId', params.squadId)
      if (params?.status?.length) search.set('status', params.status.join(','))
      const query = search.toString()
      return t.request<Monitor[]>(`/monitors${query ? `?${query}` : ''}`, { signal })
    },
    get: (id: string, signal?: AbortSignal) => t.request<Monitor>(path(id), { signal }),
    logs: (id: string, tail = 100, signal?: AbortSignal) =>
      t.request<MonitorLogs>(`${path(id)}/logs?tail=${tail}`, { signal }),
    cancel: (id: string) => t.request<Monitor>(`${path(id)}/cancel`, { method: 'POST' }),
  }
}
