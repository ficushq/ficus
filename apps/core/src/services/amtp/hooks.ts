// Ficus's DeliveryHooks implementation for amtp-engine (docs/superpowers/specs/
// 2026-07-08-amtp-engine-design.md §7.2/§7.3). All normative receive/outbox
// ordering lives in the engine; this module owns only the Ficus-specific
// presentation (senderType 'remote', deliveryMode, metadata.remote shape,
// agent wake, and the federation-bounce message) — the field ledger in §7.3.
import { eq } from 'drizzle-orm'
import type { DeliveryHooks } from 'amtp-engine'
import { db, inbox } from '../../db'
import { Agent } from '../../entities/Agent'
import { InboxAttachment } from '../../entities/InboxAttachment'
import { InboxMessage } from '../../entities/InboxMessage'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('amtp-outbox')

export const deliveryHooks: DeliveryHooks = {
  /**
   * §8 step 10 — persist the accepted message for the recipient, replacing
   * routes/amtp.ts:468-575's delivery halves. `attachments` is already pulled
   * + verified by the engine; this hook only builds Ficus's message shape,
   * persists it (+ any attachment blobs), wakes the agent best-effort, and
   * rolls back its own partial state on any failure before rethrowing.
   */
  async onMessageReceived({ envelope, peerInstanceId, senderHandle, recipientRef, agentSigVerified, attachments }) {
    const msgInput = {
      recipientType: 'agent' as const,
      recipientId: recipientRef,
      senderType: 'remote' as const,
      senderId: envelope.from,
      subject: envelope.subject,
      content: envelope.content,
      deliveryMode: 'follow-up' as const,
      metadata: {
        remote: {
          peerInstanceId,
          fromAddress: envelope.from,
          fromHandle: senderHandle,
          envelopeId: envelope.id,
          ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
          ...(envelope.agentKey ? { agentKey: envelope.agentKey } : {}),
          agentSigVerified,
        },
        sender: { name: senderHandle },
      },
    }

    if (attachments.length === 0) {
      // Text path: wake is included inside send().
      await InboxMessage.send(msgInput)
      return
    }

    // Attachment path: pull → verify already happened in the engine. Here:
    // insert (deferred wake) → link each blob → THEN wake. Roll back on any
    // failure before the wake so the caller never sees a message with
    // missing blobs, and the engine's dedup-slot release + retry can re-deliver.
    const createdAttachments: InboxAttachment[] = []
    let message: InboxMessage | undefined
    try {
      message = await InboxMessage.send({ ...msgInput, deferDelivery: true })

      for (const { ref, bytes } of attachments) {
        const att = await InboxAttachment.create({
          messageId: message.id,
          filename: ref.filename,
          contentType: ref.contentType,
          bytes,
        })
        createdAttachments.push(att)
      }

      // All blobs linked — wake the agent now. Best-effort: once the row +
      // blobs are durably persisted, a wake failure must not trigger rollback.
      try {
        const { deliverInboxMessagesToAgent } = await import('../inbox/inboxDelivery')
        await deliverInboxMessagesToAgent(message.recipientId)
      } catch {
        // Delivery (or its dynamic import) failure is non-fatal once the row + blobs exist.
      }
    } catch (err) {
      // Rollback: remove any partially-linked attachment blobs + rows.
      for (const att of createdAttachments) {
        await att.delete().catch(() => {})
      }
      // Rollback: remove the inbox row if it was created.
      if (message) {
        await db
          .delete(inbox)
          .where(eq(inbox.id, message.id))
          .catch(() => {})
      }
      throw err
    }
  },

  /**
   * §9.4 — dead-letter bounce to the local authoring agent, replacing
   * outbox-delivery.ts's `deadLetter` body (the markFailedTerminal call itself
   * is engine-owned; this hook only sends the bounce).
   */
  async onDeliveryFailed({ outboxId, envelopeId, toAddress, fromAddress, senderHandle, subject, reason, attempts }) {
    const sender = senderHandle ? await Agent.findByFederationHandle(senderHandle) : null
    if (!sender) {
      log.warn(`Outbox row ${outboxId} dead-lettered; sender ${fromAddress} not found — no bounce`)
      return
    }
    const originalSubject = subject ? `\nOriginal subject: ${subject}` : ''
    await InboxMessage.send({
      recipientType: 'agent',
      recipientId: sender.id,
      senderType: 'system',
      wakeEligible: false,
      subject: `Federation delivery failed: ${toAddress}`,
      content:
        `Your federated message to ${toAddress} could not be delivered and will not be retried.\n` +
        `Reason: ${reason}\nAttempts: ${attempts}${originalSubject}\nEnvelope id: ${envelopeId}`,
      metadata: {
        federationBounce: { outboxId, envelopeId, toAddress, reason },
      },
    })
  },
}
