import { db, integrationAuditEvents } from '../../db'
import type { IntegrationAuditEvent, IntegrationAuditRecorder } from './audit'

type IntegrationAuditExecutor = Pick<typeof db, 'insert'>

export async function insertIntegrationAuditEvent(
  executor: IntegrationAuditExecutor,
  event: IntegrationAuditEvent
): Promise<void> {
  await executor.insert(integrationAuditEvents).values({
    connectionId: event.connectionId,
    squadId: event.squadId,
    agentId: event.agentId,
    userId: event.userId,
    actorKey: event.actorKey,
    targetKind: event.targetKind,
    targetId: event.targetId,
    capability: event.capability,
    action: bounded(event.action),
    outcome: event.outcome,
    requestId: event.requestId,
    idempotencyKey: event.idempotencyKey,
    recordCount: event.recordCount,
    byteCount: event.byteCount,
    code: event.code ? bounded(event.code) : undefined,
    createdAt: event.at,
  })
}

export class DbIntegrationAuditRecorder implements IntegrationAuditRecorder {
  record(event: IntegrationAuditEvent): Promise<void> {
    return insertIntegrationAuditEvent(db, event)
  }
}
function bounded(value: string): string {
  return /^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(value) ? value : 'invalid_code'
}
