export type ProjectionStatus = 'pending' | 'installing' | 'ready' | 'degraded'

export interface IntegrationProjectionState {
  squadId: string
  providerKey: string
  generation: bigint
  status: ProjectionStatus
  desiredFingerprint: string | null
  appliedFingerprint: string | null
  desiredCredentialRevision: bigint | null
  appliedCredentialRevision: bigint | null
  attempts: number
  nextAttemptAt: Date
  leaseToken: string | null
  leaseExpiresAt: Date | null
  lastErrorCode: string | null
}

export interface ClaimedIntegrationProjection extends IntegrationProjectionState {
  leaseToken: string
  leaseExpiresAt: Date
}

export interface IntegrationProjectionStateRepository {
  invalidate(input: {
    squadId: string
    providerKey: string
    credentialRevision?: bigint | null
    desiredFingerprint?: string | null
    now: Date
  }): Promise<IntegrationProjectionState>
  claim(now: Date, leaseExpiresAt: Date, leaseToken: string): Promise<ClaimedIntegrationProjection | null>
  /** Extend a claim that is still held; false once the claim was superseded or its generation changed. */
  renew(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    leaseExpiresAt: Date
    now: Date
  }): Promise<boolean>
  complete(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    fingerprint: string
    credentialRevision: bigint | null
    now: Date
  }): Promise<boolean>
  fail(input: {
    squadId: string
    providerKey: string
    generation: bigint
    leaseToken: string
    code: string
    nextAttemptAt: Date
    now: Date
  }): Promise<boolean>
  get(squadId: string, providerKey: string): Promise<IntegrationProjectionState | null>
  listReady(
    limit?: number,
    after?: { squadId: string; providerKey: string } | null
  ): Promise<readonly IntegrationProjectionState[]>
}
