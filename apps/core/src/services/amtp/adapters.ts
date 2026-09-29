// Ficus host adapters for amtp-engine (docs/history/superpowers/specs/2026-07-08-amtp-engine-design.md §7.1/§7.2).
// Every adapter here is a thin, logic-free mapping from an engine port onto an
// existing Ficus entity. All normative AMTP behavior stays in amtp-engine; these
// adapters only translate shapes.
import type {
  AttachmentStore,
  HandleDirectory,
  InstanceIdentityPort,
  OutboxEntry,
  OutboxStore,
  PeerStore,
  PinStore,
  ReceiveCaps,
  ReceivePolicy,
  ReplayLedger,
} from 'amtp-engine'
import { isSenderAllowed } from '../../entities/AmtpAllowRule'
import { AmtpKnownKey } from '../../entities/AmtpKnownKey'
import { AmtpReceived } from '../../entities/AmtpReceived'
import { Agent } from '../../entities/Agent'
import { isValidFederationIdentityPublicKey } from '../../entities/agent-queries'
import { InboxAttachment } from '../../entities/InboxAttachment'
import { InstanceIdentity } from '../../entities/InstanceIdentity'
import { Outbox, type OutboxRow } from '../../entities/Outbox'
import { Peer } from '../../entities/Peer'
import { readAttachmentFile } from '../inbox/attachment-storage'
import { getSettingsStore } from '../settings'

// ---------------------------------------------------------------------------
// §4.1 InstanceIdentityPort — InstanceIdentity.getOrCreate()
// ---------------------------------------------------------------------------

export const identityPort: InstanceIdentityPort = {
  async get() {
    const identity = await InstanceIdentity.getOrCreate()
    return {
      instanceId: identity.instanceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
    }
  },
  async getSigning() {
    const identity = await InstanceIdentity.getOrCreate()
    return { instanceId: identity.instanceId, privateKeyPem: identity.privateKeyPem }
  },
}

// ---------------------------------------------------------------------------
// §4.2 PeerStore — Peer.findByInstanceId
// ---------------------------------------------------------------------------

export const peerStore: PeerStore = {
  async getPeer(instanceId) {
    const peer = await Peer.findByInstanceId(instanceId)
    if (!peer) return null
    return { baseUrl: peer.baseUrl, publicKeyPem: peer.publicKeyPem, status: peer.status }
  },
}

// ---------------------------------------------------------------------------
// §4.3 PinStore (TOFU) — AmtpKnownKey.getPin / .recordPinIfNew
// ---------------------------------------------------------------------------

export const pinStore: PinStore = {
  getPin: (peerInstanceId, handle) => AmtpKnownKey.getPin(peerInstanceId, handle),
  recordPinIfNew: (peerInstanceId, handle, publicKeyPem) =>
    AmtpKnownKey.recordPinIfNew(peerInstanceId, handle, publicKeyPem),
}

// ---------------------------------------------------------------------------
// §4.5 ReplayLedger — AmtpReceived.recordIfNew / .unrecord
// ---------------------------------------------------------------------------

export const replayLedger: ReplayLedger = {
  recordIfNew: (peerInstanceId, envelopeId) => AmtpReceived.recordIfNew(peerInstanceId, envelopeId),
  unrecord: (peerInstanceId, envelopeId) => AmtpReceived.unrecord(peerInstanceId, envelopeId),
}

// ---------------------------------------------------------------------------
// §4.6 OutboxStore — Outbox.enqueue/claimBatch/markDelivered/markRetry/
//   markFailedTerminal/hasOutboundAttachmentForPeer
// ---------------------------------------------------------------------------

function toOutboxEntry(row: OutboxRow | Outbox): OutboxEntry {
  return {
    id: row.id,
    peerInstanceId: row.peerInstanceId,
    toAddress: row.toAddress,
    envelope: row.envelopeJson,
    attempts: row.attempts,
    claimToken: row.claimToken,
  }
}

export const outboxStore: OutboxStore = {
  async enqueue(input) {
    const row = await Outbox.enqueue(input)
    return toOutboxEntry(row)
  },
  async claimBatch(limit, staleMs) {
    const rows = await Outbox.claimBatch(limit, staleMs)
    return rows.map(toOutboxEntry)
  },
  markDelivered: (id, claimToken) => Outbox.markDelivered(id, claimToken),
  markRetry: (id, claimToken, error) => Outbox.markRetry(id, claimToken, error),
  markFailedTerminal: (id, claimToken, error) => Outbox.markFailedTerminal(id, claimToken, error),
  hasOutboundAttachmentForPeer: (peerInstanceId, attachmentId) =>
    Outbox.hasOutboundAttachmentForPeer(peerInstanceId, attachmentId),
}

// ---------------------------------------------------------------------------
// §4.7 AttachmentStore — InboxAttachment.totalStorageBytes / .findById +
//   readAttachmentFile
// ---------------------------------------------------------------------------

export const attachmentStore: AttachmentStore = {
  totalStoredBytes: () => InboxAttachment.totalStorageBytes(),
  async readOutboundBlob(attachmentId) {
    // The port's contract (§4.7) requires mapping EVERY lookup failure — unknown
    // id, or blob missing/unreadable on disk — to null, never a throw. `id` is a
    // uuid-typed column, so a malformed (non-uuid) attachmentId would otherwise
    // surface as a raw Postgres error rather than "not found"; the outer
    // try/catch folds that case into the same uniform null.
    let att: InboxAttachment | null
    try {
      att = await InboxAttachment.findById(attachmentId)
    } catch {
      return null
    }
    if (!att) return null
    try {
      const buffer = await readAttachmentFile(att.storagePath)
      return { bytes: new Uint8Array(buffer), contentType: att.contentType, byteSize: att.byteSize }
    } catch {
      return null
    }
  },
}

// ---------------------------------------------------------------------------
// §4.8 HandleDirectory — Agent.findByFederationHandle / .listFederationHandles
// ---------------------------------------------------------------------------

export const handleDirectory: HandleDirectory = {
  async resolve(handle) {
    const agent = await Agent.findByFederationHandle(handle)
    if (!agent || !isValidFederationIdentityPublicKey(agent.identityPublicKey)) return null
    return {
      recipientRef: agent.id,
      inboundOpen: agent.inboundOpen,
      agentPublicKeyPem: agent.identityPublicKey,
    }
  },
  list: () => Agent.listFederationHandleRecords(),
  async getCard(handle) {
    const agent = await Agent.findByFederationHandle(handle)
    if (!agent || !isValidFederationIdentityPublicKey(agent.identityPublicKey)) return null
    return agent.cardJson ?? null
  },
}

// ---------------------------------------------------------------------------
// §4.9 ReceivePolicy — isSenderAllowed (allow-rule match) + settings caps
// ---------------------------------------------------------------------------

export const receivePolicy: ReceivePolicy = {
  isReceiveAllowed: ({ recipientRef, peerInstanceId, senderHandle }) =>
    isSenderAllowed({ targetAgentId: recipientRef, peerInstanceId, senderHandle }),
  async getReceiveCaps(): Promise<ReceiveCaps> {
    const store = getSettingsStore()
    return {
      maxAttachmentBytes: store.getTyped('INBOX_MAX_ATTACHMENT_BYTES') as number,
      maxTotalStorageBytes: store.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES') as number,
    }
  },
}
