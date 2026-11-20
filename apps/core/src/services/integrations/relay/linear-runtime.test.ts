import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { LinearRelayDelivery } from '@ficus/shared/integration-relay'
import { db, integrationConnections, integrationEventPollingDispatches, webhookEvents } from '../../../db'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'
import { storeWebhookEvent } from '../../webhooks/store'
import { PlatformRequestError, type platformRequest } from '../../platform/instance-client'
import { getSecretStore } from '../../secrets'
import { DbIntegrationConnectionRepository } from '../db-connection-repository'
import { DbEventPollingDispatchStore } from '../db-event-polling-dispatch-store'
import { serializeOAuthCredential } from '../authorization/credential-bundle'
import { clearLinearUserCacheForTest } from '../linear/app-ingress'
import { handleLinearAppEvent } from '../linear/app-webhook'
import { resolveManagedLinearConnection } from '../linear/resolve-connection'
import { LINEAR_ACK_BODY } from '../linear/session-acknowledger'
import { APP_TOKEN, createLinearAppFixture } from '../linear/testing/app-fixtures'
import { agentSessionCreatedPayload, createFakeLinear, type FakeLinear } from '../linear/testing/fake-linear'
import { HostedIntegrationRelayRunner } from './runner'
import {
  createLinearRelayDispatcher,
  createManagedLinearRelayResolver,
  linearRelayInterests,
  linearRelayProvider,
  linearRelayReceiptKey,
  processRelayedLinearDelivery,
  recordLinearRelaySubscribeRejection,
  type LinearRelayDispatchDependencies,
  type LinearRelayInterest,
  type ManagedLinearConnection,
} from './linear-runtime'

type Fixture = Awaited<ReturnType<typeof createLinearAppFixture>>
const fixtures: Fixture[] = []
const deliveryIds: string[] = []
const originalFetch = globalThis.fetch
const originalManaged = process.env.FICUS_MANAGED

async function hosted(input: { clientAuthority?: 'local' | 'platform_broker' } = {}) {
  const fixture = await createLinearAppFixture({
    clientAuthority: input.clientAuthority ?? 'platform_broker',
    appSettings: false,
  })
  fixtures.push(fixture)
  return fixture
}

function relayDelivery(fixture: Fixture, payload: Record<string, unknown>, deliveryId = randomUUID()) {
  deliveryIds.push(deliveryId)
  return {
    id: randomUUID(),
    leaseToken: randomUUID(),
    connectionId: fixture.connectionId,
    connectionRevision: fixture.revision,
    deliveryId,
    resourceId: fixture.organizationId,
    resourceKey: fixture.organizationId,
    eventType: payload.type as LinearRelayDelivery['eventType'],
    payload,
  } satisfies LinearRelayDelivery
}

