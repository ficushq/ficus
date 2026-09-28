import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq, gte, inArray } from 'drizzle-orm'
import { channelInstances, db, integrationConnections, secrets, settings, squads } from '../../../db'
import { integrationCredentialCleanupJobs } from '../../../db/schema'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import { createChannelConnections, legacyChannelCredentialKeys, type ChannelConnections } from './connections'
import { createChannelPlugins } from './plugins'
import { IntegrationConnectionService } from '../connection-service'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbIntegrationAuditRecorder } from '../db-audit'
import { serializeOAuthCredential } from '../authorization/credential-bundle'

const providers = ['telegram', 'slack', 'discord'] as const
const enabledKeys = providers.map((key) => `__integration-enabled:${key}`)
const priorEnv = new Map<string, string | undefined>()
let squadId: string
let startedAt: Date

async function wipe() {
  const currentRefs = await db
    .select({ ref: integrationConnections.credentialRef })
    .from(integrationConnections)
    .where(inArray(integrationConnections.providerKey, [...providers]))
  const retiredRefs = startedAt
    ? await db
        .select({ ref: integrationCredentialCleanupJobs.credentialRef })
        .from(integrationCredentialCleanupJobs)
        .where(gte(integrationCredentialCleanupJobs.createdAt, startedAt))
    : []
  const refs = [...currentRefs, ...retiredRefs].map((row) => row.ref)
  // Replacing a credential retires the previous one through a cleanup job; leave
  // none behind for the cleanup worker's own tests to claim.
  if (startedAt) {
    await db.delete(integrationCredentialCleanupJobs).where(gte(integrationCredentialCleanupJobs.createdAt, startedAt))
  }
  await db.delete(integrationConnections).where(inArray(integrationConnections.providerKey, [...providers]))
  if (refs.length) await db.delete(secrets).where(inArray(secrets.key, refs))
  await db.delete(channelInstances).where(inArray(channelInstances.provider, [...providers]))
  await db.delete(secrets).where(inArray(secrets.key, [...legacyChannelCredentialKeys]))
  await db.delete(settings).where(inArray(settings.key, enabledKeys))
}

beforeEach(async () => {
  for (const key of [
    ...legacyChannelCredentialKeys,
    'FICUS_ENCRYPTION_KEY',
    'FICUS_MANAGED',
    'FICUS_MANAGED_SECRET_KEYS',
  ]) {
    priorEnv.set(key, process.env[key])
    delete process.env[key]
  }
  process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  startedAt = new Date()
  await wipe()
  resetSecretStore()
  resetSettingsStore()
  await getSecretStore().initialize()
  await getSettingsStore().initialize()
  const [squad] = await db
    .insert(squads)
    .values({ name: `channel-connections-${crypto.randomUUID()}`, purpose: 'channel connection tests' })
    .returning({ id: squads.id })
  squadId = squad!.id
})
afterEach(async () => {
  await wipe()
  await db.delete(squads).where(eq(squads.id, squadId))
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetSecretStore()
  resetSettingsStore()
})

