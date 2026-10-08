import type { AuthorizationGrant, IntegrationPluginV1 } from '../plugin'
import type { OAuthStateRecord } from '../authorization/state-repository'
import type { OAuthCredentialBundleV1 } from '../authorization/credential-bundle'
import type { OAuthTransport } from '../authorization/transport'
import {
  type AuthorizationFlowReceipt,
  type AuthorizationFlowReceiptRepository,
} from '../authorization/flow-repository'
import type { IntegrationConnectionRecord } from '../connection-repository'
import { IntegrationConnectionCreateCommittedError } from '../connection-service'
import { revocationArtifactLeaseResource } from '../authorization/connection-lease'

type OAuthGrant<C> = AuthorizationGrant<C, OAuthCredentialBundleV1>
type OAuthPlugin<C> = IntegrationPluginV1<C, OAuthCredentialBundleV1>

export class AuthorizationGrantAbandonedError extends Error {
  readonly code: string

  constructor(message: string, code = 'grant_abandoned') {
    super(message)
    this.code = code
    this.name = 'AuthorizationGrantAbandonedError'
  }
}

export interface OAuthConnectionAuthorizerDependencies<C> {
  repository: {
    get(id: string): Promise<IntegrationConnectionRecord | null>
    getByAuthorizationFlow(localFlowId: string): Promise<IntegrationConnectionRecord | null>
    list(providerKey: string): Promise<readonly { displayName: string }[]>
    installAuthorizedMaterial(input: {
      id: string
      expectedMaterialRevision: string
      expectedProviderKey: string
      expectedAdapterVersion: number
      expectedIdentity: Readonly<Record<string, string | number>>
      configuration: C
      credentialRef: string
      materialRevision: string
      displayName: string
      updatedByUserId: string
      clientAuthority: OAuthStateRecord['authority']
      authorizationFlowId?: string
      adoptStagedRevocationRef?: string
    }): Promise<{ status: 'updated' | 'changed' | 'not_found' }>
    enqueueRevocation(input: {
      providerKey: string
      adapterVersion: number
      credentialRef: string
      clientAuthority: OAuthStateRecord['authority']
    }): Promise<void>
    ownsRevocation(input: {
      credentialRef: string
      providerKey: string
      adapterVersion: number
      clientAuthority: OAuthStateRecord['authority']
    }): Promise<boolean>
    abandonPendingAuthorization(input: {
      id: string
      localFlowId: string
      code: string
    }): Promise<'updated' | 'changed' | 'not_found'>
  }
  flowReceipts: AuthorizationFlowReceiptRepository
  stageRevocationArtifact(input: {
    credentialRef: string
    credential: string
    providerKey: string
    adapterVersion: number
    clientAuthority: OAuthStateRecord['authority']
    actor: string
  }): Promise<void>
  connectionService: {
    create(input: {
      providerKey: string
      adapterVersion: number
      displayName: string
      configuration: C
      credential: string
      actor: string
      authorizationGrant: true
      clientAuthority: OAuthStateRecord['authority']
      authorizationFlowId?: string
      stagedCredentialRef?: string
    }): Promise<{ id: string }>
    validate(id: string, actor?: string, options?: { allowAuthenticationRefresh?: boolean }): Promise<unknown>
    enable(id: string, actor?: string, authorizationFlowId?: string): Promise<unknown>
    remove(id: string, actor?: string, confirmAssigned?: boolean): Promise<void>
    rollbackPendingLocal(id: string, credentialRef: string): Promise<void>
  }
  credentials: {
    set(key: string, value: string, actor: string): Promise<void>
    delete(key: string): Promise<void>
  }
  identity(configuration: C): Readonly<Record<string, string | number>>
  plugin: OAuthPlugin<C>
  transport: Pick<OAuthTransport, 'authority' | 'revoke'>
  lease: { runExclusiveMany<T>(resources: readonly string[], operation: () => Promise<T>): Promise<T> }
  uuid?: () => string
  reproject?: (connectionId: string) => Promise<void>
}

function isRetryableCleanupFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'staged_credential_cleanup_failed'
  )
}

interface LocalArtifactPlan {
  credentialRef: string
  materialRevision?: string
}

export class OAuthConnectionAuthorizer<C> {
  readonly #dependencies: OAuthConnectionAuthorizerDependencies<C>
  readonly #uuid: () => string

