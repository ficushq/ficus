import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { join } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  db,
  squads,
  integrationConnections,
  integrationConnectionAssignments,
  integrationCredentialCleanupJobs,
  settings,
} from '../../../db'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { getSecretStore } from '../../secrets'
import { regenerateEnvFileForSquad, setExposedSecretKeys } from '../../squad/env'
import { getSquadWorkspacePath } from '../../squad/workspace'
import { integrationConnectionService, integrationRoutesService, squadIntegrationRoutesService } from '../runtime'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { firstPartyIntegrationPlugins } from '../first-party-plugins'
import { loadEffectiveToolchain } from '../projection/load-effective-toolchain'
import { setIntegrationEnabled } from '../provider-state'

const providers: Record<string, [string, string]> = {
  cloudflare: ['wrangler', 'CLOUDFLARE_API_TOKEN'],
  digitalocean: ['doctl', 'DIGITALOCEAN_ACCESS_TOKEN'],
  netlify: ['netlify', 'NETLIFY_AUTH_TOKEN'],
  railway: ['railway', 'RAILWAY_API_TOKEN'],
  supabase: ['supabase', 'SUPABASE_ACCESS_TOKEN'],
  vercel: ['vercel', 'VERCEL_TOKEN'],
}
useEnabledIntegrationFixtures(
  ...Object.keys(providers),
  'github',
  'linear',
  'notion',
  'bigbrain',
  'discord',
  'slack',
  'telegram'
)