/** Fake Telegram/Slack/Discord APIs: the token decides whether a credential is good. */
function fakeProviders() {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (url.includes('api.telegram.org')) {
      const ok = /\/bot111:good\//.test(url)
      if (url.endsWith('/getMe'))
        return ok
          ? Response.json({ ok: true, result: { id: 111, username: 'tau_test_bot' } })
          : new Response('{"ok":false}', { status: 401 })
      return Response.json({ ok: true, result: true })
    }
    if (url.includes('slack.com/api/auth.test')) {
      if (auth === 'Bearer xoxb-good') return Response.json({ ok: true, team_id: 'T123', user_id: 'U1', team: 'Acme' })
      if (auth === 'Bearer xoxb-managed-good')
        return Response.json({ ok: true, team_id: 'T-managed', user_id: 'U-managed', team: 'Acme Managed' })
      return Response.json({ ok: false, error: 'invalid_auth' })
    }
    if (url.includes('discord.com/api')) {
      if (auth !== 'Bot good') return new Response('{}', { status: 401 })
      if (url.endsWith('/users/@me')) return Response.json({ id: 'bot-user' })
      if (url.endsWith('/applications/@me')) return Response.json({ id: 'app-1', verify_key: 'pk-1' })
      if (url.endsWith('/users/@me/guilds')) return Response.json([{ id: 'g-1', name: 'Only Guild' }])
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function make(
  options: { authority?: 'local' | 'platform_broker' } = {}
): ChannelConnections & { calls: string[]; plugins: ReturnType<typeof createChannelPlugins> } {
  const { fetchImpl, calls } = fakeProviders()
  const plugins = createChannelPlugins({ fetch: fetchImpl })
  const connections = createChannelConnections({
    plugins,
    fetch: fetchImpl,
    webOrigin: () => 'https://tau.example.test',
    randomSecret: () => 'generated-webhook-secret',
    resolveAuthority: () => options.authority ?? 'local',
  })
  return Object.assign(connections, { calls, plugins })
}

/**
 * Installs a broker-issued ("Add to Slack") connection directly through the
 * provider-neutral connection service — Task C wires the real OAuth flow;
 * here we only need a `platform_broker` row to exist so `ChannelConnections`'
 * read-side selection logic can be exercised.
 */
async function createManagedSlackConnection(
  plugins: ReturnType<typeof createChannelPlugins>,
  options: {
    accessToken?: string
    teamId?: string
    botUserId?: string
    teamName?: string
    appId?: string
    enable?: boolean
    displayName?: string
  } = {}
) {
  const repository = new DbIntegrationConnectionRepository()
  const service = new IntegrationConnectionService({
    repository,
    assignments: repository,
    credentials: {
      get: (key) => getSecretStore().get(key),
      set: (key, value, actor) => getSecretStore().set(key, value, actor),
      delete: (key) => getSecretStore().delete(key),
    },
    resolveProvider: () => plugins.slack.runtime.provider,
    audit: new DbIntegrationAuditRecorder(),
  })
  const created = await service.create({
    providerKey: 'slack',
    adapterVersion: 1,
    displayName: options.displayName ?? 'Acme (managed)',
    configuration: {
      version: 1,
      teamId: options.teamId ?? 'T-managed',
      botUserId: options.botUserId ?? 'U-managed',
      teamName: options.teamName ?? 'Acme Managed',
      appId: options.appId ?? 'A-managed',
    },
    credential: serializeOAuthCredential({
      version: 1,
      accessToken: options.accessToken ?? 'xoxb-managed-good',
      refreshToken: null,
      expiresAt: null,
      tokenRevision: 1,
    }),
    actor: 'test',
    authorizationGrant: true,
    clientAuthority: 'platform_broker',
  })
  if (options.enable !== false) await service.enable(created.id, 'test')
  return created
}

test('saving a Telegram bot token creates a validated connection with discovered identity and a generated webhook secret', async () => {
  const connections = make()
  const view = await connections.configure('telegram', { botToken: '111:good' }, 'test')
  expect(view.fields).toEqual([expect.objectContaining({ key: 'botToken', configured: true, managed: false })])
  expect(view.identity).toEqual({ botId: '111', username: 'tau_test_bot' })
  expect(view.connection).toMatchObject({ source: 'connection', authState: 'authenticated', healthState: 'healthy' })
  expect(view.setup).toEqual({ state: 'configured', issues: [] })
  expect(view.webhook).toEqual({
    url: 'https://tau.example.test/api/webhooks/channels/telegram',
    secretConfigured: true,
    delivery: 'direct',
  })
  expect(JSON.stringify(view)).not.toContain('111:good')
  expect(JSON.stringify(view)).not.toContain('generated-webhook-secret')

  const state = connections.get('telegram')
  expect(state).toMatchObject({
    source: 'connection',
    configuration: { version: 1, botId: '111', username: 'tau_test_bot' },
    credential: { botToken: '111:good', webhookSecret: 'generated-webhook-secret' },
  })
  // Stored encrypted through the secret store, never in the connection row.
  const [row] = await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'telegram'))
  expect(row!.configuration).toEqual({ version: 1, botId: '111', username: 'tau_test_bot' })
  expect(JSON.stringify(row)).not.toContain('111:good')
  expect(JSON.stringify(await db.select().from(secrets))).not.toContain('111:good')
})

