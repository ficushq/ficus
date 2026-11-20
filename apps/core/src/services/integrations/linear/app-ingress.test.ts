import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { getSecretStore } from '../../secrets'
import { randomUUID } from 'node:crypto'
import { createBlankWorkflow } from '@ficus/shared'
import { and, eq, sql } from 'drizzle-orm'
import {
  agentTypes,
  db,
  inbox,
  integrationConnections,
  integrationOutputEvents,
  integrationOutputTriggerRuns,
  linearAgentSessions,
  linearTeamAccess,
  settings,
  squads,
  workStreams,
} from '../../../db'
import { clearLinearUserCacheForTest, processLinearAppEvent } from './app-ingress'
import { LINEAR_ACK_BODY } from './session-acknowledger'
import { linearActivityId } from './app-api'
import { announceLinearSessionBinding } from './session-binding'
import { inaccessibleLinearTeams, linearTeamAccessSetupIssues } from './team-access'
import { isUntrustedOutputActor } from '../outputs/authority'
import { setEventRuleDecideForTests } from '../outputs/event-rule-decisions'
import { LINEAR_DISPOSITION_ACTIVITIES } from './session-disposition'
import { createLinearAppFixture } from './testing/app-fixtures'
import {
  agentSessionCreatedPayload,
  agentSessionPromptedPayload,
  createFakeLinear,
  linearSystemCommentId,
  oauthAppRevokedPayload,
  permissionChangePayload,
  type FakeLinear,
  type FakeLinearIssue,
} from './testing/fake-linear'

const originalFetch = globalThis.fetch
const originalAppUrl = process.env.APP_URL
let fixture: Awaited<ReturnType<typeof createLinearAppFixture>>
let linear: FakeLinear
let issue: FakeLinearIssue
let now = 0
const teamId = randomUUID()
const member = { id: randomUUID(), name: 'Member', active: true }
const guest = { id: randomUUID(), name: 'Guest', guest: true, active: true }

function rule(id: string, output: string, action: Record<string, unknown>, audience = 'connected-account') {
  return {
    id,
    enabled: true,
    source: { integration: 'linear', output, version: 1 },
    filters: { squadRouting: true, audience },
    action,
  }
}
// An inline workflow keeps the fixture independent of seeded presets.
const workerType = `linear-app-worker-${randomUUID().slice(0, 8)}`
function startAction() {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = workerType
  return { type: 'start-workstream', workflow: { kind: 'inline', definition } }
}
const startRule = (output = 'issue.delegated') => rule(`start-${output.replace(/[._]/g, '-')}`, output, startAction())

function bodies(sessionId: string) {
  return linear.activitiesFor(sessionId).map((activity) => [activity.content.type, activity.content.body])
}
async function created(
  sessionId: string,
  input: { creatorId?: string | null; commentId?: string; issue?: FakeLinearIssue | null } = {}
) {
  await processLinearAppEvent(
    {
      type: 'AgentSessionEvent',
      payload: agentSessionCreatedPayload(fixture.context, {
        sessionId,
        issue: input.issue === undefined ? issue : input.issue,
        // null: no creator, as Linear sends for a session an agent user (the app itself) started.
        creatorId: input.creatorId === null ? undefined : (input.creatorId ?? member.id),
        commentId: input.commentId,
        timestamp: now,
      }),
    },
    { now: () => now }
  )
}