beforeAll(async () => {
  await getSecretStore().initialize()
  // Schema push skips partial indexes; delivery deduplication needs the migration's unique index.
  await ensureQueryIndex('uq_webhook_events_provider_delivery')
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalManaged === undefined) delete process.env.FICUS_MANAGED
  else process.env.FICUS_MANAGED = originalManaged
  const ids = deliveryIds.splice(0)
  if (ids.length) {
    await db
      .delete(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'linear-app'), inArray(webhookEvents.deliveryId, ids)))
    await db
      .delete(integrationEventPollingDispatches)
      .where(inArray(integrationEventPollingDispatches.eventKey, ids.map(linearRelayReceiptKey)))
  }
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe('linearRelayInterests', () => {
  test('offers enabled hosted app connections and leaves out everything else', async () => {
    const offered = await hosted()
    const local = await hosted({ clientAuthority: 'local' })
    const disabled = await hosted()
    await db
      .update(integrationConnections)
      .set({ enabled: false })
      .where(eq(integrationConnections.id, disabled.connectionId))
    const revoked = await hosted()
    await new DbIntegrationConnectionRepository().markReauthorizationRequired({
      id: revoked.connectionId,
      materialRevision: revoked.revision,
      code: 'app_uninstalled',
    })
    const ids = (await linearRelayInterests()).map((interest) => interest.connectionId)
    expect(ids).toContain(offered.connectionId)
    for (const excluded of [local, disabled, revoked]) expect(ids).not.toContain(excluded.connectionId)
    expect((await linearRelayInterests()).find((interest) => interest.connectionId === offered.connectionId)).toEqual({
      connectionId: offered.connectionId,
      organizationId: offered.organizationId,
    })
  })

  test('a claimed revision is recorded on the connection, shown in its view and no longer offered; a reconnect clears it', async () => {
    const fixture = await hosted()
    const repository = new DbIntegrationConnectionRepository()
    await recordLinearRelaySubscribeRejection({
      connectionId: fixture.connectionId,
      connectionRevision: fixture.revision,
      code: 'linear_organization_claimed',
    })
    expect((await repository.get(fixture.connectionId))?.relaySubscribeErrorCode).toBe('linear_organization_claimed')
    expect((await linearRelayInterests()).map((interest) => interest.connectionId)).not.toContain(fixture.connectionId)

    // A rejection for an older revision never lands on the current one.
    const other = await hosted()
    await recordLinearRelaySubscribeRejection({
      connectionId: other.connectionId,
      connectionRevision: randomUUID(),
      code: 'linear_organization_claimed',
    })
    expect((await repository.get(other.connectionId))?.relaySubscribeErrorCode).toBeNull()

    // Reconnecting replaces the material revision: the old refusal is stale and the connection is offered again.
    await db
      .update(integrationConnections)
      .set({ materialRevision: randomUUID() })
      .where(eq(integrationConnections.id, fixture.connectionId))
    expect((await repository.get(fixture.connectionId))?.relaySubscribeErrorCode).toBeNull()
    expect((await linearRelayInterests()).map((interest) => interest.connectionId)).toContain(fixture.connectionId)
  })
})

describe('resolveManagedLinearConnection', () => {
  test('returns the bare token and its revision for a hosted connection, and refuses a local one', async () => {
    const fixture = await hosted()
    const resolve = createManagedLinearRelayResolver()
    expect(await resolve(fixture.connectionId)).toEqual({
      id: fixture.connectionId,
      revision: fixture.revision,
      accessToken: APP_TOKEN,
      credentialRevision: 1,
    })
    const local = await hosted({ clientAuthority: 'local' })
    expect(await resolveManagedLinearConnection(local.connectionId)).toBeUndefined()
  })

  test('a rotated token is visible on the next read with a new credential revision', async () => {
    const fixture = await hosted()
    await getSecretStore().set(
      fixture.credentialRef,
      serializeOAuthCredential({
        version: 1,
        accessToken: 'rotated-token',
        refreshToken: 'rotated-refresh',
        expiresAt: new Date(Date.now() + 86_000_000).toISOString(),
        tokenRevision: 2,
      }),
      'test'
    )
    expect(await createManagedLinearRelayResolver()(fixture.connectionId)).toMatchObject({
      accessToken: 'rotated-token',
      credentialRevision: 2,
    })
  })

  test('an expired access token is not offered to the relay', async () => {
    const fixture = await hosted()
    await getSecretStore().set(
      fixture.credentialRef,
      serializeOAuthCredential({
        version: 1,
        accessToken: 'expired',
        refreshToken: 'refresh',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        tokenRevision: 3,
      }),
      'test'
    )
    expect(await resolveManagedLinearConnection(fixture.connectionId)).toBeUndefined()
  })
})