test('a rejected credential is kept for the card to explain but never served to the transport', async () => {
  const connections = make()
  const view = await connections.configure('slack', { botToken: 'xoxb-bad', signingSecret: 'sig' }, 'test')
  expect(view.connection).toMatchObject({ source: 'connection', authState: 'invalid', lastErrorCode: 'invalid_auth' })
  expect(view.setup.state).toBe('needs_attention')
  expect(view.setup.issues[0]).toContain('Slack rejected the saved credential')
  expect(connections.get('slack')).toBeUndefined()
  const [before] = await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'slack'))
  // Keep the named connection while replacing and validating its material.
  const fixed = await connections.configure('slack', { botToken: 'xoxb-good' }, 'test')
  const [after] = await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'slack'))
  expect(after.id).toBe(before.id)
  expect(after.credentialRef).not.toBe(before.credentialRef)
  expect(
    await db
      .select()
      .from(integrationCredentialCleanupJobs)
      .where(eq(integrationCredentialCleanupJobs.credentialRef, before.credentialRef))
  ).toHaveLength(1)
  expect(fixed.identity).toEqual({ teamId: 'T123', botUserId: 'U1', teamName: 'Acme' })
  expect(connections.get('slack')?.credential).toEqual({ botToken: 'xoxb-good', signingSecret: 'sig' })
  expect(
    await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'slack'))
  ).toHaveLength(1)
})

test('the provider switch hides the transport credential without discarding it', async () => {
  const connections = make()
  await connections.configure('telegram', { botToken: '111:good' }, 'test')
  await getSettingsStore().set('__integration-enabled:telegram', 'false', 'test')
  expect(connections.get('telegram')).toBeUndefined()
  expect((await connections.view('telegram')).fields[0]!.configured).toBe(true)
  await getSettingsStore().set('__integration-enabled:telegram', 'true', 'test')
  expect(connections.get('telegram')?.credential.botToken).toBe('111:good')
})

test('a default squad creates the routing entry from the discovered identity, once', async () => {
  const connections = make()
  await expect(connections.configure('telegram', { defaultSquadId: squadId }, 'test')).rejects.toThrow('required')
  expect((await connections.view('telegram')).routable).toBe(false)
  const saved = await connections.configure('telegram', { botToken: '111:good' }, 'test')
  expect(saved.routing).toBeNull()
  expect(saved.routable).toBe(true)
  const view = await connections.configure('telegram', { defaultSquadId: squadId }, 'test')
  expect(view.routing).toEqual({ instanceId: 'telegram-111', defaultSquadId: squadId })
  const rows = await db.select().from(channelInstances).where(eq(channelInstances.provider, 'telegram'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    name: 'Telegram · @tau_test_bot',
    providerConfig: { botId: '111' },
    defaultSquadId: squadId,
  })
  // Changing the squad updates the same entry; clearing it keeps the entry with no default.
  await connections.configure('telegram', { defaultSquadId: null }, 'test')
  expect(await db.select().from(channelInstances).where(eq(channelInstances.provider, 'telegram'))).toHaveLength(1)
  expect((await connections.view('telegram')).routing).toEqual({ instanceId: 'telegram-111', defaultSquadId: null })
})

test('Discord routing needs a server: discovered when the bot is in exactly one, otherwise chosen', async () => {
  const connections = make()
  let view = await connections.configure('discord', { botToken: 'good' }, 'test')
  expect(view.identity).toEqual({ applicationId: 'app-1', publicKey: 'pk-1' })
  expect(view.guilds).toEqual([{ id: 'g-1', name: 'Only Guild' }])
  expect(await connections.discoverDiscordGuild()).toBe('g-1')
  view = await connections.configure('discord', { guildId: 'g-1', defaultSquadId: squadId }, 'test')
  expect(view.identity).toEqual({ applicationId: 'app-1', publicKey: 'pk-1', guildId: 'g-1' })
  expect(view.routing).toEqual({ instanceId: 'discord-g-1', defaultSquadId: squadId })
})

test('legacy secret keys migrate into a connection once and keep serving as the fallback', async () => {
  const connections = make()
  await getSecretStore().set('TELEGRAM_BOT_TOKEN', '111:good', 'test')
  await getSecretStore().set('TELEGRAM_WEBHOOK_SECRET', 'legacy-secret', 'test')
  await getSecretStore().set('TELEGRAM_BOT_ID', '111', 'test')
  await connections.refresh()
  expect(connections.get('telegram')).toMatchObject({
    source: 'legacy',
    credential: { webhookSecret: 'legacy-secret' },
  })

  expect(await connections.migrateLegacy()).toEqual(['telegram'])
  expect(await connections.migrateLegacy()).toEqual([])
  const state = connections.get('telegram')
  expect(state).toMatchObject({
    source: 'connection',
    configuration: { version: 1, botId: '111', username: 'tau_test_bot' },
    credential: { botToken: '111:good', webhookSecret: 'legacy-secret' },
  })
  // The legacy keys are untouched for this release.
  expect(getSecretStore().get('TELEGRAM_BOT_TOKEN')).toBe('111:good')
})

