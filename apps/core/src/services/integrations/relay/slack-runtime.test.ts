import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('slack')
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, integrationConnections, integrationEventPollingDispatches, secrets } from '../../../db'
import { getSecretStore, resetSecretStore } from '../../secrets'
import { getSettingsStore, resetSettingsStore } from '../../settings'
import { IntegrationConnectionService } from '../connection-service'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbIntegrationAuditRecorder } from '../db-audit'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { createChannelConnections } from '../channels/connections'
import { createChannelPlugins } from '../channels/plugins'
import { slackProvider } from '../../../channels/slack'
import { ChannelInstance } from '../../../entities/ChannelInstance'
import type { ChannelProvider } from '../../../channels/provider'
import type { HandlerResult } from '../../../channels/handler'
import {
  createManagedSlackRelayResolver,
  createSlackRelayDispatcher,
  defaultDispatchWebhook,
  type ManagedSlackConnection,
  type SlackRelayDispatchDependencies,
  type SlackRelayInterest,
} from './slack-runtime'
import type { SlackRelayDelivery } from '@ficus/shared/integration-relay'

const TEAM_ID = 'T12345678'

function connection(overrides: Partial<ManagedSlackConnection['configuration']> = {}): ManagedSlackConnection {
  return {
    connection: { id: crypto.randomUUID(), materialRevision: crypto.randomUUID() },
    configuration: { version: 1, teamId: TEAM_ID, botUserId: 'UBOT1', ...overrides },
  }
}

function delivery(overrides: Partial<SlackRelayDelivery> = {}): SlackRelayDelivery {
  return {
    id: crypto.randomUUID(),
    leaseToken: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    connectionRevision: crypto.randomUUID(),
    deliveryId: crypto.randomUUID(),
    resourceId: TEAM_ID,
    resourceKey: TEAM_ID,
    eventType: 'event_callback',
    payload: {},
    ...overrides,
  }
}

function interestFor(conn: ManagedSlackConnection): SlackRelayInterest[] {
  return [{ connectionId: conn.connection.id, teamId: conn.configuration.teamId! }]
}

function deps(overrides: Partial<SlackRelayDispatchDependencies> = {}) {
  const calls = {
    dispatchWebhook: [] as Record<string, unknown>[],
    postResponseUrl: [] as { url: string; body: unknown }[],
    markReauthorizationRequired: [] as { id: string; materialRevision: string; code: string }[],
    refreshChannelConnections: 0,
    audit: [] as { connectionId: string; action: string; outcome: string; code?: string }[],
    release: [] as { providerKey: string; eventKey: string }[],
    claim: [] as { providerKey: string; eventKey: string }[],
  }
  const base: SlackRelayDispatchDependencies = {
    resolveConnection: async () => connection(),
    // A minimal actionable stand-in for the real slackProvider.parseWebhook:
    // enough for the pre-claim actionability check to treat every default
    // fixture event_callback as dispatchable. Tests that need a specific
    // parse outcome (null/challenge/pong) override `provider` themselves.
    provider: { parseWebhook: async () => ({ type: 'mention' }) } as unknown as ChannelProvider,
    dispatchWebhook: async (_provider, payload) => {
      calls.dispatchWebhook.push(payload)
      return { response: { ok: true }, emptyResponse: true }
    },
    receipts: {
      claim: async (providerKey, eventKey) => {
        calls.claim.push({ providerKey, eventKey })
        return { status: 'claimed' as const, leaseToken: crypto.randomUUID() }
      },
      complete: async () => undefined,
      release: async (providerKey, eventKey) => {
        calls.release.push({ providerKey, eventKey })
      },
    },
    postResponseUrl: async (url, body) => {
      calls.postResponseUrl.push({ url, body })
    },
    markReauthorizationRequired: async (input) => {
      calls.markReauthorizationRequired.push(input)
      return true
    },
    refreshChannelConnections: async () => {
      calls.refreshChannelConnections++
    },
    audit: async (event) => {
      calls.audit.push(event)
    },
    ...overrides,
  }
  return { base, calls }
}

