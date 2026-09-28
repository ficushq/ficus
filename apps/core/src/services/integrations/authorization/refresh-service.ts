import type { IntegrationAuditRecorder } from '../audit'
import type { IntegrationConnectionRecord } from '../connection-repository'
import type { IntegrationPluginV1 } from '../plugin'
import type { ConnectionAuthorizationLease } from './connection-lease'
import { OAuthTransportError, type OAuthTransport } from './transport'
import { PlatformRequestError } from '../../platform/instance-client'
import { BrokerUnconfiguredError } from './authority'
import type { OAuthControlPlaneAlert } from './oauth-operational-alert'
import { assertNotionIdentity } from '../notion/identity'
import { parseNotionConfiguration } from '@ficus/shared/oauth-providers/notion/config'
import {
  parseOAuthCredential,
  rotateOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './credential-bundle'

type OAuthPlugin = IntegrationPluginV1<unknown, OAuthCredentialBundleV1>
export type RefreshReason = 'proactive' | 'explicit' | 'authentication_failure'
export type RefreshResult = {
  status: 'refreshed' | 'unchanged' | 'reauthorization_required' | 'degraded'
  code?: string
}

export interface IntegrationRefreshDependencies {
  connections: {
    get(id: string): Promise<IntegrationConnectionRecord | null>
    markReauthorizationRequired(input: { id: string; materialRevision: string; code: string }): Promise<boolean>
    recordValidation(input: {
      id: string
      materialRevision: string
      validation: { ok: true; grantedScopes: readonly string[] }
      now: Date
      expiresAt: Date
    }): Promise<boolean>
    recordRefreshFailure(input: {
      id: string
      materialRevision: string
      code: string
      invalidateAuthentication?: boolean
    }): Promise<boolean>
  }
  credentials: {
    get(key: string): string | undefined
    refreshKey(key: string): Promise<void>
    mutateSecret(
      key: string,
      mutate: (current: string | undefined) => string | undefined,
      actor?: string
    ): Promise<void>
  }
  resolvePlugin(providerKey: string): OAuthPlugin | undefined
  transport: Pick<OAuthTransport, 'authority' | 'refresh'>
  lease: ConnectionAuthorizationLease
  invalidateAssignments(connectionId: string): Promise<void>
  audit?: IntegrationAuditRecorder
  operatorAlert?(alert: OAuthControlPlaneAlert): Promise<void>
  reportOperationalIssue?(issue: {
    severity: 'alert' | 'error'
    connectionId: string
    code: string
  }): Promise<void> | void
  now?: () => Date
  proactiveWindowMs?: number
}

export class IntegrationRefreshService {
  readonly #dependencies: IntegrationRefreshDependencies
  readonly #now: () => Date
  readonly #proactiveWindowMs: number

  constructor(dependencies: IntegrationRefreshDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date())
    this.#proactiveWindowMs = dependencies.proactiveWindowMs ?? 5 * 60_000
  }

  async refresh(connectionId: string, reason: RefreshReason): Promise<RefreshResult> {
    const connection = await this.#dependencies.connections.get(connectionId)
    if (!connection) return { status: 'unchanged', code: 'connection_not_found' }
    if (connection.clientAuthority !== this.#dependencies.transport.authority) {
      return this.#dependencies.lease.runExclusive(connection.id, async () => {
        const currentConnection = await this.#dependencies.connections.get(connection.id)
        if (!currentConnection || currentConnection.materialRevision !== connection.materialRevision) {
          return { status: 'unchanged', code: 'connection_changed' }
        }
        if (currentConnection.clientAuthority === this.#dependencies.transport.authority) {
          return { status: 'unchanged', code: 'connection_changed' }
        }
        const result = await this.#reauthorization(currentConnection, 'client_authority_mismatch')
        if (result.status === 'reauthorization_required') {
          await this.#reportOperationalIssue(currentConnection.id, 'client_authority_mismatch', 'error')
        }
        return result
      })
    }
    await this.#dependencies.credentials.refreshKey(connection.credentialRef)
    const observedRevision = this.#readCredential(connection.credentialRef)?.tokenRevision

    return this.#dependencies.lease.runExclusive(connection.id, async () => {
      const currentConnection = await this.#dependencies.connections.get(connection.id)
      if (!currentConnection || currentConnection.materialRevision !== connection.materialRevision) {
        return { status: 'unchanged', code: 'connection_changed' }
      }
      if (currentConnection.clientAuthority !== this.#dependencies.transport.authority) {
        const result = await this.#reauthorization(currentConnection, 'client_authority_mismatch')
        if (result.status === 'reauthorization_required') {
          await this.#reportOperationalIssue(currentConnection.id, 'client_authority_mismatch', 'error')
        }
        return result
      }
      const plugin = this.#dependencies.resolvePlugin(currentConnection.providerKey)
      if (!plugin || plugin.authorization.kind !== 'oauth2') {
        return { status: 'unchanged', code: 'unsupported_provider' }
      }
      let configuration: unknown
      try {
        configuration = plugin.connection.parseConfiguration(currentConnection.configuration)
      } catch {
        return this.#reauthorization(currentConnection, 'invalid_configuration')
      }
      await this.#dependencies.credentials.refreshKey(currentConnection.credentialRef)
      const current = this.#readCredential(currentConnection.credentialRef)
      if (!current) return this.#reauthorization(currentConnection, 'credential_unavailable')
      if (observedRevision !== undefined && current.tokenRevision !== observedRevision) {
        return { status: 'unchanged', code: 'already_rotated' }
      }
      const requestedRevision = current.tokenRevision
      if (reason === 'proactive' && !shouldProactivelyRefresh(current, this.#now(), this.#proactiveWindowMs)) {
        return { status: 'unchanged', code: 'not_due' }
      }
      if (!current.refreshToken) return this.#reauthorization(currentConnection, 'refresh_token_unavailable')

      let rotation: { accessToken: string; refreshToken: string | null; expiresAt: string | null }
      try {
        const grant = await this.#dependencies.transport.refresh({
          providerKey: plugin.authorization.adapter,
          connectionId: currentConnection.id,
          materialRevision: currentConnection.materialRevision,
          tokenRevision: current.tokenRevision,
          refreshToken: current.refreshToken,
          ...(current.clientBinding ? { clientBinding: current.clientBinding } : {}),
        })
        if (currentConnection.providerKey === 'notion') {
          assertNotionIdentity(parseNotionConfiguration(configuration), grant.configuration)
        }
        rotation = grant.tokens
      } catch (error) {
        const failure =
          error instanceof PlatformRequestError
            ? { code: error.code, retryable: error.retryable }
            : error instanceof BrokerUnconfiguredError
              ? { code: error.code, retryable: true }
              : error instanceof OAuthTransportError
                ? { code: error.code, retryable: false }
                : plugin.classifyError(error)
        if (failure.code === 'operation_key_conflict') {
          await this.#reportOperationalIssue(currentConnection.id, failure.code, 'error')
        }
        if (isTerminalRefreshFailure(failure)) {
          return this.#reauthorization(currentConnection, failure.code)
        }
        const code = safeCode(failure.code)
        const brokerAccessFailure = code === 'broker_unauthorized' || code === 'insufficient_scope'
        return this.#degraded(currentConnection, code, current, reason, async () => {
          if (!brokerAccessFailure) return
          await this.#reportOperationalIssue(currentConnection.id, code, 'alert')
          try {
            await this.#dependencies.operatorAlert?.({
              connectionId: currentConnection.id,
              providerKey: currentConnection.providerKey,
              materialRevision: currentConnection.materialRevision,
              safeCode: code,
            })
          } catch {
            // Durable alert delivery never changes the persisted degraded/token-preservation result.
          }
        })
      }

      const rotated = rotateOAuthCredential(current, rotation)
      const persistRotation = async (): Promise<boolean> => {
        let installed = false
        await this.#dependencies.credentials.mutateSecret(
          currentConnection.credentialRef,
          (raw) => {
            if (raw === undefined) return undefined
            let latest: OAuthCredentialBundleV1
            try {
              latest = parseOAuthCredential(raw)
            } catch {
              return undefined
            }
            if (latest.tokenRevision !== requestedRevision) return undefined
            installed = true
            return serializeOAuthCredential(rotated)
          },
          'system:integration-oauth-refresh'
        )
        return installed
      }
      const persistBeforeValidation = plugin.authorization.refreshInvalidatesPreviousTokens === true
      if (persistBeforeValidation) {
        // Keep runtime access disabled until validation succeeds, but save the
        // only usable refresh token before doing any more provider I/O.
        const pending = await this.#dependencies.connections.recordRefreshFailure({
          id: currentConnection.id,
          materialRevision: currentConnection.materialRevision,
          code: 'refresh_validation_pending',
          invalidateAuthentication: true,
        })
        if (!pending) return { status: 'unchanged', code: 'connection_changed' }
        if (!(await persistRotation())) return { status: 'unchanged', code: 'revision_changed' }
        await this.#dependencies.invalidateAssignments(currentConnection.id)
      }
      const validation = await plugin.authorization.validate({ configuration, credential: rotated })
      if (!validation.ok) {
        const code = safeCode(validation.code)
        return isTerminalCandidateValidation(code)
          ? this.#reauthorization(currentConnection, code)
          : this.#degraded(
              currentConnection,
              code,
              persistBeforeValidation ? rotated : current,
              persistBeforeValidation ? 'authentication_failure' : reason
            )
      }
      if (!persistBeforeValidation && !(await persistRotation()))
        return { status: 'unchanged', code: 'revision_changed' }
      const validatedAt = this.#now()
      let recorded: boolean
      try {
        recorded = await this.#dependencies.connections.recordValidation({
          id: currentConnection.id,
          materialRevision: currentConnection.materialRevision,
          validation,
          now: validatedAt,
          expiresAt: new Date(validatedAt.getTime() + 15 * 60_000),
        })
      } catch {
        await this.#reportOperationalIssue(currentConnection.id, 'post_commit_reconciliation_required', 'error')
        return { status: 'refreshed', code: 'post_commit_reconciliation_required' }
      }
      if (!recorded) return { status: 'unchanged', code: 'connection_changed' }
      const sideEffects = await Promise.allSettled([
        this.#dependencies.invalidateAssignments(currentConnection.id),
        this.#audit(currentConnection, 'succeeded'),
      ])
      if (sideEffects.some((result) => result.status === 'rejected')) {
        await this.#reportOperationalIssue(currentConnection.id, 'post_commit_side_effect_failed', 'error')
        return { status: 'refreshed', code: 'post_commit_side_effect_failed' }
      }
      return { status: 'refreshed' }
    })
  }

  #readCredential(reference: string): OAuthCredentialBundleV1 | null {
    const raw = this.#dependencies.credentials.get(reference)
    if (!raw) return null
    try {
      return parseOAuthCredential(raw)
    } catch {
      return null
    }
  }

  async #reauthorization(connection: IntegrationConnectionRecord, code: string): Promise<RefreshResult> {
    const updated = await this.#dependencies.connections.markReauthorizationRequired({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code,
    })
    if (!updated) return { status: 'unchanged', code: 'connection_changed' }
    await this.#dependencies.invalidateAssignments(connection.id)
    await this.#audit(connection, 'failed', code)
    return { status: 'reauthorization_required', code }
  }

  async #degraded(
    connection: IntegrationConnectionRecord,
    code: string,
    credential: OAuthCredentialBundleV1,
    reason: RefreshReason,
    afterPersist?: () => Promise<void>
  ): Promise<RefreshResult> {
    const expiresAt = credential.expiresAt === null ? null : Date.parse(credential.expiresAt)
    const invalidateAuthentication =
      reason === 'authentication_failure' || (expiresAt !== null && expiresAt <= this.#now().getTime())
    const updated = await this.#dependencies.connections.recordRefreshFailure({
      id: connection.id,
      materialRevision: connection.materialRevision,
      code,
      invalidateAuthentication,
    })
    if (!updated) return { status: 'unchanged', code: 'connection_changed' }
    await afterPersist?.()
    if (invalidateAuthentication) {
      await this.#dependencies.invalidateAssignments(connection.id)
    }
    await this.#audit(connection, 'failed', code)
    return { status: 'degraded', code }
  }

  async #reportOperationalIssue(connectionId: string, code: string, severity: 'alert' | 'error'): Promise<void> {
    try {
      await this.#dependencies.reportOperationalIssue?.({ severity, connectionId, code })
    } catch {
      // Operational signaling must never change credential lifecycle behavior.
    }
  }

  async #audit(connection: IntegrationConnectionRecord, outcome: 'succeeded' | 'failed', code?: string): Promise<void> {
    await this.#dependencies.audit?.record({
      connectionId: connection.id,
      action: 'oauth_refresh',
      outcome,
      ...(code ? { code } : {}),
      at: this.#now(),
    })
  }
}

export function shouldProactivelyRefresh(
  credential: OAuthCredentialBundleV1,
  now: Date,
  refreshWindowMs: number
): boolean {
  if (credential.expiresAt === null) return false
  const expiresAt = Date.parse(credential.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime() + Math.max(0, refreshWindowMs)
}

function isTerminalRefreshFailure(failure: { code: string; retryable: boolean }): boolean {
  return (
    !failure.retryable &&
    (failure.code === 'invalid_grant' ||
      failure.code === 'bad_refresh_token' ||
      failure.code === 'account_identity_mismatch' ||
      failure.code === 'refresh_ambiguous' ||
      failure.code === 'workspace_identity_mismatch' ||
      failure.code === 'workspace_mismatch')
  )
}

function isTerminalCandidateValidation(code: string): boolean {
  return code === 'workspace_identity_mismatch' || code === 'workspace_mismatch' || code === 'account_identity_mismatch'
}

function safeCode(code: string): string {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : 'provider_error'
}