  constructor(dependencies: OAuthConnectionAuthorizerDependencies<C>) {
    this.#dependencies = dependencies
    this.#uuid = dependencies.uuid ?? (() => crypto.randomUUID())
  }

  async install(input: {
    intent: OAuthStateRecord
    userId: string
    grant?: OAuthGrant<C>
    exchange?: () => Promise<AuthorizationGrant<unknown, unknown>>
  }): Promise<void> {
    if ((input.intent.purpose ?? 'integration') !== 'integration') {
      throw new Error('OAuth integration authorization purpose mismatch')
    }
    if (input.intent.providerKey !== this.#dependencies.plugin.key || input.userId !== input.intent.userId) {
      throw new Error('OAuth authorization binding mismatch')
    }
    if (input.intent.authority !== this.#dependencies.transport.authority) {
      throw new Error('OAuth client authority mismatch')
    }
    if (input.intent.intent === 'reconnect' && (!input.intent.connectionId || !input.intent.expectedMaterialRevision)) {
      throw new Error('Invalid reconnect intent')
    }
    const localArtifact =
      !input.intent.localFlowId && this.#dependencies.transport.authority === 'local'
        ? input.intent.intent === 'reconnect'
          ? (() => {
              const materialRevision = this.#uuid()
              return {
                materialRevision,
                credentialRef: `__integration-credential:${input.intent.connectionId}:${materialRevision}:bearer`,
              }
            })()
          : { credentialRef: `__integration-credential:rollback:${this.#uuid()}:bearer` }
        : undefined
    const resources = [
      ...(input.intent.localFlowId ? [`flow:${input.intent.localFlowId}`] : []),
      ...(input.intent.intent === 'reconnect' ? [input.intent.connectionId!] : []),
      ...(localArtifact ? [revocationArtifactLeaseResource(localArtifact.credentialRef)] : []),
    ]
    await this.#dependencies.lease.runExclusiveMany(resources, () => this.#installOnce(input, localArtifact))
  }

