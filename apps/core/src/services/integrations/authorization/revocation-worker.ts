import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  db,
  integrationAuthorizationFlowReceipts,
  integrationConnections,
  integrationCredentialCleanupJobs,
  integrationRevocationJobs,
  secrets,
} from '../../../db'
import { createPeriodicRunner, type PeriodicRunner } from '../../../lib/infra/PeriodicRunner'
import type { IntegrationAuditRecorder } from '../audit'
import { connectionAuthorizationLeaseKey, revocationArtifactLeaseResource } from './connection-lease'
import { parseOAuthCredential } from './credential-bundle'
import { OAuthTransportError } from './transport'
import type { OAuthRevocationTransportResolver } from './revocation-transport'
import { PlatformRequestError } from '../../platform/instance-client'
import { BrokerUnconfiguredError } from './authority'
import { isGitHubIdentityTokenShared } from '../github/personal-oauth-finalizer'

const LEASE_MS = 60_000
const MAX_BACKOFF_MS = 15 * 60_000
const TERMINAL_ALREADY_INVALID = new Set(['invalid_grant', 'invalid_auth', 'already_revoked'])
const RETRYABLE_BROKER_ACCESS_FAILURES = new Set(['broker_unauthorized', 'insufficient_scope'])

export interface RevocationJob {
  id: string
  providerKey: string
  adapterVersion: number
  clientAuthority: 'local' | 'platform_broker'
  credentialRef: string
  authorizationFlowId: string | null
  attempts: number
  leaseToken: string
}

export interface IntegrationRevocationRepository {
  claim(now: Date, leaseExpiresAt: Date, leaseToken: string): Promise<RevocationJob | null>
  complete(job: RevocationJob): Promise<void>
  fail(input: {
    id: string
    leaseToken: string
    attempts: number
    nextAttemptAt: Date
    backoffMs: number
    code: string
  }): Promise<void>
  failTerminal(input: { id: string; leaseToken: string; attempts: number; code: string; at: Date }): Promise<void>
}

