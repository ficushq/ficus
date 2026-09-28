import type { EventMap } from '@ficus/shared'

type EventMessage = {
  id: string
  agentId: string
  metadata?: unknown
}

/** Builds a message event exclusively from the row's persisted identity. */
export function messageEventData(message: EventMessage): EventMap['message.created'] {
  const metadata = isRecord(message.metadata) ? message.metadata : undefined
  const executionId = nonEmptyString(metadata?.executionId)
  const streamGroupId = nonEmptyString(metadata?.streamGroupId)

  return {
    messageId: message.id,
    agentId: message.agentId,
    ...(executionId ? { executionId } : {}),
    ...(streamGroupId ? { streamGroupId } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