describe('createLinearRelayDispatcher', () => {
  const organizationId = randomUUID()
  const live: ManagedLinearConnection = {
    connection: { id: randomUUID(), materialRevision: randomUUID() },
    configuration: { organizationId },
  }
  const interests: LinearRelayInterest[] = [{ connectionId: live.connection.id, organizationId }]
  function delivery(overrides: Partial<LinearRelayDelivery> = {}): LinearRelayDelivery {
    const deliveryId = randomUUID()
    deliveryIds.push(deliveryId)
    return {
      id: randomUUID(),
      leaseToken: randomUUID(),
      connectionId: live.connection.id,
      connectionRevision: live.connection.materialRevision,
      deliveryId,
      resourceId: organizationId,
      resourceKey: organizationId,
      eventType: 'Issue',
      payload: { type: 'Issue', organizationId },
      ...overrides,
    }
  }
  function deps(overrides: Partial<LinearRelayDispatchDependencies> = {}) {
    const processed: string[] = []
    return {
      processed,
      deps: {
        resolveConnection: async () => live,
        receipts: new DbEventPollingDispatchStore(),
        process: async (event: LinearRelayDelivery) => {
          processed.push(event.deliveryId)
        },
        ...overrides,
      } satisfies LinearRelayDispatchDependencies,
    }
  }

  test('no usable connection leaves the delivery unacknowledged', async () => {
    const { deps: d } = deps({ resolveConnection: async () => undefined })
    await expect(createLinearRelayDispatcher(d)(delivery(), interests)).rejects.toThrow(
      'relay_authorization_unavailable'
    )
  })

  test('a delivery queued for an older revision, or whose body names another workspace or type, is not processed', async () => {
    const { deps: d, processed } = deps()
    const dispatch = createLinearRelayDispatcher(d)
    await dispatch(delivery({ connectionRevision: randomUUID() }), interests)
    await dispatch(delivery({ payload: { type: 'Issue', organizationId: randomUUID() } }), interests)
    await dispatch(delivery({ payload: { type: 'Comment', organizationId } }), interests)
    const other = randomUUID()
    await dispatch(
      delivery({ resourceId: other, resourceKey: other, payload: { type: 'Issue', organizationId: other } }),
      interests
    )
    expect(processed).toEqual([])
  })

  test('a delivery ID is processed exactly once, durably', async () => {
    const { deps: d, processed } = deps()
    const dispatch = createLinearRelayDispatcher(d)
    const first = delivery()
    await dispatch(first, interests)
    // Platform redelivers after a lost acknowledgment, with a new lease.
    await dispatch({ ...first, id: randomUUID(), leaseToken: randomUUID() }, interests)
    expect(processed).toEqual([first.deliveryId])
    const [receipt] = await db
      .select()
      .from(integrationEventPollingDispatches)
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, 'linear'),
          eq(integrationEventPollingDispatches.eventKey, `linear:${first.deliveryId}`)
        )
      )
    expect(receipt?.completedAt).toBeInstanceOf(Date)
  })

  test('a processing failure releases the receipt so the redelivery is processed', async () => {
    let fail = true
    const { deps: d, processed } = deps({
      process: async (event) => {
        if (fail) throw new Error('database unavailable')
        processed.push(event.deliveryId)
      },
    })
    const dispatch = createLinearRelayDispatcher(d)
    const event = delivery()
    await expect(dispatch(event, interests)).rejects.toThrow('database unavailable')
    fail = false
    await dispatch(event, interests)
    expect(processed).toEqual([event.deliveryId])
  })
})