beforeAll(async () => {
  await getSecretStore().initialize()
  await db.insert(agentTypes).values({
    id: workerType,
    name: 'Linear app fixture worker',
    extraScopes: ['workstreams:respond'],
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
})
afterAll(async () => {
  await db.delete(agentTypes).where(eq(agentTypes.id, workerType))
})
beforeEach(async () => {
  now = Date.now()
  clearLinearUserCacheForTest()
  fixture = await createLinearAppFixture()
  linear = createFakeLinear({
    organization: { id: fixture.organizationId, name: 'Acme', urlKey: 'acme' },
    app: { id: fixture.appUserId, name: 'Ficus', app: true, active: true },
    clock: () => now,
    advance: (ms) => (now += ms),
    latencyMs: 700,
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
    labels: ['bug'],
    delegateId: fixture.appUserId,
  })
  globalThis.fetch = linear.fetch
  delete process.env.APP_URL
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAppUrl === undefined) delete process.env.APP_URL
  else process.env.APP_URL = originalAppUrl
  await fixture.cleanup()
})

describe('acknowledgment', () => {
  test('every created session is acknowledged once, before rules, within 10 seconds, with no squad assigned', async () => {
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    const sentAt = now
    await created(sessionId)
    const ack = linear.calls.find((call) => call.operation === 'FicusAgentActivity')!
    // The acknowledgment is the first Linear call: no probe, rule or decision ran before it.
    expect(linear.calls[0]).toBe(ack)
    expect(ack.variables.input.content).toEqual({ type: 'thought', body: LINEAR_ACK_BODY })
    expect(ack.at - sentAt).toBeLessThan(10_000)
    expect(ack.authorization).toBe('Bearer linear-app-access-token')
    // No squad is assigned: the session is acknowledged and closed as not set up.
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.ignored.body],
    ])
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row).toMatchObject({ ackState: 'sent', disposition: 'unrouted', trigger: 'delegation', teamId })
    // A redelivery (or the polling fallback) neither acknowledges nor disposes again.
    await created(sessionId)
    expect(bodies(sessionId)).toHaveLength(2)
  })

  test('a failed first attempt is retried once inside the deadline', async () => {
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    linear.failNext(500, 'FicusAgentActivity')
    await created(sessionId)
    expect(linear.activitiesFor(sessionId)[0]?.content.body).toBe(LINEAR_ACK_BODY)
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row?.ackState).toBe('sent')
  })

  // Live, Linear answers a repeated activity ID with HTTP 200 and "conflict on insert of AgentActivity".
  test('an acknowledgment stored by Linear but answered too late counts as sent, and the disposition follows', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    linear.failNext('stored-then-timeout', 'FicusAgentActivity')
    await created(sessionId)
    const acks = linear.calls.filter(
      (call) => call.operation === 'FicusAgentActivity' && call.variables.input?.content?.body === LINEAR_ACK_BODY
    )
    // The retry reused the activity ID and met the conflict.
    expect(acks).toHaveLength(2)
    expect(acks[1]!.variables.input.id).toBe(acks[0]!.variables.input.id)
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body],
    ])
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row).toMatchObject({ ackState: 'sent', dispositionState: 'sent', disposition: 'notified' })
  })

  test('a disposition Linear already holds counts as sent', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    // An earlier attempt stored it and its answer was lost.
    linear.activities.push({
      id: linearActivityId(sessionId, 'disposition'),
      agentSessionId: sessionId,
      content: LINEAR_DISPOSITION_ACTIVITIES.notified,
      at: now,
    })
    await created(sessionId)
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row).toMatchObject({ ackState: 'sent', dispositionState: 'sent', disposition: 'notified' })
    expect(bodies(sessionId).filter(([type]) => type === 'response')).toHaveLength(1)
  })

  test('an app without the write scope is not retried and is marked for reconnect', async () => {
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    linear.failNext('scope', 'FicusAgentActivity')
    await created(sessionId)
    // One acknowledgment attempt only: a retry is refused the same way.
    const acks = linear.calls.filter(
      (call) => call.operation === 'FicusAgentActivity' && call.variables.input?.content?.body === LINEAR_ACK_BODY
    )
    expect(acks).toHaveLength(1)
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row?.ackState).toBe('failed')
    const [connection] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, fixture.connectionId))
    expect(connection).toMatchObject({ authState: 'reauthorization_required', lastErrorCode: 'insufficient_scope' })
  })

  test('a session outside an issue is acknowledged and closed politely', async () => {
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await fixture.addSquad({ teamIds: [teamId] })
    await created(sessionId, { issue: null })
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['response', LINEAR_DISPOSITION_ACTIVITIES['no-issue'].body],
    ])
    expect(linear.calls.some((call) => call.operation === 'FicusLinearAppProbe')).toBe(false)
  })
})

