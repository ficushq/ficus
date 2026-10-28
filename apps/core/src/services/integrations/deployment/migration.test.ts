import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, integrationConnections, integrationConnectionAssignments, secrets, settings } from '../../../db'
import { SecretStore } from '../../secrets/store'
import { decrypt, encrypt, getEncryptionKey } from '../../secrets/crypto'
import * as migration from './legacy-import'

const providers = ['cloudflare', 'digitalocean', 'netlify', 'railway', 'supabase', 'vercel']
const legacyKey = (provider: string) => `DEPLOY_${provider.toUpperCase()}_TOKEN`
const marker = (provider: string) => `__integration-migration:deploy:${provider}`
let store: SecretStore
let ids: string[] = []
let refs: string[] = []
const importAll = (environment: Record<string, string | undefined> = {}) => {
  expect(typeof (migration as any).importLegacyDeploymentCredentials).toBe('function')
  return migration.importLegacyDeploymentCredentials(store, environment)
}
async function imported(provider: string) {
  const [m] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, marker(provider)))
  expect(m?.value).toMatch(/^[a-f0-9-]{36}$/)
  ids.push(m!.value)
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, m!.value))
  refs.push(row!.credentialRef)
  return row!
}
async function seed(key: string, value: string) {
  const { encrypted, iv } = encrypt(value, getEncryptionKey())
  await db
    .insert(secrets)
    .values({ key, encryptedValue: encrypted, iv })
    .onConflictDoUpdate({ target: secrets.key, set: { encryptedValue: encrypted, iv } })
}
beforeEach(async () => {
  store = new SecretStore()
  await store.initialize()
  ids = []
  refs = []
  await db.delete(settings).where(inArray(settings.key, providers.map(marker)))
})
afterEach(async () => {
  if (ids.length) {
    await db.delete(integrationConnections).where(inArray(integrationConnections.id, ids))
    for (const ref of refs) await store.delete(ref)
  }
  await db.delete(secrets).where(inArray(secrets.key, [...providers.map(legacyKey), 'DEPLOY_UNRELATED_TOKEN']))
  await db
    .delete(settings)
    .where(inArray(settings.key, [...providers.map(marker), '__integration-migration:deploy-notice']))
})

test('stored-only migration copies six encrypted credentials, no assignment/default/exposure choices, and deletes old keys', async () => {
  for (const provider of providers) await seed(legacyKey(provider), `synthetic-stored-${provider}`)
  await seed('DEPLOY_UNRELATED_TOKEN', 'synthetic-unrelated-exposure')
  await importAll()
  for (const provider of providers) {
    const connection = await imported(provider)
    expect(connection).toMatchObject({
      providerKey: provider,
      enabled: false,
      authState: 'pending',
      squadId: null,
      configuration: { version: 1 },
    })
    expect(
      await db
        .select()
        .from(integrationConnectionAssignments)
        .where(eq(integrationConnectionAssignments.connectionId, connection.id))
    ).toEqual([])
    const [credential] = await db.select().from(secrets).where(eq(secrets.key, connection.credentialRef))
    expect(credential!.encryptedValue).not.toContain(`synthetic-stored-${provider}`)
    expect(decrypt(credential!.encryptedValue, credential!.iv, getEncryptionKey())).toBe(`synthetic-stored-${provider}`)
    expect(
      await db
        .select()
        .from(secrets)
        .where(eq(secrets.key, legacyKey(provider)))
    ).toEqual([])
    expect(store.get(legacyKey(provider))).toBeUndefined()
  }
  expect(await db.select().from(secrets).where(eq(secrets.key, 'DEPLOY_UNRELATED_TOKEN'))).toHaveLength(1)
})

test('environment-only import is once, stored wins when both present, and legacy lookup never revives', async () => {
  await seed('DEPLOY_VERCEL_TOKEN', 'synthetic-stored-wins')
  await importAll({ DEPLOY_VERCEL_TOKEN: 'synthetic-env-loses', DEPLOY_NETLIFY_TOKEN: 'synthetic-env-only' })
  const vercel = await imported('vercel'),
    netlify = await imported('netlify')
  expect(store.get(vercel.credentialRef)).toBe('synthetic-stored-wins')
  expect(store.get(netlify.credentialRef)).toBe('synthetic-env-only')
  const original = process.env.DEPLOY_NETLIFY_TOKEN
  try {
    process.env.DEPLOY_NETLIFY_TOKEN = 'synthetic-env-still-set'
    expect(store.get('DEPLOY_NETLIFY_TOKEN')).toBeUndefined()
    await store.set(netlify.credentialRef, 'synthetic-rotated', 'test')
    await importAll({
      DEPLOY_NETLIFY_TOKEN: 'synthetic-env-only',
      DEPLOY_SUPABASE_TOKEN: 'synthetic-added-after-upgrade',
    })
    expect(store.get(netlify.credentialRef)).toBe('synthetic-rotated')
    expect(
      await db
        .select()
        .from(settings)
        .where(eq(settings.key, marker('supabase')))
    ).toMatchObject([{ value: 'none' }])
    await db.delete(integrationConnections).where(eq(integrationConnections.id, netlify.id))
    await importAll({ DEPLOY_NETLIFY_TOKEN: 'synthetic-env-only' })
    expect(await db.select().from(integrationConnections).where(eq(integrationConnections.id, netlify.id))).toEqual([])
  } finally {
    if (original === undefined) delete process.env.DEPLOY_NETLIFY_TOKEN
    else process.env.DEPLOY_NETLIFY_TOKEN = original
  }
})

