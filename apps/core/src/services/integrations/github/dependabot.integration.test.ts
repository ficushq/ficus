import { afterEach, expect, spyOn, test } from 'bun:test'
import { and, eq, inArray, sql } from 'drizzle-orm'
import {
  createBlankWorkflow,
  createWorkflowRun,
  effectiveSquadEventRules,
  resolveTrackedResources,
} from '@ficus/shared'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import {
  db,
  squads,
  agents,
  agentTypes,
  inbox,
  workStreams,
  workStreamFlowRuns,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  integrationOutputDeliveries,
  integrationAuditEvents,
  integrationConnections,
  integrationEventPollingCursors,
  integrationEventPollingDispatches,
} from '../../../db'
import { Agent } from '../../../entities/Agent'
import * as api from '../../github/api-client'
import { publishGitHubWebhookOutputs } from './ingress'
import {
  publishIntegrationOutputs,
  reconcileUnmatchedOutputs,
  reconcileOutputDeliveries,
  isCurrentIntegrationDelivery,
} from '../outputs/runtime'
import { InboxMessage } from '../../../entities/InboxMessage'
import { resolveEventTrackedResource } from '../../work-streams/tracked-resources'
useEnabledIntegrationFixtures('github')

const owned: string[] = []
const connections: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
const pollKeys: string[] = []
const dispatchKeys: string[] = []
const prefix = `dependabot-${crypto.randomUUID()}`
const repo = `${prefix}/private`
const repository = { id: 101, full_name: repo }
const alert = {
  number: 7,
  state: 'open',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  dependency: { package: { name: 'widget', ecosystem: 'npm' }, manifest_path: 'bun.lock' },
  security_advisory: { ghsa_id: 'GHSA-abcd-efgh-ijkl', severity: 'high' },
  security_vulnerability: {
    severity: 'high',
    vulnerable_version_range: '<2',
    first_patched_version: { identifier: '2' },
  },
}
const event = (action = 'created', overrides = {}) => ({
  type: 'dependabot_alert',
  payload: { repository, action, alert: { ...alert, ...overrides } },
})
async function fixture(metadata: unknown = { github: [{ repo }] }) {
  await db
    .insert(agentTypes)
    .values({ id: prefix, name: prefix, model: 'anthropic:claude-sonnet-4-5', systemPrompt: 'Test manager' })
    .onConflictDoNothing()
  const [squad] = await db
    .insert(squads)
    .values({ name: prefix, purpose: 'Dependabot webhook test', metadata })
    .returning()
  owned.push(squad!.id)
  const [manager] = await db
    .insert(agents)
    .values({ squadId: squad!.id, agentTypeId: prefix, status: 'idle' })
    .returning()
  await db.update(squads).set({ managerAgentId: manager!.id }).where(eq(squads.id, squad!.id))
  const connection = await createTestGitHubConnection({ squadId: squad!.id })
  connections.push(connection)
  return { squadId: squad!.id, managerId: manager!.id, connectionId: connection.id }
}
afterEach(async () => {
  if (pollKeys.length)
    await db
      .delete(integrationEventPollingCursors)
      .where(inArray(integrationEventPollingCursors.resourceKey, pollKeys.splice(0)))
  if (dispatchKeys.length)
    await db
      .delete(integrationEventPollingDispatches)
      .where(inArray(integrationEventPollingDispatches.eventKey, dispatchKeys.splice(0)))
  const recipients = await db.select({ id: agents.id }).from(agents).where(inArray(agents.squadId, owned))
  if (recipients.length)
    await db.delete(inbox).where(
      inArray(
        inbox.recipientId,
        recipients.map((r) => r.id)
      )
    )
  await db.delete(workStreams).where(inArray(workStreams.squadId, owned))
  await db.update(squads).set({ managerAgentId: null }).where(inArray(squads.id, owned))
  await db.delete(agents).where(inArray(agents.squadId, owned))
  for (const connection of connections.splice(0)) {
    await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.connectionId, connection.id))
    await db
      .delete(integrationOutputEvents)
      .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${connection.id}`)
    await connection.dispose()
  }
  await db.delete(squads).where(inArray(squads.id, owned.splice(0)))
  await db.delete(agentTypes).where(eq(agentTypes.id, prefix))
})

test('duplicate webhooks notify one manager; inaccessible alerts and unrelated squads receive no messages', async () => {
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const one = await fixture()
  const unrelated = await fixture({ github: [{ repo: 'elsewhere/private' }] })
  let securityAllowed = true
  const read = spyOn(api, 'githubApiGet').mockImplementation(
    async <T>(path: string): Promise<T | null> =>
      (path.includes('/dependabot/alerts/') ? (securityAllowed ? { number: 7 } : null) : repository) as T | null
  )
  try {
    await publishGitHubWebhookOutputs(event())
    await publishGitHubWebhookOutputs(event())
    const messages = await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toContain('--from-event')
    expect(messages[0]!.content).toContain('Dependabot alert')
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, unrelated.managerId))).toHaveLength(0)
    const [stored] = await db
      .select()
      .from(integrationOutputEvents)
      .where(
        and(
          eq(integrationOutputEvents.integration, 'github'),
          sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`,
          eq(
            integrationOutputEvents.eventKey,
            (await import('../outputs/github')).githubOutputAdapter.normalize(event())[0]!.eventKey
          )
        )
      )
    expect((await resolveEventTrackedResource(stored!.id, one.squadId)).externalId).toBe('101:7')
    await expect(resolveEventTrackedResource(stored!.id, unrelated.squadId)).rejects.toThrow('not accessible')
    securityAllowed = false
    await publishGitHubWebhookOutputs(event('reopened', { updated_at: '2026-09-02T00:00:00Z' }))
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))
    expect(notices).toHaveLength(1)
  } finally {
    read.mockRestore()
    send.mockRestore()
  }
})

