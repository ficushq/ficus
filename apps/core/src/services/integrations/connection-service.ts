import { randomUUID } from 'crypto'
import { createLogger } from '../../lib/infra/logger'
import type {
  GuardedConnectionMutation,
  IntegrationAssignmentRepository,
  IntegrationConnectionRecord,
  IntegrationConnectionRepository,
  IntegrationConnectionUsage,
  IntegrationCredentialStore,
  ProviderResolver,
} from './connection-repository'
import type { IntegrationProvider, ProviderValidation } from './types'
import type { IntegrationAuditRecorder } from './audit'
import type { OAuthAuthority } from './authorization/authority'

const VALIDATION_FRESHNESS_MS = 15 * 60 * 1000
const SAFE_ERROR_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const log = createLogger('integration-connections')

export interface SafeIntegrationConnection {
  id: string
  providerKey: string
  adapterVersion: number
  displayName: string
  configuration: unknown
  credentialConfigured: boolean
  refreshAvailable?: boolean
  enabled: boolean
  authState: IntegrationConnectionRecord['authState']
  healthState: IntegrationConnectionRecord['healthState']
  grantedScopes: readonly string[]
  validatedAt: Date | null
  validationExpiresAt: Date | null
  lastErrorCode: string | null
  usage: IntegrationConnectionUsage
}

export class IntegrationManualCredentialNotAllowedError extends Error {
  constructor() {
    super('OAuth authorization required')
    this.name = 'IntegrationManualCredentialNotAllowedError'
  }
}

export class IntegrationConnectionCreateCommittedError extends Error {
  constructor(
    readonly connectionId: string,
    options: { cause: unknown }
  ) {
    super('Integration connection creation committed but finalization failed', options)
    this.name = 'IntegrationConnectionCreateCommittedError'
  }
}

export class IntegrationConnectionInUseError extends Error {
  constructor(readonly usage: IntegrationConnectionUsage) {
    super('Integration connection is assigned to squads')
    this.name = 'IntegrationConnectionInUseError'
  }
}

export interface ConnectionServiceDependencies {
  repository: IntegrationConnectionRepository
  assignments: Pick<IntegrationAssignmentRepository, 'usage'>
  credentials: IntegrationCredentialStore
  resolveProvider: ProviderResolver
  now?: () => Date
  uuid?: () => string
  audit?: IntegrationAuditRecorder
  requiresRemoteRevocation?: (providerKey: string, adapterVersion: number, clientAuthority: OAuthAuthority) => boolean
  deproject?: (input: { squadIds: readonly string[]; providerKey: string }) => Promise<void>
  /**
   * Capture provider-side cleanup while the connection and its credential still
   * exist (the removal enqueues credential revocation). The returned step runs
   * only after the removal commits, before squads are deprojected.
   */
  prepareRemoval?: (
    connection: IntegrationConnectionRecord,
    credential: string | undefined
  ) => Promise<(() => Promise<void>) | undefined>
  allowsManualCredential?: (providerKey: string) => boolean
  safeConfiguration?: (providerKey: string, configuration: unknown) => unknown
  refreshAvailable?: (providerKey: string, credential: string | undefined) => boolean | undefined
  currentOAuthAuthority?: (providerKey: string, adapterVersion: number) => OAuthAuthority | undefined
  authorizationLease?: { runExclusive<T>(resource: string, operation: () => Promise<T>): Promise<T> }
  operatorAlert?: (input: {
    connectionId: string
    providerKey: string
    materialRevision: string
    safeCode: 'client_authority_mismatch'
  }) => Promise<void>
  refreshAuthenticationFailure?: (
    connectionId: string
  ) => Promise<{ status: 'refreshed' | 'unchanged' | 'reauthorization_required' | 'degraded' }>
}

