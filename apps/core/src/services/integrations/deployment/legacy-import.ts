import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, integrationConnections, secrets, settings, type DbTx } from '../../../db'
import { decrypt, encrypt, getEncryptionKey } from '../../secrets/crypto'
import type { SecretStore } from '../../secrets/store'
import { retiredDeploymentKeys } from '../../secrets/retired-deployment'
import { deploymentProviders, type DeploymentProvider } from './plugins'

const markerFor = (provider: string) => `__integration-migration:deploy:${provider}`
/**
 * The marker row serializes concurrent API/worker starts, including the no-source case.
 * Credential ownership, marker and source deletion commit together. Never use the
 * presence of a connection as the marker: people may rotate, reconnect or delete it.
 */
export async function migrateLegacyDeploymentProvider(
  tx: DbTx,
  provider: DeploymentProvider,
  readEnvironment: () => string | undefined,
  encryptionKey: Buffer
): Promise<void> {
  const marker = markerFor(provider)
  await tx.insert(settings).values({ key: marker, value: 'pending' }).onConflictDoNothing()
  const [state] = await tx.select().from(settings).where(eq(settings.key, marker)).for('update')
  if (state!.value !== 'pending') return
  const key = retiredDeploymentKeys[provider]
  const [source] = await tx.select().from(secrets).where(eq(secrets.key, key)).for('update')
  // A stored value (even an empty tombstone) wins over the host fallback.
  const value = source ? decrypt(source.encryptedValue, source.iv, encryptionKey) : readEnvironment()
  let id = 'none'
  if (value) {
    id = randomUUID()
    const credentialRef = `__integration-credential:${id}:deploy-import:bearer`
    const encrypted = encrypt(value, encryptionKey)
    await tx.insert(secrets).values({
      key: credentialRef,
      encryptedValue: encrypted.encrypted,
      iv: encrypted.iv,
      updatedBy: 'integration-migration',
    })
    await tx.insert(integrationConnections).values({
      id,
      providerKey: provider,
      adapterVersion: 1,
      displayName: `Imported ${deploymentProviders[provider].label} account (${id.slice(0, 8)})`,
      configuration: { version: 1 },
      credentialRef,
      // Deliberately no squad, assignment, default, enabled flag or validation.
    })
  }
  await tx.update(settings).set({ value: id, updatedAt: new Date() }).where(eq(settings.key, marker))
  await tx.delete(secrets).where(eq(secrets.key, key))
}

/** Upgrade only: no network validation, no assignment and no arbitrary exposed-key migration. */
export async function importLegacyDeploymentCredentials(
  store: Pick<SecretStore, 'refreshKey'>,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const encryptionKey = getEncryptionKey()
  for (const provider of Object.keys(retiredDeploymentKeys) as DeploymentProvider[]) {
    await db.transaction((tx) =>
      migrateLegacyDeploymentProvider(tx, provider, () => environment[retiredDeploymentKeys[provider]], encryptionKey)
    )
    // Reconcile even on marker skips: the prior commit may have succeeded before
    // acknowledgement/cache publication failed. Never rewrite an imported credential.
    const [marker] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, markerFor(provider)))
    if (marker && marker.value !== 'none') {
      const [connection] = await db
        .select()
        .from(integrationConnections)
        .where(eq(integrationConnections.id, marker.value))
      if (connection) await store.refreshKey(connection.credentialRef)
    }
    await store.refreshKey(retiredDeploymentKeys[provider])
  }
}
