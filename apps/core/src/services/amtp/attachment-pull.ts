// Thin delegate to the engine's default attachment-pull implementation
// (docs/history/superpowers/specs/2026-07-08-amtp-engine-design.md §7.4/§9.9). The
// frozen route-level suite imports `pullAttachment` directly (dynamic-import
// seam resets in routes/amtp.inbox-attachments.test.ts), so this module is
// KEPT rather than deleted — but it now contains no logic of its own: all
// normative behavior (per-item cap check, URL/signing, verify) lives in
// `createDefaultAttachmentPull` (amtp-engine src/attachment-pull.ts).
// `getCaps` reads tau's settings store PER CALL (unlike the engine's internal
// once-per-receive snapshot), preserving today's per-pull settings read here.
import { createDefaultAttachmentPull } from 'amtp-engine'
import type { ReceiveCaps } from 'amtp-engine'
import type { AmtpAttachmentRef } from '@ficus/shared'
import { InstanceIdentity } from '../../entities/InstanceIdentity'
import { getSettingsStore } from '../settings/store'

export interface PullDeps {
  signer?: () => Promise<{ instanceId: string; privateKeyPem: string }>
  fetchImpl?: typeof fetch
}

async function defaultSigner(): Promise<{ instanceId: string; privateKeyPem: string }> {
  const identity = await InstanceIdentity.getOrCreate()
  return { instanceId: identity.instanceId, privateKeyPem: identity.privateKeyPem }
}

async function tauReceiveCaps(): Promise<ReceiveCaps> {
  const store = getSettingsStore()
  return {
    maxAttachmentBytes: store.getTyped('INBOX_MAX_ATTACHMENT_BYTES') as number,
    maxTotalStorageBytes: store.getTyped('INBOX_MAX_TOTAL_STORAGE_BYTES') as number,
  }
}

export function pullAttachment(
  deps: PullDeps,
  args: { peerBaseUrl: string; ref: AmtpAttachmentRef }
): Promise<Uint8Array> {
  return createDefaultAttachmentPull({
    signing: deps.signer ?? defaultSigner,
    getCaps: tauReceiveCaps,
    fetch: deps.fetchImpl,
  })(args)
}
