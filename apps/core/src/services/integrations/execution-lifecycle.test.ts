import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github', 'linear', 'notion')
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { db, squads, integrationConnections, integrationConnectionAssignments } from '../../db'
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { regenerateEnvFileForSquad } from '../squad/env'
import { getSquadWorkspacePath } from '../squad/workspace'
import { squadIntegrationRoutesService } from './runtime'
import { getSecretStore } from '../secrets'
import { serializeOAuthCredential } from './authorization/credential-bundle'
import { firstPartyIntegrationPlugins } from './first-party-plugins'
import { setIntegrationEnabled } from './provider-state'

test('all migrated providers stay out of generated files and generic exec follow live account health, rotation, provider disable and detach', async () => {
  const squadId = crypto.randomUUID(),
    otherSquad = crypto.randomUUID()
  await db.insert(squads).values([
    { id: squadId, name: 'Exec lifecycle', purpose: 'test' },
    { id: otherSquad, name: 'Other', purpose: 'test' },
  ])
  const first = await createTestGitHubConnection({ squadId, login: 'default' })
  const second = await createTestGitHubConnection({ squadId, login: 'additional', isDefault: false })
  const linearId = crypto.randomUUID(),
    linearRevision = crypto.randomUUID(),
    linearRef = `__integration-test:linear:${linearId}`
  const notionId = crypto.randomUUID(),
    notionRevision = crypto.randomUUID(),
    notionRef = `__integration-test:notion:${notionId}`
  const notionCredential = {
    version: 1 as const,
    tokenRevision: 1,
    accessToken: 'synthetic-notion-access',
    refreshToken: 'synthetic-notion-refresh',
    expiresAt: null,
  }
  try {
    await getSecretStore().set(notionRef, serializeOAuthCredential(notionCredential), 'test')
    await db.insert(integrationConnections).values({
      id: notionId,
      providerKey: 'notion',
      adapterVersion: 1,
      clientAuthority: 'local',
      displayName: 'Notion fixture',
      configuration: {
        version: 1,
        workspaceId: 'synthetic-workspace',
        workspaceName: null,
        workspaceIcon: null,
        botId: 'synthetic-bot',
      },
      credentialRef: notionRef,
      materialRevision: notionRevision,
      validatedRevision: notionRevision,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validatedAt: new Date(),
      validationExpiresAt: new Date(Date.now() + 60_000),
    })
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId, providerKey: 'notion', connectionId: notionId, isDefault: true })
    await getSecretStore().set(linearRef, 'synthetic-linear-command-only', 'test')
    await db.insert(integrationConnections).values({
      id: linearId,
      providerKey: 'linear',
      adapterVersion: 1,
      displayName: 'Linear fixture',
      configuration: { version: 1 },
      credentialRef: linearRef,
      materialRevision: linearRevision,
      validatedRevision: linearRevision,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validatedAt: new Date(),
      validationExpiresAt: new Date(Date.now() + 60_000),
    })
    await db
      .insert(integrationConnectionAssignments)
      .values({ squadId, providerKey: 'linear', connectionId: linearId, isDefault: true })
    // The exhaustive all-assigned fixture (including deploy and nonexec providers) lives in deployment/execution.test.ts.
    expect(
      firstPartyIntegrationPlugins
        .filter((plugin) => plugin.execution)
        .map((plugin) => plugin.key)
        .sort()
    ).toEqual(['cloudflare', 'digitalocean', 'github', 'linear', 'netlify', 'notion', 'railway', 'supabase', 'vercel'])
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'linear')).toEqual({
      LINEAR_API_KEY: 'synthetic-linear-command-only',
    })
    const oldDot = join(getSquadWorkspacePath(squadId), '.ficus')
    mkdirSync(oldDot, { recursive: true })
    writeFileSync(
      join(oldDot, '.env'),
      '# Generated protected integration bindings. Do not edit values here.\nexport NOTION_API_TOKEN=synthetic-legacy-notion-token\n'
    )
    await regenerateEnvFileForSquad(squadId)
    const dot = join(getSquadWorkspacePath(squadId), '.ficus'),
      wrapper = join(dot, 'integration-bin', 'gh')
    expect(existsSync(wrapper)).toBe(true)
    expect(existsSync(join(dot, 'integration-bin', '.git-config'))).toBe(true)
    expect(readFileSync(join(dot, '.env'), 'utf8')).not.toContain('git()')
    const notionWrapper = join(dot, 'integration-bin', 'ntn')
    expect(existsSync(notionWrapper)).toBe(true)
    expect(readFileSync(notionWrapper, 'utf8')).toContain("exec ficus integration exec 'notion'")
    const beforeRotation = readFileSync(join(dot, '.env'), 'utf8')
    expect(beforeRotation).toContain("export NOTION_WORKSPACE_ID='synthetic-workspace'")
    expect(beforeRotation).not.toContain('NOTION_API_TOKEN')
    // Every migrated provider is assigned; inspect every generated file, not only .env.
    const files = readdirSync(dot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
    for (const path of files) {
      const content = readFileSync(path, 'utf8')
      expect(content).not.toContain(`test-access-${first.id}`)
      expect(content).not.toContain(`test-access-${second.id}`)
      expect(content).not.toContain('test-refresh')
      expect(content).not.toContain('synthetic-linear-command-only')
      expect(content).not.toContain('synthetic-legacy-notion-token')
      expect(content).not.toContain(notionCredential.accessToken)
      expect(content).not.toContain(notionCredential.refreshToken)
    }
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'notion')).toEqual({
      NOTION_API_TOKEN: notionCredential.accessToken,
    })
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'notion', notionId)).toEqual({
      NOTION_API_TOKEN: notionCredential.accessToken,
    })
    expect(await squadIntegrationRoutesService.executionEnvironment(otherSquad, 'notion', notionId)).toBeNull()
    await getSecretStore().set(
      notionRef,
      serializeOAuthCredential({ ...notionCredential, accessToken: 'synthetic-notion-rotated', tokenRevision: 2 }),
      'test'
    )
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'notion')).toEqual({
      NOTION_API_TOKEN: 'synthetic-notion-rotated',
    })
    expect(readFileSync(join(dot, '.env'), 'utf8')).toBe(beforeRotation)
    await regenerateEnvFileForSquad(squadId)
    expect(readFileSync(join(dot, '.env'), 'utf8')).toBe(beforeRotation)
    for (const path of files) expect(readFileSync(path, 'utf8')).not.toContain('synthetic-notion-rotated')
    await db.update(integrationConnections).set({ authState: 'invalid' }).where(eq(integrationConnections.id, notionId))
    expect(existsSync(notionWrapper)).toBe(true)
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'notion')).toBeNull()
    await squadIntegrationRoutesService.unassign(squadId, 'notion')
    expect(existsSync(notionWrapper)).toBe(false)
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github')).toMatchObject({
      GITHUB_USER: 'default',
    })
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github', second.id)).toMatchObject({
      GITHUB_USER: 'additional',
    })
    expect(await squadIntegrationRoutesService.executionEnvironment(otherSquad, 'github', first.id)).toBeNull()
    await getSecretStore().set(
      first.credentialRef,
      serializeOAuthCredential({
        version: 1,
        tokenRevision: 2,
        accessToken: 'synthetic-rotated',
        refreshToken: null,
        expiresAt: null,
      }),
      'test'
    )
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github')).toMatchObject({
      GH_TOKEN: 'synthetic-rotated',
    })
    await db
      .update(integrationConnections)
      .set({ healthState: 'degraded' })
      .where(eq(integrationConnections.id, first.id))
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github')).toBeNull()
    await setIntegrationEnabled('github', false, 'test')
    await regenerateEnvFileForSquad(squadId)
    expect(existsSync(wrapper)).toBe(false)
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github', second.id)).toBeNull()
    await setIntegrationEnabled('github', true, 'test')
    await regenerateEnvFileForSquad(squadId)
    expect(existsSync(wrapper)).toBe(true)
    await squadIntegrationRoutesService.unassign(squadId, 'github')
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github')).toBeNull()
    await squadIntegrationRoutesService.unassign(squadId, 'github', undefined, second.id)
    expect(existsSync(wrapper)).toBe(false)
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'github', second.id)).toBeNull()
  } finally {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, notionId))
    await getSecretStore().delete(notionRef)
    await db.delete(integrationConnections).where(eq(integrationConnections.id, linearId))
    await getSecretStore().delete(linearRef)
    await first.dispose()
    await second.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(squads).where(eq(squads.id, otherSquad))
  }
})