describe('createSlackRelayDispatcher', () => {
  test('no live managed connection leaves the delivery unacknowledged instead of swallowing it', async () => {
    const { base } = deps({ resolveConnection: async () => undefined })
    const dispatch = createSlackRelayDispatcher(base)
    await expect(dispatch(delivery(), [{ connectionId: crypto.randomUUID(), teamId: TEAM_ID }])).rejects.toThrow(
      'relay_authorization_unavailable'
    )
  })

  test('a revision mismatch acks without dispatch (the connection moved on since this delivery was queued)', async () => {
    const conn = connection()
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({ connectionId: conn.connection.id, connectionRevision: crypto.randomUUID() }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
    expect(calls.markReauthorizationRequired).toEqual([])
  })

  test('a cross-team event_callback payload is dropped, never reaching the handler', async () => {
    const conn = connection({ teamId: TEAM_ID })
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    const payload = { type: 'event_callback', team_id: 'T99999999', event_id: 'Ev1' }
    await dispatch(
      delivery({ connectionId: conn.connection.id, connectionRevision: conn.connection.materialRevision, payload }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
  })

  test('a cross-team slash_command payload is dropped, never reaching the handler', async () => {
    const conn = connection({ teamId: TEAM_ID })
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    const payload = { command: '/tau', team_id: 'T99999999', response_url: 'https://hooks.slack.com/commands/T1/1/abc' }
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'slash_command',
        payload,
      }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
    expect(calls.postResponseUrl).toEqual([])
  })

  test('a slash_command payload missing team_id is dropped, never reaching the handler', async () => {
    const conn = connection({ teamId: TEAM_ID })
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    const payload = { command: '/tau', response_url: 'https://hooks.slack.com/commands/T1/1/abc' }
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'slash_command',
        payload,
      }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
    expect(calls.postResponseUrl).toEqual([])
  })

  test('a non-actionable event_callback is dropped before ever claiming a receipt', async () => {
    const conn = connection({ teamId: TEAM_ID })
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      provider: { parseWebhook: async () => null } as unknown as ChannelProvider,
    })
    const dispatch = createSlackRelayDispatcher(base)
    const payload = { type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev-non-actionable' }
    await dispatch(
      delivery({ connectionId: conn.connection.id, connectionRevision: conn.connection.materialRevision, payload }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
    expect(calls.claim).toEqual([])
  })

  test('a matching event_callback is forwarded to the shared webhook handler with its raw payload', async () => {
    const conn = connection({ teamId: TEAM_ID })
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    const payload = { type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev1', event: { type: 'app_mention' } }
    await dispatch(
      delivery({ connectionId: conn.connection.id, connectionRevision: conn.connection.materialRevision, payload }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([payload])
  })

  test('a busy receipt (another replica already processing this delivery) leaves the lease unacknowledged', async () => {
    const conn = connection()
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      receipts: {
        claim: async () => ({ status: 'busy' as const }),
        complete: async () => undefined,
        release: async () => undefined,
      },
    })
    const dispatch = createSlackRelayDispatcher(base)
    await expect(
      dispatch(
        delivery({ connectionId: conn.connection.id, connectionRevision: conn.connection.materialRevision }),
        interestFor(conn)
      )
    ).rejects.toThrow('relay_receipt_busy')
    expect(calls.dispatchWebhook).toEqual([])
  })

  test('a receipt already completed acks without redispatching', async () => {
    const conn = connection()
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      receipts: {
        claim: async () => ({ status: 'completed' as const }),
        complete: async () => undefined,
        release: async () => undefined,
      },
    })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({ connectionId: conn.connection.id, connectionRevision: conn.connection.materialRevision }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
  })

  test('a slash command synchronous response is POSTed to a valid hooks.slack.com response_url', async () => {
    const conn = connection()
    const responseBody = { response_type: 'ephemeral', text: 'hi' }
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      dispatchWebhook: async () => ({ response: responseBody }) satisfies HandlerResult,
    })
    const dispatch = createSlackRelayDispatcher(base)
    const responseUrl = 'https://hooks.slack.com/commands/T1/1/abc'
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'slash_command',
        payload: { command: '/tau', team_id: TEAM_ID, response_url: responseUrl },
      }),
      interestFor(conn)
    )
    expect(calls.postResponseUrl).toEqual([{ url: responseUrl, body: responseBody }])
  })

  test('a slash command response is never sent to a response_url outside hooks.slack.com', async () => {
    const conn = connection()
    const responseBody = { response_type: 'ephemeral', text: 'hi' }
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      dispatchWebhook: async () => ({ response: responseBody }) satisfies HandlerResult,
    })
    const dispatch = createSlackRelayDispatcher(base)
    for (const bad of ['http://hooks.slack.com/x', 'https://evil.example.com/hooks.slack.com', 'not-a-url']) {
      await dispatch(
        delivery({
          connectionId: conn.connection.id,
          connectionRevision: conn.connection.materialRevision,
          eventType: 'slash_command',
          deliveryId: crypto.randomUUID(),
          payload: { command: '/tau', team_id: TEAM_ID, response_url: bad },
        }),
        interestFor(conn)
      )
    }
    expect(calls.postResponseUrl).toEqual([])
  })

  test('a slash command already answered via the Bot API (empty response) is never sent to response_url', async () => {
    const conn = connection()
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      dispatchWebhook: async () => ({ response: null, emptyResponse: true }) satisfies HandlerResult,
    })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'slash_command',
        payload: { command: '/tau', team_id: TEAM_ID, response_url: 'https://hooks.slack.com/commands/T1/1/abc' },
      }),
      interestFor(conn)
    )
    expect(calls.postResponseUrl).toEqual([])
  })

  test('app_uninstalled marks the managed connection reauthorization_required and refreshes ChannelConnections', async () => {
    const conn = connection()
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'app_uninstalled',
        payload: {},
      }),
      interestFor(conn)
    )
    expect(calls.markReauthorizationRequired).toEqual([
      { id: conn.connection.id, materialRevision: conn.connection.materialRevision, code: 'provider_access_revoked' },
    ])
    expect(calls.refreshChannelConnections).toBe(1)
    expect(calls.audit).toEqual([
      {
        connectionId: conn.connection.id,
        action: 'slack_relay_revocation',
        outcome: 'failed',
        code: 'provider_access_revoked',
      },
    ])
  })

  test('tokens_revoked only revokes when the revoked bot token belongs to this connection', async () => {
    const conn = connection({ botUserId: 'UBOT1' })
    const { base: matching, calls: matchingCalls } = deps({ resolveConnection: async () => conn })
    await createSlackRelayDispatcher(matching)(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'tokens_revoked',
        payload: { event: { tokens: { bot: ['UBOT1', 'UOTHER'] } } },
      }),
      interestFor(conn)
    )
    expect(matchingCalls.markReauthorizationRequired).toHaveLength(1)

    const { base: other, calls: otherCalls } = deps({ resolveConnection: async () => conn })
    await createSlackRelayDispatcher(other)(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'tokens_revoked',
        payload: { event: { tokens: { bot: ['UOTHER'] } } },
      }),
      interestFor(conn)
    )
    expect(otherCalls.markReauthorizationRequired).toEqual([])
  })

  test('an already-revoked connection does not re-audit or re-refresh (no duplicate broker revocation loop)', async () => {
    const conn = connection()
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      markReauthorizationRequired: async () => false,
    })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'app_uninstalled',
      }),
      interestFor(conn)
    )
    expect(calls.audit).toEqual([])
    expect(calls.refreshChannelConnections).toBe(0)
  })

  test('an unrecognized relay event type is acknowledged and ignored', async () => {
    const conn = connection()
    const { base, calls } = deps({ resolveConnection: async () => conn })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({
        connectionId: conn.connection.id,
        connectionRevision: conn.connection.materialRevision,
        eventType: 'unknown_event' as SlackRelayDelivery['eventType'],
      }),
      interestFor(conn)
    )
    expect(calls.dispatchWebhook).toEqual([])
    expect(calls.markReauthorizationRequired).toEqual([])
  })

  test('no declared interest for this connection is a no-op (nothing to dispatch)', async () => {
    const { base, calls } = deps()
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(delivery(), [])
    expect(calls.dispatchWebhook).toEqual([])
  })
})