describe('disposition and authority', () => {
  test('default rules notify the manager and pass the request to the team', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
    const notices = await db
      .select()
      .from(inbox)
      .where(
        and(
          eq(inbox.recipientId, squad.managerAgentId!),
          sql`${inbox.metadata}->>'source' = 'integration-notification'`
        )
      )
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('linear:issue.delegated')
  })

  test("a delegation (with Linear's authorless thread comment) routes as issue.delegated, a mention as issue.mentioned", async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const notices = async () =>
      (
        await db
          .select({ content: inbox.content })
          .from(inbox)
          .where(
            and(
              eq(inbox.recipientId, squad.managerAgentId!),
              sql`${inbox.metadata}->>'source' = 'integration-notification'`
            )
          )
      ).map((notice) => notice.content)
    const delegation = randomUUID()
    linear.addSession({ id: delegation, issueId: issue.id })
    await created(delegation)
    const [delegated] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, delegation))
    // The live shape: a delegation's session has a root comment too, the system thread comment.
    expect(delegated).toMatchObject({ trigger: 'delegation', rootCommentId: linearSystemCommentId(delegation) })
    expect(await notices()).toHaveLength(1)
    expect((await notices())[0]).toContain('linear:issue.delegated')

    const mention = randomUUID()
    const commentId = randomUUID()
    linear.addSession({ id: mention, issueId: issue.id, commentId })
    await created(mention, { commentId })
    const [mentioned] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, mention))
    expect(mentioned).toMatchObject({ trigger: 'mention', rootCommentId: commentId })
    const all = await notices()
    expect(all).toHaveLength(2)
    expect(all.filter((content) => content.includes('linear:issue.mentioned'))).toHaveLength(1)
    const outputs = await db
      .select({ output: sql<string>`${integrationOutputEvents.fact}->>'output'` })
      .from(integrationOutputEvents)
      .where(sql`${integrationOutputEvents.fact}->'data'->'session'->>'id' in (${delegation}, ${mention})`)
    expect(outputs.map((row) => row.output).sort()).toEqual([
      'agent_session.created',
      'agent_session.created',
      'issue.delegated',
      'issue.mentioned',
    ])
  })

  test('a session the app opened on itself is recorded as its own and never acknowledged or routed', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    // Live shape (session 53becf37): no creator, Linear's authorless thread comment, issue not delegated.
    const own = linear.addIssue({ ...issue, id: randomUUID(), number: 9, identifier: 'ENG-9', delegateId: null })
    linear.addSession({ id: sessionId, issueId: own.id })
    await created(sessionId, { creatorId: null, issue: own })
    expect(bodies(sessionId)).toEqual([])
    expect(linear.calls).toEqual([])
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row).toMatchObject({ trigger: 'proactive', ackState: 'sent', dispositionState: 'sent' })
    expect(await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))).toEqual([])
  })

  test('one probe per event is shared by every squad; unrouted teams match nothing', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    await fixture.addSquad({ teamIds: [randomUUID()] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(linear.calls.filter((call) => call.operation === 'FicusLinearAppProbe')).toHaveLength(1)
    const facts = await db
      .select({
        output: sql<string>`${integrationOutputEvents.fact}->>'output'`,
        authority: integrationOutputEvents.authority,
      })
      .from(integrationOutputEvents)
      .where(sql`${integrationOutputEvents.fact}->'data'->'session'->>'id' = ${sessionId}`)
    // Both squads record both facts under their own authority, bound to the app user and a trusted author.
    expect(facts).toHaveLength(4)
    for (const fact of facts)
      expect(fact.authority).toMatchObject({ accountId: fixture.appUserId, actorTrust: 'trusted' })
    expect(bodies(sessionId).at(-1)?.[0]).toBe('response')
  })

  test('ignore rules close the session as not set up', async () => {
    await fixture.addSquad({ teamIds: [teamId], rules: [rule('quiet', 'issue.delegated', { type: 'ignore' })] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.ignored.body])
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row?.disposition).toBe('ignored')
  })

  test('an issue the app cannot read reaches no squad and shows an error', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const hidden: FakeLinearIssue = { ...issue, id: randomUUID() }
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: hidden.id })
    await created(sessionId, { issue: hidden })
    expect(bodies(sessionId).at(-1)).toEqual(['error', LINEAR_DISPOSITION_ACTIVITIES.inaccessible.body])
    const recorded = await db
      .select()
      .from(integrationOutputEvents)
      .where(sql`${integrationOutputEvents.fact}->'data'->'session'->>'id' = ${sessionId}`)
    expect(recorded).toEqual([])
  })

  test('a delegation the live probe does not confirm is not routed as a delegation', async () => {
    await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    linear.issues.set(issue.id, { ...issue, delegateId: null })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(
      await db
        .select()
        .from(workStreams)
        .where(sql`${workStreams.metadata}->'integrationSource'->>'resourceKey' = ${issue.id}`)
    ).toEqual([])
  })

  test('a start-workstream rule queues work and binds the session to exactly one stream', async () => {
    const first = await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    const second = await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    const streams = await db
      .select()
      .from(workStreams)
      .where(sql`${workStreams.squadId} in (${first.id}, ${second.id})`)
    expect(streams).toHaveLength(2)
    const [session] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(session).toMatchObject({ disposition: 'bound', primary: true })
    const winner = streams.find((stream) => stream.id === session!.workStreamId)!
    expect(winner).toBeDefined()
    const tracked = (winner.metadata as { tracked: Array<Record<string, unknown>> }).tracked
    expect(tracked[0]).toMatchObject({ integration: 'linear', externalId: issue.id, agentSession: { id: sessionId } })
    const receipts = await db
      .select()
      .from(integrationOutputTriggerRuns)
      .where(sql`${integrationOutputTriggerRuns.squadId} in (${first.id}, ${second.id})`)
    expect(receipts.map((receipt) => receipt.outcomeCode).sort()).toEqual(['session_already_bound', null].sort())
    expect(bodies(sessionId)).toEqual([
      ['thought', LINEAR_ACK_BODY],
      ['thought', 'Ficus started tracking this work.'],
      ['thought', LINEAR_DISPOSITION_ACTIVITIES.queued.body],
    ])
    // Without an https public URL, Ficus adds no link to the session.
    expect(linear.sessions.get(sessionId)?.externalUrls).toEqual([])
  })

  test('binding adds Open in Ficus only with an https public URL', async () => {
    await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    process.env.APP_URL = 'https://ficus.example.com'
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    const [link] = linear.sessions.get(sessionId)!.externalUrls
    expect(link?.label).toBe('Open in Ficus')
    expect(link?.url).toMatch(/^https:\/\/ficus\.example\.com\/squads\/[0-9a-f-]+\/work\?ws=\d+$/)

    process.env.APP_URL = 'http://ficus.internal:8080'
    const plain = randomUUID()
    const other = linear.addIssue({ ...issue, id: randomUUID(), number: 8, identifier: 'ENG-8' })
    linear.addSession({ id: plain, issueId: other.id })
    await created(plain, { issue: other })
    expect(linear.sessions.get(plain)?.externalUrls).toEqual([])
  })

  test('a binding thought Linear already holds still adds Open in Ficus', async () => {
    await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    process.env.APP_URL = 'https://ficus.example.com'
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    // As if the link had failed after the thought was stored: announcing again meets the conflict.
    linear.sessions.get(sessionId)!.externalUrls = []
    await announceLinearSessionBinding(sessionId, row!.workStreamId!)
    expect(linear.sessions.get(sessionId)!.externalUrls.map((link) => link.label)).toEqual(['Open in Ficus'])
    expect(bodies(sessionId).filter(([, body]) => body === 'Ficus started tracking this work.')).toHaveLength(1)
  })

  test('a later session on an issue a stream already tracks binds to that stream', async () => {
    await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    const firstSession = randomUUID()
    linear.addSession({ id: firstSession, issueId: issue.id })
    await created(firstSession)
    const [first] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, firstSession))
    const mention = randomUUID()
    linear.addSession({ id: mention, issueId: issue.id })
    await created(mention, { commentId: randomUUID() })
    const [second] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, mention))
    expect(second?.workStreamId).toBe(first!.workStreamId)
    expect(second?.primary).toBe(true)
    const [previous] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, firstSession))
    expect(previous?.primary).toBe(false)
  })
})

