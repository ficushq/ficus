import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { and, eq, like, sql } from 'drizzle-orm'
import {
  db,
  integrationConnections,
  integrationEventPollingCursors,
  integrationEventPollingDispatches,
  integrationOutputEvents,
  linearAgentSessions,
  webhookEvents,
} from '../../../db'
import { getSecretStore } from '../../secrets'
import { clearLinearUserCacheForTest, processLinearAppEvent } from './app-ingress'
import { LINEAR_ACK_BODY } from './session-acknowledger'
import { LINEAR_DISPOSITION_ACTIVITIES } from './session-disposition'
import {
  dispatchPolledLinearEvent,
  linearAgentSessionPolling,
  linearAgentSessionPollingRuntime,
  linearPollingResourceKey,
  listLinearPollingWatches,
} from './polling-runtime'
import { createLinearAppFixture } from './testing/app-fixtures'
import {
  agentSessionCreatedPayload,
  agentSessionPromptedPayload,
  createFakeLinear,
  issueWebhookPayload,
  type FakeLinear,
  type FakeLinearIssue,
} from './testing/fake-linear'

const originalFetch = globalThis.fetch
let fixture: Awaited<ReturnType<typeof createLinearAppFixture>>
let linear: FakeLinear
let issue: FakeLinearIssue
const teamId = randomUUID()
const member = { id: randomUUID(), name: 'Member', active: true }

function bodies(sessionId: string) {
  return linear.activitiesFor(sessionId).map((activity) => [activity.content.type, activity.content.body])
}
async function watch() {
  const found = (await listLinearPollingWatches()).find((entry) => entry.connection.id === fixture.connectionId)
  expect(found).toBeDefined()
  return found!
}
/** One poll and its dispatches, the way the runner does it. */
async function pollOnce(cursor: Record<string, unknown> | null = null) {
  const result = await linearAgentSessionPolling.poll((await watch()).connection, cursor)
  for (const event of result.events) await dispatchPolledLinearEvent(event)
  return result
}
async function outputs(output: string) {
  return db
    .select({ eventKey: integrationOutputEvents.eventKey, fact: integrationOutputEvents.fact })
    .from(integrationOutputEvents)
    .where(
      and(
        sql`${integrationOutputEvents.authority}->>'connectionId' = ${fixture.connectionId}`,
        sql`${integrationOutputEvents.fact}->>'output' = ${output}`
      )
    )
}
async function recordAppWebhook() {
  await db.insert(webhookEvents).values({
    provider: 'linear-app',
    eventType: 'AgentSessionEvent',
    payload: { organizationId: fixture.organizationId },
    headers: {},
    verified: true,
    deliveryId: randomUUID(),
  })
}

