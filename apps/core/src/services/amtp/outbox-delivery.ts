// Compat wrapper (docs/history/superpowers/specs/2026-07-08-amtp-engine-design.md §7.4):
// all §9 outbox-drain logic now lives in amtp-engine (amtp-engine src/outbox.ts).
// This module preserves `drainOutboxOnce`'s exact signature for worker.ts and the
// frozen `outbox-delivery.test.ts` by building a per-call engine over `deps` and
// delegating to it. `deps.signer` maps HONESTLY onto `identity.getSigning` (the
// injected test signers supply exactly `{instanceId, privateKeyPem}` and are
// never asked to self-certify); `identity.get` stays the Ficus default.
import { createAmtpEngine } from 'amtp-engine'
import type { PeerStore } from 'amtp-engine'
import type { PeerResolver } from '../../entities/Peer'
import { InstanceIdentity } from '../../entities/InstanceIdentity'
import {
  attachmentStore,
  handleDirectory,
  identityPort,
  outboxStore,
  peerStore,
  pinStore,
  receivePolicy,
  replayLedger,
} from './adapters'
import { deliveryHooks } from './hooks'
import { keyFetchImpl, pullImpl } from './seams'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('amtp-outbox')

export interface DrainOutboxDeps {
  resolver?: PeerResolver
  signer?: () => Promise<{ instanceId: string; privateKeyPem: string }>
  fetchImpl?: typeof fetch
  batchSize?: number
}

export interface DrainOutboxResult {
  delivered: number
  failedTerminal: number
  retried: number
}

async function defaultSigner(): Promise<{ instanceId: string; privateKeyPem: string }> {
  const identity = await InstanceIdentity.getOrCreate()
  return { instanceId: identity.instanceId, privateKeyPem: identity.privateKeyPem }
}

function toPeerStore(resolver: PeerResolver): PeerStore {
  return { getPeer: (instanceId) => resolver.resolve(instanceId) }
}

/**
 * Claim a batch of outbox rows and attempt delivery via the engine's §9 drain
 * (amtp-engine outbox.ts:drainOutboxOnce). Builds a FRESH per-call
 * engine every invocation (construction is cheap/side-effect-free, §2) so each
 * call's injected `deps` (resolver/signer/fetchImpl/batchSize) apply exactly as
 * before — matching today's per-call `deps.resolver ?? new LocalPeerResolver()`
 * / `deps.signer ?? defaultSigner` / `deps.fetchImpl ?? fetch` defaults.
 */
export async function drainOutboxOnce(deps: DrainOutboxDeps = {}): Promise<DrainOutboxResult> {
  const peers = deps.resolver ? toPeerStore(deps.resolver) : peerStore
  const signer = deps.signer ?? defaultSigner

  const engine = createAmtpEngine(
    {
      identity: { get: identityPort.get, getSigning: signer },
      peers,
      pins: pinStore,
      replays: replayLedger,
      outbox: outboxStore,
      attachments: attachmentStore,
      handles: handleDirectory,
      policy: receivePolicy,
      delivery: deliveryHooks,
    },
    {
      fetch: deps.fetchImpl,
      logger: (level, message) => (level === 'warn' ? log.warn(message) : log.info(message)),
      overrides: {
        fetchPeerAgentKey: (args) => keyFetchImpl(args),
        pullAttachment: (args) => pullImpl({}, args),
      },
    }
  )

  return engine.drainOutboxOnce({ batchSize: deps.batchSize })
}
