import { integrationRoutesService } from './runtime'
import { expect, spyOn, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, integrationConnections, integrationProjectionStates, settings, squads } from '../../db'
import { DbIntegrationConnectionRepository } from './db-connection-repository'
import { INTEGRATION_ENABLED_PREFIX, isIntegrationEnabled, setIntegrationEnabled } from './provider-state'
import { createTestGitHubConnection } from '../../test-utils/github-connection'
import { resolveGitHubConnection, resolveInstanceGitHubConnection } from './github/resolve-connection'
import { resolveAssignedIntegrationRefs } from './projection/agent-refs'
import { loadProtectedIntegrationBindings } from './projection/protected-env'
import { loadEffectiveToolchain } from './projection/load-effective-toolchain'
import { publishIntegrationOutputs } from './outputs/runtime'
import { dispatchVerifiedWebhookContext } from '../webhooks/dispatch'
import { webhookRegistry } from '../webhooks/registry'

test('global disable preserves account choices and assignments, blocks runtime reads, and invalidates projections on both transitions', async () => {
  const provider = `test-${crypto.randomUUID()}`
  const repository = new DbIntegrationConnectionRepository()
  const [squad] = await db.insert(squads).values({ name: provider, purpose: 'test' }).returning()
  const ids: string[] = []
  try {
    for (const enabled of [true, false]) {
      const id = crypto.randomUUID(),
        revision = crypto.randomUUID()
      ids.push(id)
      await db.insert(integrationConnections).values({
        id,
        providerKey: provider,
        adapterVersion: 1,
        displayName: String(enabled),
        configuration: {},
        credentialRef: `test:${id}`,
        materialRevision: revision,
        validatedRevision: revision,
        enabled,
        authState: 'authenticated',
        healthState: 'healthy',
        validationExpiresAt: new Date(Date.now() + 60_000),
      })
    }
    expect(await isIntegrationEnabled(provider)).toBe(false)
    expect((await repository.get(ids[0]))?.enabled).toBe(false)
    await setIntegrationEnabled(provider, true, 'test')
    await repository.assign(squad.id, provider, ids[0])
    const before = await db
      .select()
      .from(integrationProjectionStates)
      .where(eq(integrationProjectionStates.squadId, squad.id))
    expect(await setIntegrationEnabled(provider, false, 'test')).toEqual([squad.id])
    expect(await isIntegrationEnabled(provider)).toBe(false)
    expect((await new DbIntegrationConnectionRepository().get(ids[0]))?.enabled).toBe(false)
    expect((await repository.getAssigned(squad.id, provider))?.enabled).toBe(false)
    expect((await repository.listAssigned(squad.id, provider))[0].enabled).toBe(false)
    expect(await repository.listRefreshCandidates(provider, 'local', null, 10)).toEqual([])
    expect((await repository.listPoolSummaries(provider)).every((row) => !row.enabled)).toBe(true)
    await expect(repository.assign(squad.id, provider, ids[0])).rejects.toThrow('enabled provider connection')
    // The stored account intent survives; the effective runtime flag is separate.
    expect((await repository.list(provider)).find((row) => row.id === ids[0])?.enabled).toBe(true)
    await setIntegrationEnabled(provider, true, 'test')
    expect((await repository.getAssigned(squad.id, provider))?.id).toBe(ids[0])
    expect((await repository.get(ids[0]))?.enabled).toBe(true)
    expect((await repository.get(ids[1]))?.enabled).toBe(false)
    const after = await db
      .select()
      .from(integrationProjectionStates)
      .where(eq(integrationProjectionStates.squadId, squad.id))
    expect(after[0].generation).toBe(before[0].generation + 2n)
    expect(after[0].status).toBe('pending')
  } finally {
    await db.delete(squads).where(eq(squads.id, squad.id))
    if (ids.length) await db.delete(integrationConnections).where(inArray(integrationConnections.id, ids))
    await db.delete(settings).where(eq(settings.key, INTEGRATION_ENABLED_PREFIX + provider))
  }
})