test('platform-managed material is neither migrated nor editable, and still serves the transport', async () => {
  process.env.FICUS_MANAGED = '1'
  process.env.FICUS_MANAGED_SECRET_KEYS = 'SLACK_BOT_TOKEN,SLACK_SIGNING_SECRET'
  process.env.SLACK_BOT_TOKEN = 'platform-token'
  process.env.SLACK_SIGNING_SECRET = 'platform-signing'
  resetSecretStore()
  await getSecretStore().initialize()
  const connections = make()
  expect(await connections.migrateLegacy()).toEqual([])
  expect(connections.get('slack')).toMatchObject({ source: 'legacy', credential: { botToken: 'platform-token' } })
  const view = await connections.view('slack')
  expect(view.fields.every((field) => field.managed && field.configured)).toBe(true)
  expect(JSON.stringify(view)).not.toContain('platform-token')
  await expect(connections.configure('slack', { botToken: 'replacement', signingSecret: 'x' }, 'test')).rejects.toThrow(
    'managed'
  )
})

test('a usable managed Slack connection (broker authority) wins over the manual one for the transport', async () => {
  const connections = make({ authority: 'platform_broker' })
  await connections.configure('slack', { botToken: 'xoxb-good', signingSecret: 'sig' }, 'test')
  await createManagedSlackConnection(connections.plugins)
  await connections.refresh()

  const active = connections.get('slack')
  expect(active).toMatchObject({
    authority: 'platform_broker',
    credential: { botToken: 'xoxb-managed-good' },
    configuration: { teamId: 'T-managed', botUserId: 'U-managed' },
  })
  // Normalized for the transport: no signing secret on a managed connection (events arrive via relay).
  expect((active!.credential as { signingSecret?: string }).signingSecret).toBeUndefined()

  // The manual row is untouched underneath and still available via `stored()`.
  expect(connections.stored('slack')).toMatchObject({ authority: 'local', credential: { botToken: 'xoxb-good' } })
})

test('falls back to the manual connection when the managed one is disabled or unauthenticated', async () => {
  const connections = make({ authority: 'platform_broker' })
  await connections.configure('slack', { botToken: 'xoxb-good', signingSecret: 'sig' }, 'test')

  // Disabled managed connection: manual wins.
  await createManagedSlackConnection(connections.plugins, { enable: false })
  await connections.refresh()
  expect(connections.get('slack')).toMatchObject({ authority: 'local', credential: { botToken: 'xoxb-good' } })

  // Unauthenticated (rejected) managed connection: manual still wins. `create()`
  // already runs validation, so the row lands `invalid`/disabled without enabling it.
  await createManagedSlackConnection(connections.plugins, { accessToken: 'xoxb-managed-bad', enable: false })
  await connections.refresh()
  expect(connections.get('slack')).toMatchObject({ authority: 'local', credential: { botToken: 'xoxb-good' } })
})

test('local authority never offers the managed connection, even if a broker row exists', async () => {
  // Authority is 'local' (default from `make()`), so `#managedRow` never looks
  // at the broker-authority row at all — the manual connection is the only one.
  const connections = make()
  await connections.configure('slack', { botToken: 'xoxb-good', signingSecret: 'sig' }, 'test')
  await createManagedSlackConnection(connections.plugins)
  await connections.refresh()
  expect(connections.get('slack')).toMatchObject({ authority: 'local', credential: { botToken: 'xoxb-good' } })
  expect(connections.storedManaged('slack')).toBeUndefined()
})

