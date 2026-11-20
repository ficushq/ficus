import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createBlankWorkflow } from '@ficus/shared'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import {
  agentTypes,
  db,
  inbox,
  integrationConnections,
  integrationCredentialRetirements,
  integrationEventPollingCursors,
  integrationEventPollingDispatches,
  integrationOutputEvents,
  linearAgentSessions,
  webhookEvents,
  workStreams,
} from '../../../db'
import { getSecretStore } from '../../secrets'
import { SELF_HOSTED_OAUTH_APP_KEY } from '../authorization/client-credentials'
import { linearDeliveryKey } from './delivery-receipts'
import { clearLinearUserCacheForTest, processLinearAppEvent } from './app-ingress'
import { LINEAR_ACK_BODY } from './session-acknowledger'
import { LINEAR_DISPOSITION_ACTIVITIES } from './session-disposition'
import {
  dispatchPolledLinearEvent,
  linearAgentSessionPolling,
  linearAgentSessionPollingRuntime,
  linearPollingResourceKey,
  listLinearPollingWatches,
  receivedRecentWebhook,
  recentLinearAppWebhookSql,
} from './polling-runtime'
import type { LinearRelayDelivery } from '@ficus/shared/integration-relay'
import { processRelayedLinearDelivery } from '../relay/linear-runtime'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'
import { createLinearAppFixture } from './testing/app-fixtures'
import {
  LINEAR_POLL_PAGE_SIZE,
  LINEAR_POLL_REQUESTS_PER_TICK,
  LINEAR_POLL_SLOW_MS,
  LINEAR_POLL_WEBHOOK_RECENCY_MS,
  LINEAR_SESSION_RETRY_REQUESTS,
} from './polling'
import { createEventPollingBudget } from '../event-polling-budget'
import { retryLinearSession } from './session-retry'
import { setLinearAppReadinessForTest } from './app-readiness'
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
const guest = { id: randomUUID(), name: 'Guest', guest: true, active: true }
// An inline workflow keeps start-workstream rules independent of seeded presets.
const workerType = `linear-poll-worker-${randomUUID().slice(0, 8)}`
/** A rule bound to the connected account, the default audience for these outputs. */
function startRule(output: string) {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = workerType
  return {
    id: `start-${output.replace(/[._]/g, '-')}`,
    enabled: true,
    source: { integration: 'linear', output, version: 1 },
    filters: { squadRouting: true, audience: 'connected-account' },
    action: { type: 'start-workstream', workflow: { kind: 'inline', definition } },
  }
}

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
async function sessionRow(sessionId: string) {
  const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
  return row
}
/** Moves a session's last attempt back, so the retry sweep finds it due. */
async function ageSession(sessionId: string) {
  await db
    .update(linearAgentSessions)
    .set({ updatedAt: sql`now() - interval '2 minutes'` })
    .where(eq(linearAgentSessions.id, sessionId))
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

// The app stays uninstallable in production until write-back ships; these tests exercise its event path.
let restoreReadiness: () => void = () => {}
beforeAll(async () => {
  restoreReadiness = setLinearAppReadinessForTest({ local: true, platform_broker: false })
  await getSecretStore().initialize()
  await db.insert(agentTypes).values({
    id: workerType,
    name: 'Linear polling fixture worker',
    extraScopes: ['workstreams:respond'],
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
})
afterAll(async () => {
  restoreReadiness()
  await db.delete(agentTypes).where(eq(agentTypes.id, workerType))
})
beforeEach(async () => {
  clearLinearUserCacheForTest()
  fixture = await createLinearAppFixture()
  linear = createFakeLinear({
    organization: { id: fixture.organizationId, name: 'Acme', urlKey: 'acme' },
    app: { id: fixture.appUserId, name: 'Ficus', app: true, active: true },
  })
  linear.addUser(member)
  linear.addUser(guest)
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
  // The fixture removes its connection's rows. Receipts are keyed by Linear's session, activity and
  // notification IDs; the fake knows every one, including any that left no session row or output.
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

  test('a session the webhook fully handled is not handled again by polling', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    const payload = agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id })
    await processLinearAppEvent({ type: 'AgentSessionEvent', payload })
    await ageSession(sessionId)
    const before = linear.calls.length
    const result = await pollOnce()
    expect(result.events).toEqual([])
    expect(linear.calls.slice(before).map((call) => call.operation)).not.toContain('FicusAgentActivity')
    expect(bodies(sessionId)).toHaveLength(2)
    expect(await outputs('agent_session.created')).toHaveLength(1)
  })

  test('a session whose acknowledgment and disposition failed is answered by the next poll, once', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    // Linear is failing while the webhook is processed: both acknowledgment attempts and the disposition.
    for (let i = 0; i < 3; i++) linear.failNext(500, 'FicusAgentActivity')
    const payload = agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id })
    await processLinearAppEvent({ type: 'AgentSessionEvent', payload })
    expect(bodies(sessionId)).toEqual([])
    expect(await sessionRow(sessionId)).toMatchObject({ ackState: 'failed', dispositionState: 'failed' })
    expect(linear.sessions.get(sessionId)!.status).toBe('pending')
    // Not retried within a minute of the failure.
    await pollOnce()
    expect(bodies(sessionId)).toEqual([])
    await ageSession(sessionId)
    await pollOnce()
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
    ])
    expect(await sessionRow(sessionId)).toMatchObject({
      ackState: 'sent',
      dispositionState: 'sent',
      disposition: 'notified',
    })
    // Recovery does not route the session a second time, and a later poll does nothing more.
    expect(await outputs('agent_session.created')).toHaveLength(1)
    expect(await outputs('issue.delegated')).toHaveLength(1)
    await ageSession(sessionId)
    await pollOnce()
    expect(bodies(sessionId)).toHaveLength(2)
  })

  test('one retry makes no more Linear calls than it reserves', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    for (let i = 0; i < 3; i++) linear.failNext(500, 'FicusAgentActivity')
    await processLinearAppEvent({
      type: 'AgentSessionEvent',
      payload: agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id }),
    })
    expect(await sessionRow(sessionId)).toMatchObject({ ackState: 'failed', dispositionState: 'failed' })
    // The worst case: the first acknowledgment attempt fails again, the second and the disposition succeed.
    linear.failNext(500, 'FicusAgentActivity')
    const before = linear.calls.length
    expect(await retryLinearSession((await sessionRow(sessionId))!, 'Bearer linear-app-access-token')).toBe(true)
    const calls = linear.calls.slice(before)
    expect(calls).toHaveLength(LINEAR_SESSION_RETRY_REQUESTS)
    expect(calls.every((call) => call.operation === 'FicusAgentActivity')).toBe(true)
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
    ])
  })

  test('a failed disposition alone is retried; a failed acknowledgment after a sent disposition is not', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const dispositionFailed = randomUUID()
    linear.addSession({ id: dispositionFailed, issueId: issue.id, creatorId: member.id })
    await processLinearAppEvent({
      type: 'AgentSessionEvent',
      payload: agentSessionCreatedPayload(fixture.context, {
        sessionId: dispositionFailed,
        issue,
        creatorId: member.id,
      }),
    })
    // Simulate the disposition post failing after a sent acknowledgment.
    linear.activities.splice(
      linear.activities.findIndex(
        (activity) => activity.agentSessionId === dispositionFailed && activity.content.type === 'response'
      ),
      1
    )
    await db
      .update(linearAgentSessions)
      .set({ dispositionState: 'failed' })
      .where(eq(linearAgentSessions.id, dispositionFailed))
    const answered = randomUUID()
    linear.addSession({ id: answered, issueId: issue.id, creatorId: member.id })
    await processLinearAppEvent({
      type: 'AgentSessionEvent',
      payload: agentSessionCreatedPayload(fixture.context, { sessionId: answered, issue, creatorId: member.id }),
    })
    // Its acknowledgment failed, but the disposition reached Linear: the session has its answer.
    await db.update(linearAgentSessions).set({ ackState: 'failed' }).where(eq(linearAgentSessions.id, answered))
    await ageSession(dispositionFailed)
    await ageSession(answered)
    const before = linear.activities.length
    await pollOnce()
    expect(linear.activities.slice(before).map((activity) => [activity.agentSessionId, activity.content.type])).toEqual(
      [[dispositionFailed, 'response']]
    )
    expect(await sessionRow(dispositionFailed)).toMatchObject({ dispositionState: 'sent', disposition: 'notified' })
  })

  test('a backlog over a page is read across polls: every session acknowledged exactly once', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    // The first poll starts at the install time: an hour ago, before the backlog.
    await db
      .update(integrationConnections)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(integrationConnections.id, fixture.connectionId))
    const start = Date.now() - 600_000
    const ids = Array.from({ length: LINEAR_POLL_PAGE_SIZE + 10 }, (_, i) => {
      const id = randomUUID()
      linear.addSession({ id, issueId: issue.id, creatorId: member.id, at: start + i * 1_000 })
      return id
    })
    // A budget with no room for a second session page: the first poll reads only the newest page.
    const poll = async (cursor: Record<string, unknown> | null) => {
      const budget = createEventPollingBudget(LINEAR_POLL_REQUESTS_PER_TICK)
      const result = await linearAgentSessionPolling.poll((await watch()).connection, cursor, budget.signal)
      for (const event of result.events) await dispatchPolledLinearEvent(event)
      return result
    }
    const first = await poll(null)
    expect(first.events).toHaveLength(LINEAR_POLL_PAGE_SIZE)
    // The walk stopped after one page: the cursor says where the next poll continues.
    expect(typeof (first.nextCursor.sessions as { resume?: { after?: unknown } }).resume?.after).toBe('string')
    const second = await poll(first.nextCursor)
    expect(second.events).toHaveLength(10)
    expect(second.nextCursor.sessions).not.toHaveProperty('resume')
    const third = await poll(second.nextCursor)
    expect(third.events).toEqual([])
    for (const id of ids) {
      const acknowledgments = bodies(id).filter(([type, body]) => type === 'thought' && body === LINEAR_ACK_BODY)
      expect(acknowledgments).toHaveLength(1)
      expect(await sessionRow(id)).toMatchObject({ ackState: 'sent', dispositionState: 'sent' })
    }
  }, 60_000)

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