// Network is stubbed at the provider boundary; assignment, encrypted store,
// generic exec, projection and filesystem rendering are the production services.
test('every integration assigned: generated env/files stay credential-free, deploy accounts follow default/alternate/revoke/install lifecycle', async () => {
  const squadId = crypto.randomUUID(),
    otherSquad = crypto.randomUUID()
  await db.insert(squads).values([
    { id: squadId, name: 'All integrations', purpose: 'test' },
    { id: otherSquad, name: 'Unassigned', purpose: 'test' },
  ])
  const gh = await createTestGitHubConnection({ squadId, login: 'all-assigned' })
  const created: { id: string; credentialRef: string }[] = []
  const sentinels = [`test-access-${gh.id}`, 'test-refresh']
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => {
    const target = String(url)
    return Response.json(
      target.includes('cloudflare')
        ? { success: true, result: { status: 'active' } }
        : target.includes('digitalocean')
          ? { account: { uuid: 'synthetic-user' } }
          : target.includes('netlify')
            ? { id: 'synthetic-user' }
            : target.includes('railway')
              ? { data: { projects: { edges: [] } } }
              : target.includes('supabase')
                ? []
                : { user: { id: 'synthetic-user' } }
    )
  }) as typeof fetch
  try {
    for (const key of Object.keys(providers)) {
      for (let account = 0; account < 2; account++) {
        const token = `synthetic-${key}-account-${account}`
        sentinels.push(token)
        const connection = await integrationConnectionService.create({
          providerKey: key,
          adapterVersion: 1,
          displayName: `${squadId}-${key}-${account}`,
          configuration: { version: 1, ...(key === 'cloudflare' ? { accountId: `account-${account}` } : {}) },
          credential: token,
          actor: 'test',
        })
        const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connection.id))
        created.push(row!)
        expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key, connection.id)).toBeNull()
        await integrationConnectionService.enable(connection.id, 'test')
        await squadIntegrationRoutesService.assign(squadId, key, connection.id, undefined, account === 0)
      }
      expect((await squadIntegrationRoutesService.selection(squadId, key)).attached).toHaveLength(2)
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key)).toMatchObject({
        [providers[key]![1]]: `synthetic-${key}-account-0`,
      })
      const alternate = created.at(-1)!
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key, alternate.id)).toMatchObject({
        [providers[key]![1]]: `synthetic-${key}-account-1`,
      })
      expect(await squadIntegrationRoutesService.executionEnvironment(otherSquad, key, alternate.id)).toBeNull()
    }
    // Nonexec/channel plugins are included adversarially: even a row marked
    // assigned must not make a channel token or vault credential executable.
    for (const plugin of firstPartyIntegrationPlugins.filter((p) => !providers[p.key] && p.key !== 'github')) {
      const id = crypto.randomUUID(),
        revision = crypto.randomUUID(),
        credentialRef = `__integration-test:all:${id}`
      const token = `synthetic-${plugin.key}-credential`,
        refreshToken = `synthetic-${plugin.key}-refresh`
      const configuration =
        plugin.key === 'notion'
          ? {
              version: 1,
              workspaceId: 'synthetic-workspace',
              workspaceName: null,
              workspaceIcon: null,
              botId: 'synthetic-bot',
            }
          : { version: 1 }
      sentinels.push(token, refreshToken)
      await getSecretStore().set(
        credentialRef,
        plugin.key === 'notion'
          ? serializeOAuthCredential({
              version: 1,
              tokenRevision: 1,
              accessToken: token,
              refreshToken,
              expiresAt: null,
            })
          : token,
        'test'
      )
      await db.insert(integrationConnections).values({
        id,
        providerKey: plugin.key,
        adapterVersion: 1,
        displayName: `${squadId}-${plugin.key}`,
        configuration,
        credentialRef,
        materialRevision: revision,
        validatedRevision: revision,
        enabled: true,
        authState: 'authenticated',
        healthState: 'healthy',
        validatedAt: new Date(),
        validationExpiresAt: new Date(Date.now() + 120_000),
      })
      created.push({ id, credentialRef })
      await db
        .insert(integrationConnectionAssignments)
        .values({ squadId, providerKey: plugin.key, connectionId: id, isDefault: true })
      if (!plugin.execution)
        expect(await squadIntegrationRoutesService.executionEnvironment(squadId, plugin.key)).toBeNull()
    }
    // Legacy provider exposure must not leak even if conversion has not run.
    for (const key of Object.keys(providers)) {
      const legacy = `DEPLOY_${key.toUpperCase()}_TOKEN`
      await getSecretStore().set(legacy, `synthetic-legacy-${key}`, 'test')
      sentinels.push(`synthetic-legacy-${key}`)
    }
    await setExposedSecretKeys(
      squadId,
      Object.keys(providers).map((key) => `DEPLOY_${key.toUpperCase()}_TOKEN`)
    )
    await regenerateEnvFileForSquad(squadId)
    const dot = join(getSquadWorkspacePath(squadId), '.ficus')
    const files = readdirSync(dot, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
    expect(files).toContain(join(dot, '.env'))
    const toolchain = await loadEffectiveToolchain(squadId, undefined)
    for (const content of [...files.map((p) => readFileSync(p, 'utf8')), JSON.stringify(toolchain)])
      for (const token of sentinels) expect(content).not.toContain(token)
    for (const [key, [binary]] of Object.entries(providers)) {
      expect(existsSync(join(dot, 'integration-bin', binary))).toBe(true)
      expect(toolchain.config.setupScript).toContain(binary)
      expect(toolchain.readiness.map((r) => r.id)).toContain(`${binary}-cli`)
      const account = created[Object.keys(providers).indexOf(key) * 2]!
      await integrationRoutesService.setDefault(key, account.id)
      await integrationConnectionService.replaceCredential(account.id, `synthetic-rotated-${key}`, 'test', true)
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key)).toBeNull()
      await integrationConnectionService.enable(account.id, 'test')
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key)).toMatchObject({
        [providers[key]![1]]: `synthetic-rotated-${key}`,
      })
      await integrationConnectionService.disable(account.id, 'test', true)
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key, account.id)).toBeNull()
      await setIntegrationEnabled(key, false, 'test')
      await regenerateEnvFileForSquad(squadId)
      expect(existsSync(join(dot, 'integration-bin', binary))).toBe(false)
      await setIntegrationEnabled(key, true, 'test')
      await squadIntegrationRoutesService.unassign(squadId, key)
      const alternate = created[Object.keys(providers).indexOf(key) * 2 + 1]!
      expect(await squadIntegrationRoutesService.executionEnvironment(squadId, key, alternate.id)).toMatchObject({
        [providers[key]![1]]: `synthetic-${key}-account-1`,
      })
      await squadIntegrationRoutesService.unassign(squadId, key, undefined, alternate.id)
      expect(existsSync(join(dot, 'integration-bin', binary))).toBe(false)
    }
  } finally {
    globalThis.fetch = realFetch
    const refs = new Set(created.map((row) => row.credentialRef))
    for (const row of created) {
      const [current] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, row.id))
      if (current) refs.add(current.credentialRef)
      await db.delete(integrationConnections).where(eq(integrationConnections.id, row.id))
    }
    await db
      .delete(integrationCredentialCleanupJobs)
      .where(inArray(integrationCredentialCleanupJobs.credentialRef, [...refs]))
    for (const ref of refs) await getSecretStore().delete(ref)
    await db.delete(settings).where(
      inArray(
        settings.key,
        Object.keys(providers).map((key) => `__integration-default:${key}`)
      )
    )
    for (const key of Object.keys(providers)) await getSecretStore().delete(`DEPLOY_${key.toUpperCase()}_TOKEN`)
    await gh.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(squads).where(eq(squads.id, otherSquad))
  }
})
