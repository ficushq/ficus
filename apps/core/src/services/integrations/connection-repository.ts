import type { IntegrationProvider, ProviderValidation } from './types'
import type { OAuthAuthority } from './authorization/authority'

export type ConnectionAuthState = 'pending' | 'authenticated' | 'invalid' | 'reauthorization_required'
export type ConnectionHealthState = 'unknown' | 'healthy' | 'degraded' | 'unreachable'

/** Persisted provider material. Connections belong to the instance-global pool. */
export interface IntegrationConnectionRecord<C = unknown> {
  id: string
  providerKey: string
  adapterVersion: number
  clientAuthority: OAuthAuthority
  authorizationFlowId: string | null
  displayName: string
  configuration: C
  credentialRef: string
  materialRevision: string
  validatedRevision: string | null
  enabled: boolean
  authState: ConnectionAuthState
  healthState: ConnectionHealthState
  grantedScopes: readonly string[]
  validatedAt: Date | null
  validationExpiresAt: Date | null
  lastErrorCode: string | null
  updatedAt: Date
}

/** A global connection resolved in a squad assignment context for runtime use. */
export interface AssignedIntegrationConnectionRecord<C = unknown> extends IntegrationConnectionRecord<C> {
  squadId: string
}

export interface IntegrationConnectionSummary {
  id: string
  providerKey: string
  displayName: string
  enabled: boolean
  healthState: ConnectionHealthState
}

export interface IntegrationConnectionUsage {
  squadCount: number
  squads: readonly { id: string; name: string }[]
}

export interface CreatePendingConnection<C> {
  id: string
  providerKey: string
  adapterVersion: number
  clientAuthority?: OAuthAuthority
  authorizationFlowId?: string
  displayName: string
  configuration: C
  credentialRef: string
  materialRevision: string
  createdByUserId?: string
  updatedByUserId?: string
  /** Atomically transfers an already durable revocation artifact into connection ownership. */
  adoptStagedRevocationRef?: string
}

export interface AssignedConnectionResolver {
  getAssigned(squadId: string, providerKey: string): Promise<AssignedIntegrationConnectionRecord | null>
  /** The named connection only if it is assigned to this squad for this provider (any default flag). */
  getAssignedById?(
    squadId: string,
    providerKey: string,
    connectionId: string
  ): Promise<AssignedIntegrationConnectionRecord | null>
}

export interface IntegrationAssignmentActor {
  userId?: string
  agentId?: string
}

export interface IntegrationAssignmentRepository extends AssignedConnectionResolver {
  listPoolSummaries(providerKey: string): Promise<readonly IntegrationConnectionSummary[]>
  assign(
    squadId: string,
    providerKey: string,
    connectionId: string,
    actor?: IntegrationAssignmentActor,
    options?: { retainPrevious?: boolean; makeDefault?: boolean }
  ): Promise<AssignedIntegrationConnectionRecord>
  unassign(
    squadId: string,
    providerKey: string,
    actor?: IntegrationAssignmentActor,
    connectionId?: string
  ): Promise<boolean>
  usage(connectionId: string): Promise<IntegrationConnectionUsage>
}

export type GuardedConnectionMutation<T = undefined> =
  { status: 'updated'; value: T } | { status: 'not_found' } | { status: 'in_use'; usage: IntegrationConnectionUsage }

export interface IntegrationConnectionRepository {
  createPending<C>(input: CreatePendingConnection<C>): Promise<IntegrationConnectionRecord<C>>
  get(id: string): Promise<IntegrationConnectionRecord | null>
  list(providerKey: string): Promise<readonly IntegrationConnectionRecord[]>
  due(now: Date, limit: number): Promise<readonly { id: string }[]>
  scheduleCredentialCleanup(credentialRef: string): Promise<void>
  scheduleRevocation?(input: {
    providerKey: string
    adapterVersion: number
    credentialRef: string
    clientAuthority: OAuthAuthority
  }): Promise<void>
  recordValidation(input: {
    id: string
    materialRevision: string
    validation: ProviderValidation
    now: Date
    expiresAt: Date
  }): Promise<boolean>
  enableValidated(input: {
    id: string
    materialRevision: string
    validation: Extract<ProviderValidation, { ok: true }>
    now: Date
    expiresAt: Date
    authorizationFlowId?: string
  }): Promise<boolean>
  disable(id: string, confirmAssigned?: boolean): Promise<GuardedConnectionMutation>
  disableRuntimeAuthFailure(input: { id: string; materialRevision: string }): Promise<boolean>
  markReauthorizationRequired(input: { id: string; materialRevision: string; code: string }): Promise<boolean>
  recordRefreshFailure(input: {
    id: string
    materialRevision: string
    code: string
    invalidateAuthentication?: boolean
  }): Promise<boolean>
  installAuthorizedMaterial?(input: {
    id: string
    expectedMaterialRevision: string
    expectedProviderKey: string
    expectedAdapterVersion: number
    expectedIdentity: Readonly<Record<string, string | number>>
    configuration: unknown
    credentialRef: string
    materialRevision: string
    displayName: string
    updatedByUserId: string
    clientAuthority: OAuthAuthority
    authorizationFlowId?: string
    adoptStagedRevocationRef?: string
  }): Promise<{ status: 'updated' | 'changed' | 'not_found' }>
  rotateMaterial(input: {
    id: string
    materialRevision: string
    configuration?: unknown
    credentialRef?: string
    updatedByUserId?: string
    confirmAssigned?: boolean
  }): Promise<
    GuardedConnectionMutation<{ connection: IntegrationConnectionRecord; retiredCredentialRef: string | null }>
  >
  delete(id: string, confirmAssigned?: boolean): Promise<GuardedConnectionMutation<{ retiredCredentialRef: string }>>
  rollbackPendingLocal?(input: { id: string; credentialRef: string }): Promise<boolean>
  deleteWithRevocation?(
    id: string,
    confirmAssigned?: boolean
  ): Promise<GuardedConnectionMutation<{ retiredCredentialRef: string }>>
}

export interface IntegrationCredentialStore {
  get(reference: string): string | undefined
  set(reference: string, value: string, actor: string): Promise<void>
  delete(reference: string): Promise<void>
}

export type ProviderResolver = (key: string, adapterVersion: number) => IntegrationProvider
