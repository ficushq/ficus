import { useEnabledIntegrationFixtures } from '../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
const githubFixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
afterEach(async () => {
  for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
})
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, squads, integrationConnections } from '../../db'
import { Squad } from '../../entities/Squad'
import { PROVIDER_AUTH_DATA_KEY } from '../agent/account-store'
import { getSecretStore, resetSecretStore } from '../secrets'
import { getSettingsStore, resetSettingsStore } from '../settings'
import {
  computeOnboardingStatus,
  getOnboardingStatus,
  isOnboardingItemId,
  isRequiredOnboardingItem,
  OnboardingRequiredItemError,
  ONBOARDING_ITEM_ORDER,
  setItemSkipped,
  type OnboardingItemId,
} from './status'

const ALL_TRUE: Record<OnboardingItemId, boolean> = {
  ai_provider: true,
  first_squad: true,
  github: true,
}
const ALL_FALSE: Record<OnboardingItemId, boolean> = {
  ai_provider: false,
  first_squad: false,
  github: false,
}

describe('computeOnboardingStatus (pure algebra)', () => {
  it('every item reads todo when every signal is false and nothing is skipped', () => {
    const status = computeOnboardingStatus(ALL_FALSE, new Set())
    expect(status.ready).toBe(false)
    for (const item of status.items) {
      expect(item.state).toBe('todo')
    }
    expect(status.items.map((i) => i.id)).toEqual([...ONBOARDING_ITEM_ORDER])
  })

  it('every item reads done when every signal is true, and ready is true', () => {
    const status = computeOnboardingStatus(ALL_TRUE, new Set())
    expect(status.ready).toBe(true)
    for (const item of status.items) {
      expect(item.state).toBe('done')
    }
  })

  it('marks required items correctly', () => {
    const status = computeOnboardingStatus(ALL_FALSE, new Set())
    const byId = Object.fromEntries(status.items.map((i) => [i.id, i]))
    expect(byId.ai_provider.required).toBe(true)
    expect(byId.first_squad.required).toBe(true)
    expect(byId.github.required).toBe(false)
  })

  it('an optional item with a false signal and a skip flag reads skipped', () => {
    const status = computeOnboardingStatus(ALL_FALSE, new Set(['github']))
    expect(status.items.find((i) => i.id === 'github')?.state).toBe('skipped')
  })

  it('completion outranks a skip: a true signal wins even if the item is flagged skipped', () => {
    const signals = { ...ALL_FALSE, github: true }
    const status = computeOnboardingStatus(signals, new Set(['github']))
    expect(status.items.find((i) => i.id === 'github')?.state).toBe('done')
  })

  it('a stray skip flag on a required id is ignored — required items are never skipped', () => {
    const status = computeOnboardingStatus(ALL_FALSE, new Set(['ai_provider'] as unknown as OnboardingItemId[]))
    expect(status.items.find((i) => i.id === 'ai_provider')?.state).toBe('todo')
  })

  it('ready requires both required items done, regardless of optional state', () => {
    const signals = { ...ALL_TRUE, first_squad: false }
    const status = computeOnboardingStatus(signals, new Set(['github']))
    expect(status.ready).toBe(false)
    expect(status.items.find((i) => i.id === 'first_squad')?.state).toBe('todo')
  })

  it('ready is true once every optional item is either done or skipped', () => {
    const signals = { ...ALL_TRUE, github: false }
    const status = computeOnboardingStatus(signals, new Set(['github']))
    expect(status.ready).toBe(true)
  })

  it('ready is false while any optional item is neither done nor skipped', () => {
    const signals = { ...ALL_TRUE, github: false }
    const status = computeOnboardingStatus(signals, new Set())
    expect(status.ready).toBe(false)
  })
})

describe('isOnboardingItemId / isRequiredOnboardingItem', () => {
  it('recognizes exactly the three main setup ids', () => {
    expect(ONBOARDING_ITEM_ORDER).toHaveLength(3)
    for (const id of ONBOARDING_ITEM_ORDER) {
      expect(isOnboardingItemId(id)).toBe(true)
    }
    expect(isOnboardingItemId('not_a_real_item')).toBe(false)
  })

  it('required ids are exactly ai_provider and first_squad', () => {
    expect(isRequiredOnboardingItem('ai_provider')).toBe(true)
    expect(isRequiredOnboardingItem('first_squad')).toBe(true)
    expect(isOnboardingItemId('invite_users')).toBe(false)
    expect(isRequiredOnboardingItem('github')).toBe(false)
    expect(isOnboardingItemId('chat_channel')).toBe(false)
    expect(isOnboardingItemId('remote_hosts')).toBe(false)
  })
})

