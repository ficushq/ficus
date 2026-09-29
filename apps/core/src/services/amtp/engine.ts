// Ficus's amtp-engine wiring (§7.1): assembles the port adapters + delivery
// hooks into an AmtpEngine singleton. `fetch` is deliberately omitted from the
// options below so the engine falls back to its own late-bound
// `globalThis.fetch` resolution (§2) — this module must never capture a
// `fetch` reference itself.
import { createAmtpEngine } from 'amtp-engine'
import type { AmtpEngine, AmtpEngineOptions, AmtpEnginePorts } from 'amtp-engine'
import { createLogger } from '../../lib/infra/logger'
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

const log = createLogger('amtp-outbox')

export function buildFicusEnginePorts(): AmtpEnginePorts {
  return {
    identity: identityPort,
    peers: peerStore,
    pins: pinStore,
    replays: replayLedger,
    outbox: outboxStore,
    attachments: attachmentStore,
    handles: handleDirectory,
    policy: receivePolicy,
    delivery: deliveryHooks,
  }
}

/**
 * Builds a fresh tau-wired AmtpEngine. Exposed (rather than only exporting the
 * singleton below) so the future outbox-delivery.ts compat wrapper (§7.4) can
 * build a per-call engine with an injected signer, matching today's
 * `DrainOutboxDeps` seam.
 */
export function createFicusAmtpEngine(opts: AmtpEngineOptions = {}): AmtpEngine {
  return createAmtpEngine(buildFicusEnginePorts(), {
    logger: (level, message) => (level === 'warn' ? log.warn(message) : log.info(message)),
    overrides: {
      fetchPeerAgentKey: (args) => keyFetchImpl(args),
      pullAttachment: (args) => pullImpl({}, args),
    },
    ...opts,
  })
}

/** Process-wide engine singleton (§2: construction is cheap + side-effect-free). */
export const amtpEngine: AmtpEngine = createFicusAmtpEngine()
