import type { OAuthClientBinding } from '@ficus/shared/oauth-providers/types'
import { GitHubOAuthClient, type GitHubDeviceAuthorization } from '@ficus/shared/oauth-providers/github/client'
import { classifyGitHubOAuthError } from '@ficus/shared/oauth-providers'
import type { GitHubConnectionConfiguration } from '@ficus/shared/oauth-providers/github/config'
import type { AuthorizationFlowReceipt, AuthorizationFlowReceiptRepository } from './flow-repository'
import type { OAuthCredentialBundleV1 } from './credential-bundle'
import type { OAuthStateRecord } from './state-repository'
import type { AuthorizationGrant } from '../plugin'
import { AuthorizationFlowError, isSafeReturnTarget } from './service'

export interface DeviceAuthorizationRecord {
  id: string
  userId: string
  clientBinding: OAuthClientBinding
  deviceCode: string | null
  status: 'pending' | 'authorized'
  intervalSeconds: number
  nextPollAt: Date
  expiresAt: Date
  receipt: AuthorizationFlowReceipt
}

export interface DeviceAuthorizationRepository {
  create(input: {
    id: string
    userId: string
    clientBinding: OAuthClientBinding
    device: GitHubDeviceAuthorization
    returnTo: string
    connectionId: string | null
    expectedMaterialRevision: string | null
  }): Promise<{ expiresAt: Date }>
  get(id: string, userId: string): Promise<DeviceAuthorizationRecord | null>
  defer(id: string, intervalSeconds: number): Promise<void>
  stage(record: DeviceAuthorizationRecord, credential: OAuthCredentialBundleV1): Promise<void>
  credential(record: DeviceAuthorizationRecord): Promise<OAuthCredentialBundleV1>
  remove(id: string): Promise<void>
}

export interface DeviceAuthorizationDependencies {
  repository: DeviceAuthorizationRepository
  receipts: AuthorizationFlowReceiptRepository
  client: Pick<GitHubOAuthClient, 'startDevice' | 'pollDevice' | 'currentUser'>
  /** Device authorization is local; never bypass the hosted authority boundary. */
  requireLocal(): void
  resolveClient(): OAuthClientBinding | undefined
  lease: { runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> }
  install(input: {
    state: OAuthStateRecord
    userId: string
    grant: AuthorizationGrant<GitHubConnectionConfiguration, OAuthCredentialBundleV1>
  }): Promise<void>
  now?: () => Date
  uuid?: () => string
}

export type DeviceAuthorizationPollResult =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'complete'; returnTo: string }
  | { status: 'failed'; code: string }

export class DeviceAuthorizationService {
  readonly #now: () => Date
  constructor(private readonly dependencies: DeviceAuthorizationDependencies) {
    this.#now = dependencies.now ?? (() => new Date())
  }

  async start(input: { userId: string; returnTo: string; connectionId?: string; expectedMaterialRevision?: string }) {
    this.dependencies.requireLocal()
    if (!isSafeReturnTarget(input.returnTo)) throw new AuthorizationFlowError('unsafe_return_target')
    if (Boolean(input.connectionId) !== Boolean(input.expectedMaterialRevision))
      throw new AuthorizationFlowError('invalid_reconnect_target')
    const clientBinding = this.dependencies.resolveClient()
    if (!clientBinding) throw new AuthorizationFlowError('oauth_app_unconfigured')
    const device = await this.dependencies.client.startDevice({ clientId: clientBinding.clientId })
    const id = this.dependencies.uuid?.() ?? crypto.randomUUID()
    const { expiresAt } = await this.dependencies.repository.create({
      id,
      userId: input.userId,
      clientBinding,
      device,
      returnTo: input.returnTo,
      connectionId: input.connectionId ?? null,
      expectedMaterialRevision: input.expectedMaterialRevision ?? null,
    })
    return {
      kind: 'device' as const,
      id,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: expiresAt.toISOString(),
      intervalSeconds: device.interval,
    }
  }

