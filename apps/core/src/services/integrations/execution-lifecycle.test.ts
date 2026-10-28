import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github', 'linear')
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
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

test('assigned GitHub wrapper lifecycle and generic exec follow live account health, rotation, provider disable and detach', async () => {
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
  try {
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
    // Extend this fixture as later phases migrate more providers onto execution.
    expect(
      firstPartyIntegrationPlugins
        .filter((plugin) => plugin.execution)
        .map((plugin) => plugin.key)
        .sort()
    ).toEqual(['github', 'linear'])
    expect(await squadIntegrationRoutesService.executionEnvironment(squadId, 'linear')).toEqual({
      LINEAR_API_KEY: 'synthetic-linear-command-only',
    })
    await regenerateEnvFileForSquad(squadId)
    const dot = join(getSquadWorkspacePath(squadId), '.ficus'),
      wrapper = join(dot, 'integration-bin', 'gh')
    expect(existsSync(wrapper)).toBe(true)
    expect(existsSync(join(dot, 'integration-bin', '.git-config'))).toBe(true)
    expect(readFileSync(join(dot, '.env'), 'utf8')).not.toContain('git()')
    for (const path of [wrapper, join(dot, '.env'), join(dot, 'integration-bin', '.git-config')]) {
      const content = readFileSync(path, 'utf8')
      expect(content).not.toContain(`test-access-${first.id}`)
      expect(content).not.toContain(`test-access-${second.id}`)
      expect(content).not.toContain('test-refresh')
      expect(content).not.toContain('synthetic-linear-command-only')
    }
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
    await db.delete(integrationConnections).where(eq(integrationConnections.id, linearId))
    await getSecretStore().delete(linearRef)
    await first.dispose()
    await second.dispose()
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(squads).where(eq(squads.id, otherSquad))
  }
})
