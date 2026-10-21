import type { IntegrationCapabilityKind } from './types'

/** Deliberately content-free integration audit event. */
export interface IntegrationAuditEvent {
  connectionId?: string
  squadId?: string
  agentId?: string
  userId?: string
  /** Literal authenticated principal (e.g. `user:<id>`) for security-sensitive actions. */
  actorKey?: string
  /** Content-free target of the action (e.g. kind `managed_bigbrain_vault`, its ID). */
  targetKind?: string
  targetId?: string
  capability?: IntegrationCapabilityKind
  action: string
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed'
  requestId?: string
  idempotencyKey?: string
  recordCount?: number
  byteCount?: number
  code?: string
  at: Date
}

export interface IntegrationAuditRecorder {
  record(event: IntegrationAuditEvent): Promise<void>
}