  async #installOnce(
    input: {
      intent: OAuthStateRecord
      userId: string
      grant?: OAuthGrant<C>
      exchange?: () => Promise<AuthorizationGrant<unknown, unknown>>
    },
    localArtifact?: LocalArtifactPlan
  ): Promise<void> {
    const authorizationFlowId = input.intent.localFlowId ?? undefined
    if (authorizationFlowId) {
      const receipt = await this.#receiptForRetry(authorizationFlowId, input.intent)
      if (receipt.installKind) return
      if (receipt.terminalAt || receipt.revocationRequiredAt || receipt.cleanupRequiredAt) {
        throw new AuthorizationGrantAbandonedError(receipt.terminalCode ?? 'Authorization flow disposed')
      }
      await this.#requireEligibleFlow(authorizationFlowId)
      const existing = await this.#dependencies.repository.getByAuthorizationFlow(authorizationFlowId)
      if (existing) {
        await this.#resumeFlowConnection(existing, input.intent, input.userId)
        return
      }
    }
    if (input.intent.intent !== 'reconnect') {
      const grant = await this.#resolveGrant(input, authorizationFlowId, localArtifact?.credentialRef)
      await this.#stageGrant(grant, authorizationFlowId)
      await this.#validateOrRevoke(grant, authorizationFlowId, localArtifact?.credentialRef)
      await this.#createDistinct(grant, input.intent, input.userId, authorizationFlowId, localArtifact?.credentialRef)
      return
    }
    if (!input.intent.connectionId || !input.intent.expectedMaterialRevision) {
      throw new Error('Invalid reconnect intent')
    }
    if (authorizationFlowId) await this.#requireEligibleFlow(authorizationFlowId)
    const installed = authorizationFlowId
      ? await this.#dependencies.repository.getByAuthorizationFlow(authorizationFlowId)
      : null
    if (installed) {
      await this.#resumeFlowConnection(installed, input.intent, input.userId)
      return
    }
    const target = await this.#dependencies.repository.get(input.intent.connectionId!)
    if (
      !target ||
      target.providerKey !== this.#dependencies.plugin.key ||
      target.adapterVersion !== this.#dependencies.plugin.adapterVersion ||
      target.materialRevision !== input.intent.expectedMaterialRevision
    ) {
      throw new Error('Reconnect target changed')
    }
    let targetConfiguration: C
    try {
      targetConfiguration = this.#dependencies.plugin.connection.parseConfiguration(target.configuration)
    } catch {
      throw new Error('Reconnect target changed')
    }
    const grant = await this.#resolveGrant(input, authorizationFlowId, localArtifact?.credentialRef)
    await this.#stageGrant(grant, authorizationFlowId)
    await this.#validateOrRevoke(grant, authorizationFlowId, localArtifact?.credentialRef)
    if (!this.#sameIdentity(targetConfiguration, grant.configuration)) {
      await this.#createDistinct(grant, input.intent, input.userId, authorizationFlowId, localArtifact?.credentialRef)
      return
    }
    await this.#installReconnect(
      { id: target.id, configuration: targetConfiguration },
      grant,
      input.intent,
      input.userId,
      input.intent.expectedMaterialRevision!,
      authorizationFlowId,
      localArtifact
    )
  }

  async #receiptForRetry(localFlowId: string, intent: OAuthStateRecord): Promise<AuthorizationFlowReceipt> {
    const receipt = await this.#dependencies.flowReceipts.get(localFlowId, {
      providerKey: intent.providerKey,
      authority: intent.authority,
      intent: intent.intent,
      userId: intent.userId,
      connectionId: intent.connectionId,
      expectedMaterialRevision: intent.expectedMaterialRevision,
    })
    const bindingMatches =
      receipt?.providerKey === intent.providerKey &&
      receipt.authority === intent.authority &&
      receipt.intent === intent.intent &&
      receipt.initiatingUserId === intent.userId &&
      receipt.sourceConnectionId === intent.connectionId &&
      receipt.sourceMaterialRevision === intent.expectedMaterialRevision
    const compatibleInstall =
      !receipt?.installKind ||
      (intent.intent === 'connect' && receipt.installKind === 'connect' && receipt.installedConnectionId !== null) ||
      (intent.intent === 'reconnect' &&
        ((receipt.installKind === 'reconnect_same' && receipt.installedConnectionId === intent.connectionId) ||
          (receipt.installKind === 'reconnect_distinct' &&
            receipt.installedConnectionId !== null &&
            receipt.installedConnectionId !== intent.connectionId)))
    if (!receipt || !bindingMatches || !compatibleInstall) {
      throw new Error('Authorization flow receipt mismatch')
    }
    return receipt
  }

  async #requireEligibleFlow(localFlowId: string): Promise<AuthorizationFlowReceipt> {
    const receipt = await this.#dependencies.flowReceipts.beginStaging(
      localFlowId,
      this.#dependencies.plugin.adapterVersion
    )
    if (!receipt) throw new AuthorizationGrantAbandonedError('Authorization flow expired', 'flow_expired')
    return receipt
  }

  async #stageGrant(grant: Pick<OAuthGrant<C>, 'credential'>, authorizationFlowId?: string): Promise<void> {
    if (!authorizationFlowId) return
    const receipt = await this.#dependencies.flowReceipts.beginStaging(
      authorizationFlowId,
      this.#dependencies.plugin.adapterVersion
    )
    if (!receipt) throw new Error('Authorization flow artifact unavailable')
    await this.#dependencies.credentials.set(
      receipt.artifactCredentialRef,
      this.#dependencies.plugin.connection.credential.serialize(grant.credential),
      'system:oauth-authorization-staging'
    )
  }

  async #resumeFlowConnection(
    existing: IntegrationConnectionRecord,
    intent: OAuthStateRecord,
    userId: string
  ): Promise<void> {
    if (
      existing.providerKey !== this.#dependencies.plugin.key ||
      existing.adapterVersion !== this.#dependencies.plugin.adapterVersion ||
      existing.clientAuthority !== intent.authority
    ) {
      throw new Error('Authorization flow connection mismatch')
    }
    const receipt = intent.localFlowId ? await this.#dependencies.flowReceipts.get(intent.localFlowId) : null
    if (receipt?.installKind) return
    try {
      await this.#dependencies.connectionService.validate(existing.id, `user:${userId}`, {
        allowAuthenticationRefresh: false,
      })
      await this.#dependencies.connectionService.enable(existing.id, `user:${userId}`, intent.localFlowId ?? undefined)
    } catch (error) {
      const reconciled = intent.localFlowId ? await this.#dependencies.flowReceipts.get(intent.localFlowId) : null
      if (reconciled?.installKind) return
      await this.#removePendingConnection(existing.id, intent, userId, error)
    }
  }

  async #removePendingConnection(
    connectionId: string,
    intent: OAuthStateRecord,
    userId: string,
    originalError: unknown,
    stagedCredentialRef?: string
  ): Promise<never> {
    if (intent.localFlowId) {
      const status = await this.#dependencies.repository.abandonPendingAuthorization({
        id: connectionId,
        localFlowId: intent.localFlowId,
        code: 'grant_abandoned',
      })
      if (status !== 'updated') throw new Error('Pending authorization cleanup failed')
    } else {
      if (!stagedCredentialRef) throw new Error('Pending authorization cleanup failed')
      await this.#dependencies.connectionService.rollbackPendingLocal(connectionId, stagedCredentialRef)
    }
    throw new AuthorizationGrantAbandonedError(
      originalError instanceof Error ? originalError.message : 'Pending authorization install failed'
    )
  }

  async #resolveGrant(
    input: {
      grant?: OAuthGrant<C>
      exchange?: () => Promise<AuthorizationGrant<unknown, unknown>>
    },
    authorizationFlowId?: string,
    stagedCredentialRef?: string
  ): Promise<OAuthGrant<C>> {
    if (input.grant) return input.grant
    if (!input.exchange) throw new Error('Authorization grant unavailable')
    const grant = await input.exchange()
    const credential = this.#dependencies.plugin.connection.credential.parse(
      this.#dependencies.plugin.connection.credential.serialize(grant.credential as OAuthCredentialBundleV1)
    )
    const authorization = this.#dependencies.plugin.authorization
    if (grant.configuration === null && authorization.kind === 'oauth2' && authorization.resolveGrantIdentity) {
      // The app code has already been consumed. Give cleanup durable ownership
      // before making another provider request, including on a failed callback.
      if (authorizationFlowId) await this.#stageGrant({ credential }, authorizationFlowId)
      else if (stagedCredentialRef) await this.#stageLocalRevocationArtifact(stagedCredentialRef, { credential })
      else throw new Error('Authorization artifact unavailable')
      const identity = await authorization.resolveGrantIdentity(credential)
      return { ...identity, credential }
    }
    return {
      configuration: this.#dependencies.plugin.connection.parseConfiguration(grant.configuration),
      credential,
      displayName: String(grant.displayName),
    }
  }

  async #validateOrRevoke(
    grant: OAuthGrant<C>,
    authorizationFlowId?: string,
    stagedCredentialRef?: string
  ): Promise<void> {
    if (this.#dependencies.plugin.authorization.kind !== 'oauth2') throw new Error('OAuth unavailable')
    const validation = await this.#dependencies.plugin.authorization.validate({
      configuration: grant.configuration,
      credential: grant.credential,
    })
    if (validation.ok) return
    await this.#revokeNewGrant(grant, authorizationFlowId, stagedCredentialRef)
    throw new AuthorizationGrantAbandonedError(
      `${this.#dependencies.plugin.presentation.label} grant validation failed`
    )
  }

  async #createDistinct(
    grant: OAuthGrant<C>,
    intent: OAuthStateRecord,
    userId: string,
    authorizationFlowId?: string,
    stagedCredentialRef?: string
  ): Promise<void> {
    const displayName = await this.#uniqueDisplayName(grant.displayName)
    if (stagedCredentialRef) {
      try {
        await this.#stageLocalRevocationArtifact(stagedCredentialRef, grant)
      } catch (error) {
        await this.#revokeNewGrant(grant, undefined, stagedCredentialRef)
        throw new AuthorizationGrantAbandonedError(error instanceof Error ? error.message : 'Credential staging failed')
      }
    }
    let createdId: string | null = null
    try {
      const created = await this.#dependencies.connectionService.create({
        providerKey: this.#dependencies.plugin.key,
        adapterVersion: this.#dependencies.plugin.adapterVersion,
        displayName,
        configuration: grant.configuration,
        credential: this.#dependencies.plugin.connection.credential.serialize(grant.credential),
        actor: `user:${userId}`,
        authorizationGrant: true,
        clientAuthority: this.#dependencies.transport.authority,
        authorizationFlowId,
        stagedCredentialRef,
      })
      createdId = created.id
      await this.#dependencies.connectionService.enable(created.id, `user:${userId}`, authorizationFlowId)
    } catch (error) {
      if (error instanceof IntegrationConnectionCreateCommittedError) createdId = error.connectionId
      if (authorizationFlowId) {
        const receipt = await this.#dependencies.flowReceipts.get(authorizationFlowId)
        if (receipt?.installKind) return
      }
      if (!createdId && authorizationFlowId) {
        let committed: IntegrationConnectionRecord | null
        try {
          committed = await this.#dependencies.repository.getByAuthorizationFlow(authorizationFlowId)
        } catch {
          // The create outcome remains ambiguous. Preserve the deterministic
          // staged credential and let the completion flow retry.
          throw error
        }
        if (committed) {
          await this.#resumeFlowConnection(committed, intent, userId)
          return
        }
      }
      if (isRetryableCleanupFailure(error)) throw error
      if (createdId) await this.#removePendingConnection(createdId, intent, userId, error, stagedCredentialRef)
      if (authorizationFlowId) await this.#revokeNewGrant(grant, authorizationFlowId)
      throw new AuthorizationGrantAbandonedError(error instanceof Error ? error.message : 'Connection creation failed')
    }
  }
  async #installReconnect(
    target: { id: string; configuration: C },
    grant: OAuthGrant<C>,
    intent: OAuthStateRecord,
    userId: string,
    expectedMaterialRevision: string,
    authorizationFlowId?: string,
    localArtifact?: LocalArtifactPlan
  ): Promise<void> {
    const materialRevision = localArtifact?.materialRevision ?? this.#uuid()
    const credentialRef = authorizationFlowId
      ? `__integration-credential:authorization-flow:${authorizationFlowId}:bearer`
      : localArtifact!.credentialRef
    try {
      if (authorizationFlowId) {
        await this.#dependencies.credentials.set(
          credentialRef,
          this.#dependencies.plugin.connection.credential.serialize(grant.credential),
          `user:${userId}`
        )
      } else {
        await this.#stageLocalRevocationArtifact(credentialRef, grant)
      }
    } catch (error) {
      // A flow-scoped write may have committed before its acknowledgement was
      // lost. Its deterministic reference is safe to overwrite on retry.
      if (authorizationFlowId) throw error
      await this.#revokeNewGrant(grant, undefined, credentialRef)
      throw new AuthorizationGrantAbandonedError(error instanceof Error ? error.message : 'Credential staging failed')
    }

    let result: { status: 'updated' | 'changed' | 'not_found' } | null = null
    try {
      result = await this.#dependencies.repository.installAuthorizedMaterial({
        id: target.id,
        expectedMaterialRevision,
        expectedProviderKey: this.#dependencies.plugin.key,
        expectedAdapterVersion: this.#dependencies.plugin.adapterVersion,
        expectedIdentity: this.#dependencies.identity(target.configuration),
        configuration: grant.configuration,
        credentialRef,
        materialRevision,
        displayName: grant.displayName,
        updatedByUserId: userId,
        clientAuthority: this.#dependencies.transport.authority,
        authorizationFlowId,
        adoptStagedRevocationRef: authorizationFlowId === undefined ? credentialRef : undefined,
      })
    } catch (error) {
      let current: IntegrationConnectionRecord | null
      try {
        current = await this.#dependencies.repository.get(target.id)
      } catch {
        // Ambiguous commit: never compensate a credential that may already be
        // authoritative.
        throw error
      }
      let currentConfiguration: C | null = null
      try {
        currentConfiguration = current
          ? this.#dependencies.plugin.connection.parseConfiguration(current.configuration)
          : null
      } catch {
        // A mismatched/malformed row is not a committed install.
      }
      if (
        current?.providerKey === this.#dependencies.plugin.key &&
        current.adapterVersion === this.#dependencies.plugin.adapterVersion &&
        current.credentialRef === credentialRef &&
        current.materialRevision === materialRevision &&
        current.clientAuthority === this.#dependencies.transport.authority &&
        currentConfiguration !== null &&
        this.#sameIdentity(currentConfiguration, grant.configuration)
      ) {
        await this.#dependencies.reproject?.(target.id).catch(() => {})
        return
      }
      if (authorizationFlowId) {
        const committed = await this.#dependencies.repository.getByAuthorizationFlow(authorizationFlowId)
        if (committed) {
          await this.#resumeFlowConnection(committed, intent, userId)
          await this.#dependencies.reproject?.(target.id).catch(() => {})
          return
        }
      }
      await this.#rollbackStagedGrant(credentialRef, grant, authorizationFlowId, error)
    }
    if (!result || result.status !== 'updated') {
      await this.#rollbackStagedGrant(credentialRef, grant, authorizationFlowId, new Error('Reconnect target changed'))
    }
    // Persistence is the commit boundary. A projection repair failure must not
    // delete or revoke the newly-authoritative credential; the durable
    // projection generation remains pending for worker retry.
    await this.#dependencies.reproject?.(target.id).catch(() => {})
  }
  #sameIdentity(left: C, right: C): boolean {
    const expected = this.#dependencies.identity(left)
    const actual = this.#dependencies.identity(right)
    const keys = Object.keys(expected)
    return (
      keys.length > 0 &&
      keys.length === Object.keys(actual).length &&
      keys.every((key) => Object.hasOwn(actual, key) && expected[key] === actual[key])
    )
  }

  async #uniqueDisplayName(candidate: string): Promise<string> {
    const normalized = candidate.trim().slice(0, 200) || this.#dependencies.plugin.presentation.label
    const existing = new Set(
      (await this.#dependencies.repository.list(this.#dependencies.plugin.key)).map((row) => row.displayName)
    )
    if (!existing.has(normalized)) return normalized
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const ending = ` (${suffix})`
      const value = `${normalized.slice(0, 200 - ending.length)}${ending}`
      if (!existing.has(value)) return value
    }
    throw new Error('Connection display name unavailable')
  }

  async #rollbackStagedGrant(
    credentialRef: string,
    grant: OAuthGrant<C>,
    authorizationFlowId: string | undefined,
    error: unknown
  ): Promise<never> {
    if (authorizationFlowId) {
      await this.#revokeNewGrant(grant, authorizationFlowId)
      throw new AuthorizationGrantAbandonedError(error instanceof Error ? error.message : 'Reconnect failed')
    }
    // Preserve the staged credential until an authority-owned revocation job
    // has consumed it. The artifact and job are committed atomically below.
    await this.#revokeNewGrant(grant, authorizationFlowId, credentialRef)
    throw new AuthorizationGrantAbandonedError(error instanceof Error ? error.message : 'Reconnect failed')
  }

  #ownsLocalRevocation(credentialRef: string): Promise<boolean> {
    return this.#dependencies.repository.ownsRevocation({
      credentialRef,
      providerKey: this.#dependencies.plugin.key,
      adapterVersion: this.#dependencies.plugin.adapterVersion,
      clientAuthority: this.#dependencies.transport.authority,
    })
  }

  async #stageLocalRevocationArtifact(credentialRef: string, grant: Pick<OAuthGrant<C>, 'credential'>): Promise<void> {
    try {
      await this.#dependencies.stageRevocationArtifact({
        credentialRef,
        credential: this.#dependencies.plugin.connection.credential.serialize(grant.credential),
        providerKey: this.#dependencies.plugin.key,
        adapterVersion: this.#dependencies.plugin.adapterVersion,
        clientAuthority: this.#dependencies.transport.authority,
        actor: 'system:oauth-rollback',
      })
    } catch (error) {
      // A transaction commit may have succeeded before its acknowledgement was
      // lost. The durable job is the ownership proof; never create a second ref.
      if (await this.#ownsLocalRevocation(credentialRef)) return
      throw error
    }
  }

  async #revokeNewGrant(
    grant: OAuthGrant<C>,
    authorizationFlowId?: string,
    stagedCredentialRef?: string
  ): Promise<void> {
    if (this.#dependencies.plugin.authorization.kind !== 'oauth2') return
    if (authorizationFlowId) {
      const receipt = await this.#dependencies.flowReceipts.requireRevocation({
        localFlowId: authorizationFlowId,
        adapterVersion: this.#dependencies.plugin.adapterVersion,
        code: 'grant_abandoned',
      })
      if (!receipt?.revocationRequiredAt) throw new Error('Authorization revocation could not be made durable')
      return
    }
    const credentialRef = stagedCredentialRef ?? `__integration-credential:rollback:${this.#uuid()}:bearer`
    if (stagedCredentialRef && (await this.#ownsLocalRevocation(credentialRef))) return
    await this.#stageLocalRevocationArtifact(credentialRef, grant)
  }
}
