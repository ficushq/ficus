import { gt, lte, sql } from 'drizzle-orm'
import { db, integrationCredentialRetirements, type secrets } from '../../db'
import { createLogger } from '../../lib/infra/logger'
import { integrationCredentialEntries, INTEGRATION_CREDENTIAL_PREFIX } from '../security/integration-credential-entries'
import { decrypt } from './crypto'
import type { SecretStoreTransaction } from './store'

export const RETIRED_INTEGRATION_GRACE_MS = 60 * 60_000
export type RetiredIntegrationLeaf = { key: string; value: string; expiresAt: number }
const log = createLogger('integration-retirement')

/** Includes absent rows, so concurrent first writes and deletes serialize too. */
export async function lockIntegrationCredential(tx: SecretStoreTransaction, key: string): Promise<void> {
  if (key.startsWith(INTEGRATION_CREDENTIAL_PREFIX)) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
  }
}

/** Copy ciphertext, not plaintext, atomically with the mutation that retires it. */
export async function retainIntegrationCredential(
  tx: SecretStoreTransaction,
  row: typeof secrets.$inferSelect | undefined,
  now: number
): Promise<void> {
  if (!row?.key.startsWith(INTEGRATION_CREDENTIAL_PREFIX)) return
  await tx.insert(integrationCredentialRetirements).values({
    credentialKey: row.key,
    encryptedValue: row.encryptedValue,
    iv: row.iv,
    expiresAt: new Date(now + RETIRED_INTEGRATION_GRACE_MS),
  })
}

/** Original deadlines are authoritative: startup/peer refresh must never renew grace. */
export async function loadRetiredIntegrationLeaves(
  encryptionKey: Buffer,
  now: number
): Promise<Map<string, RetiredIntegrationLeaf>> {
  const rows = await db
    .select()
    .from(integrationCredentialRetirements)
    .where(gt(integrationCredentialRetirements.expiresAt, new Date(now)))
  const entries = new Map<string, RetiredIntegrationLeaf>()
  for (const row of rows) {
    try {
      const material = decrypt(row.encryptedValue, row.iv, encryptionKey)
      for (const leaf of integrationCredentialEntries(row.credentialKey, material)) {
        const id = JSON.stringify([leaf.key, leaf.value])
        const expiresAt = row.expiresAt.getTime()
        if ((entries.get(id)?.expiresAt ?? 0) < expiresAt) entries.set(id, { ...leaf, expiresAt })
      }
    } catch {
      // Never log encrypted bundles, plaintext or a parser exception containing either.
      log.error(`Cannot decrypt retired integration material for '${row.credentialKey}'`)
    }
  }
  return entries
}

/** Full cache refresh owns bounded-lifetime storage cleanup; no per-token timers. */
export async function pruneRetiredIntegrationCredentials(now: number): Promise<void> {
  await db
    .delete(integrationCredentialRetirements)
    .where(lte(integrationCredentialRetirements.expiresAt, new Date(now)))
}
