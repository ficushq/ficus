import { apiFetch } from './client'
import type { Monitor, MonitorLogs, MonitorStatus } from '@ficus/shared'

export interface ListMonitorsParams {
  agentId?: string
  squadId?: string
  status?: MonitorStatus[]
}

export const monitorsApi = {
  list: (params?: ListMonitorsParams): Promise<Monitor[]> => {
    const search = new URLSearchParams()
    if (params?.agentId) search.set('agentId', params.agentId)
    if (params?.squadId) search.set('squadId', params.squadId)
    if (params?.status?.length) search.set('status', params.status.join(','))
    const query = search.toString()
    return apiFetch(`/monitors${query ? `?${query}` : ''}`)
  },
  get: (id: string): Promise<Monitor> => apiFetch(`/monitors/${id}`),
  logs: (id: string, tail = 100): Promise<MonitorLogs> => apiFetch(`/monitors/${id}/logs?tail=${tail}`),
  cancel: (id: string): Promise<Monitor> => apiFetch(`/monitors/${id}/cancel`, { method: 'POST' }),
}