describe('onboarding status — live wiring (real DB + secret store)', () => {
  let priorEncryptionKey: string | undefined
  let priorGitHubToken: string | undefined
  const createdSquadIds: string[] = []

  beforeAll(async () => {
    priorEncryptionKey = process.env.FICUS_ENCRYPTION_KEY
    process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey ?? '0'.repeat(64)
    priorGitHubToken = process.env.GITHUB_TOKEN
    delete process.env.GITHUB_TOKEN
    resetSecretStore()
    await getSecretStore().initialize()
    resetSettingsStore()
    await getSettingsStore().initialize()
  })

  afterAll(async () => {
    if (priorEncryptionKey === undefined) delete process.env.FICUS_ENCRYPTION_KEY
    else process.env.FICUS_ENCRYPTION_KEY = priorEncryptionKey
    if (priorGitHubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = priorGitHubToken
    resetSecretStore()
    resetSettingsStore()
  })

  afterEach(async () => {
    await getSecretStore().delete('GITHUB_TOKEN')
    await getSecretStore().delete('SLACK_BOT_TOKEN')
    await getSecretStore().delete('DISCORD_BOT_TOKEN')
    await getSecretStore().delete(PROVIDER_AUTH_DATA_KEY)
    await getSettingsStore().set('onboarding.skips', JSON.stringify([]), 'test-cleanup')

    for (const id of createdSquadIds.splice(0)) {
      await db.delete(squads).where(eq(squads.id, id))
    }
  })

  it('github reads done only after a connection is authorized', async () => {
    await getSecretStore().delete('GITHUB_TOKEN')
    const before = await getOnboardingStatus()
    expect(before.items.find((i) => i.id === 'github')?.state).toBe('todo')

    githubFixtures.push(await createTestGitHubConnection())
    const after = await getOnboardingStatus()
    expect(after.items.find((i) => i.id === 'github')?.state).toBe('done')
  })

  it('GitHub onboarding remains complete across lease expiry and token refresh while runtime access stays fenced', async () => {
    const fixture = await createTestGitHubConnection()
    githubFixtures.push(fixture)
    const { connectedGitHubLogins } = await import('../integrations/github/resolve-connection')
    for (const state of [
      { validationExpiresAt: new Date(0) },
      { validatedRevision: null, healthState: 'degraded' },
      { authState: 'invalid', lastErrorCode: 'refresh_validation_pending' },
      { authState: 'reauthorization_required', lastErrorCode: 'bad_refresh_token' },
    ] as const) {
      await db.update(integrationConnections).set(state).where(eq(integrationConnections.id, fixture.id))
      expect((await getOnboardingStatus()).items.find((item) => item.id === 'github')?.state).toBe('done')
      expect(await connectedGitHubLogins()).toEqual([])
    }
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, fixture.id))
    expect((await getOnboardingStatus()).items.find((item) => item.id === 'github')?.state).toBe('todo')
    await db
      .update(integrationConnections)
      .set({ enabled: true, validatedAt: null, authState: 'pending' })
      .where(eq(integrationConnections.id, fixture.id))
    expect((await getOnboardingStatus()).items.find((item) => item.id === 'github')?.state).toBe('todo')
  })

  it('a whitespace-only secret does not count as set', async () => {
    await getSecretStore().set('GITHUB_TOKEN', '   ', 'test')
    const status = await getOnboardingStatus()
    expect(status.items.find((i) => i.id === 'github')?.state).toBe('todo')
  })

  it('ai_provider reads done for an enabled account with a credential', async () => {
    await getSecretStore().set(
      PROVIDER_AUTH_DATA_KEY,
      JSON.stringify({
        version: 1,
        accounts: {
          'onboarding-test-provider': [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-test' } }],
        },
      }),
      'test'
    )
    const status = await getOnboardingStatus()
    expect(status.items.find((i) => i.id === 'ai_provider')?.state).toBe('done')
  })

  it('an OAuth-incomplete account (credential: null) does NOT count as configured — ai_provider stays todo', async () => {
    await getSecretStore().set(
      PROVIDER_AUTH_DATA_KEY,
      JSON.stringify({
        version: 1,
        accounts: { 'onboarding-test-provider': [{ id: 'acc_1', enabled: true, credential: null }] },
      }),
      'test'
    )
    const status = await getOnboardingStatus()
    expect(status.items.find((i) => i.id === 'ai_provider')?.state).toBe('todo')
  })

  it('first_squad reads done once a squad exists', async () => {
    const squad = await Squad.create({
      name: `onboarding-status-test-${Date.now()}`,
      purpose: 'onboarding status test',
    })
    createdSquadIds.push(squad.id)
    const status = await getOnboardingStatus()
    expect(status.items.find((i) => i.id === 'first_squad')?.state).toBe('done')
  })

  // Machine setup stays optional regardless of whether an exe.dev key is present.
  it('never emits exe_key — exactly three items, in both directions of the exe.dev key', async () => {
    const { EXE_PROVIDER_SSH_KEY } = await import('../machines/provider-credentials')
    await getSecretStore().delete(EXE_PROVIDER_SSH_KEY)
    const withoutKey = await getOnboardingStatus()
    expect(withoutKey.items).toHaveLength(3)
    expect(withoutKey.items.map((i) => i.id)).not.toContain('exe_key')

    await getSecretStore().set(EXE_PROVIDER_SSH_KEY, 'a-private-key-body', 'test')
    try {
      const withKey = await getOnboardingStatus()
      expect(withKey.items).toHaveLength(3)
      expect(withKey.items.map((i) => i.id)).not.toContain('exe_key')
    } finally {
      await getSecretStore().delete(EXE_PROVIDER_SSH_KEY)
    }
  })

  it('setItemSkipped rejects a required item id', async () => {
    await expect(setItemSkipped('ai_provider', true, 'test')).rejects.toBeInstanceOf(OnboardingRequiredItemError)
    await expect(setItemSkipped('first_squad', true, 'test')).rejects.toBeInstanceOf(OnboardingRequiredItemError)
  })

  it('ignores saved legacy optional skips and returns only the three main steps', async () => {
    await getSettingsStore().set(
      'onboarding.skips',
      JSON.stringify(['voice_memory', 'invite_users', 'chat_channel', 'remote_hosts', 'github']),
      'test'
    )
    const status = await getOnboardingStatus()
    expect(status.items.map((item) => item.id)).toEqual(['ai_provider', 'github', 'first_squad'])
    expect(status.items.find((item) => item.id === 'github')?.state).toBe('skipped')
  })

  it('skip/unskip round-trips through getOnboardingStatus for an optional item still todo', async () => {
    await getSecretStore().delete('GITHUB_TOKEN')
    await setItemSkipped('github', true, 'test')
    const skipped = await getOnboardingStatus()
    expect(skipped.items.find((i) => i.id === 'github')?.state).toBe('skipped')

    await setItemSkipped('github', false, 'test')
    const unskipped = await getOnboardingStatus()
    expect(unskipped.items.find((i) => i.id === 'github')?.state).toBe('todo')
  })

  it('skipping an already-done optional item is a no-op — it still reads done', async () => {
    githubFixtures.push(await createTestGitHubConnection())
    await setItemSkipped('github', true, 'test')
    const status = await getOnboardingStatus()
    expect(status.items.find((i) => i.id === 'github')?.state).toBe('done')
  })

  it('end-to-end: ready becomes true once both required items are done and every optional is done or skipped', async () => {
    await getSecretStore().set(
      PROVIDER_AUTH_DATA_KEY,
      JSON.stringify({
        version: 1,
        accounts: {
          'onboarding-test-provider': [{ id: 'acc_1', enabled: true, credential: { type: 'api_key', key: 'sk-test' } }],
        },
      }),
      'test'
    )
    const squad = await Squad.create({ name: `onboarding-ready-test-${Date.now()}`, purpose: 'onboarding ready test' })
    createdSquadIds.push(squad.id)

    await setItemSkipped('github', true, 'test')

    const status = await getOnboardingStatus()
    expect(status.ready).toBe(true)
    expect(status.items.find((i) => i.id === 'ai_provider')?.state).toBe('done')
    expect(status.items.find((i) => i.id === 'first_squad')?.state).toBe('done')
  })
})
