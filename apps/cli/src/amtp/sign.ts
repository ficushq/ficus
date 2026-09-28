import { randomUUID } from 'crypto'
import { canonicalAgentSigBytes } from '@ficus/shared'
import { deriveAgentKeyPem, signAgentSig } from './identity'

export interface FederatedAttachmentRef {
  id: string
  filename: string
  contentType: string
  byteSize: number
  sha256: string
}

export interface FederatedSendBody {
  recipientType: 'agent'
  recipientId: string
  subject?: string
  content: string
  id: string
  agentKey: string
  agentSig: string
  attachmentIds?: string[]
  inReplyToEnvelopeId?: string
}

/**
 * Assemble the signed POST /api/inbox body for a federated send. The CLI generates the
 * envelope id (the server's idempotency/dedup key), canonicalizes the subset in @ficus/shared
 * (identical to the server's verification), signs it, and attaches the derived SPKI agentKey.
 * The canonical subset excludes attachment ids, ts, and inReplyTo (D4) — only the four
 * attachment digest fields are bound.
 */
export function buildFederatedSendBody(args: {
  from: string
  to: string
  subject?: string
  content: string
  attachments: FederatedAttachmentRef[]
  inReplyToEnvelopeId?: string
  privateKeyPem: string
}): FederatedSendBody {
  const id = randomUUID()
  const bytes = canonicalAgentSigBytes({
    v: 1,
    id,
    from: args.from,
    to: args.to,
    subject: args.subject,
    content: args.content,
    attachments: args.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      byteSize: a.byteSize,
      sha256: a.sha256,
    })),
  })
  return {
    recipientType: 'agent',
    recipientId: args.to,
    ...(args.subject ? { subject: args.subject } : {}),
    content: args.content,
    id,
    agentKey: deriveAgentKeyPem(args.privateKeyPem),
    agentSig: signAgentSig(args.privateKeyPem, bytes),
    ...(args.attachments.length > 0 ? { attachmentIds: args.attachments.map((a) => a.id) } : {}),
    ...(args.inReplyToEnvelopeId ? { inReplyToEnvelopeId: args.inReplyToEnvelopeId } : {}),
  }
}