describe('createSlackRelayDispatcher — DB-backed receipt durability', () => {
  test('a non-actionable event_callback never inserts a durable receipt row', async () => {
    const conn = connection()
    const receipts = new DbEventPollingDispatchStore()
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      receipts,
      provider: { parseWebhook: async () => null } as unknown as ChannelProvider,
    })
    const dispatch = createSlackRelayDispatcher(base)
    const d = delivery({
      connectionId: conn.connection.id,
      connectionRevision: conn.connection.materialRevision,
      payload: { type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev-non-actionable' },
    })
    await dispatch(d, interestFor(conn))
    expect(calls.dispatchWebhook).toEqual([])
    const rows = await db
      .select({ eventKey: integrationEventPollingDispatches.eventKey })
      .from(integrationEventPollingDispatches)
      .where(eq(integrationEventPollingDispatches.eventKey, `relay:${conn.connection.id}:${d.deliveryId}`))
    expect(rows).toHaveLength(0)
  })

  test('a duplicate deliveryId is dispatched exactly once, durably', async () => {
    const conn = connection()
    const receipts = new DbEventPollingDispatchStore()
    const { base, calls } = deps({ resolveConnection: async () => conn, receipts })
    const dispatch = createSlackRelayDispatcher(base)
    const d = delivery({
      connectionId: conn.connection.id,
      connectionRevision: conn.connection.materialRevision,
      payload: { type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev1' },
    })
    try {
      await dispatch(d, interestFor(conn))
      // Redelivered lease, or a second replica racing the same pull: still exactly one dispatch.
      await dispatch(d, interestFor(conn))
      expect(calls.dispatchWebhook).toHaveLength(1)
    } finally {
      await db
        .delete(integrationEventPollingDispatches)
        .where(eq(integrationEventPollingDispatches.eventKey, `relay:${conn.connection.id}:${d.deliveryId}`))
    }
  })

  test('a handler failure releases the claim, so redelivery of the same deliveryId is not stuck behind relay_receipt_busy', async () => {
    const conn = connection()
    const receipts = new DbEventPollingDispatchStore()
    let attempts = 0
    const { base, calls } = deps({
      resolveConnection: async () => conn,
      receipts,
      dispatchWebhook: async (_provider, payload) => {
        attempts += 1
        if (attempts === 1) throw new Error('transient handler failure')
        calls.dispatchWebhook.push(payload)
        return { response: { ok: true }, emptyResponse: true }
      },
    })
    const dispatch = createSlackRelayDispatcher(base)
    const d = delivery({
      connectionId: conn.connection.id,
      connectionRevision: conn.connection.materialRevision,
      payload: { type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev1' },
    })
    try {
      await expect(dispatch(d, interestFor(conn))).rejects.toThrow('transient handler failure')
      // The relay redelivers the same deliveryId after the failed attempt. If
      // the claim were never released, this would throw `relay_receipt_busy`
      // instead of actually reprocessing the event.
      await dispatch(d, interestFor(conn))
      expect(calls.dispatchWebhook).toHaveLength(1)
      expect(attempts).toBe(2)
    } finally {
      await db
        .delete(integrationEventPollingDispatches)
        .where(eq(integrationEventPollingDispatches.eventKey, `relay:${conn.connection.id}:${d.deliveryId}`))
    }
  })
})

describe('production webhook dispatch (real slackProvider + real handleChannelEvent)', () => {
  test('an event_callback reaches handleChannelEvent with the delivery team as the platform id', async () => {
    const findInstance = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(null)
    const botId = spyOn(slackProvider, 'getBotUserId').mockResolvedValue('BOTUSER1')
    try {
      const payload = {
        type: 'event_callback',
        team_id: TEAM_ID,
        event_id: 'Ev1',
        event: { type: 'app_mention', text: 'hi <@BOTUSER1>', user: 'U1', channel: 'C1', ts: '100.1' },
      }
      const result = await defaultDispatchWebhook(slackProvider, payload)
      expect(findInstance).toHaveBeenCalledWith('slack', TEAM_ID)
      // No channel instance for this team: the safe configuration-error reply, not a crash.
      expect(result).toMatchObject({ response: expect.anything() })
    } finally {
      findInstance.mockRestore()
      botId.mockRestore()
    }
  })

  test('a null/ignored parse (challenge, or nothing actionable) never reaches the handler', async () => {
    const findInstance = spyOn(ChannelInstance, 'findByProvider').mockResolvedValue(null)
    try {
      const result = await defaultDispatchWebhook(slackProvider, { type: 'url_verification', challenge: 'abc' })
      expect(result).toBeUndefined()
      expect(findInstance).not.toHaveBeenCalled()
    } finally {
      findInstance.mockRestore()
    }
  })
})

describe('managed connection revocation falls back the live ChannelConnections transport', () => {
  const priorEnv = new Map<string, string | undefined>()

  async function wipe() {
    const refs = await db
      .select({ ref: integrationConnections.credentialRef })
      .from(integrationConnections)
      .where(eq(integrationConnections.providerKey, 'slack'))
    await db.delete(integrationConnections).where(eq(integrationConnections.providerKey, 'slack'))
    if (refs.length)
      await db.delete(secrets).where(
        inArray(
          secrets.key,
          refs.map((row) => row.ref)
        )
      )
  }

  beforeEach(async () => {
    for (const key of ['FICUS_ENCRYPTION_KEY']) {
      priorEnv.set(key, process.env[key])
    }
    process.env.FICUS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    await wipe()
    resetSecretStore()
    resetSettingsStore()
    await getSecretStore().initialize()
    await getSettingsStore().initialize()
  })
  afterEach(async () => {
    await wipe()
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSecretStore()
    resetSettingsStore()
  })

  test('app_uninstalled through the real repository flips authState, and a refreshed ChannelConnections stops offering the managed row', async () => {
    // A fake `auth.test` keyed by bearer token, so validate()/enable() never touch the network
    // (same approach `channels/connections.test.ts` uses for the same managed-row shape).
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      if (String(input).includes('slack.com/api/auth.test') && auth === 'Bearer xoxb-managed-good')
        return Response.json({ ok: true, team_id: TEAM_ID, user_id: 'UBOT1', team: 'Acme' })
      return Response.json({ ok: false, error: 'invalid_auth' })
    }) as typeof fetch
    const plugins = createChannelPlugins({ fetch: fetchImpl })
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
      displayName: 'Acme (managed)',
      configuration: { version: 1, teamId: TEAM_ID, botUserId: 'UBOT1', teamName: 'Acme', appId: 'A1' },
      credential: serializeOAuthCredential({
        version: 1,
        accessToken: 'xoxb-managed-good',
        refreshToken: null,
        expiresAt: null,
        tokenRevision: 1,
      }),
      actor: 'test',
      authorizationGrant: true,
      clientAuthority: 'platform_broker',
    })
    await service.enable(created.id, 'test')
    const stored = (await repository.get(created.id))!

    const connections = createChannelConnections({
      plugins,
      fetch: fetchImpl,
      resolveAuthority: () => 'platform_broker',
    })
    await connections.refresh()
    expect(connections.get('slack')?.authority).toBe('platform_broker')
    expect(connections.storedManaged('slack')?.id).toBe(created.id)

    const { base } = deps({
      resolveConnection: async () => ({
        connection: { id: created.id, materialRevision: stored.materialRevision },
        configuration: { version: 1, teamId: TEAM_ID, botUserId: 'UBOT1' },
      }),
      markReauthorizationRequired: (input) => repository.markReauthorizationRequired(input),
      refreshChannelConnections: () => connections.refresh(),
      audit: async () => undefined,
    })
    const dispatch = createSlackRelayDispatcher(base)
    await dispatch(
      delivery({ connectionId: created.id, connectionRevision: stored.materialRevision, eventType: 'app_uninstalled' }),
      [{ connectionId: created.id, teamId: TEAM_ID }]
    )

    // ChannelConnections has been refreshed by the dispatcher itself: the managed
    // row is no longer usable, so the transport falls back (here, to nothing local).
    expect(connections.get('slack')).toBeUndefined()
    expect(connections.storedManaged('slack')?.authState).toBe('reauthorization_required')
  })
})

describe('createManagedSlackRelayResolver', () => {
  test('logs once on the transition into unresolvable, not on every subsequent tick', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let live = false
      const resolver = createManagedSlackRelayResolver(async (id) =>
        live
          ? {
              connection: { id, materialRevision: 'rev-1' },
              configuration: { version: 1, teamId: TEAM_ID },
              credential: { accessToken: 'xoxb-live' } as any,
            }
          : undefined
      )

      // Still advertised by the snapshot, but not (yet) live-resolvable.
      expect(await resolver('conn-1')).toBeUndefined()
      expect(await resolver('conn-1')).toBeUndefined()
      expect(await resolver('conn-1')).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)

      // Recovers: no further warning while it stays resolvable.
      live = true
      expect(await resolver('conn-1')).toEqual({ id: 'conn-1', revision: 'rev-1', accessToken: 'xoxb-live' })
      expect(await resolver('conn-1')).toEqual({ id: 'conn-1', revision: 'rev-1', accessToken: 'xoxb-live' })
      expect(warn).toHaveBeenCalledTimes(1)

      // Fails again: a fresh transition, diagnosable again.
      live = false
      expect(await resolver('conn-1')).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