beforeAll(async () => {
  await getSecretStore().initialize()
})
beforeEach(async () => {
  clearLinearUserCacheForTest()
  fixture = await createLinearAppFixture()
  linear = createFakeLinear({
    organization: { id: fixture.organizationId, name: 'Acme', urlKey: 'acme' },
    app: { id: fixture.appUserId, name: 'Ficus', app: true, active: true },
  })
  linear.addUser(member)
  issue = linear.addIssue({
    id: randomUUID(),
    number: 7,
    identifier: 'ENG-7',
    title: 'Fix the checkout',
    url: 'https://linear.app/acme/issue/ENG-7',
    team: { id: teamId, key: 'ENG' },
    delegateId: fixture.appUserId,
  })
  globalThis.fetch = linear.fetch
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  await db
    .delete(integrationOutputEvents)
    .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${fixture.connectionId}`)
  await db
    .delete(integrationEventPollingCursors)
    .where(eq(integrationEventPollingCursors.resourceKey, linearPollingResourceKey(fixture.connectionId)))
  await db
    .delete(webhookEvents)
    .where(
      and(
        eq(webhookEvents.provider, 'linear-app'),
        sql`${webhookEvents.payload}->>'organizationId' = ${fixture.organizationId}`
      )
    )
  for (const session of linear.sessions.keys())
    await db
      .delete(integrationEventPollingDispatches)
      .where(like(integrationEventPollingDispatches.eventKey, `linear:session:${session}:%`))
  for (const key of [
    ...linear.prompts.map((p) => `linear:activity:${p.id}`),
    ...linear.notifications.map((n) => `linear:notification:${n.id}`),
  ])
    await db.delete(integrationEventPollingDispatches).where(eq(integrationEventPollingDispatches.eventKey, key))
  await fixture.cleanup()
})

describe('watches', () => {
  test('every enabled app connection is watched, fast until app webhooks arrive; API-key connections are not', async () => {
    const apiKeyConnection = randomUUID()
    await db.insert(integrationConnections).values({
      id: apiKeyConnection,
      providerKey: 'linear',
      adapterVersion: 1,
      clientAuthority: 'local',
      authorizationKind: 'manual',
      displayName: `Personal key ${apiKeyConnection}`,
      configuration: { version: 1 },
      credentialRef: `__integration-test:linear-key:${apiKeyConnection}`,
      materialRevision: randomUUID(),
      enabled: true,
      authState: 'authenticated',
      healthState: 'healthy',
    })
    try {
      const watches = await listLinearPollingWatches()
      expect(watches.some((entry) => entry.connection.id === apiKeyConnection)).toBe(false)
      expect(await watch()).toMatchObject({
        providerKey: 'linear',
        resourceKey: `linear-app:${fixture.connectionId}`,
        active: true,
      })
      await recordAppWebhook()
      expect((await watch()).active).toBe(false)
    } finally {
      await db.delete(integrationConnections).where(eq(integrationConnections.id, apiKeyConnection))
    }
  })
})

describe('recovered sessions', () => {
  test('a polled pending session is acknowledged and gets its disposition', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    await pollOnce()
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
    ])
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row).toMatchObject({ ackState: 'sent', disposition: 'notified', trigger: 'delegation' })
    const delegated = await outputs('issue.delegated')
    expect(delegated).toHaveLength(1)
    expect(delegated[0]!.fact.data).toMatchObject({ session: { id: sessionId }, delegate: fixture.appUserId })
    expect(squad.id).toBeTruthy()
    // The session is no longer pending in Linear and Ficus handled it: another poll leaves it alone.
    await pollOnce()
    expect(bodies(sessionId)).toHaveLength(2)
  })

  test('a session the webhook handled is not handled again by polling', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    const payload = agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id })
    await processLinearAppEvent({ type: 'AgentSessionEvent', payload })
    const before = linear.calls.length
    const result = await pollOnce()
    expect(result.events).toEqual([])
    // Even a forced redelivery of the polled shape is skipped by the shared receipt.
    linear.sessions.get(sessionId)!.status = 'pending'
    await db.update(linearAgentSessions).set({ ackState: 'failed' }).where(eq(linearAgentSessions.id, sessionId))
    const forced = await linearAgentSessionPolling.poll((await watch()).connection, null)
    expect(forced.events.map((event) => event.logicalEventKey)).toEqual([`linear:session:${sessionId}:created`])
    for (const event of forced.events) await dispatchPolledLinearEvent(event)
    expect(linear.calls.slice(before).map((call) => call.operation)).not.toContain('FicusAgentActivity')
    expect(bodies(sessionId)).toHaveLength(2)
    expect(await outputs('agent_session.created')).toHaveLength(1)
  })

  test('a late webhook for a session polling already handled changes nothing', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    await pollOnce()
    const before = linear.calls.length
    const payload = agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id })
    await processLinearAppEvent({ type: 'AgentSessionEvent', payload })
    expect(linear.calls.length).toBe(before)
    expect(bodies(sessionId)).toHaveLength(2)
    expect(await outputs('agent_session.created')).toHaveLength(1)
  })
})

describe('recovered prompts', () => {
  test('a prompt seen by webhook and poll is routed and answered once, in either order', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id, status: 'active' })
    await db.insert(linearAgentSessions).values({
      id: sessionId,
      connectionId: fixture.connectionId,
      organizationId: fixture.organizationId,
      issueId: issue.id,
      trigger: 'delegation',
      ackState: 'sent',
      dispositionState: 'sent',
      disposition: 'notified',
    })
    const viaWebhook = randomUUID()
    const viaPoll = randomUUID()
    linear.addPrompt({ id: viaWebhook, sessionId, userId: member.id, body: 'Any news?' })
    linear.addPrompt({ id: viaPoll, sessionId, userId: member.id, body: 'Still there?' })
    const prompted = (activityId: string, body: string) =>
      processLinearAppEvent({
        type: 'AgentSessionEvent',
        payload: agentSessionPromptedPayload(fixture.context, {
          sessionId,
          issue,
          userId: member.id,
          activityId,
          body,
        }),
      })
    await prompted(viaWebhook, 'Any news?')
    await pollOnce()
    await prompted(viaPoll, 'Still there?')
    const promptFacts = await outputs('agent_session.prompted')
    expect(promptFacts.map((row) => (row.fact.data as any).activity.id).sort()).toEqual([viaWebhook, viaPoll].sort())
    // One disposition per prompt.
    expect(bodies(sessionId)).toEqual([
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
    ])
  })
})

describe('recovered undelegation', () => {
  test('a polled undelegation and the Issue webhook for it are recorded once, in either order', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    issue.delegateId = null
    const notificationId = randomUUID()
    linear.addNotification({
      id: notificationId,
      type: 'issueUnassignedFromYou',
      issueId: issue.id,
      actorId: member.id,
    })
    await pollOnce()
    let undelegated = await outputs('issue.undelegated')
    expect(undelegated).toHaveLength(1)
    expect(undelegated[0]!.fact.data).toMatchObject({ delegate: fixture.appUserId, action: 'undelegated' })
    // The Issue webhook for the same change arrives afterwards.
    const webhook = issueWebhookPayload(fixture.organizationId, issue, {
      updatedFrom: { delegateId: fixture.appUserId },
      actorId: member.id,
    })
    await processLinearAppEvent({ type: 'Issue', payload: webhook })
    undelegated = await outputs('issue.undelegated')
    expect(undelegated).toHaveLength(1)
    // And polling it again changes nothing.
    await pollOnce()
    expect(await outputs('issue.undelegated')).toHaveLength(1)
  })

  test('the Issue webhook first, then the polled notification', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    issue.delegateId = null
    await processLinearAppEvent({
      type: 'Issue',
      payload: issueWebhookPayload(fixture.organizationId, issue, {
        updatedFrom: { delegateId: fixture.appUserId },
        actorId: member.id,
      }),
    })
    expect(await outputs('issue.undelegated')).toHaveLength(1)
    linear.addNotification({ id: randomUUID(), type: 'issueUnassignedFromYou', issueId: issue.id, actorId: member.id })
    await pollOnce()
    expect(await outputs('issue.undelegated')).toHaveLength(1)
  })
})

describe('runner', () => {
  test('a tick polls the connection, saves the version 1 cursor and waits for the cadence', async () => {
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    await linearAgentSessionPollingRuntime.runOnce()
    expect(bodies(sessionId)[0]).toEqual(['thought', LINEAR_ACK_BODY])
    const [cursor] = await db
      .select()
      .from(integrationEventPollingCursors)
      .where(eq(integrationEventPollingCursors.resourceKey, linearPollingResourceKey(fixture.connectionId)))
    expect(cursor!.cursor).toMatchObject({
      version: 1,
      sessions: { boundaryIds: [sessionId] },
      prompts: { boundaryIds: [] },
      notifications: { boundaryIds: [] },
    })
    const delay = cursor!.nextPollAt.getTime() - Date.now()
    // No recent app webhook: the fast cadence, 60 seconds with no jitter.
    expect(delay).toBeGreaterThan(50_000)
    expect(delay).toBeLessThanOrEqual(60_000)
    const calls = linear.calls.length
    await linearAgentSessionPollingRuntime.runOnce()
    expect(
      linear.calls.filter((call, index) => index >= calls && call.operation.startsWith('FicusLinearPoll'))
    ).toEqual([])
  })
})