describe('trust', () => {
  test('a guest’s delegation never starts work: the rule is held and the manager is told', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId, { creatorId: guest.id })
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squad.id))).toEqual([])
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('not a trusted member')
    expect(notices[0]!.content).toContain('--from-event')
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
  })

  test('a held start-workstream rule with a decision condition still tells the manager', async () => {
    const restore = setEventRuleDecideForTests(async (_purpose, request) => ({
      ok: true,
      result: {
        answers: Object.fromEntries(
          Object.keys(request.questions).map((name) => [name, { type: 'yesno', probability: 1 }])
        ),
        providerId: 'stub',
        model: 'stub',
        latencyMs: 1,
      },
    }))
    try {
      const squad = await fixture.addSquad({
        teamIds: [teamId],
        rules: [
          {
            ...startRule(),
            predicates: [{ kind: 'decision', question: { type: 'yesno', instructions: 'This is a real request.' } }],
          },
        ],
      })
      const sessionId = randomUUID()
      linear.addSession({ id: sessionId, issueId: issue.id })
      await created(sessionId, { creatorId: guest.id })
      expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squad.id))).toEqual([])
      const notices = await db.select().from(inbox).where(eq(inbox.recipientId, squad.managerAgentId!))
      expect(notices).toHaveLength(1)
      expect(notices[0]!.content).toContain('not a trusted member')
      expect(notices[0]!.content).toContain('--from-event')
      expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
    } finally {
      restore()
    }
  })

  test('an untrusted actor fails closed: a Linear authority without trust is never trusted', () => {
    const base = { kind: 'connection' as const, connectionId: 'c', squadId: 's' }
    expect(isUntrustedOutputActor('linear', base)).toBe(true)
    expect(isUntrustedOutputActor('linear', { ...base, actorTrust: 'untrusted' })).toBe(true)
    expect(isUntrustedOutputActor('linear', { ...base, actorTrust: 'trusted' })).toBe(false)
    expect(isUntrustedOutputActor('github', base)).toBe(false)
  })

  test('a user lookup that fails leaves the actor untrusted without hiding the issue', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    linear.failNext('graphql', 'FicusLinearUser')
    await created(sessionId)
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squad.id))).toEqual([])
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
  })

  test('an untrusted prompt only notifies the manager; a member’s prompt follows the rule', async () => {
    const squad = await fixture.addSquad({
      teamIds: [teamId],
      rules: [rule('prompt-start', 'agent_session.prompted', startAction())],
    })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    const prompt = (userId: string) =>
      processLinearAppEvent({
        type: 'AgentSessionEvent',
        payload: agentSessionPromptedPayload(fixture.context, {
          sessionId,
          issue,
          userId,
          activityId: randomUUID(),
          body: 'Please look at this',
        }),
      })
    await prompt(guest.id)
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squad.id))).toEqual([])
    await prompt(member.id)
    expect(await db.select().from(workStreams).where(eq(workStreams.squadId, squad.id))).toHaveLength(1)
  })
})

