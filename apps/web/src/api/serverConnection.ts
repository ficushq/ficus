import { apiFetch } from './client'

export interface ServerConnection {
  managed: boolean
  connected: boolean
  configured: boolean
  baseUrl: string
  manageUrl: string
  origin: string | null
  setupError?: string
  error?: string
  status?: {
    instanceId: string
    name: string
    origin: string
    instancePro: boolean
    allowance: number | null
    used: number
    registered: number
  }
  /**
   * What this server recorded when its Ficus account was connected (admin-only).
   * Null for connections made before Core kept a record.
   */
  connection?: {
    connectedAt: string
    /** The local person who connected it. */
    connectedBy?: string
    /** The Ficus account that approved it, when Cloud reported one. */
    accountEmail?: string
  } | null
}
export interface ServerConnectionRequest {
  id: string
  approvalUrl: string
  expiresIn: number
}
/**
 * Member-readable relay availability (GET /push/relay-config), the same answer
 * the mobile app reads. `delivery: 'direct'` marks Ficus Cloud's own delivery.
 */
export interface RelayAvailability {
  enabled: boolean
  instanceId?: string
  delivery?: 'direct'
  liveActivities?: boolean
  /** The server's configured public address (APP_URL), when set. */
  serverUrl?: string | null
}
export const getRelayAvailability = () => apiFetch<RelayAvailability>('/push/relay-config')
export const getServerConnection = () => apiFetch<ServerConnection>('/push/server-connection')
export const startServerConnection = (name: string) =>
  apiFetch<ServerConnectionRequest>('/push/server-connection', { method: 'POST', body: JSON.stringify({ name }) })
export const pollServerConnection = (id: string, signal?: AbortSignal) =>
  apiFetch<{ status: 'pending' | 'denied' | 'connected' }>('/push/server-connection/poll', {
    method: 'POST',
    body: JSON.stringify({ id }),
    signal,
  })
export const disconnectServerConnection = () =>
  apiFetch<{ disconnected: true }>('/push/server-connection', { method: 'DELETE' })
