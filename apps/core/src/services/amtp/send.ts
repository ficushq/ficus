// Wrapper over the engine's enqueueSend (docs/superpowers/specs/
// 2026-07-08-amtp-engine-design.md §7.4/§5.9). `routes/inbox.ts` calls this
// unchanged and uses only the returned entry's `.id`.
import { amtpEngine } from './engine'
import type { AmtpAttachmentRef } from '@ficus/shared'
import type { OutboxEntry } from 'amtp-engine'

export async function enqueueFederatedSend(args: {
  fromHandle: string
  toAddress: string
  subject?: string
  content: string
  inReplyTo?: string
  attachments?: AmtpAttachmentRef[]
  id?: string
  agentSig?: string
  agentKey?: string
}): Promise<OutboxEntry> {
  const result = await amtpEngine.enqueueSend(args)
  // Preserves send.ts:25's original error for an unparseable federation address.
  if (!result.ok) throw new Error('invalid federation address')
  return result.entry
}
