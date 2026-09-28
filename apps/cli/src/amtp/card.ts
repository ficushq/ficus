import {
  canonicalAgentCardBytes,
  type AmtpAgentCard,
  type AmtpSignedAgentCard,
  type AmtpSignedAgentCardSansSig,
} from '@ficus/shared'
import { signAgentSig } from './identity'

/**
 * Assemble a fully-signed agent card (spec §4.6). Builds the card object omitting
 * absent/empty fields, then signs the exact bytes the server re-derives and verifies
 * (canonicalAgentCardBytes over {v, instanceId, handle, card} — identical shape to
 * sign.ts's buildFederatedSendBody, but for the card-signing domain).
 */
export function buildSignedCardBody(args: {
  instanceId: string
  handle: string
  name?: string
  description?: string
  extensions?: AmtpAgentCard['extensions']
  privateKeyPem: string
}): AmtpSignedAgentCard {
  const card: AmtpAgentCard = {
    ...(args.name ? { name: args.name } : {}),
    ...(args.description ? { description: args.description } : {}),
    ...(args.extensions && Object.keys(args.extensions).length > 0 ? { extensions: args.extensions } : {}),
  }
  const sansSig: AmtpSignedAgentCardSansSig = {
    v: 1,
    instanceId: args.instanceId,
    handle: args.handle,
    card,
  }
  return {
    ...sansSig,
    cardSig: signAgentSig(args.privateKeyPem, canonicalAgentCardBytes(sansSig)),
  }
}