test('configured workflows create one paused tracked alert stream across replay, rename and reopen; fixed alerts never create work', async () => {
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const rules = effectiveSquadEventRules({ github: [{ repo }] }, 'github').filter(
    (r) => r.source.output === 'dependabot_alert.updated'
  )
  rules[0]!.action = {
    type: 'start-workstream',
    workflow: {
      kind: 'inline',
      definition: {
        ...createBlankWorkflow(),
        participants: { worker: { agentTypeId: prefix, session: 'reuse-within-stream' } },
      },
    },
  }
  const one = await fixture({ github: [{ repo: '*' }], integrationRules: { github: rules } })
  const authority = { kind: 'connection' as const, squadId: one.squadId, connectionId: one.connectionId }
  try {
    await Promise.all([
      publishIntegrationOutputs('github', event(), authority),
      publishIntegrationOutputs('github', event(), authority),
    ])
    const renamed = event('reopened', { updated_at: '2026-09-02T00:00:00Z' })
    renamed.payload.repository = { ...repository, full_name: `${prefix}/renamed` }
    await publishIntegrationOutputs('github', renamed, authority)
    await publishIntegrationOutputs(
      'github',
      event('fixed', { state: 'fixed', number: 8, updated_at: '2026-09-03T00:00:00Z' }),
      authority
    )
    const streams = await db.select().from(workStreams).where(eq(workStreams.squadId, one.squadId))
    expect(streams).toHaveLength(1)
    expect(streams[0]!.status).toBe('queued')
    expect(streams[0]!.pause).toBeTruthy()
    expect(resolveTrackedResources(streams[0]!.metadata)[0]).toMatchObject({
      kind: 'dependabot_alert',
      externalId: '101:7',
      delivery: false,
    })
    expect((streams[0]!.metadata as any).github).toBeUndefined()
    expect(
      await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streams[0]!.id))
    ).toHaveLength(1)
    expect(
      await db.select().from(integrationOutputTriggerRuns).where(eq(integrationOutputTriggerRuns.squadId, one.squadId))
    ).toHaveLength(1)
  } finally {
    send.mockRestore()
  }
})

