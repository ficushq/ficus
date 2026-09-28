import { eq } from 'drizzle-orm'
import { db, integrationConnections, integrationConnectionAssignments } from '../db'
import { getSecretStore } from '../services/secrets'
import { serializeOAuthCredential } from '../services/integrations/authorization/credential-bundle'
import { resolveOAuthAuthority } from '../services/integrations/authorization/authority'

let activeFixtures = 0
let previousKey: string | undefined

/** Every caller owns and disposes its connection and encrypted credential. */
export async function createTestGitHubConnection(
  options: { squadId?: string; login?: string; isDefault?: boolean } = {}
) {
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID(),
    credentialRef = `__integration-test:github:${id}`
  const store = getSecretStore()
  if (activeFixtures++ === 0) {
    previousKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY ??= '0'.repeat(64)
    await store.initialize()
  }
  const releaseKey = async () => {
    if (--activeFixtures === 0) {
      if (previousKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
      else process.env.FICUS_ENCRYPTION_KEY = previousKey
      await store.initialize()
    }
  }
  try {
    await store.set(
      credentialRef,
      serializeOAuthCredential({
        version: 1,
        accessToken: `test-access-${id}`,
        refreshToken: 'test-refresh',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokenRevision: 1,
        clientBinding: { clientId: 'test-app' },
      }),
      'test'
    )
    await db.insert(integrationConnections).values({
      id,
      providerKey: 'github',
      adapterVersion: 1,
      clientAuthority: resolveOAuthAuthority(),
      displayName: options.login ?? 'testbot',
      configuration: { version: 1, userId: 123, login: options.login ?? 'testbot' },
      credentialRef,
      materialRevision: revision,
      validatedRevision: revision,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validatedAt: new Date(),
      validationExpiresAt: new Date(Date.now() + 900_000),
    })
    if (options.squadId)
      await db.insert(integrationConnectionAssignments).values({
        squadId: options.squadId,
        providerKey: 'github',
        connectionId: id,
        isDefault: options.isDefault ?? true,
      })
  } catch (error) {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    await store.delete(credentialRef)
    await releaseKey()
    throw error
  }
  return {
    id,
    credentialRef,
    async dispose() {
      await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
      await store.delete(credentialRef)
      await releaseKey()
    },
  }
}