test("manual configure() never rotates the managed row, even when it is the connection that's active", async () => {
  const connections = make({ authority: 'platform_broker' })
  const managed = await createManagedSlackConnection(connections.plugins)
  await connections.refresh()
  expect(connections.get('slack')?.authority).toBe('platform_broker')

  const [before] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, managed.id))
  const view = await connections.configure('slack', { botToken: 'xoxb-good', signingSecret: 'sig' }, 'test')
  expect(view.connection?.id).not.toBe(managed.id)

  const [after] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, managed.id))
  expect(after).toBeDefined()
  expect(after).toMatchObject({
    clientAuthority: 'platform_broker',
    credentialRef: before!.credentialRef,
    materialRevision: before!.materialRevision,
  })

  const rows = await db.select().from(integrationConnections).where(eq(integrationConnections.providerKey, 'slack'))
  expect(rows).toHaveLength(2)
  expect(rows.map((row) => row.clientAuthority).sort()).toEqual(['local', 'platform_broker'])
})

test('a duplicate managed broker row is broken by most-recently-updated, not by a random materialRevision', async () => {
  const connections = make({ authority: 'platform_broker' })
  const older = await createManagedSlackConnection(connections.plugins, {
    teamId: 'T-older',
    botUserId: 'U-older',
    displayName: 'Acme (managed) — older',
  })
  const newer = await createManagedSlackConnection(connections.plugins, {
    teamId: 'T-newer',
    botUserId: 'U-newer',
    displayName: 'Acme (managed) — newer',
  })
  // materialRevision is a random UUID with no relationship to recency. Force the
  // *older* row's revision to sort after the *newer* row's, so a comparator that
  // (wrongly) orders by materialRevision would still pick the older row here —
  // only ordering by updatedAt picks the row that was actually written last.
  await db
    .update(integrationConnections)
    .set({ materialRevision: 'ffffffff-ffff-ffff-ffff-ffffffffffff', updatedAt: new Date(Date.now() - 60_000) })
    .where(eq(integrationConnections.id, older.id))
  await db
    .update(integrationConnections)
    .set({ materialRevision: '00000000-0000-0000-0000-000000000000', updatedAt: new Date() })
    .where(eq(integrationConnections.id, newer.id))

  await connections.refresh()
  expect(connections.get('slack')).toMatchObject({ configuration: { teamId: 'T-newer' } })
  expect(connections.storedManaged('slack')).toMatchObject({ configuration: { teamId: 'T-newer' } })
})

test('view() exposes managedApp: availability, identity, health and whether it is what the transport uses', async () => {
  const localAuthorityConnections = make()
  expect((await localAuthorityConnections.view('slack')).routable).toBe(false)
  expect((await localAuthorityConnections.view('slack')).managedApp).toMatchObject({
    available: false,
    connection: null,
    active: false,
  })

  const connections = make({ authority: 'platform_broker' })
  expect((await connections.view('slack')).managedApp).toMatchObject({
    available: true,
    connection: null,
    active: false,
  })

  const managed = await createManagedSlackConnection(connections.plugins, { teamId: 'T-view', botUserId: 'U-view' })
  await connections.refresh()
  const view = await connections.view('slack')
  expect(view.managedApp).toMatchObject({
    available: true,
    active: true,
    connection: {
      id: managed.id,
      authState: 'authenticated',
      healthState: 'healthy',
      lastErrorCode: null,
      teamId: 'T-view',
      teamName: 'Acme Managed',
    },
  })
  expect(view.webhook.delivery).toBe('relay')
  // Connected and routable before any channel instance exists: choosing a default squad creates it.
  expect(view.setup.state).toBe('configured')
  expect(view.routing).toBeNull()
  expect(view.routable).toBe(true)

  // Without any manual credential, the manual-facing `fields`/`connection` sections stay empty:
  // the managed connection is a distinct concept from the "bring your own app" one.
  expect(view.connection).toBeNull()
  expect(view.fields.every((field) => !field.configured)).toBe(true)
})

test('default squad routing works from the managed connection when no manual one is configured', async () => {
  const connections = make({ authority: 'platform_broker' })
  await createManagedSlackConnection(connections.plugins, { teamId: 'T-routing' })
  await connections.refresh()
  const view = await connections.configure('slack', { defaultSquadId: squadId }, 'test')
  expect(view.routing).toEqual({ instanceId: 'slack-t-routing', defaultSquadId: squadId })
  const rows = await db.select().from(channelInstances).where(eq(channelInstances.provider, 'slack'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ providerConfig: { teamId: 'T-routing' }, defaultSquadId: squadId })
})