test('concurrent imports produce one connection and marker; post-commit refresh failure retries without overwrite', async () => {
  await seed('DEPLOY_RAILWAY_TOKEN', 'synthetic-concurrent')
  await Promise.all([importAll(), importAll()])
  const row = await imported('railway')
  await store.set(row.credentialRef, 'synthetic-reauthorized', 'test')
  const refresh = store.refreshKey.bind(store)
  store.refreshKey = async () => {
    throw new Error('synthetic-refresh-failure')
  }
  try {
    await expect(importAll()).resolves.toBeUndefined()
  } finally {
    store.refreshKey = refresh
  }
  await importAll({ DEPLOY_RAILWAY_TOKEN: 'synthetic-old-env' })
  expect(store.get(row.credentialRef)).toBe('synthetic-reauthorized')
  expect(
    await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'railway'))
  ).toHaveLength(1)
})

test('failed transaction leaves source encrypted credential and marker retryable', async () => {
  expect(typeof (migration as any).migrateLegacyDeploymentProvider).toBe('function')
  await seed('DEPLOY_CLOUDFLARE_TOKEN', 'synthetic-rollback')
  await expect(
    db.transaction(async (tx) => {
      await migration.migrateLegacyDeploymentProvider(tx, 'cloudflare', () => undefined, getEncryptionKey())
      throw new Error('synthetic-rollback')
    })
  ).rejects.toThrow('synthetic-rollback')
  expect(await db.select().from(secrets).where(eq(secrets.key, 'DEPLOY_CLOUDFLARE_TOKEN'))).toHaveLength(1)
  expect(
    await db
      .select()
      .from(settings)
      .where(eq(settings.key, marker('cloudflare')))
  ).toEqual([])
  await importAll()
  expect(store.get((await imported('cloudflare')).credentialRef)).toBe('synthetic-rollback')
})

test('an empty stored tombstone wins over a host credential and is marked once without creating an account', async () => {
  await seed('DEPLOY_NETLIFY_TOKEN', '')
  await importAll({ DEPLOY_NETLIFY_TOKEN: 'synthetic-should-not-be-imported' })
  expect(
    await db
      .select()
      .from(settings)
      .where(eq(settings.key, marker('netlify')))
  ).toMatchObject([{ value: 'none' }])
  expect(await db.select().from(secrets).where(eq(secrets.key, 'DEPLOY_NETLIFY_TOKEN'))).toEqual([])
  expect((await store.list()).some((entry) => providers.map(legacyKey).includes(entry.key))).toBe(false)
})

test('without an encryption key upgrade skips with a sanitized warning and no markers, then recovers', async () => {
  const originalKey = process.env.FICUS_ENCRYPTION_KEY
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
  }
  try {
    delete process.env.FICUS_ENCRYPTION_KEY
    await expect(importAll({ DEPLOY_VERCEL_TOKEN: 'synthetic-no-key-source' })).resolves.toBeUndefined()
    expect(
      await db
        .select()
        .from(settings)
        .where(inArray(settings.key, providers.map(marker)))
    ).toEqual([])
    expect(warnings.join(' ')).toContain('encryption key')
    expect(warnings.join(' ')).not.toContain('synthetic-no-key-source')
  } finally {
    if (originalKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = originalKey
    console.warn = warn
  }
  await importAll({ DEPLOY_VERCEL_TOKEN: 'synthetic-no-key-source' })
  expect(store.get((await imported('vercel')).credentialRef)).toBe('synthetic-no-key-source')
})

test('undecryptable provider remains retryable without aborting startup or other providers', async () => {
  const wrongKey = Buffer.from(getEncryptionKey())
  wrongKey[0] = wrongKey[0]! ^ 255
  const { encrypted, iv } = encrypt('synthetic-undecryptable', wrongKey)
  await db.insert(secrets).values({ key: 'DEPLOY_CLOUDFLARE_TOKEN', encryptedValue: encrypted, iv })
  const warnings: string[] = [],
    warn = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(importAll({ DEPLOY_NETLIFY_TOKEN: 'synthetic-healthy-provider' })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('cloudflare')
    expect(warnings.join(' ')).not.toContain('synthetic-undecryptable')
    expect(
      await db
        .select()
        .from(settings)
        .where(eq(settings.key, marker('cloudflare')))
    ).toEqual([])
    expect((await db.select().from(secrets).where(eq(secrets.key, 'DEPLOY_CLOUDFLARE_TOKEN')))[0]?.encryptedValue).toBe(
      encrypted
    )
    expect(store.get((await imported('netlify')).credentialRef)).toBe('synthetic-healthy-provider')
  } finally {
    console.warn = warn
  }
  await seed('DEPLOY_CLOUDFLARE_TOKEN', 'synthetic-recovered-provider')
  await importAll()
  expect(store.get((await imported('cloudflare')).credentialRef)).toBe('synthetic-recovered-provider')
})