test('managed relay rejects unrelated squad interests and rechecks Dependabot resource permission', async () => {
  const { dispatchHostedGitHubDelivery } = await import('../relay/runtime')
  const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  const one = await fixture({ github: [{ repo }], integrationRules: { github: [] } })
  const connection = (
    await db.select().from(integrationConnections).where(eq(integrationConnections.id, one.connectionId))
  )[0]!
  const read = spyOn(api, 'githubApiGet').mockResolvedValue(null)
  try {
    await dispatchHostedGitHubDelivery(
      {
        id: crypto.randomUUID(),
        leaseToken: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        connectionId: one.connectionId,
        connectionRevision: connection.materialRevision,
        resourceId: '101',
        resourceKey: repo,
        eventType: 'dependabot_alert',
        payload: event().payload,
      },
      [{ squadId: one.squadId, connectionId: one.connectionId, repository: repo }]
    )
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(0)
    await db
      .update(squads)
      .set({ metadata: { github: [{ repo }] } })
      .where(eq(squads.id, one.squadId))
    const delivery = {
      id: crypto.randomUUID(),
      leaseToken: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      connectionId: one.connectionId,
      connectionRevision: connection.materialRevision,
      resourceId: '101',
      resourceKey: repo,
      eventType: 'dependabot_alert',
      payload: event().payload,
    }
    read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path.includes('/dependabot/alerts/') ? null : repository) as T | null
    )
    await dispatchHostedGitHubDelivery(delivery, [
      { squadId: one.squadId, connectionId: one.connectionId, repository: repo },
    ])
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(0)
    read.mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path.includes('/dependabot/alerts/') ? { number: 7 } : repository) as T | null
    )
    await dispatchHostedGitHubDelivery(delivery, [
      { squadId: one.squadId, connectionId: one.connectionId, repository: repo },
    ])
    expect(
      await db
        .select()
        .from(integrationOutputEvents)
        .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
    ).toHaveLength(1)
  } finally {
    read.mockRestore()
    send.mockRestore()
  }
})

for (const action of ['created', 'reopened', 'fixed', 'dismissed']) {
  test(`authorized ${action} webhooks route native-only rules exactly once`, async () => {
    const send = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
      success: true,
      queued: true,
      status: 'queued',
    })
    const read = spyOn(api, 'githubApiGet').mockImplementation(
      async <T>(path: string): Promise<T | null> =>
        (path.includes('/dependabot/alerts/') ? { number: 7 } : repository) as T
    )
    try {
      const rules = effectiveSquadEventRules({ github: [{ repo }] }, 'github').filter(
        (r) => r.source.output === 'dependabot_alert.updated'
      )
      rules[0]!.predicates = [{ field: 'action', op: 'eq', value: action }]
      const one = await fixture({ github: [{ repo }], integrationRules: { github: rules } })
      const native = event(action, { state: ['fixed', 'dismissed'].includes(action) ? action : 'open' })
      await publishGitHubWebhookOutputs(native)
      await publishGitHubWebhookOutputs(native)
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(1)
    } finally {
      read.mockRestore()
      send.mockRestore()
    }
  })
}

for (const action of ['notify-manager', 'start-workstream'] as const) {
  test(`unmatched historical polling is silent with ${action}; real webhooks can refine and route`, async () => {
    const send = spyOn(InboxMessage, 'send')
    const sendOnce = spyOn(InboxMessage, 'sendOnce')
    const wake = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
      success: true,
      queued: true,
      status: 'queued',
    })
    try {
      const rules = effectiveSquadEventRules({ github: [{ repo }] }, 'github').filter(
        (r) => r.source.output === 'dependabot_alert.updated'
      )
      if (action === 'start-workstream') {
        const definition = createBlankWorkflow()
        definition.participants.worker!.agentTypeId = prefix
        rules[0]!.action = { type: 'start-workstream', workflow: { kind: 'inline', definition } }
      }
      const one = await fixture({ github: [{ repo }], integrationRules: { github: rules } })
      const { githubOutputAdapter } = await import('../outputs/github')
      const native = githubOutputAdapter.normalize(event())[0]!
      const [stored] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: `connection:${one.connectionId}:${one.squadId}:${(await db.select().from(integrationConnections).where(eq(integrationConnections.id, one.connectionId)))[0]!.materialRevision}`,
          eventKey: native.eventKey,
          authority: { kind: 'connection', squadId: one.squadId, connectionId: one.connectionId },
          fact: { ...native, data: { ...native.data, action: 'observed' } },
        })
        .returning()
      await reconcileUnmatchedOutputs()
      expect(send).not.toHaveBeenCalled()
      expect(sendOnce).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(0)
      expect(await db.select().from(workStreams).where(eq(workStreams.squadId, one.squadId))).toHaveLength(0)
      await publishIntegrationOutputs('github', event(), {
        kind: 'connection',
        squadId: one.squadId,
        connectionId: one.connectionId,
      })
      if (action === 'notify-manager')
        expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(1)
      else expect(await db.select().from(workStreams).where(eq(workStreams.squadId, one.squadId))).toHaveLength(1)
      expect(
        (await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, stored!.id)))[0]!.fact
          .data.action
      ).toBe('created')
    } finally {
      send.mockRestore()
      sendOnce.mockRestore()
      wake.mockRestore()
    }
  })
}