export class IntegrationConnectionService {
  readonly #repository: IntegrationConnectionRepository
  readonly #assignments: Pick<IntegrationAssignmentRepository, 'usage'>
  readonly #credentials: IntegrationCredentialStore
  readonly #resolveProvider: ProviderResolver
  readonly #now: () => Date
  readonly #uuid: () => string
  readonly #auditRecorder?: IntegrationAuditRecorder
  readonly #requiresRemoteRevocation: (
    providerKey: string,
    adapterVersion: number,
    clientAuthority: OAuthAuthority
  ) => boolean
  readonly #deproject?: ConnectionServiceDependencies['deproject']
  readonly #prepareRemoval?: ConnectionServiceDependencies['prepareRemoval']
  readonly #allowsManualCredential: (providerKey: string) => boolean
  readonly #safeConfiguration: (providerKey: string, configuration: unknown) => unknown
  readonly #refreshAvailable: (providerKey: string, credential: string | undefined) => boolean | undefined
  readonly #refreshAuthenticationFailure?: ConnectionServiceDependencies['refreshAuthenticationFailure']
  readonly #currentOAuthAuthority: NonNullable<ConnectionServiceDependencies['currentOAuthAuthority']>
  readonly #operatorAlert?: ConnectionServiceDependencies['operatorAlert']
  readonly #authorizationLease?: ConnectionServiceDependencies['authorizationLease']

  constructor(dependencies: ConnectionServiceDependencies) {
    this.#repository = dependencies.repository
    this.#assignments = dependencies.assignments
    this.#credentials = dependencies.credentials
    this.#resolveProvider = dependencies.resolveProvider
    this.#now = dependencies.now ?? (() => new Date())
    this.#uuid = dependencies.uuid ?? randomUUID
    this.#auditRecorder = dependencies.audit
    this.#requiresRemoteRevocation = dependencies.requiresRemoteRevocation ?? (() => false)
    this.#deproject = dependencies.deproject
    this.#prepareRemoval = dependencies.prepareRemoval
    this.#allowsManualCredential = dependencies.allowsManualCredential ?? (() => true)
    this.#safeConfiguration = dependencies.safeConfiguration ?? ((_providerKey, configuration) => configuration)
    this.#refreshAvailable = dependencies.refreshAvailable ?? (() => undefined)
    this.#refreshAuthenticationFailure = dependencies.refreshAuthenticationFailure
    this.#currentOAuthAuthority = dependencies.currentOAuthAuthority ?? (() => undefined)
    this.#operatorAlert = dependencies.operatorAlert
    this.#authorizationLease = dependencies.authorizationLease
  }

  async create(input: {
    providerKey: string
    adapterVersion: number
    displayName: string
    configuration: unknown
    credential: string
    actor: string
    authorizationGrant?: true
    clientAuthority?: OAuthAuthority
    authorizationFlowId?: string
    stagedCredentialRef?: string
  }): Promise<SafeIntegrationConnection> {
    if (!input.authorizationGrant && !this.#allowsManualCredential(input.providerKey))
      throw new IntegrationManualCredentialNotAllowedError()
    const provider = this.#resolveProvider(input.providerKey, input.adapterVersion)
    const configuration = provider.parseConfig(input.configuration)
    const id = this.#uuid()
    const materialRevision = this.#uuid()
    const credentialRef =
      input.stagedCredentialRef ??
      (input.authorizationFlowId
        ? `__integration-credential:authorization-flow:${input.authorizationFlowId}:bearer`
        : `__integration-credential:${id}:${materialRevision}:bearer`)
    if (!input.stagedCredentialRef) {
      try {
        await this.#credentials.set(credentialRef, input.credential, input.actor)
      } catch (error) {
        if (!input.authorizationFlowId || this.#credentials.get(credentialRef) !== input.credential) throw error
        // A deterministic flow-scoped write committed before acknowledgement.
      }
    }
    const pending = {
      id,
      providerKey: provider.key,
      adapterVersion: provider.adapterVersion,
      clientAuthority: input.clientAuthority ?? ('local' as const),
      authorizationFlowId: input.authorizationFlowId,
      displayName: input.displayName,
      configuration,
      credentialRef,
      materialRevision,
      createdByUserId: actorUserId(input.actor),
      updatedByUserId: actorUserId(input.actor),
      ...(input.stagedCredentialRef ? { adoptStagedRevocationRef: input.stagedCredentialRef } : {}),
    }
    let connection: IntegrationConnectionRecord
    try {
      connection = await this.#repository.createPending(pending)
    } catch (error) {
      let committed: IntegrationConnectionRecord | null
      try {
        committed = await this.#repository.get(id)
      } catch {
        // The insert outcome remains ambiguous. Preserve its potentially
        // authoritative credential so a later flow retry can reconcile it.
        throw error
      }
      if (!isCommittedCreate(committed, pending)) {
        if (committed === null && !input.authorizationFlowId && !input.stagedCredentialRef) {
          // A manual credential has no authorization-flow or staged revocation
          // owner. Once non-commit is proven, retire it instead of orphaning it.
          await this.#retireCredential(credentialRef)
        }
        // OAuth artifacts remain owned by their flow/staged revocation record.
        // Ambiguous reads also preserve potentially authoritative material.
        throw error
      }
      connection = committed
    }
    try {
      await this.#validateAndRecord(connection, provider, input.credential)
      await this.#audit(connection, 'create', input.actor)
      return this.safeView((await this.#repository.get(id)) ?? connection)
    } catch (error) {
      throw new IntegrationConnectionCreateCommittedError(id, { cause: error })
    }
  }

  async validate(
    id: string,
    actor?: string,
    options: { allowAuthenticationRefresh?: boolean } = {}
  ): Promise<SafeIntegrationConnection> {
    let connection = await this.#mustGet(id)
    if (await this.#reconcileAuthority(connection)) return this.safeView(await this.#mustGet(id))
    const provider = this.#resolveProvider(connection.providerKey, connection.adapterVersion)
    let validation = await this.#liveValidation(connection, provider, this.#requireCredential(connection))
    if (
      !validation.ok &&
      validation.code === 'invalid_auth' &&
      options.allowAuthenticationRefresh !== false &&
      this.#refreshAuthenticationFailure
    ) {
      const refreshed = await this.#refreshAuthenticationFailure(id)
      if (refreshed.status === 'reauthorization_required') return this.safeView(await this.#mustGet(id))
      if (refreshed.status === 'degraded') {
        // Refresh persistence retains the enabled intent but marks the token
        // invalid and retryable. Deproject immediately without replacing its
        // short retry backoff with the generic validation interval.
        if (this.#deproject) {
          const usage = await this.#assignments.usage(id)
          await this.#deproject({
            squadIds: usage.squads.map((squad) => squad.id),
            providerKey: connection.providerKey,
          })
        }
        return this.safeView(await this.#mustGet(id))
      }
      connection = await this.#mustGet(id)
      validation = await this.#liveValidation(connection, provider, this.#requireCredential(connection))
    }
    await this.#record(connection, validation)
    if (!validation.ok && this.#deproject) {
      const usage = await this.#assignments.usage(id)
      await this.#deproject({ squadIds: usage.squads.map((squad) => squad.id), providerKey: connection.providerKey })
    }
    await this.#audit(connection, 'validate', actor)
    return this.safeView(await this.#mustGet(id))
  }

  async enable(id: string, actor?: string, authorizationFlowId?: string): Promise<SafeIntegrationConnection> {
    const connection = await this.#mustGet(id)
    if (connection.authState === 'reauthorization_required')
      throw new Error('Integration authentication failed: reauthorization_required')
    if (await this.#reconcileAuthority(connection))
      throw new Error('Integration authentication failed: client_authority_mismatch')
    const provider = this.#resolveProvider(connection.providerKey, connection.adapterVersion)
    const validation = await this.#liveValidation(connection, provider, this.#requireCredential(connection))
    if (!validation.ok) {
      await this.#record(connection, validation)
      throw new Error(`Integration authentication failed: ${sanitizeCode(validation.code)}`)
    }
    const now = this.#now()
    const updated = await this.#repository.enableValidated({
      id,
      materialRevision: connection.materialRevision,
      validation,
      now,
      expiresAt: new Date(now.getTime() + VALIDATION_FRESHNESS_MS),
      authorizationFlowId,
    })
    if (!updated) throw new Error('Connection changed during validation')
    await this.#audit(connection, 'enable', actor)
    return this.safeView(await this.#mustGet(id))
  }

  async disable(id: string, actor?: string, confirmAssigned = false): Promise<void> {
    const connection = await this.#mustGet(id)
    const usage = await this.#assignments.usage(id)
    this.#requireUpdated(await this.#repository.disable(id, confirmAssigned))
    await this.#deproject?.({ squadIds: usage.squads.map((squad) => squad.id), providerKey: connection.providerKey })
    await this.#audit(connection, 'disable', actor)
  }

  async replaceCredential(
    id: string,
    credential: string,
    actor: string,
    confirmAssigned = false,
    configuration?: unknown,
    /** Trusted internal flow (like `create`'s): material came from an authorization, not a person. */
    authorizationGrant?: true
  ): Promise<SafeIntegrationConnection> {
    const current = await this.#mustGet(id)
    if (!authorizationGrant && !this.#allowsManualCredential(current.providerKey))
      throw new IntegrationManualCredentialNotAllowedError()
    const parsedConfiguration =
      configuration === undefined
        ? undefined
        : this.#resolveProvider(current.providerKey, current.adapterVersion).parseConfig(configuration)
    const materialRevision = this.#uuid()
    const credentialRef = `__integration-credential:${id}:${materialRevision}:bearer`
    await this.#credentials.set(credentialRef, credential, actor)
    let mutation: Awaited<ReturnType<IntegrationConnectionRepository['rotateMaterial']>>
    try {
      mutation = await this.#repository.rotateMaterial({
        id,
        materialRevision,
        credentialRef,
        ...(parsedConfiguration === undefined ? {} : { configuration: parsedConfiguration }),
        updatedByUserId: actorUserId(actor),
        confirmAssigned,
      })
    } catch (error) {
      await this.#retireCredential(credentialRef)
      throw error
    }
    if (mutation.status !== 'updated') {
      await this.#retireCredential(credentialRef)
      this.#requireUpdated(mutation)
      throw new Error('unreachable')
    }
    if (mutation.value.retiredCredentialRef) await this.#cleanupCredential(mutation.value.retiredCredentialRef)
    await this.#audit(mutation.value.connection, 'rotate', actor)
    return this.safeView(mutation.value.connection)
  }

  /** Roll back a never-enabled local authorization row while its staged artifact lease is already held. */
  async rollbackPendingLocal(id: string, credentialRef: string): Promise<void> {
    if (
      !this.#repository.rollbackPendingLocal ||
      !(await this.#repository.rollbackPendingLocal({ id, credentialRef }))
    ) {
      throw new Error('Pending authorization cleanup failed')
    }
  }

  async remove(id: string, actor?: string, confirmAssigned = false): Promise<void> {
    const removeWhileLeased = async () => {
      const connection = await this.#mustGet(id)
      const usage = await this.#assignments.usage(id)
      const requiresRevocation = this.#requiresRemoteRevocation(
        connection.providerKey,
        connection.adapterVersion,
        connection.clientAuthority
      )
      if (requiresRevocation && !this.#repository.deleteWithRevocation) {
        throw new Error('Remote revocation is unavailable')
      }
      const cleanup = await this.#prepareRemoval?.(connection, this.#credentials.get(connection.credentialRef))
      let mutation: Awaited<ReturnType<IntegrationConnectionRepository['delete']>>
      try {
        mutation = requiresRevocation
          ? await this.#repository.deleteWithRevocation!(id, confirmAssigned)
          : await this.#repository.delete(id, confirmAssigned)
      } catch (error) {
        let current: IntegrationConnectionRecord | null
        try {
          current = await this.#repository.get(id)
        } catch {
          throw error
        }
        if (current) throw error
        mutation = { status: 'updated', value: { retiredCredentialRef: connection.credentialRef } }
      }
      this.#requireUpdated(mutation)
      if (mutation.status !== 'updated') throw new Error('unreachable')
      return {
        connection,
        usage,
        requiresRevocation,
        retiredCredentialRef: mutation.value.retiredCredentialRef,
        cleanup,
      }
    }
    const removed = this.#authorizationLease
      ? await this.#authorizationLease.runExclusive(id, removeWhileLeased)
      : await removeWhileLeased()
    await removed.cleanup?.()
    await this.#deproject?.({
      squadIds: removed.usage.squads.map((squad) => squad.id),
      providerKey: removed.connection.providerKey,
    })
    await this.#auditRemoval(actor)
    if (!removed.requiresRevocation) await this.#cleanupCredential(removed.retiredCredentialRef)
  }

  async safeView(connection: IntegrationConnectionRecord): Promise<SafeIntegrationConnection> {
    const credential = this.#credentials.get(connection.credentialRef)
    return {
      id: connection.id,
      providerKey: connection.providerKey,
      adapterVersion: connection.adapterVersion,
      displayName: connection.displayName,
      configuration: this.#safeConfiguration(connection.providerKey, connection.configuration),
      credentialConfigured: credential !== undefined,
      ...optionalRefreshAvailability(this.#refreshAvailable(connection.providerKey, credential)),
      enabled: connection.enabled,
      authState: connection.authState,
      healthState: connection.healthState,
      grantedScopes: connection.grantedScopes,
      validatedAt: connection.validatedAt,
      validationExpiresAt: connection.validationExpiresAt,
      lastErrorCode: connection.lastErrorCode,
      usage: await this.#assignments.usage(connection.id),
    }
  }

  async #auditRemoval(actor?: string): Promise<void> {
    try {
      await this.#auditRecorder?.record({
        connectionId: undefined,
        squadId: undefined,
        userId: actor?.startsWith('user:') ? actor.slice(5) : undefined,
        agentId: actor?.startsWith('agent:') ? actor.slice(6) : undefined,
        action: 'connection_remove',
        outcome: 'succeeded',
        at: this.#now(),
      })
    } catch (error) {
      log.warn(
        'Integration removal audit failed after database deletion',
        error instanceof Error ? error.name : 'unknown'
      )
    }
  }

  async #audit(connection: IntegrationConnectionRecord, action: string, actor?: string): Promise<void> {
    await this.#auditRecorder?.record({
      connectionId: connection.id,
      squadId: undefined,
      userId: actor?.startsWith('user:') ? actor.slice(5) : undefined,
      agentId: actor?.startsWith('agent:') ? actor.slice(6) : undefined,
      action: `connection_${action}`,
      outcome: 'succeeded',
      at: this.#now(),
    })
  }

  async #mustGet(id: string): Promise<IntegrationConnectionRecord> {
    const connection = await this.#repository.get(id)
    if (!connection) throw new Error('Integration connection not found')
    return connection
  }

  #requireUpdated<T>(mutation: GuardedConnectionMutation<T>): T {
    if (mutation.status === 'in_use') throw new IntegrationConnectionInUseError(mutation.usage)
    if (mutation.status === 'not_found') throw new Error('Integration connection not found')
    return mutation.value
  }

  #requireCredential(connection: IntegrationConnectionRecord): string {
    const credential = this.#credentials.get(connection.credentialRef)
    if (!credential) throw new Error('Integration credential is not configured')
    return credential
  }

  async #retireCredential(reference: string): Promise<void> {
    try {
      await this.#repository.scheduleCredentialCleanup(reference)
    } catch (error) {
      log.error(
        'Integration credential cleanup could not be scheduled',
        error instanceof Error ? error.name : 'unknown'
      )
    }
    await this.#cleanupCredential(reference)
  }

  async #cleanupCredential(reference: string): Promise<void> {
    try {
      await this.#credentials.delete(reference)
    } catch (error) {
      log.warn(
        'Integration credential cleanup failed after database mutation',
        error instanceof Error ? error.name : 'unknown'
      )
    }
  }

  async #reconcileAuthority(connection: IntegrationConnectionRecord): Promise<boolean> {
    const currentAuthority = this.#currentOAuthAuthority(connection.providerKey, connection.adapterVersion)
    if (!currentAuthority || currentAuthority === connection.clientAuthority) return false
    const updated = await this.#repository.markReauthorizationRequired({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code: 'client_authority_mismatch',
    })
    if (updated) {
      try {
        await this.#operatorAlert?.({
          connectionId: connection.id,
          providerKey: connection.providerKey,
          materialRevision: connection.materialRevision,
          safeCode: 'client_authority_mismatch',
        })
      } catch (error) {
        log.error(
          'OAuth authority mismatch alert failed after lifecycle transition',
          error instanceof Error ? error.name : 'unknown'
        )
      }
    }
    if (updated && this.#deproject) {
      const usage = await this.#assignments.usage(connection.id)
      await this.#deproject({
        squadIds: usage.squads.map((squad) => squad.id),
        providerKey: connection.providerKey,
      })
    }
    return true
  }

  async #validateAndRecord(
    connection: IntegrationConnectionRecord,
    provider: IntegrationProvider,
    credential: string
  ): Promise<void> {
    await this.#record(connection, await this.#liveValidation(connection, provider, credential))
  }

  async #liveValidation(
    connection: IntegrationConnectionRecord,
    provider: IntegrationProvider,
    credential: string
  ): Promise<ProviderValidation> {
    let validation: ProviderValidation
    try {
      validation = await provider.validate({ connection, credential })
    } catch {
      return { ok: false, code: 'provider_unreachable' }
    }
    if (!validation.ok || validation.configuration === undefined) return validation
    // A refreshed configuration is persisted only in the provider's own validated shape.
    const { configuration, ...rest } = validation
    try {
      return { ...rest, configuration: provider.parseConfig(configuration) }
    } catch {
      return rest
    }
  }

  async #record(connection: IntegrationConnectionRecord, validation: ProviderValidation): Promise<void> {
    const now = this.#now()
    const safe = validation.ok ? validation : { ok: false as const, code: sanitizeCode(validation.code) }
    const updated = await this.#repository.recordValidation({
      id: connection.id,
      materialRevision: connection.materialRevision,
      validation: safe,
      now,
      expiresAt: new Date(now.getTime() + VALIDATION_FRESHNESS_MS),
    })
    if (!updated) throw new Error('Connection changed during validation')
  }
}

function isCommittedCreate(
  connection: IntegrationConnectionRecord | null,
  pending: {
    id: string
    providerKey: string
    adapterVersion: number
    clientAuthority: OAuthAuthority
    authorizationFlowId?: string
    credentialRef: string
    materialRevision: string
  }
): connection is IntegrationConnectionRecord {
  return Boolean(
    connection &&
    connection.id === pending.id &&
    connection.providerKey === pending.providerKey &&
    connection.adapterVersion === pending.adapterVersion &&
    connection.clientAuthority === pending.clientAuthority &&
    connection.authorizationFlowId === (pending.authorizationFlowId ?? null) &&
    connection.credentialRef === pending.credentialRef &&
    connection.materialRevision === pending.materialRevision
  )
}

function optionalRefreshAvailability(value: boolean | undefined): { refreshAvailable?: boolean } {
  return value === undefined ? {} : { refreshAvailable: value }
}

function actorUserId(actor: string | undefined): string | undefined {
  return actor?.startsWith('user:') ? actor.slice(5) : undefined
}

function sanitizeCode(code: string): string {
  return SAFE_ERROR_CODE.test(code) ? code : 'provider_error'
}
