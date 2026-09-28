import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections, settings, squads, users } from '../../../db'
import { getSecretStore } from '../../secrets'
import {
  defaultGitHubConnectionId,
  githubConnectionIdsForUser,
  githubSigningPublicKeyForSquad,
  githubSigningSecretKey,
} from './commit-signing-store'

const created = { connections: [] as string[], squads: [] as string[], users: [] as string[], secrets: [] as string[] }

async function user(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `signing-store-${randomUUID()}@example.com` })
    .returning()
  created.users.push(row!.id)
  return row!.id
}

async function squad(): Promise<string> {
  const [row] = await db
    .insert(squads)
    .values({ name: `signing-store-${randomUUID()}`, purpose: 'commit signing store fixture' })
    .returning()
  created.squads.push(row!.id)
  return row!.id
}

async function connection(
  options: { enabled?: boolean; authState?: 'authenticated' | 'reauthorization_required'; by?: string } = {}
) {
  const id = randomUUID()
  const revision = randomUUID()
  const credentialRef = `__integration-test:github:${id}`
  await getSecretStore().set(credentialRef, 'bundle', 'test')
  created.secrets.push(credentialRef)
  await db.insert(integrationConnections).values({
    id,
    providerKey: 'github',
    adapterVersion: 1,
    displayName: `github-${id.slice(0, 8)}`,
    configuration: { version: 1, userId: 7, login: 'octo' },
    credentialRef,
    enabled: options.enabled ?? true,
    authState: options.authState ?? 'authenticated',
    healthState: 'healthy',
    materialRevision: revision,
    validatedRevision: revision,
    validatedAt: new Date(),
    // Deliberately lapsed: env rendering must not depend on validation freshness.
    validationExpiresAt: new Date(Date.now() - 60_000),
    ...(options.by ? { createdByUserId: options.by } : {}),
  })
  created.connections.push(id)
  return id
}

async function assign(squadId: string, connectionId: string, isDefault: boolean) {
  await db.insert(integrationConnectionAssignments).values({ squadId, providerKey: 'github', connectionId, isDefault })
}

async function signingOn(connectionId: string, publicKey: string) {
  const key = githubSigningSecretKey(connectionId)
  created.secrets.push(key)
  await getSecretStore().set(
    key,
    JSON.stringify({
      version: 1,
      state: 'on',
      privateKey: 'pem',
      publicKey,
      githubKeyId: 1,
      enabledAt: new Date().toISOString(),
      enabledBy: 'test',
    }),
    'test'
  )
}

const ENABLED_KEY = '__integration-enabled:github'
let previousKey: string | undefined
let previousEnabled: string | undefined
beforeAll(async () => {
  // Signing follows the squad's usable connection, which requires GitHub itself to be enabled.
  previousEnabled = (await db.select().from(settings).where(eq(settings.key, ENABLED_KEY)))[0]?.value
  await db
    .insert(settings)
    .values({ key: ENABLED_KEY, value: 'true' })
    .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
  previousKey = process.env.FICUS_ENCRYPTION_KEY
  process.env.FICUS_ENCRYPTION_KEY ??= '0'.repeat(64)
  await getSecretStore().initialize()
})

afterAll(async () => {
  if (created.connections.length) {
    await db
      .delete(integrationConnectionAssignments)
      .where(inArray(integrationConnectionAssignments.connectionId, created.connections))
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, created.connections))
  }
  for (const key of created.secrets) await getSecretStore().delete(key)
  if (created.squads.length) await db.delete(squads).where(inArray(squads.id, created.squads))
  for (const id of created.users) await db.delete(users).where(eq(users.id, id))
  if (previousEnabled === undefined) await db.delete(settings).where(eq(settings.key, ENABLED_KEY))
  else await db.update(settings).set({ value: previousEnabled }).where(eq(settings.key, ENABLED_KEY))
  if (previousKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
  else process.env.FICUS_ENCRYPTION_KEY = previousKey
  await getSecretStore().initialize()
})

describe('commit signing store', () => {
  it("resolves a squad's default GitHub connection even after its validation window lapsed", async () => {
    const squadId = await squad()
    const primary = await connection()
    const secondary = await connection()
    await assign(squadId, secondary, false)
    await assign(squadId, primary, true)
    expect(await defaultGitHubConnectionId(squadId)).toBe(primary)
  })

  it('ignores disabled and reauthorization-required defaults, and GitHub being turned off', async () => {
    for (const options of [{ enabled: false }, { authState: 'reauthorization_required' as const }]) {
      const squadId = await squad()
      await assign(squadId, await connection(options), true)
      expect(await defaultGitHubConnectionId(squadId)).toBeUndefined()
    }
    const squadId = await squad()
    await assign(squadId, await connection(), true)
    await db.update(settings).set({ value: 'false' }).where(eq(settings.key, ENABLED_KEY))
    try {
      expect(await defaultGitHubConnectionId(squadId)).toBeUndefined()
    } finally {
      await db.update(settings).set({ value: 'true' }).where(eq(settings.key, ENABLED_KEY))
    }
  })

  it("renders the squad's signing key only while signing is on for its default connection", async () => {
    const squadId = await squad()
    const id = await connection()
    await assign(squadId, id, true)
    expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
    await signingOn(id, 'ssh-ed25519 AAAA test')
    expect(await githubSigningPublicKeyForSquad(squadId)).toBe('ssh-ed25519 AAAA test')
    await getSecretStore().set(
      githubSigningSecretKey(id),
      JSON.stringify({ version: 1, state: 'off', updatedAt: new Date().toISOString(), updatedBy: 'test' }),
      'test'
    )
    expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
  })

  it('lists only the connections a person connected', async () => {
    const [me, someoneElse] = [await user(), await user()]
    const mine = await connection({ by: me })
    const theirs = await connection({ by: someoneElse })
    const ids = await githubConnectionIdsForUser(me)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
  })
})
