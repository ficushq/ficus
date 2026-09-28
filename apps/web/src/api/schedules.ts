import { apiFetch } from './client'
import type {
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScheduleScopeType,
  WebhookEnableResult,
} from '@ficus/shared'

export interface ListSchedulesParams {
  scopeType?: ScheduleScopeType
  scopeId?: string
  enabled?: boolean
  kind?: string
  excludeKind?: string
}

export const createSchedulesApi = (fetch: typeof apiFetch) => ({
  list: async (params?: ListSchedulesParams): Promise<Schedule[]> => {
    const searchParams = new URLSearchParams()
    if (params?.scopeType) searchParams.set('scopeType', params.scopeType)
    if (params?.scopeId) searchParams.set('scopeId', params.scopeId)
    if (params?.enabled !== undefined) searchParams.set('enabled', String(params.enabled))
    if (params?.kind) searchParams.set('kind', params.kind)
    if (params?.excludeKind) searchParams.set('excludeKind', params.excludeKind)
    const query = searchParams.toString()
    return fetch(`/schedules${query ? `?${query}` : ''}`)
  },

  get: async (id: string): Promise<Schedule> => {
    return fetch(`/schedules/${id}`)
  },

  create: async (input: CreateScheduleInput): Promise<Schedule> => {
    return fetch('/schedules', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  update: async (id: string, input: UpdateScheduleInput): Promise<Schedule> => {
    return fetch(`/schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },

  delete: async (id: string): Promise<void> => {
    return fetch(`/schedules/${id}`, { method: 'DELETE' })
  },

  trigger: async (id: string): Promise<{ triggered: boolean; schedule: Schedule }> => {
    return fetch(`/schedules/${id}/trigger`, { method: 'POST' })
  },

  enable: async (id: string): Promise<Schedule> => {
    return fetch(`/schedules/${id}/enable`, { method: 'POST' })
  },

  disable: async (id: string): Promise<Schedule> => {
    return fetch(`/schedules/${id}/disable`, { method: 'POST' })
  },

  // Webhook methods
  enableWebhook: async (id: string): Promise<WebhookEnableResult> => {
    return fetch(`/schedules/${id}/webhook/enable`, { method: 'POST' })
  },

  disableWebhook: async (id: string): Promise<Schedule> => {
    return fetch(`/schedules/${id}/webhook/disable`, { method: 'POST' })
  },

  regenerateWebhookToken: async (id: string): Promise<WebhookEnableResult> => {
    return fetch(`/schedules/${id}/webhook/regenerate-token`, { method: 'POST' })
  },
})

export const schedulesApi = createSchedulesApi(apiFetch)