describe('processRelayedLinearDelivery redelivery', () => {
  const organizationId = randomUUID()
  const live: ManagedLinearConnection = {
    connection: { id: randomUUID(), materialRevision: randomUUID() },
    configuration: { organizationId },
  }
  const interests: LinearRelayInterest[] = [{ connectionId: live.connection.id, organizationId }]
  function delivery(): LinearRelayDelivery {
    const deliveryId = randomUUID()
    deliveryIds.push(deliveryId)
    return {
      id: randomUUID(),
      leaseToken: randomUUID(),
      connectionId: live.connection.id,
      connectionRevision: live.connection.materialRevision,
      deliveryId,
      resourceId: organizationId,
      resourceKey: organizationId,
      eventType: 'Issue',
      payload: { type: 'Issue', organizationId },
    }
  }
  async function row(deliveryId: string) {
    const [stored] = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, deliveryId)))
    return stored
  }
  async function receipt(deliveryId: string) {
    const [stored] = await db
      .select()
      .from(integrationEventPollingDispatches)
      .where(
        and(
          eq(integrationEventPollingDispatches.providerKey, 'linear'),
          eq(integrationEventPollingDispatches.eventKey, linearRelayReceiptKey(deliveryId))
        )
      )
    return stored
  }

  test('processing succeeded but the receipt did not complete: the redelivery runs the handlers no second time', async () => {
    const handled: string[] = []
    const handlers = (async (ctx: { payload: Record<string, unknown>; headers: Record<string, string> }) => {
      handled.push(ctx.headers['linear-delivery']!)
    }) as Parameters<typeof processRelayedLinearDelivery>[1]
    const store = new DbEventPollingDispatchStore()
    let failComplete = true
    const dispatch = createLinearRelayDispatcher({
      resolveConnection: async () => live,
      receipts: {
        claim: (...args) => store.claim(...args),
        release: (...args) => store.release(...args),
        complete: async (...args) => {
          if (failComplete) throw new Error('database unavailable')
          return store.complete(...args)
        },
      },
      process: (event) => processRelayedLinearDelivery(event, handlers),
    })
    const event = delivery()
    await expect(dispatch(event, interests)).rejects.toThrow('database unavailable')
    expect(handled).toEqual([event.deliveryId])
    expect((await row(event.deliveryId))?.processedAt).toBeInstanceOf(Date)
    expect((await receipt(event.deliveryId))?.completedAt ?? null).toBeNull()

    // Platform redelivers the unacknowledged delivery with a new lease.
    failComplete = false
    await dispatch({ ...event, id: randomUUID(), leaseToken: randomUUID() }, interests)
    expect(handled).toEqual([event.deliveryId])
    expect((await receipt(event.deliveryId))?.completedAt).toBeInstanceOf(Date)
  })

  test('a row that recorded a handler error is not retried on redelivery', async () => {
    let calls = 0
    const failing = (async () => {
      calls++
      throw new Error('handler failed')
    }) as Parameters<typeof processRelayedLinearDelivery>[1]
    const event = delivery()
    await processRelayedLinearDelivery(event, failing)
    expect((await row(event.deliveryId))?.error).toBeTruthy()
    await processRelayedLinearDelivery(event, failing)
    expect(calls).toBe(1)
  })

  test('a stored row that was never processed is processed on redelivery', async () => {
    const event = delivery()
    // An earlier attempt stored the row and then stopped before any handler finished.
    await storeWebhookEvent({
      provider: 'linear-app',
      eventType: event.eventType,
      payload: event.payload,
      headers: { 'linear-delivery': event.deliveryId, 'linear-event': event.eventType },
      signature: null,
      verified: true,
      deliveryId: event.deliveryId,
    })
    expect((await row(event.deliveryId))?.processedAt ?? null).toBeNull()
    const handled: string[] = []
    await processRelayedLinearDelivery(event, (async (ctx: { headers: Record<string, string> }) => {
      handled.push(ctx.headers['linear-delivery']!)
    }) as Parameters<typeof processRelayedLinearDelivery>[1])
    expect(handled).toEqual([event.deliveryId])
    expect((await row(event.deliveryId))?.processedAt).toBeInstanceOf(Date)
    const stored = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, event.deliveryId)))
    expect(stored).toHaveLength(1)
  })
})

