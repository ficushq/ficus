import type { OAuthAuthority } from './authority'

export type OAuthAuthorizationIntent = 'connect' | 'reconnect'
export type OAuthAuthorizationPurpose = 'integration' | 'github_identity'

export interface OAuthStateRecord {
  stateHash: string
  localFlowId: string | null
  authority: OAuthAuthority
  completionHandleHash: string | null
  recoveryExpiresAt: Date | null
  providerKey: string
  userId: string
  intent: OAuthAuthorizationIntent
  /** Absent on pre-purpose in-memory adapters only; persisted rows default to integration. */
  purpose?: OAuthAuthorizationPurpose
  linkGeneration?: number | null
  connectionId: string | null
  expectedMaterialRevision: string | null
  redirectUri: string
  returnTo: string
  expiresAt: Date
  createdAt: Date
}

export type NewOAuthStateRecord = Omit<
  OAuthStateRecord,
  'createdAt' | 'localFlowId' | 'authority' | 'completionHandleHash' | 'recoveryExpiresAt'
> & {
  localFlowId?: string | null
  authority?: OAuthAuthority
  completionHandleHash?: string | null
  recoveryExpiresAt?: Date | null
}

export interface OAuthStateRepository {
  create(state: NewOAuthStateRecord): Promise<void>
  consume(input: { stateHash: string; providerKey: string; userId: string }): Promise<OAuthStateRecord | null>
  claimByFlow(input: {
    localFlowId: string
    providerKey: string
    userId: string
    authority: 'platform_broker'
    handleHash: string
  }): Promise<OAuthStateRecord | null>
  finishByFlow(input: { localFlowId: string; handleHash: string }): Promise<boolean>
  flowExists(localFlowId: string): Promise<boolean>
  burnByFlow(input: { localFlowId: string; handleHash: string }): Promise<boolean>
  deleteExpired(): Promise<number>
}
