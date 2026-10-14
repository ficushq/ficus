import { createHash, randomBytes } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db, integrationDeviceAuthorizations, integrationAuthorizationFlowReceipts } from '../../../db'
import { getSecretStore } from '../../secrets'
import { encrypt, decrypt, getEncryptionKey } from '../../secrets/crypto'
import {
  parseOAuthClientBinding,
  parseOAuthCredential,
  serializeOAuthCredential,
  type OAuthCredentialBundleV1,
} from './credential-bundle'
import type { DeviceAuthorizationRecord, DeviceAuthorizationRepository } from './device-service'
import { DbAuthorizationFlowReceiptRepository } from './flow-repository'

export class DbDeviceAuthorizationRepository implements DeviceAuthorizationRepository {
  readonly #receipts = new DbAuthorizationFlowReceiptRepository()

  async create(input: Parameters<DeviceAuthorizationRepository['create']>[0]): Promise<{ expiresAt: Date }> {
    const secret = encrypt(input.device.deviceCode, getEncryptionKey())
    return db.transaction(async (tx) => {
      // Use database time for the persisted polling/expiry contract.
      const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`)
      const now = new Date(clock!.now)
      const expiresAt = new Date(now.getTime() + input.device.expiresIn * 1000)
      await tx.insert(integrationAuthorizationFlowReceipts).values({
        localFlowId: input.id,
        providerKey: 'github',
        authority: 'local',
        intent: input.connectionId ? 'reconnect' : 'connect',
        purpose: input.purpose ?? 'integration',
        linkGeneration: input.linkGeneration ?? null,
        initiatingUserId: input.userId,
        returnTo: input.returnTo,
        completionHandleHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        sourceConnectionId: input.connectionId,
        sourceMaterialRevision: input.expectedMaterialRevision,
        artifactCredentialRef: `__integration-credential:authorization-flow:${input.id}:bearer`,
        recoveryExpiresAt: expiresAt,
        retainUntil: new Date(now.getTime() + 24 * 60 * 60_000),
      })
      await tx.insert(integrationDeviceAuthorizations).values({
        id: input.id,
        userId: input.userId,
        clientBinding: input.clientBinding,
        userCode: input.device.userCode,
        verificationUri: input.device.verificationUri,
        encryptedDeviceCode: secret.encrypted,
        deviceCodeIv: secret.iv,
        intervalSeconds: input.device.interval,
        nextPollAt: new Date(now.getTime() + input.device.interval * 1000),
        expiresAt,
      })
      return { expiresAt }
    })
  }

  async get(id: string, userId: string): Promise<DeviceAuthorizationRecord | null> {
    const [row] = await db
      .select()
      .from(integrationDeviceAuthorizations)
      .where(and(eq(integrationDeviceAuthorizations.id, id), eq(integrationDeviceAuthorizations.userId, userId)))
      .limit(1)
    if (!row) return null
    const receipt = await this.#receipts.get(id)
    if (!receipt || (row.status !== 'pending' && row.status !== 'authorized')) return null
    return {
      id,
      userId,
      clientBinding: parseOAuthClientBinding(row.clientBinding),
      deviceCode:
        row.encryptedDeviceCode && row.deviceCodeIv
          ? decrypt(row.encryptedDeviceCode, row.deviceCodeIv, getEncryptionKey())
          : null,
      status: row.status,
      intervalSeconds: row.intervalSeconds,
      nextPollAt: row.nextPollAt,
      expiresAt: row.expiresAt,
      receipt,
    }
  }

  async defer(id: string, intervalSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600)
      throw new Error('Invalid device polling interval')
    await db
      .update(integrationDeviceAuthorizations)
      .set({ intervalSeconds, nextPollAt: sql`clock_timestamp() + (${intervalSeconds} * interval '1 second')` })
      .where(eq(integrationDeviceAuthorizations.id, id))
  }

  /** Caller owns the flow lease; token bytes and their recovery obligation commit together. */
  async stage(record: DeviceAuthorizationRecord, credential: OAuthCredentialBundleV1): Promise<void> {
    await getSecretStore().setWithDurableObligation(
      record.receipt.artifactCredentialRef,
      serializeOAuthCredential(credential),
      'system:device-authorization',
      async (tx) => {
        const [receipt] = await tx
          .select()
          .from(integrationAuthorizationFlowReceipts)
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, record.id))
          .for('update')
        if (
          !receipt ||
          receipt.terminalAt ||
          receipt.installKind ||
          receipt.identityProofId ||
          receipt.authority !== 'local' ||
          receipt.providerKey !== 'github' ||
          receipt.initiatingUserId !== record.userId
        )
          throw new Error('Device authorization changed')
        await tx
          .update(integrationAuthorizationFlowReceipts)
          .set({
            stagingStartedAt: sql`clock_timestamp()`,
            adapterVersion: 1,
            recoveryExpiresAt: sql`clock_timestamp() + interval '15 minutes'`,
            retainUntil: sql`greatest(${integrationAuthorizationFlowReceipts.retainUntil}, clock_timestamp() + interval '24 hours')`,
          })
          .where(eq(integrationAuthorizationFlowReceipts.localFlowId, record.id))
        const changed = await tx
          .update(integrationDeviceAuthorizations)
          .set({
            status: 'authorized',
            encryptedDeviceCode: null,
            deviceCodeIv: null,
          })
          .where(
            and(
              eq(integrationDeviceAuthorizations.id, record.id),
              eq(integrationDeviceAuthorizations.status, 'pending')
            )
          )
          .returning({ id: integrationDeviceAuthorizations.id })
        if (changed.length !== 1) throw new Error('Device authorization changed')
      }
    )
  }

  async credential(record: DeviceAuthorizationRecord): Promise<OAuthCredentialBundleV1> {
    const store = getSecretStore()
    await store.refreshKey(record.receipt.artifactCredentialRef)
    return parseOAuthCredential(store.get(record.receipt.artifactCredentialRef))
  }

  async remove(id: string): Promise<void> {
    await db.delete(integrationDeviceAuthorizations).where(eq(integrationDeviceAuthorizations.id, id))
  }
}

/** Receipt recovery owns staged tokens; device codes themselves need only local deletion. */
export async function deleteExpiredDeviceAuthorizations(): Promise<void> {
  await db.delete(integrationDeviceAuthorizations).where(sql`exists (
    select 1 from ${integrationAuthorizationFlowReceipts} receipt
    where receipt.local_flow_id = ${integrationDeviceAuthorizations.id}
      and (receipt.terminal_at is not null or receipt.recovery_expires_at <= clock_timestamp())
  )`)
}
