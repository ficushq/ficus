import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { eq, inArray } from 'drizzle-orm'
import { db, integrationConnectionAssignments, integrationConnections, settings, squads, users } from '../../../db'
import { getSecretStore } from '../../secrets'
import { resolveOAuthAuthority } from '../authorization/authority'
import {
  githubConnectionIdsForUser,
  githubSigningAccount,
  githubSigningAccountsForSquad,
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
  options: {
    enabled?: boolean
    authState?: 'authenticated' | 'invalid' | 'reauthorization_required'
    healthState?: 'healthy' | 'degraded' | 'unreachable'
    lastErrorCode?: string
    by?: string
    login?: string
    userId?: number
    clientAuthority?: 'local' | 'platform_broker'
  } = {}
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
    configuration: { version: 1, userId: options.userId ?? 7, login: options.login ?? 'octo' },
    ...(options.clientAuthority ? { clientAuthority: options.clientAuthority } : {}),
    credentialRef,
    enabled: options.enabled ?? true,
    authState: options.authState ?? 'authenticated',
    healthState: options.healthState ?? 'healthy',
    ...(options.lastErrorCode ? { lastErrorCode: options.lastErrorCode } : {}),
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
  it('lists every account attached to the squad, default first, even after validation lapsed', async () => {
    const squadId = await squad()
    const primary = await connection()
    const secondary = await connection({ login: 'hubot', userId: 9 })
    await assign(squadId, secondary, false)
    await assign(squadId, primary, true)
    expect(await githubSigningAccountsForSquad(squadId)).toEqual([
      { connectionId: primary, login: 'octo', userId: 7, isDefault: true, canSign: true },
      { connectionId: secondary, login: 'hubot', userId: 9, isDefault: false, canSign: true },
    ])
    expect(await githubSigningAccount(secondary)).toEqual({
      connectionId: secondary,
      login: 'hubot',
      userId: 9,
      isDefault: false,
      canSign: true,
    })
  })

  it('never offers a connection attached to another squad, or one attached to none', async () => {
    const [mine, theirs] = [await squad(), await squad()]
    const own = await connection()
    const foreign = await connection({ login: 'hubot', userId: 9 })
    await connection({ login: 'loose', userId: 11 })
    await assign(mine, own, true)
    await assign(theirs, foreign, true)
    expect((await githubSigningAccountsForSquad(mine)).map((account) => account.connectionId)).toEqual([own])
    expect((await githubSigningAccountsForSquad(theirs)).map((account) => account.connectionId)).toEqual([foreign])
  })

  it('marks disabled, reauthorization-required and other-authority connections, and GitHub turned off, as unable to sign', async () => {
    const otherAuthority = resolveOAuthAuthority() === 'local' ? 'platform_broker' : 'local'
    for (const options of [
      { enabled: false },
      { authState: 'reauthorization_required' as const },
      { clientAuthority: otherAuthority } as const,
    ]) {
      const squadId = await squad()
      const id = await connection(options)
      await assign(squadId, id, true)
      await signingOn(id, 'ssh-ed25519 AAAA unusable')
      expect(await githubSigningAccountsForSquad(squadId)).toMatchObject([{ connectionId: id, canSign: false }])
      expect(await githubSigningAccount(id)).toMatchObject({ canSign: false })
      expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
    }
    const squadId = await squad()
    await assign(squadId, await connection(), true)
    await db.update(settings).set({ value: 'false' }).where(eq(settings.key, ENABLED_KEY))
    try {
      expect(await githubSigningAccountsForSquad(squadId)).toMatchObject([{ canSign: false }])
    } finally {
      await db.update(settings).set({ value: 'true' }).where(eq(settings.key, ENABLED_KEY))
    }
  })

  // The state the refresh service records for the seconds a rotated token is validated.
  const refreshPending = {
    authState: 'invalid' as const,
    healthState: 'degraded' as const,
    lastErrorCode: 'refresh_validation_pending',
  }

  it('keeps signing while the token is being refreshed', async () => {
    const squadId = await squad()
    const id = await connection(refreshPending)
    await assign(squadId, id, true)
    await signingOn(id, 'ssh-ed25519 AAAA refreshing')
    expect(await githubSigningAccountsForSquad(squadId)).toMatchObject([{ connectionId: id, canSign: true }])
    expect(await githubSigningAccount(id)).toMatchObject({ canSign: true })
    expect(await githubSigningPublicKeyForSquad(squadId)).toBe('ssh-ed25519 AAAA refreshing')
  })

  it('does not sign mid-refresh when the connection is otherwise unusable', async () => {
    const otherAuthority = resolveOAuthAuthority() === 'local' ? 'platform_broker' : 'local'
    const cases: Parameters<typeof connection>[0][] = [
      { ...refreshPending, enabled: false },
      { ...refreshPending, clientAuthority: otherAuthority },
    ]
    for (const options of cases) {
      const squadId = await squad()
      const id = await connection(options)
      await assign(squadId, id, true)
      await signingOn(id, 'ssh-ed25519 AAAA unusable')
      expect(await githubSigningAccountsForSquad(squadId)).toMatchObject([{ connectionId: id, canSign: false }])
      expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
    }
    // Unassigned or attached elsewhere: never offered to this squad, so none of its commits is signed with it.
    const [mine, theirs] = [await squad(), await squad()]
    await connection(refreshPending)
    await assign(theirs, await connection(refreshPending), true)
    expect(await githubSigningAccountsForSquad(mine)).toEqual([])
    expect(await githubSigningPublicKeyForSquad(mine)).toBeUndefined()
  })

  it('does not sign once GitHub rejected the token or the refresh failed', async () => {
    for (const options of [
      // Validation answered invalid_auth.
      { authState: 'invalid' as const, healthState: 'unreachable' as const, lastErrorCode: 'invalid_auth' },
      // Health says rejected, whatever the last code.
      {
        authState: 'invalid' as const,
        healthState: 'unreachable' as const,
        lastErrorCode: 'refresh_validation_pending',
      },
      // The pending refresh failed for another reason and recorded its own code.
      { authState: 'invalid' as const, healthState: 'degraded' as const, lastErrorCode: 'provider_unavailable' },
      { authState: 'invalid' as const, healthState: 'degraded' as const },
      {
        authState: 'reauthorization_required' as const,
        healthState: 'unreachable' as const,
        lastErrorCode: 'refresh_validation_pending',
      },
    ]) {
      const squadId = await squad()
      const id = await connection(options)
      await assign(squadId, id, true)
      await signingOn(id, 'ssh-ed25519 AAAA rejected')
      expect(await githubSigningAccountsForSquad(squadId)).toMatchObject([{ connectionId: id, canSign: false }])
      expect(await githubSigningAccount(id)).toMatchObject({ canSign: false })
      expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
    }
  })

  it("switches the squad's git signing on while any attached account signs, naming the default's key first", async () => {
    const squadId = await squad()
    const id = await connection()
    const other = await connection({ login: 'hubot', userId: 9 })
    await assign(squadId, id, true)
    await assign(squadId, other, false)
    expect(await githubSigningPublicKeyForSquad(squadId)).toBeUndefined()
    await signingOn(other, 'ssh-ed25519 AAAA other')
    expect(await githubSigningPublicKeyForSquad(squadId)).toBe('ssh-ed25519 AAAA other')
    await signingOn(id, 'ssh-ed25519 AAAA test')
    expect(await githubSigningPublicKeyForSquad(squadId)).toBe('ssh-ed25519 AAAA test')
    for (const connectionId of [id, other])
      await getSecretStore().set(
        githubSigningSecretKey(connectionId),
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