describe('trusted authors and the connected account', () => {
  async function authorities(output: string) {
    const rows = await db
      .select({ authority: integrationOutputEvents.authority })
      .from(integrationOutputEvents)
      .where(
        and(
          sql`${integrationOutputEvents.authority}->>'connectionId' = ${fixture.connectionId}`,
          sql`${integrationOutputEvents.fact}->>'output' = ${output}`
        )
      )
    return rows.map((row) => row.authority as Record<string, unknown>)
  }
  async function streams(squadId: string) {
    return db.select().from(workStreams).where(eq(workStreams.squadId, squadId))
  }

  test('a member’s polled delegation runs the account-bound start-workstream rule', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule('issue.delegated')] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    await pollOnce()
    expect(await authorities('issue.delegated')).toEqual([
      expect.objectContaining({ squadId: squad.id, accountId: fixture.appUserId, actorTrust: 'trusted' }),
    ])
    const started = await streams(squad.id)
    expect(started).toHaveLength(1)
    expect((await sessionRow(sessionId))?.workStreamId).toBe(started[0]!.id)
    expect(bodies(sessionId).at(-1)).toEqual(['thought', LINEAR_DISPOSITION_ACTIVITIES.queued.body])
  })

  test('a guest’s polled delegation is held: no stream, and the manager is told', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule('issue.delegated')] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: guest.id })
    await pollOnce()
    expect(await authorities('issue.delegated')).toEqual([
      expect.objectContaining({ accountId: fixture.appUserId, actorTrust: 'untrusted' }),
    ])
    expect(await streams(squad.id)).toEqual([])
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('not a trusted member')
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
  })

  test('a polled prompt follows the rule for a member and is held for a guest', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule('agent_session.prompted')] })
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
    linear.addPrompt({ id: randomUUID(), sessionId, userId: guest.id, body: 'Do this for me' })
    const first = await pollOnce()
    expect(await streams(squad.id)).toEqual([])
    linear.addPrompt({ id: randomUUID(), sessionId, userId: member.id, body: 'Please take this' })
    await pollOnce(first.nextCursor)
    expect(await streams(squad.id)).toHaveLength(1)
    const trust = (await authorities('agent_session.prompted')).map((authority) => [
      authority.accountId,
      authority.actorTrust,
    ])
    expect(trust.sort()).toEqual(
      [
        [fixture.appUserId, 'trusted'],
        [fixture.appUserId, 'untrusted'],
      ].sort()
    )
  })

  test('a polled undelegation is recorded under the account with the actor’s trust', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    issue.delegateId = null
    linear.addNotification({ id: randomUUID(), type: 'issueUnassignedFromYou', issueId: issue.id, actorId: member.id })
    await pollOnce()
    expect(await authorities('issue.undelegated')).toEqual([
      expect.objectContaining({ accountId: fixture.appUserId, actorTrust: 'trusted' }),
    ])
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

  test('a delivery relayed through Platform counts as a recent app webhook and moves the poll to the 5-minute cadence', async () => {
    function relayed(organizationId: string): LinearRelayDelivery {
      return {
        id: randomUUID(),
        leaseToken: randomUUID(),
        connectionId: fixture.connectionId,
        connectionRevision: fixture.revision,
        deliveryId: randomUUID(),
        resourceId: organizationId,
        resourceKey: organizationId,
        eventType: 'Issue',
        payload: { type: 'Issue', action: 'update', organizationId },
      }
    }
    // Schema push skips partial indexes; delivery deduplication needs the migration's unique index.
    await ensureQueryIndex('uq_webhook_events_provider_delivery')
    const handled: string[] = []
    const dispatch = async (context: { eventType: string }) => {
      handled.push(context.eventType)
    }
    // Another workspace's relayed delivery does not relax this connection's cadence.
    const other = relayed(randomUUID())
    await processRelayedLinearDelivery(other, dispatch)
    try {
      expect(await receivedRecentWebhook(fixture.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)).toBe(false)
      expect((await watch()).active).toBe(true)

      await processRelayedLinearDelivery(relayed(fixture.organizationId), dispatch)
      expect(handled).toEqual(['Issue', 'Issue'])
      expect(await receivedRecentWebhook(fixture.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)).toBe(true)
      expect((await watch()).active).toBe(false)
      expect((await pollOnce()).suggestedIntervalMs).toBe(LINEAR_POLL_SLOW_MS)

      await db
        .delete(integrationEventPollingCursors)
        .where(eq(integrationEventPollingCursors.resourceKey, linearPollingResourceKey(fixture.connectionId)))
      await linearAgentSessionPollingRuntime.runOnce()
      const [cursor] = await db
        .select()
        .from(integrationEventPollingCursors)
        .where(eq(integrationEventPollingCursors.resourceKey, linearPollingResourceKey(fixture.connectionId)))
      const delay = cursor!.nextPollAt.getTime() - Date.now()
      expect(delay).toBeGreaterThan(LINEAR_POLL_SLOW_MS - 10_000)
      expect(delay).toBeLessThanOrEqual(LINEAR_POLL_SLOW_MS)
    } finally {
      await db
        .delete(webhookEvents)
        .where(and(eq(webhookEvents.provider, 'linear-app'), eq(webhookEvents.deliveryId, other.deliveryId)))
    }
  })
})