for (const status of [401, 403, 404, 429, 500, 'missing-auth', 'network-error'] as const) {
  test(`webhook authorization ${status} emits no inbox, send, sendOnce or manager wake`, async () => {
    const send = spyOn(InboxMessage, 'send')
    const sendOnce = spyOn(InboxMessage, 'sendOnce')
    const wake = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
      success: true,
      queued: true,
      status: 'queued',
    })
    const request = spyOn(globalThis, 'fetch').mockImplementation((async (input: any) => {
      if (!String(input).includes('/dependabot/alerts/')) return Response.json(repository)
      if (status === 'network-error') throw new Error('network unavailable')
      return new Response(null, { status: typeof status === 'number' ? status : 401 })
    }) as typeof fetch)
    try {
      const one = await fixture()
      if (status === 'missing-auth')
        await db
          .update(integrationConnections)
          .set({ authState: 'reauthorization_required' })
          .where(eq(integrationConnections.id, one.connectionId))
      if (status === 'network-error')
        await expect(publishGitHubWebhookOutputs(event())).rejects.toThrow('network unavailable')
      else expect(await publishGitHubWebhookOutputs(event())).toEqual([])
      expect(send).not.toHaveBeenCalled()
      expect(sendOnce).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(0)
      expect(
        await db
          .select()
          .from(integrationOutputEvents)
          .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${one.connectionId}`)
      ).toHaveLength(0)
      if (status === 'missing-auth') expect(request).not.toHaveBeenCalled()
    } finally {
      request.mockRestore()
      send.mockRestore()
      sendOnce.mockRestore()
      wake.mockRestore()
    }
  })
}

test('no-event runtime ticks and restarts leave retired cursors/dispatches inert and never send housekeeping', async () => {
  const send = spyOn(InboxMessage, 'send')
  const sendOnce = spyOn(InboxMessage, 'sendOnce')
  const wake = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
    success: true,
    queued: true,
    status: 'queued',
  })
  // Only fetch calls are intercepted; Bun's attached preconnect method is not
  // part of this fixture, matching the existing delivery-presentation boundary.
  const request = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    Response.json([])) as unknown as typeof fetch)
  let restorePoll: (() => void) | undefined
  try {
    const one = await fixture()
    const { integrationEventPollingRuntime } = await import('../runtime')
    const { createGitHubPlugin, githubPlugin } = await import('./plugin')
    const { resolveGitHubConnection } = await import('./resolve-connection')
    // The singleton captured fetch at module load. Delegate to a fresh real plugin
    // so all requests use this fixture's transport, never a live GitHub endpoint.
    const fresh = createGitHubPlugin(
      { currentUser: async () => ({ version: 1, userId: 123, login: 'testbot' }) },
      async (connection) => (await resolveGitHubConnection(connection.squadId, connection.id))?.credential.accessToken
    )
    const poll = spyOn(githubPlugin.runtime.provider.capabilities.event_polling!, 'poll').mockImplementation(
      fresh.runtime.provider.capabilities.event_polling!.poll
    )
    restorePoll = () => poll.mockRestore()
    pollKeys.push(`${one.squadId}:${one.connectionId}:${repo}:issue-events`)
    await integrationEventPollingRuntime.runOnce()
    const key = `${one.squadId}:${one.connectionId}:${repo}:dependabot-alerts`
    pollKeys.push(key)
    const eventKey = `retired-${crypto.randomUUID()}`
    dispatchKeys.push(eventKey)
    const [cursor] = await db
      .insert(integrationEventPollingCursors)
      .values({
        providerKey: 'github',
        resourceKey: key,
        cursor: { after: 'unfinished-page', repository },
        nextPollAt: new Date(0),
      })
      .returning()
    const [dispatch] = await db
      .insert(integrationEventPollingDispatches)
      .values({ providerKey: 'github', eventKey, leaseUntil: new Date(0), leaseToken: crypto.randomUUID() })
      .returning()
    await db.insert(workStreams).values({
      squadId: one.squadId,
      title: 'Tracked security alert',
      status: 'active',
      metadata: {
        tracked: [
          { integration: 'github', repository: repo, kind: 'dependabot_alert', number: 7, externalId: '101:7' },
        ],
      },
    })
    // Each tick reloads current DB watch sources, including startup with stale durable state.
    await integrationEventPollingRuntime.runOnce()
    await integrationEventPollingRuntime.stop()
    await integrationEventPollingRuntime.runOnce()
    expect(
      await db.select().from(integrationEventPollingCursors).where(eq(integrationEventPollingCursors.resourceKey, key))
    ).toEqual([cursor!])
    expect(
      await db
        .select()
        .from(integrationEventPollingDispatches)
        .where(eq(integrationEventPollingDispatches.eventKey, eventKey))
    ).toEqual([dispatch!])
    expect(request.mock.calls.some(([url]) => String(url).includes('/dependabot/alerts'))).toBe(false)
    expect(request.mock.calls.some(([url]) => String(url).includes('/issues/events'))).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(sendOnce).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toHaveLength(0)
  } finally {
    restorePoll?.()
    request.mockRestore()
    send.mockRestore()
    sendOnce.mockRestore()
    wake.mockRestore()
  }
})

for (const status of ['pending', 'queued'] as const) {
  test(`${status} historical synthetic deliveries are suppressed without new inbox creation or history removal`, async () => {
    const send = spyOn(InboxMessage, 'send')
    const sendOnce = spyOn(InboxMessage, 'sendOnce')
    const wake = spyOn(Agent.prototype, 'sendMessage').mockResolvedValue({
      success: true,
      queued: true,
      status: 'queued',
    })
    try {
      const one = await fixture()
      const { githubOutputAdapter } = await import('../outputs/github')
      const native = githubOutputAdapter.normalize(event())[0]!
      const [stored] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: `retired:${one.connectionId}`,
          eventKey: native.eventKey,
          authority: { kind: 'connection', squadId: one.squadId, connectionId: one.connectionId },
          fact: { ...native, data: { ...native.data, action: 'observed' } },
          matchedAt: new Date(),
        })
        .returning()
      const definition = createBlankWorkflow()
      definition.participants.worker!.agentTypeId = prefix
      const subscription = {
        id: 'security',
        source: { integration: 'github', output: 'dependabot_alert.updated', version: 1 },
        match: { 'alert.externalId': { value: '101:7' } },
        deliver: { to: { participant: 'worker' }, whenInactive: 'retain' as const },
      }
      definition.subscriptions = [subscription]
      const [stream] = await db
        .insert(workStreams)
        .values({ squadId: one.squadId, title: 'Active tracked security work', status: 'active' })
        .returning()
      const state = createWorkflowRun(definition)
      await db.insert(workStreamFlowRuns).values({
        workStreamId: stream!.id,
        activated: true,
        state,
        attemptAgents: { '1': one.managerId },
        source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
        createRequestId: crypto.randomUUID(),
        createRequestHash: 'fixture',
        createdBy: 'test',
      })
      const [history] = await db
        .insert(inbox)
        .values({
          recipientType: 'agent',
          recipientId: one.managerId,
          senderType: 'system',
          content: 'Historical notification; preserve unread history',
        })
        .returning()
      const [delivery] = await db
        .insert(integrationOutputDeliveries)
        .values({
          eventId: stored!.id,
          workStreamId: stream!.id,
          subscriptionId: subscription.id,
          subscription,
          status,
          targets: status === 'queued' ? [{ agentId: one.managerId, attemptId: 1, inboxId: history!.id }] : [],
        })
        .returning()
      expect(await isCurrentIntegrationDelivery(db, delivery!.id, one.managerId, history!.id)).toBe(false)
      await reconcileOutputDeliveries(stream!.id)
      expect(
        (await db.select().from(integrationOutputDeliveries).where(eq(integrationOutputDeliveries.id, delivery!.id)))[0]
      ).toMatchObject({ status: 'superseded', reason: 'Event suppressed by integration notification policy' })
      expect(send).not.toHaveBeenCalled()
      expect(sendOnce).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      expect(await db.select().from(inbox).where(eq(inbox.recipientId, one.managerId))).toEqual([history!])
    } finally {
      send.mockRestore()
      sendOnce.mockRestore()
      wake.mockRestore()
    }
  })
}
