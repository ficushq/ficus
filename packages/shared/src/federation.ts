// Pure re-export: the wire-protocol code lives in amtp-protocol (the amtp-protocol npm package),
// which apps/cli also depends on directly. This file exists only so existing `@ficus/shared`
// importers keep working.
//
// Import from the specific submodules, NOT the barrel `amtp-protocol`, so the
// browser bundle (@ficus/shared is used by apps/web) never pulls in ./crypto,
// which imports node:crypto and breaks vite. address/canonical are pure.
export { parseAmtpAddress, formatAmtpAddress } from 'amtp-protocol/address'
export { canonicalAgentSigBytes, type AgentSigSubset } from 'amtp-protocol/canonical'
export { canonicalAgentCardBytes, signedCardByteSize, SIGNED_CARD_MAX_BYTES } from 'amtp-protocol/card'

export type AmtpSigningIdentityStatus = 'ready' | 'unavailable' | 'unsupported'

export type AmtpSigningIdentityReason =
  | 'missing_public_key'
  | 'invalid_public_key'
  | 'missing_private_key'
  | 'invalid_private_key'
  | 'public_private_mismatch'
  | 'shared_system_manager_custody'
  | 'shared_parent_custody'
  | 'shared_consultant_custody'

export interface AmtpSigningIdentity {
  status: AmtpSigningIdentityStatus
  reason: AmtpSigningIdentityReason | null
  message: string | null
  identityPublicKey: string | null
}

export interface AgentAmtpAllowRuleResponse {
  id: string
  targetAgentId: string
  peerInstanceId: string
  principalKind: 'any' | 'handle'
  principalValue: string | null
  createdAt: string
}

export interface AgentFederationStatusResponse {
  handle: string | null
  address: string | null
  registered: boolean
  federationReady: boolean
  inboundOpen: boolean
  allowsInbound: boolean
  signingIdentity: AmtpSigningIdentity
  allowRules: AgentAmtpAllowRuleResponse[]
  card: import('amtp-protocol/card').AmtpSignedAgentCard | null
  agentName: string | null
  agentDescription: string | null
}

export interface AgentRegisterResponse {
  handle: string
  address: string
  identityPublicKey: string
}
