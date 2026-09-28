import { expect, test } from 'bun:test'
import { inArray, eq } from 'drizzle-orm'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { db, secrets, settings, squads } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import { getSquadWorkspacePath } from '../../squad/workspace'
import { getExposedSecretKeys, setExposedSecretKeys } from '../../squad/env'
import {
  deploymentCredentialProviders,
  deploymentIntegrationCatalog,
  configureDeploymentIntegration,
  getDeploymentIntegrationSettings,
  initializeDeploymentIntegrationStates,
  setDeploymentIntegrationEnabled,
} from './settings'

test('deployment cards preserve existing tokens and exposure choices while enforcing global enable state', async () => {
  const keys = Object.values(deploymentCredentialProviders).map((entry) => entry.key)
  const settingKeys = Object.keys(deploymentCredentialProviders).map((provider) => `__integration-enabled:${provider}`)
  const env = Object.fromEntries(['HOME_DIR', 'FICUS_ENCRYPTION_KEY', ...keys].map((key) => [key, process.env[key]]))
  const priorSecrets = await db.select().from(secrets).where(inArray(secrets.key, keys))
  const priorSettings = await db.select().from(settings).where(inArray(settings.key, settingKeys))
  const home = await mkdtemp(join(tmpdir(), 'tau-deployment-integrations-'))
  const squadId = crypto.randomUUID()
  try {
    process.env.HOME_DIR = home
    process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    for (const key of keys) delete process.env[key]
    await db.delete(secrets).where(inArray(secrets.key, keys))
    await db.delete(settings).where(inArray(settings.key, settingKeys))
    resetSecretStore()
    resetSettingsStore()
    await getSecretStore().initialize()
    await getSettingsStore().initialize()
    await getSecretStore().set('DEPLOY_VERCEL_TOKEN', 'existing-test-token')
    await initializeDeploymentIntegrationStates()
    expect(deploymentIntegrationCatalog.map((entry) => entry.key)).toEqual([
      'cloudflare',
      'digitalocean',
      'netlify',
      'railway',
      'supabase',
      'vercel',
    ])
    expect(getSettingsStore().getStoredValue('__integration-enabled:vercel')).toBe('true')
    expect(getSettingsStore().getStoredValue('__integration-enabled:railway')).toBe('false')
    expect(JSON.stringify(getDeploymentIntegrationSettings('vercel'))).not.toContain('existing-test-token')
    await db.insert(squads).values({ id: squadId, name: 'Deployment integration fixture', purpose: 'test' })
    await setExposedSecretKeys(squadId, ['DEPLOY_VERCEL_TOKEN'])
    const generated = () => readFile(join(getSquadWorkspacePath(squadId), '.tau', '.env'), 'utf8')
    expect(await generated()).toContain("export DEPLOY_VERCEL_TOKEN='existing-test-token'")
    await setDeploymentIntegrationEnabled('vercel', false, 'test')
    expect(await generated()).not.toContain('existing-test-token')
    expect(await generated()).toContain('unset DEPLOY_VERCEL_TOKEN')
    expect(await getExposedSecretKeys(squadId)).toEqual(['DEPLOY_VERCEL_TOKEN'])
    await initializeDeploymentIntegrationStates()
    expect(getSettingsStore().getStoredValue('__integration-enabled:vercel')).toBe('false')
    await configureDeploymentIntegration('vercel', { DEPLOY_VERCEL_TOKEN: 'rotated-test-token' }, 'test')
    expect(await generated()).not.toContain('rotated-test-token')
    await setDeploymentIntegrationEnabled('vercel', true, 'test')
    expect(await generated()).toContain("export DEPLOY_VERCEL_TOKEN='rotated-test-token'")
    await expect(
      configureDeploymentIntegration('vercel', { DEPLOY_RAILWAY_TOKEN: 'wrong-provider' }, 'test')
    ).rejects.toThrow()
    expect(getDeploymentIntegrationSettings('railway').fields[0].configured).toBe(false)
  } finally {
    await db.delete(squads).where(eq(squads.id, squadId))
    await db.delete(secrets).where(inArray(secrets.key, keys))
    await db.delete(settings).where(inArray(settings.key, settingKeys))
    if (priorSecrets.length) await db.insert(secrets).values(priorSecrets)
    if (priorSettings.length) await db.insert(settings).values(priorSettings)
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSecretStore()
    resetSettingsStore()
    await rm(home, { recursive: true, force: true })
  }
})