describe('hosted relay end to end (fake Platform and fake Linear)', () => {
  let linear: FakeLinear
  beforeEach(() => {
    process.env.FICUS_MANAGED = '1'
    clearLinearUserCacheForTest()
  })

  test('a relayed session is acknowledged through the direct path processing, stored once and acknowledged to Platform', async () => {
    const fixture = await hosted()
    linear = createFakeLinear({
      organization: { id: fixture.organizationId, name: 'Acme', urlKey: 'acme' },
      app: { id: fixture.appUserId, name: 'Ficus', app: true, active: true },
    })
    globalThis.fetch = linear.fetch
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: randomUUID() })
    const payload = agentSessionCreatedPayload(fixture.context, { sessionId, creatorId: randomUUID(), issue: null })
    const queued = relayDelivery(fixture, payload)
    let pending: LinearRelayDelivery[] = [queued]
    const calls: string[] = []
    const request: typeof platformRequest = async (input) => {
      const path = input.path.split('/').at(-1)!
      calls.push(path)
      if (path === 'status') return input.schema.parse({ enabled: true, connections: [] })
      if (path === 'pull') {
        const deliveries = pending
        pending = []
        return input.schema.parse({ deliveries })
      }
      return input.schema.parse({ ok: true })
    }
    const runner = new HostedIntegrationRelayRunner(linearRelayProvider, {
      managed: () => true,
      interests: linearRelayInterests,
      resolve: createManagedLinearRelayResolver(),
      request,
      dispatch: createLinearRelayDispatcher({
        resolveConnection: resolveManagedLinearConnection,
        receipts: new DbEventPollingDispatchStore(),
        process: (delivery) => processRelayedLinearDelivery(delivery, handleLinearAppEvent),
      }),
      onSubscribeRejected: recordLinearRelaySubscribeRejection,
      onError: (code) => {
        throw new Error(`unexpected relay error ${code}`)
      },
    })
    await runner.tick()
    expect(calls).toEqual(['status', 'subscribe', 'pull', 'ack'])
    const activities = linear.activitiesFor(sessionId).map((activity) => activity.content)
    expect(activities[0]).toEqual({ type: 'thought', body: LINEAR_ACK_BODY })
    const stored = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, queued.deliveryId)))
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ verified: true, eventType: 'AgentSessionEvent', error: null })
    expect(stored[0]!.processedAt).toBeInstanceOf(Date)
    expect(stored[0]!.headers).toEqual({ 'linear-delivery': queued.deliveryId, 'linear-event': 'AgentSessionEvent' })

    // A redelivery of the same Linear delivery (lost acknowledgment) is acknowledged without reprocessing.
    const before = linear.calls.length
    pending = [{ ...queued, id: randomUUID(), leaseToken: randomUUID() }]
    calls.length = 0
    await runner.tick()
    expect(calls).toEqual(['pull', 'ack'])
    expect(linear.calls.length).toBe(before)
  })

  test('a 409 linear_organization_claimed answer is recorded on the connection and stops its subscription', async () => {
    const fixture = await hosted()
    const calls: string[] = []
    const request: typeof platformRequest = async (input) => {
      const path = input.path.split('/').at(-1)!
      calls.push(path)
      if (path === 'status') return input.schema.parse({ enabled: true, connections: [] })
      if (path === 'subscribe') throw new PlatformRequestError('linear_organization_claimed', false, 409)
      return input.schema.parse({ ok: true })
    }
    const runner = new HostedIntegrationRelayRunner(linearRelayProvider, {
      managed: () => true,
      // Only this test's connection, so other hosted rows in the database cannot interleave.
      interests: async () =>
        (await linearRelayInterests()).filter((interest) => interest.connectionId === fixture.connectionId),
      resolve: createManagedLinearRelayResolver(),
      request,
      dispatch: async () => {},
      onSubscribeRejected: recordLinearRelaySubscribeRejection,
      onError: () => {},
    })
    await runner.tick()
    expect(calls).toEqual(['status', 'subscribe'])
    const connection = await new DbIntegrationConnectionRepository().get(fixture.connectionId)
    expect(connection?.relaySubscribeErrorCode).toBe('linear_organization_claimed')
    // The connection itself stays usable for agents; only its relay subscription stops.
    expect(connection).toMatchObject({ enabled: true, authState: 'authenticated', healthState: 'healthy' })
    calls.length = 0
    await runner.tick()
    expect(calls).toEqual([])
  })
})