  async poll(input: { id: string; userId: string }): Promise<DeviceAuthorizationPollResult> {
    this.dependencies.requireLocal()
    return this.dependencies.lease.runExclusive(`device:${input.id}`, async () => {
      // The flow lock also excludes the existing receipt sweeper while a
      // provider exchange and durable token staging are in progress.
      const prepared = await this.dependencies.lease.runExclusive(`flow:${input.id}`, async () => {
        let record = await this.#requireRecord(input)
        const settled = this.#settled(record.receipt)
        if (settled) return { result: settled }
        if (record.status === 'authorized' && record.receipt.recoveryExpiresAt <= this.#now()) {
          await this.dependencies.receipts.requireRevocation({
            localFlowId: record.id,
            adapterVersion: 1,
            code: 'flow_expired',
          })
          await this.dependencies.repository.remove(record.id)
          return { result: { status: 'failed' as const, code: 'flow_expired' } }
        }
        if (record.status === 'pending') {
          if (record.expiresAt <= this.#now()) {
            await this.dependencies.receipts.markTerminal(record.id, 'flow_expired')
            await this.dependencies.repository.remove(record.id)
            return { result: { status: 'failed' as const, code: 'flow_expired' } }
          }
          const remaining = record.nextPollAt.getTime() - this.#now().getTime()
          if (remaining > 0)
            return { result: { status: 'pending' as const, retryAfterSeconds: Math.ceil(remaining / 1000) } }
          await this.dependencies.repository.defer(record.id, record.intervalSeconds)
          let polled
          try {
            polled = await this.dependencies.client.pollDevice({
              clientId: record.clientBinding.clientId,
              deviceCode: record.deviceCode!,
            })
          } catch (error) {
            const failure = classifyGitHubOAuthError(error)
            if (failure.retryable)
              return { result: { status: 'pending' as const, retryAfterSeconds: record.intervalSeconds } }
            await this.dependencies.receipts.markTerminal(record.id, failure.code)
            await this.dependencies.repository.remove(record.id)
            return { result: { status: 'failed' as const, code: failure.code } }
          }
          if (polled.status !== 'authorized') {
            const interval =
              polled.status === 'slow_down'
                ? Math.min(3600, Math.max(record.intervalSeconds + 5, polled.interval ?? 0))
                : record.intervalSeconds
            await this.dependencies.repository.defer(record.id, interval)
            return { result: { status: 'pending' as const, retryAfterSeconds: interval } }
          }
          await this.dependencies.repository.stage(record, {
            version: 1,
            ...polled.tokens,
            tokenRevision: 1,
            clientBinding: record.clientBinding,
          })
          record = await this.#requireRecord(input)
        }
        return { record }
      })
      if (prepared.result) return prepared.result
      const record = prepared.record!
      const credential = await this.dependencies.repository.credential(record)
      // This lookup can be retried without repeating the one-time exchange.
      let configuration: GitHubConnectionConfiguration
      try {
        configuration = await this.dependencies.client.currentUser({ accessToken: credential.accessToken })
      } catch (error) {
        const failure = classifyGitHubOAuthError(error)
        if (failure.retryable) return { status: 'pending', retryAfterSeconds: record.intervalSeconds }
        await this.dependencies.lease.runExclusive(`flow:${record.id}`, () =>
          this.dependencies.receipts.requireRevocation({
            localFlowId: record.id,
            adapterVersion: 1,
            code: failure.code,
          })
        )
        return { status: 'failed', code: failure.code }
      }
      const receipt = record.receipt
      const state: OAuthStateRecord = {
        stateHash: receipt.completionHandleHash,
        localFlowId: record.id,
        authority: 'local',
        completionHandleHash: receipt.completionHandleHash,
        recoveryExpiresAt: receipt.recoveryExpiresAt,
        providerKey: 'github',
        userId: input.userId,
        intent: receipt.intent,
        connectionId: receipt.sourceConnectionId,
        expectedMaterialRevision: receipt.sourceMaterialRevision,
        redirectUri: '',
        returnTo: receipt.returnTo,
        expiresAt: receipt.recoveryExpiresAt,
        createdAt: this.#now(),
      }
      await this.dependencies.install({
        state,
        userId: input.userId,
        grant: { configuration, credential, displayName: configuration.login },
      })
      const installed = await this.dependencies.receipts.get(record.id)
      if (!installed?.installKind) throw new AuthorizationFlowError('grant_persistence_failed')
      return { status: 'complete', returnTo: installed.returnTo }
    })
  }

  async cancel(input: { id: string; userId: string }): Promise<void> {
    this.dependencies.requireLocal()
    await this.dependencies.lease.runExclusive(`device:${input.id}`, () =>
      this.dependencies.lease.runExclusive(`flow:${input.id}`, async () => {
        const record = await this.#requireRecord(input)
        if (record.receipt.installKind) return
        if (record.status === 'authorized') {
          await this.dependencies.receipts.requireRevocation({
            localFlowId: record.id,
            adapterVersion: 1,
            code: 'provider_denied',
          })
        } else await this.dependencies.receipts.markTerminal(record.id, 'provider_denied')
        await this.dependencies.repository.remove(record.id)
      })
    )
  }

  async #requireRecord(input: { id: string; userId: string }): Promise<DeviceAuthorizationRecord> {
    const record = await this.dependencies.repository.get(input.id, input.userId)
    if (
      !record ||
      record.receipt.initiatingUserId !== input.userId ||
      record.receipt.providerKey !== 'github' ||
      record.receipt.authority !== 'local'
    ) {
      throw new AuthorizationFlowError('invalid_or_expired_state')
    }
    return record
  }

  #settled(receipt: AuthorizationFlowReceipt): DeviceAuthorizationPollResult | undefined {
    if (receipt.installKind) return { status: 'complete', returnTo: receipt.returnTo }
    if (receipt.terminalAt) return { status: 'failed', code: receipt.terminalCode ?? 'flow_expired' }
    return undefined
  }
}