describe('connection lifecycle', () => {
  test('PermissionChange records team access, pre-filters later events and marks removed teams inaccessible', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    await processLinearAppEvent({
      type: 'PermissionChange',
      payload: permissionChangePayload(fixture.context, { addedTeamIds: ['other-team'], removedTeamIds: [teamId] }),
    })
    const [access] = await db
      .select()
      .from(linearTeamAccess)
      .where(eq(linearTeamAccess.connectionId, fixture.connectionId))
    expect(access).toMatchObject({ source: 'webhook', canAccessAllPublicTeams: false })
    expect(access?.teamIds).toContain('other-team')
    expect(access?.teamIds).not.toContain(teamId)
    const [row] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(row?.disposition).toBe('inaccessible')
    // The recorded access now rejects the team before any probe.
    const later = randomUUID()
    linear.addSession({ id: later, issueId: issue.id })
    const probes = linear.calls.filter((call) => call.operation === 'FicusLinearAppProbe').length
    await created(later)
    expect(linear.calls.filter((call) => call.operation === 'FicusLinearAppProbe')).toHaveLength(probes)
    expect(bodies(later).at(-1)).toEqual(['error', LINEAR_DISPOSITION_ACTIVITIES.inaccessible.body])
  })

  test('a team missing from Ficus’s own team listing is still routed when the probe can read it', async () => {
    await fixture.addSquad({ teamIds: [teamId] })
    // Seeded by the team listing before this team existed; only a PermissionChange can rule a team out.
    await db.insert(linearTeamAccess).values({
      connectionId: fixture.connectionId,
      canAccessAllPublicTeams: false,
      teamIds: ['other-team'],
      source: 'probe',
    })
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
    const [access] = await db
      .select()
      .from(linearTeamAccess)
      .where(eq(linearTeamAccess.connectionId, fixture.connectionId))
    expect(access?.teamIds).toContain(teamId)
  })

  test('a PermissionChange on a fresh connection starts from the full team listing, not just its delta', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    // An admin grants one more team before any event has been routed.
    await processLinearAppEvent({
      type: 'PermissionChange',
      payload: permissionChangePayload(fixture.context, { addedTeamIds: ['other-team'] }),
    })
    const [access] = await db
      .select()
      .from(linearTeamAccess)
      .where(eq(linearTeamAccess.connectionId, fixture.connectionId))
    expect(access?.teamIds).toEqual(expect.arrayContaining([teamId, 'other-team']))
    const sessionId = randomUUID()
    linear.addSession({ id: sessionId, issueId: issue.id })
    await created(sessionId)
    expect(linear.calls.some((call) => call.operation === 'FicusLinearAppProbe')).toBe(true)
    expect(bodies(sessionId).at(-1)).toEqual(['response', LINEAR_DISPOSITION_ACTIVITIES.notified.body])
    expect((await linearTeamAccessSetupIssues()).some((text) => text.includes(squad.name))).toBe(false)
  })

  test('setup status names a squad that routes a team the app cannot access', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    await processLinearAppEvent({
      type: 'PermissionChange',
      payload: permissionChangePayload(fixture.context, { removedTeamIds: [teamId] }),
    })
    const issues = await linearTeamAccessSetupIssues()
    expect(issues.some((issue) => issue.includes(squad.name) && issue.includes(teamId))).toBe(true)
  })

  test('setup status names a routed team key as a key, never as a team the app cannot access', async () => {
    const squad = await fixture.addSquad({ teamIds: ['FIC'] })
    await processLinearAppEvent({
      type: 'PermissionChange',
      payload: permissionChangePayload(fixture.context, { removedTeamIds: [teamId] }),
    })
    const issues = (await linearTeamAccessSetupIssues()).filter((issue) => issue.includes(squad.name))
    expect(issues).toEqual([
      `Squad ${squad.name} routes Linear team key FIC, which is not a team ID, so it routes no Linear events. Open the squad's Linear settings and choose the team so Ficus stores the team ID.`,
    ])
    expect(await inaccessibleLinearTeams(squad.id, fixture.connectionId)).toEqual([])
  })

  test('setup status names an event rule whose stored team filter is a team key', async () => {
    const keyed = rule('keyed', 'issue.assigned', { type: 'notify-manager' })
    const squad = await fixture.addSquad({
      teamIds: [teamId],
      rules: [
        { ...keyed, filters: { ...keyed.filters, teamId: 'FIC' } },
        { ...rule('by-id', 'issue.unassigned', { type: 'notify-manager' }), filters: { teamId, audience: 'any' } },
      ],
    })
    const issues = (await linearTeamAccessSetupIssues()).filter((issue) => issue.includes(squad.name))
    expect(issues).toEqual([
      `Squad ${squad.name} has a Linear event rule whose team filter is not a team ID, so it matches no Linear events: rule keyed (team key FIC is not a team ID). Open the squad's Linear event rules and choose the team in each Team filter so Ficus stores the team ID.`,
    ])
  })

  test('attaching a Linear connection resolves team keys the squad stored before it had one', async () => {
    const { squadIntegrationRoutesService } = await import('../runtime')
    const store = await import('./team-route-store')
    const realReconcile = store.reconcileSquadLinearTeamRoutes
    // The real reconcile, answered by a listing instead of Linear.
    const reconcile = spyOn(store, 'reconcileSquadLinearTeamRoutes').mockImplementation((squadId) =>
      realReconcile(squadId, async () => ({
        teams: [{ id: teamId, key: 'FIC', name: 'Ficus', connectionIds: [fixture.connectionId] }],
        connections: [{ id: fixture.connectionId, displayName: 'Linear', isDefault: true, status: 'ok' }],
      }))
    )
    const keyed = rule('keyed', 'issue.assigned', { type: 'notify-manager' })
    const [squad] = await db
      .insert(squads)
      .values({
        name: `linear-attach-${randomUUID()}`,
        purpose: 'Linear attach fixture',
        metadata: {
          linear: [{ teamId: 'FIC' }],
          integrationRules: { linear: [{ ...keyed, filters: { ...keyed.filters, teamId: 'fic' } }] },
        },
      })
      .returning()
    try {
      await squadIntegrationRoutesService.assign(squad!.id, 'linear', fixture.connectionId)
      expect(reconcile).toHaveBeenCalledTimes(1)
      const [stored] = await db.select({ metadata: squads.metadata }).from(squads).where(eq(squads.id, squad!.id))
      expect(stored!.metadata).toEqual({
        linear: [{ teamId }],
        integrationRules: { linear: [{ ...keyed, filters: { ...keyed.filters, teamId } }] },
      })
    } finally {
      reconcile.mockRestore()
      await db.delete(settings).where(sql`${settings.key} like ${`%:linear:${squad!.id}`}`)
      await db.delete(squads).where(eq(squads.id, squad!.id))
    }
  })

  test('a PermissionChange for another app user is ignored', async () => {
    await processLinearAppEvent({
      type: 'PermissionChange',
      payload: permissionChangePayload({ ...fixture.context, appUserId: randomUUID() }, { removedTeamIds: [teamId] }),
    })
    expect(
      await db.select().from(linearTeamAccess).where(eq(linearTeamAccess.connectionId, fixture.connectionId))
    ).toEqual([])
  })

  test('OAuthApp revoked marks the connection for reauthorization and alerts operators', async () => {
    await processLinearAppEvent({ type: 'OAuthApp', payload: oauthAppRevokedPayload(fixture.context) })
    const [connection] = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, fixture.connectionId))
    expect(connection).toMatchObject({ authState: 'reauthorization_required', lastErrorCode: 'app_uninstalled' })
    const alerts = await db
      .select()
      .from(inbox)
      .where(sql`${inbox.metadata}->>'connectionId' = ${fixture.connectionId}`)
    expect(alerts.map((alert) => alert.subject)).toEqual(['OAuth app was uninstalled and requires attention'])
  })
})
