import { createHash } from 'crypto'

export class ChatIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different payload')
    this.name = 'ChatIdempotencyConflictError'
  }
}

export interface ConsultantAgentIdInput {
  actorUserId: string
  squadId: string
  clientId: string
}

/**
 * Derive the consultant identity used by a durable create-chat attempt.
 * Payload fields are deliberately excluded; the chat receipt detects conflicts.
 */
export function consultantAgentId(input: ConsultantAgentIdInput): string {
  const bytes = createHash('sha256')
    .update(`ficus:consultant-chat:v1\0${input.actorUserId}\0${input.squadId}\0${input.clientId}`, 'utf8')
    .digest()
    .subarray(0, 16)

  // Use UUIDv5's deterministic version marker and the RFC 4122 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