test('disabled GitHub removes credentials and tools and ignores verified webhook dispatch until re-enabled', async () => {
  const key = INTEGRATION_ENABLED_PREFIX + 'github'
  const [previous] = await db.select().from(settings).where(eq(settings.key, key))
  const [squad] = await db
    .insert(squads)
    .values({ name: `Global GitHub ${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  const fixture = await createTestGitHubConnection({ squadId: squad.id })
  const eventType = `global-switch-${crypto.randomUUID()}`
  let deliveries = 0
  const handler = async () => {
    deliveries++
  }
  const original = webhookRegistry.getHandlers.bind(webhookRegistry)
  const lookup = spyOn(webhookRegistry, 'getHandlers').mockImplementation((provider, event) =>
    provider === 'github' && event === eventType ? [handler] : original(provider, event)
  )
  try {
    await setIntegrationEnabled('github', true, 'test')
    const initial = await loadEffectiveToolchain(squad.id, undefined)
    expect((await resolveGitHubConnection(squad.id))?.connection.id).toBe(fixture.id)
    await setIntegrationEnabled('github', false, 'test')
    expect(await resolveGitHubConnection(squad.id)).toBeUndefined()
    expect(await resolveInstanceGitHubConnection(fixture.id)).toBeUndefined()
    expect(await loadProtectedIntegrationBindings(squad.id)).toEqual([])
    expect(await resolveAssignedIntegrationRefs(squad.id)).toEqual({ skills: [], extensions: [] })
    expect((await loadEffectiveToolchain(squad.id, undefined)).integrationFingerprint).not.toBe(
      initial.integrationFingerprint
    )
    expect(await publishIntegrationOutputs('github', { type: 'ping', payload: {} }, { kind: 'instance' })).toEqual([])
    const context = { provider: 'github', eventType, payload: {}, headers: {}, rawBody: '{}' }
    await dispatchVerifiedWebhookContext(context, { skipOutputs: true })
    expect(deliveries).toBe(0)
    await setIntegrationEnabled('github', true, 'test')
    expect((await resolveGitHubConnection(squad.id))?.connection.id).toBe(fixture.id)
    await dispatchVerifiedWebhookContext(context, { skipOutputs: true })
    expect(deliveries).toBe(1)
  } finally {
    lookup.mockRestore()
    await fixture.dispose()
    await db.delete(squads).where(eq(squads.id, squad.id))
    if (previous) await db.update(settings).set(previous).where(eq(settings.key, key))
    else await db.delete(settings).where(eq(settings.key, key))
  }
})

test('unsupported BigBrain refuses direct enable and masks saved intent across repository reads without erasing it', async () => {
  const previousEnv = { ...process.env }
  const key = INTEGRATION_ENABLED_PREFIX + 'bigbrain'
  const [previous] = await db.select().from(settings).where(eq(settings.key, key))
  const id = crypto.randomUUID(),
    revision = crypto.randomUUID()
  const repository = new DbIntegrationConnectionRepository()
  try {
    process.env.FICUS_MANAGED = '1'
    process.env.FICUS_DESKTOP_MANAGED = '1'
    process.env.FICUS_SANDBOX_RUNTIME = 'host'
    await db
      .insert(settings)
      .values({ key, value: 'true' })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
    await db.insert(integrationConnections).values({
      id,
      providerKey: 'bigbrain',
      adapterVersion: 2,
      displayName: 'Synthetic',
      configuration: { bindingId: 'preserve' },
      credentialRef: `test:${id}`,
      materialRevision: revision,
      validatedRevision: revision,
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
      validationExpiresAt: new Date(Date.now() + 60_000),
    })
    expect(await isIntegrationEnabled('bigbrain')).toBe(false)
    expect((await integrationRoutesService.catalog()).find((entry) => entry.key === 'bigbrain')).toMatchObject({
      enabled: false,
      // Cloud: only a Platform-confirmed managed host makes BigBrain eligible.
      availability: { available: false, reason: expect.stringContaining('not been confirmed') },
    })
    expect((await repository.get(id))?.enabled).toBe(false)
    expect((await repository.listPoolSummaries('bigbrain')).find((row) => row.id === id)?.enabled).toBe(false)
    await expect(setIntegrationEnabled('bigbrain', true, 'test')).rejects.toThrow('not been confirmed')
    expect((await db.select().from(settings).where(eq(settings.key, key)))[0].value).toBe('true')
    expect((await repository.list('bigbrain')).find((row) => row.id === id)?.configuration).toEqual({
      bindingId: 'preserve',
    })
    delete process.env.FICUS_MANAGED
    expect(await isIntegrationEnabled('bigbrain')).toBe(true)
    await integrationRoutesService.setEnabled('bigbrain', true, 'test') // eligible even without a host binding
    expect((await integrationRoutesService.catalog()).find((entry) => entry.key === 'bigbrain')).toMatchObject({
      enabled: true,
      availability: { available: true },
    })
    expect((await repository.get(id))?.enabled).toBe(true)
  } finally {
    process.env = previousEnv
    await db.delete(integrationConnections).where(eq(integrationConnections.id, id))
    if (previous) await db.update(settings).set(previous).where(eq(settings.key, key))
    else await db.delete(settings).where(eq(settings.key, key))
  }
})