describe('receivedRecentWebhook', () => {
  test('answers from the organization index without reading other workspaces or older deliveries', async () => {
    await ensureQueryIndex('idx_webhook_events_verified_organization_created')
    const noisy = randomUUID()
    try {
      // A long history: many deliveries for another workspace, and old ones for this workspace.
      await db.execute(sql`INSERT INTO webhook_events(provider,event_type,payload,headers,verified,created_at)
        SELECT 'linear-app', 'Issue', jsonb_build_object('organizationId', ${noisy}::text), '{}', true,
          now() - n * interval '1 second' FROM generate_series(1,12000) n`)
      await db.execute(sql`INSERT INTO webhook_events(provider,event_type,payload,headers,verified,created_at)
        SELECT 'linear-app', 'Issue', jsonb_build_object('organizationId', ${fixture.organizationId}::text), '{}', true,
          now() - interval '1 hour' - n * interval '1 second' FROM generate_series(1,2000) n`)
      await db.execute(sql`ANALYZE webhook_events`)
      expect(await receivedRecentWebhook(fixture.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)).toBe(false)
      expect(await receivedRecentWebhook(noisy, LINEAR_POLL_WEBHOOK_RECENCY_MS)).toBe(true)
      // An unverified delivery does not count.
      await db.insert(webhookEvents).values({
        provider: 'linear-app',
        eventType: 'Issue',
        payload: { organizationId: fixture.organizationId },
        headers: {},
        verified: false,
      })
      expect(await receivedRecentWebhook(fixture.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)).toBe(false)

      const [explained] = await db.execute(
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${recentLinearAppWebhookSql(fixture.organizationId, LINEAR_POLL_WEBHOOK_RECENCY_MS)}`
      )
      const plan = (explained['QUERY PLAN'] as any)[0].Plan
      expect(JSON.stringify(plan)).toContain('idx_webhook_events_verified_organization_created')
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(20)
    } finally {
      await db
        .delete(webhookEvents)
        .where(
          and(eq(webhookEvents.provider, 'linear-app'), sql`${webhookEvents.payload}->>'organizationId' = ${noisy}`)
        )
    }
  })
})

describe('fixture cleanup', () => {
  test('a cleaned-up fixture leaves no rows behind for a later run against the same database', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id, creatorId: member.id })
    const activityId = randomUUID()
    linear.addPrompt({ id: activityId, sessionId, userId: guest.id, body: 'Do this for me' })
    issue.delegateId = null
    linear.addNotification({ id: randomUUID(), type: 'issueUnassignedFromYou', issueId: issue.id, actorId: member.id })
    await recordAppWebhook()
    await linearAgentSessionPollingRuntime.runOnce()

    const credentialKeys = [fixture.credentialRef, SELF_HOSTED_OAUTH_APP_KEY.linear]
    const ownedReceipts = sql`${integrationEventPollingDispatches.eventKey} like ${`linear:session:${sessionId}:%`}
      or ${integrationEventPollingDispatches.eventKey} = ${linearDeliveryKey.prompt(activityId)}`
    const left = async () => ({
      sessions: (await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))).length,
      outputs: (
        await db
          .select()
          .from(integrationOutputEvents)
          .where(sql`${integrationOutputEvents.authority}->>'connectionId' = ${fixture.connectionId}`)
      ).length,
      receipts: (await db.select().from(integrationEventPollingDispatches).where(ownedReceipts)).length,
      cursors: (
        await db
          .select()
          .from(integrationEventPollingCursors)
          .where(eq(integrationEventPollingCursors.resourceKey, linearPollingResourceKey(fixture.connectionId)))
      ).length,
      webhooks: (
        await db
          .select()
          .from(webhookEvents)
          .where(sql`${webhookEvents.payload}->>'organizationId' = ${fixture.organizationId}`)
      ).length,
      notices: (await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))).length,
      retiredCredentials: (
        await db
          .select()
          .from(integrationCredentialRetirements)
          .where(inArray(integrationCredentialRetirements.credentialKey, credentialKeys))
      ).length,
    })
    // Every kind of row is there before cleanup, so the check below cannot pass vacuously. Retired
    // credentials are the exception: deleting the stored credentials during cleanup creates them.
    const { retiredCredentials: _, ...before } = await left()
    expect(Object.entries(before).filter(([, count]) => count === 0)).toEqual([])
    await fixture.cleanup()
    expect(await left()).toEqual({
      sessions: 0,
      outputs: 0,
      receipts: 0,
      cursors: 0,
      webhooks: 0,
      notices: 0,
      retiredCredentials: 0,
    })
  })
})