export class DbIntegrationRevocationRepository implements IntegrationRevocationRepository {
  constructor(private readonly eligibleCredentialRefs?: readonly string[]) {}
  async claim(_now: Date, _leaseExpiresAt: Date, leaseToken: string): Promise<RevocationJob | null> {
    return db.transaction(async (tx) => {
      const eligibility = and(
        isNull(integrationRevocationJobs.terminalAt),
        lte(integrationRevocationJobs.nextAttemptAt, sql`clock_timestamp()`),
        or(
          isNull(integrationRevocationJobs.leaseToken),
          lte(integrationRevocationJobs.leaseExpiresAt, sql`clock_timestamp()`)
        ),
        this.eligibleCredentialRefs
          ? inArray(integrationRevocationJobs.credentialRef, [...this.eligibleCredentialRefs])
          : undefined
      )
      const candidates = await tx
        .select({ id: integrationRevocationJobs.id, credentialRef: integrationRevocationJobs.credentialRef })
        .from(integrationRevocationJobs)
        .where(eligibility)
        .orderBy(asc(integrationRevocationJobs.nextAttemptAt), asc(integrationRevocationJobs.id))
        .limit(20)
      let job: typeof integrationRevocationJobs.$inferSelect | undefined
      for (const candidate of candidates) {
        const leaseKey = connectionAuthorizationLeaseKey(revocationArtifactLeaseResource(candidate.credentialRef))
        const [advisory] = await tx
          .select({ acquired: sql<boolean>`pg_try_advisory_xact_lock(hashtextextended(${leaseKey}, 0))` })
          .from(integrationRevocationJobs)
          .where(eq(integrationRevocationJobs.id, candidate.id))
        if (!advisory?.acquired) continue
        const [claimed] = await tx
          .select()
          .from(integrationRevocationJobs)
          .where(and(eq(integrationRevocationJobs.id, candidate.id), eligibility))
          .for('update')
        if (claimed) {
          job = claimed
          break
        }
      }
      if (!job) return null
      await tx
        .update(integrationRevocationJobs)
        .set({
          leaseToken,
          leaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(integrationRevocationJobs.id, job.id))
      await tx
        .delete(integrationConnections)
        .where(
          and(
            eq(integrationConnections.credentialRef, job.credentialRef),
            eq(integrationConnections.providerKey, job.providerKey),
            eq(integrationConnections.adapterVersion, job.adapterVersion),
            eq(integrationConnections.clientAuthority, job.clientAuthority),
            eq(integrationConnections.enabled, false)
          )
        )
      return {
        id: job.id,
        providerKey: job.providerKey,
        adapterVersion: job.adapterVersion,
        clientAuthority: job.clientAuthority as RevocationJob['clientAuthority'],
        credentialRef: job.credentialRef,
        authorizationFlowId: job.authorizationFlowId,
        attempts: job.attempts,
        leaseToken,
      }
    })
  }

  async complete(job: RevocationJob): Promise<void> {
    await db.transaction(async (tx) => {
      const [owned] = await tx
        .select()
        .from(integrationRevocationJobs)
        .where(
          and(
            eq(integrationRevocationJobs.id, job.id),
            eq(integrationRevocationJobs.leaseToken, job.leaseToken),
            gt(integrationRevocationJobs.leaseExpiresAt, sql`clock_timestamp()`)
          )
        )
        .for('update')
      if (
        !owned ||
        owned.providerKey !== job.providerKey ||
        owned.adapterVersion !== job.adapterVersion ||
        owned.clientAuthority !== job.clientAuthority ||
        owned.credentialRef !== job.credentialRef ||
        owned.authorizationFlowId !== job.authorizationFlowId ||
        owned.terminalAt
      ) {
        throw new Error('Revocation lease lost')
      }
      const [artifact] = await tx
        .select({ key: secrets.key })
        .from(secrets)
        .where(eq(secrets.key, job.credentialRef))
        .limit(1)
      if (job.authorizationFlowId) {
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            revocationSettledAt: sql`coalesce(${integrationAuthorizationFlowReceipts.revocationSettledAt}, transaction_timestamp())`,
            cleanupRequiredAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupRequiredAt}, transaction_timestamp())`,
            ...(!artifact
              ? {
                  cleanupSettledAt: sql`coalesce(${integrationAuthorizationFlowReceipts.cleanupSettledAt}, transaction_timestamp())`,
                }
              : {}),
            updatedAt: sql`transaction_timestamp()`,
          })
          .where(
            and(
              eq(integrationAuthorizationFlowReceipts.localFlowId, job.authorizationFlowId),
              eq(integrationAuthorizationFlowReceipts.artifactCredentialRef, job.credentialRef)
            )
          )
      }
      if (artifact) {
        await tx
          .insert(integrationCredentialCleanupJobs)
          .values({ authorizationFlowId: job.authorizationFlowId, credentialRef: job.credentialRef })
          .onConflictDoNothing({ target: integrationCredentialCleanupJobs.credentialRef })
      }
      await tx
        .delete(integrationRevocationJobs)
        .where(and(eq(integrationRevocationJobs.id, job.id), eq(integrationRevocationJobs.leaseToken, job.leaseToken)))
    })
  }

  async fail(input: {
    id: string
    leaseToken: string
    attempts: number
    nextAttemptAt: Date
    backoffMs: number
    code: string
  }): Promise<void> {
    await db
      .update(integrationRevocationJobs)
      .set({
        attempts: input.attempts,
        nextAttemptAt: sql`clock_timestamp() + (${input.backoffMs} * interval '1 millisecond')`,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: input.code,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationRevocationJobs.id, input.id),
          eq(integrationRevocationJobs.leaseToken, input.leaseToken),
          gt(integrationRevocationJobs.leaseExpiresAt, sql`clock_timestamp()`)
        )
      )
  }

  async failTerminal(input: {
    id: string
    leaseToken: string
    attempts: number
    code: string
    at: Date
  }): Promise<void> {
    await db
      .update(integrationRevocationJobs)
      .set({
        attempts: input.attempts,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: input.code,
        terminalAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(integrationRevocationJobs.id, input.id),
          eq(integrationRevocationJobs.leaseToken, input.leaseToken),
          gt(integrationRevocationJobs.leaseExpiresAt, sql`clock_timestamp()`)
        )
      )
  }
}

interface RevocationPlugin {
  authorization: { kind: 'manual' } | { kind: 'oauth2'; adapter: string }
  classifyError(error: unknown): { code: string; retryable: boolean }
}

export interface IntegrationRevocationDependencies {
  repository: IntegrationRevocationRepository
  credentials: { get(key: string): string | undefined; refreshKey(key: string): Promise<void> }
  resolvePlugin(
    providerKey: string,
    adapterVersion: number,
    clientAuthority: RevocationJob['clientAuthority']
  ): RevocationPlugin | undefined
  revocationTransports: OAuthRevocationTransportResolver
  audit?: IntegrationAuditRecorder
  now?: () => Date
  uuid?: () => string
}

export class IntegrationRevocationWorker {
  readonly #dependencies: IntegrationRevocationDependencies
  readonly #now: () => Date
  readonly #uuid: () => string
  #runner: PeriodicRunner | null = null

  constructor(dependencies: IntegrationRevocationDependencies) {
    this.#dependencies = dependencies
    this.#now = dependencies.now ?? (() => new Date())
    this.#uuid = dependencies.uuid ?? (() => crypto.randomUUID())
  }

  async runOnce(): Promise<boolean> {
    const now = this.#now()
    const leaseToken = this.#uuid()
    const job = await this.#dependencies.repository.claim(now, new Date(now.getTime() + LEASE_MS), leaseToken)
    if (!job) return false
    const plugin = this.#dependencies.resolvePlugin(job.providerKey, job.adapterVersion, job.clientAuthority)
    await this.#dependencies.credentials.refreshKey(job.credentialRef)
    const raw = this.#dependencies.credentials.get(job.credentialRef)
    if (!raw) return this.#finish(job, 'credential_already_removed')
    let credential: ReturnType<typeof parseOAuthCredential>
    try {
      credential = parseOAuthCredential(raw)
    } catch {
      return this.#finish(job, 'credential_invalid')
    }
    if (job.providerKey === 'github' && job.authorizationFlowId) {
      try {
        const [receipt] = await db
          .select({ purpose: integrationAuthorizationFlowReceipts.purpose })
          .from(integrationAuthorizationFlowReceipts)
          .where(
            and(
              eq(integrationAuthorizationFlowReceipts.localFlowId, job.authorizationFlowId),
              eq(integrationAuthorizationFlowReceipts.artifactCredentialRef, job.credentialRef),
              eq(integrationAuthorizationFlowReceipts.authority, job.clientAuthority),
              eq(integrationAuthorizationFlowReceipts.providerKey, 'github')
            )
          )
        if (!receipt) return this.#retry(job, 'identity_flow_mismatch')
        if (
          receipt.purpose === 'github_identity' &&
          (await isGitHubIdentityTokenShared(credential, job.credentialRef, this.#dependencies.credentials))
        )
          return this.#finish(job, 'shared_token_retained')
      } catch {
        // Uncertain sharing must never become authority to remotely invalidate another connection.
        return this.#retry(job, 'shared_token_check_failed')
      }
    }
    if (!plugin || plugin.authorization.kind !== 'oauth2') return this.#retry(job, 'provider_unavailable')

    try {
      await this.#dependencies.revocationTransports.resolve(job.clientAuthority).revoke({
        providerKey: plugin.authorization.adapter,
        credentialRef: job.credentialRef,
        token: credential.accessToken,
        ...(credential.clientBinding ? { clientBinding: credential.clientBinding } : {}),
      })
      return this.#finish(job)
    } catch (error) {
      const failure =
        error instanceof PlatformRequestError
          ? { code: error.code, retryable: error.retryable }
          : error instanceof BrokerUnconfiguredError
            ? { code: error.code, retryable: true }
            : error instanceof OAuthTransportError
              ? { code: error.code, retryable: error.code === 'oauth_app_unconfigured' }
              : plugin.classifyError(error)
      const code = safeCode(failure.code)
      const retryable = failure.retryable || RETRYABLE_BROKER_ACCESS_FAILURES.has(code)
      if (
        code === 'manual_revocation_required' &&
        job.clientAuthority === 'local' &&
        credential.clientBinding &&
        !credential.clientBinding.credentialRef
      ) {
        await this.#dependencies.repository.complete(job)
        await this.#audit('failed', code)
        return true
      }
      if (!retryable && TERMINAL_ALREADY_INVALID.has(code)) return this.#finish(job, code)
      if (!retryable) return this.#failTerminal(job, code)
      return this.#retry(job, code)
    }
  }

  start(): void {
    if (this.#runner) return
    this.#runner = createPeriodicRunner({
      name: 'integration-revocation',
      intervalMs: 30_000,
      runImmediately: true,
      task: async () => {
        for (let count = 0; count < 10 && (await this.runOnce()); count += 1) {
          // Drain a bounded batch.
        }
      },
    })
    this.#runner.start()
  }

  async stop(): Promise<void> {
    const runner = this.#runner
    this.#runner = null
    await runner?.stop()
  }

  async #finish(job: RevocationJob, code?: string): Promise<true> {
    await this.#dependencies.repository.complete(job)
    await this.#audit('succeeded', code)
    return true
  }

  async #failTerminal(job: RevocationJob, code: string): Promise<true> {
    await this.#dependencies.repository.failTerminal({
      id: job.id,
      leaseToken: job.leaseToken,
      attempts: job.attempts + 1,
      code,
      at: this.#now(),
    })
    await this.#audit('failed', code)
    return true
  }

  async #retry(job: RevocationJob, code: string): Promise<true> {
    const attempts = job.attempts + 1
    const backoffMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 20), MAX_BACKOFF_MS)
    await this.#dependencies.repository.fail({
      id: job.id,
      leaseToken: job.leaseToken,
      attempts,
      nextAttemptAt: new Date(this.#now().getTime() + backoffMs),
      backoffMs,
      code,
    })
    await this.#audit('failed', code)
    return true
  }

  async #audit(outcome: 'succeeded' | 'failed', code?: string): Promise<void> {
    await this.#dependencies.audit?.record({
      action: 'oauth_revoke',
      outcome,
      ...(code ? { code } : {}),
      at: this.#now(),
    })
  }
}

function safeCode(code: string): string {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(code) ? code : 'provider_error'
}
