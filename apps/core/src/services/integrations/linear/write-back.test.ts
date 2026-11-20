import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('linear')
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { createBlankWorkflow } from '@ficus/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { getSecretStore } from '../../secrets'
import {
  agentQuestions,
  agentQuestionWorkStreamOrigins,
  agents,
  agentTypes,
  db,
  inbox,
  linearActivityOutbox,
  linearAgentSessions,
  linearQuestionMirrors,
  squads,
  userLinearIdentities,
  users,
  workStreamFlowRuns,
  workStreams,
} from '../../../db'
import { ensureQueryIndex } from '../../../test-utils/message-query-indexes'
import { clearLinearUserCacheForTest, processLinearAppEvent } from './app-ingress'
import { drainLinearOutbox, resetLinearOutboxStateForTest, LINEAR_SESSION_ACTIVITIES_PER_HOUR } from './outbox'
import { openLinearSessionForStream } from './proactive-session'
import { projectLinearWriteBack } from './session-projector'
import { LINEAR_STOP_TEXT, matchLinearSelectReply } from './session-prompts'
import { createLinearAppFixture } from './testing/app-fixtures'
import {
  agentSessionCreatedPayload,
  agentSessionPromptedPayload,
  createFakeLinear,
  type FakeLinear,
  type FakeLinearIssue,
} from './testing/fake-linear'

const originalFetch = globalThis.fetch
const originalAppUrl = process.env.APP_URL
let fixture: Awaited<ReturnType<typeof createLinearAppFixture>>
let linear: FakeLinear
let issue: FakeLinearIssue
const teamId = randomUUID()
const member = { id: randomUUID(), name: 'Mira Member', active: true }
const guest = { id: randomUUID(), name: 'Gus Guest', guest: true, active: true }
const userIds: string[] = []

const workerType = `linear-write-back-worker-${randomUUID().slice(0, 8)}`
function startRule() {
  const definition = createBlankWorkflow()
  definition.participants.worker!.agentTypeId = workerType
  return {
    id: 'start-delegated',
    enabled: true,
    source: { integration: 'linear', output: 'issue.delegated', version: 1 },
    filters: { squadRouting: true, audience: 'connected-account' },
    action: { type: 'start-workstream', workflow: { kind: 'inline', definition } },
  }
}

function bodies(sessionId: string) {
  return linear
    .activitiesFor(sessionId)
    .map((activity) => [activity.content.type, activity.content.body ?? activity.content.action])
}

/** A delegated session that a start-workstream rule turned into a bound stream. */
async function boundStream(squadMetadata?: Record<string, unknown>) {
  const squad = await fixture.addSquad({ teamIds: [teamId], rules: [startRule()] })
  if (squadMetadata)
    await db
      .update(squads)
      .set({ metadata: { ...(squad.metadata as object), ...squadMetadata } })
      .where(eq(squads.id, squad.id))
  const sessionId = randomUUID()
  linear.addSession({ id: sessionId, issueId: issue.id })
  await processLinearAppEvent({
    type: 'AgentSessionEvent',
    payload: agentSessionCreatedPayload(fixture.context, { sessionId, issue, creatorId: member.id }),
  })
  const [session] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
  // The owner has prepared and started the event-created stream.
  const [stream] = await db
    .update(workStreams)
    .set({ status: 'active', pause: null })
    .where(eq(workStreams.id, session!.workStreamId!))
    .returning()
  return { squad, sessionId, stream: stream! }
}

async function setRun(streamId: string, attempts: Array<{ id: number; stepId: string; status: string }>) {
  const [run] = await db.select().from(workStreamFlowRuns).where(eq(workStreamFlowRuns.workStreamId, streamId))
  await db
    .update(workStreamFlowRuns)
    .set({ activated: true, version: run!.version + 1, state: { ...run!.state, attempts } as typeof run.state })
    .where(eq(workStreamFlowRuns.workStreamId, streamId))
}

async function setMetadata(streamId: string, patch: Record<string, unknown>) {
  const [stream] = await db.select().from(workStreams).where(eq(workStreams.id, streamId))
  await db
    .update(workStreams)
    .set({ metadata: { ...(stream!.metadata as object), ...patch } })
    .where(eq(workStreams.id, streamId))
}

async function project(streamId: string) {
  await projectLinearWriteBack(streamId)
  for (let pass = 0; pass < 4; pass++) await drainLinearOutbox()
}

async function prompt(sessionId: string, userId: string, body: string, signal?: 'stop') {
  const activityId = randomUUID()
  await processLinearAppEvent({
    type: 'AgentSessionEvent',
    payload: agentSessionPromptedPayload(fixture.context, { sessionId, issue, userId, activityId, body, signal }),
  })
  return activityId
}

async function addUser() {
  const id = randomUUID()
  await db.insert(users).values({ id, email: `linear-write-back-${id}@example.com` })
  userIds.push(id)
  return id
}

/** An open question asked by a private agent of `ownerUserId`, from the stream. */
async function askQuestion(streamId: string, ownerUserId: string, item: Record<string, unknown>) {
  const [agent] = await db.insert(agents).values({ agentTypeId: 'manager', ownerUserId }).returning()
  const [question] = await db
    .insert(agentQuestions)
    .values({ agentId: agent!.id, ownerUserId, questionData: { questions: [{ id: 'q', ...item }] }, status: 'open' })
    .returning()
  await db.insert(agentQuestionWorkStreamOrigins).values({ questionId: question!.id, workStreamId: streamId })
  return { agentId: agent!.id, questionId: question!.id }
}

const selectQuestion = {
  type: 'select',
  question: 'Which database should the cache use?',
  options: [
    { value: 'pg', label: 'Postgres' },
    { value: 'redis', label: 'Redis' },
  ],
}

beforeAll(async () => {
  await getSecretStore().initialize()
  await ensureQueryIndex('uq_linear_activity_outbox_projection')
  await ensureQueryIndex('uq_user_linear_identities_linear_user')
  await db.insert(agentTypes).values({
    id: workerType,
    name: 'Linear write-back fixture worker',
    extraScopes: ['workstreams:respond'],
    model: 'anthropic:claude-sonnet-4-5',
    systemPrompt: 'Test worker',
  })
})
afterAll(async () => {
  await db.delete(agentTypes).where(eq(agentTypes.id, workerType))
})
beforeEach(async () => {
  clearLinearUserCacheForTest()
  resetLinearOutboxStateForTest()
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
  delete process.env.APP_URL
})
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalAppUrl === undefined) delete process.env.APP_URL
  else process.env.APP_URL = originalAppUrl
  const questionAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.ownerUserId, userIds.length ? userIds : [randomUUID()]))
  if (questionAgents.length)
    await db.delete(agents).where(
      inArray(
        agents.id,
        questionAgents.map((row) => row.id)
      )
    )
  await db.delete(userLinearIdentities).where(eq(userLinearIdentities.organizationId, fixture.organizationId))
  await fixture.cleanup()
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)))
})

describe('progress projection', () => {
  test('flow progress reaches the session through the outbox exactly once', async () => {
    const { sessionId, stream } = await boundStream()
    await setRun(stream.id, [
      { id: 1, stepId: 'work', status: 'completed' },
      { id: 2, stepId: 'work', status: 'running' },
    ])
    await project(stream.id)
    const once = bodies(sessionId)
    expect(once.slice(3)).toEqual([
      ['thought', 'Started work.'],
      ['action', 'Finished'],
      ['action', 'Started'],
    ])
    // Re-projecting the same state sends nothing new, and Linear never sees a duplicate ID.
    await project(stream.id)
    expect(bodies(sessionId)).toEqual(once)
    const ids = linear.activitiesFor(sessionId).map((activity) => activity.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a completed stream with a pull request posts the response and links the session', async () => {
    const { sessionId, stream } = await boundStream()
    const url = 'https://github.com/acme/widgets/pull/42'
    await setMetadata(stream.id, {
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 42, url } },
    })
    await db.update(workStreams).set({ status: 'done' }).where(eq(workStreams.id, stream.id))
    await project(stream.id)
    expect(bodies(sessionId).at(-1)).toEqual(['response', `Done. Pull request: ${url}.`])
    expect(linear.sessions.get(sessionId)!.externalUrls).toContainEqual({ label: 'Pull request', url })
  })

  test('a retry after an unknown outcome reuses the activity ID and counts the duplicate as sent', async () => {
    const { sessionId, stream } = await boundStream()
    await projectLinearWriteBack(stream.id)
    const [row] = await db
      .select()
      .from(linearActivityOutbox)
      .where(and(eq(linearActivityOutbox.sessionId, sessionId), eq(linearActivityOutbox.projectionKey, 'stream:started')))
    // Linear already holds the activity, as if a response had been lost.
    linear.activities.push({ id: row!.activityId, agentSessionId: sessionId, content: {}, at: Date.now() })
    await drainLinearOutbox()
    const [after] = await db.select().from(linearActivityOutbox).where(eq(linearActivityOutbox.id, row!.id))
    expect(after).toMatchObject({ status: 'sent', lastErrorCode: 'duplicate' })
  })

  test('HTTP 429 honors Retry-After for the whole connection', async () => {
    const { stream } = await boundStream()
    await projectLinearWriteBack(stream.id)
    linear.failNext(429, 'FicusAgentActivity')
    const result = await drainLinearOutbox()
    expect(result.sent).toBe(0)
    const pending = await db
      .select()
      .from(linearActivityOutbox)
      .where(eq(linearActivityOutbox.connectionId, fixture.connectionId))
    expect(pending.every((row) => row.status === 'pending')).toBe(true)
    expect(pending.some((row) => row.nextAttemptAt.getTime() >= Date.now() + 25_000)).toBe(true)
  })

  test('an empty session bucket collapses pending progress to the newest item, never a response', async () => {
    const { sessionId, stream } = await boundStream()
    const sentAt = new Date()
    await db.insert(linearActivityOutbox).values(
      Array.from({ length: LINEAR_SESSION_ACTIVITIES_PER_HOUR }, (_, index) => ({
        connectionId: fixture.connectionId,
        scopeKey: sessionId,
        sessionId,
        projectionKey: `history:${index}`,
        activityId: randomUUID(),
        kind: 'activity',
        payload: {},
        status: 'sent',
        sentAt,
      }))
    )
    await setRun(stream.id, [
      { id: 1, stepId: 'work', status: 'completed' },
      { id: 2, stepId: 'work', status: 'completed' },
    ])
    await db.update(workStreams).set({ status: 'canceled' }).where(eq(workStreams.id, stream.id))
    await projectLinearWriteBack(stream.id)
    await drainLinearOutbox()
    const rows = await db
      .select()
      .from(linearActivityOutbox)
      .where(and(eq(linearActivityOutbox.sessionId, sessionId), inArray(linearActivityOutbox.status, ['pending', 'skipped'])))
    const state = Object.fromEntries(rows.map((row) => [row.projectionKey, row.status]))
    expect(state['flow:1:completed']).toBe('skipped')
    expect(state['flow:2:completed']).toBe('pending')
    expect(state['stream:canceled']).toBe('pending')
  })

  test('a permission error marks the session inaccessible and tells the owner once', async () => {
    const { sessionId, stream } = await boundStream()
    await projectLinearWriteBack(stream.id)
    linear.failNext(403, 'FicusAgentActivity')
    await drainLinearOutbox()
    const [session] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, sessionId))
    expect(session!.disposition).toBe('inaccessible')
    const before = linear.calls.length
    await project(stream.id)
    expect(linear.calls.length).toBe(before)
  })
})

describe('pull request attachments', () => {
  const url = 'https://github.com/acme/widgets/pull/9'
  test('the origin issue closes and other tracked issues link by default', async () => {
    const { stream } = await boundStream()
    const other = linear.addIssue({ ...issue, id: randomUUID(), number: 8, identifier: 'ENG-8' })
    const tracked = (stream.metadata as { tracked: Array<Record<string, unknown>> }).tracked
    await setMetadata(stream.id, {
      tracked: [
        ...tracked,
        { integration: 'linear', repository: 'eng', kind: 'issue', number: 8, externalId: other.id },
      ],
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 9, url } },
    })
    await project(stream.id)
    expect(linear.attachments.get(`${issue.id}\u0000${url}`)).toMatchObject({ linkKind: 'closes' })
    expect(linear.attachments.get(`${other.id}\u0000${url}`)).toMatchObject({ linkKind: 'links' })
    // Attaching again is idempotent.
    const calls = linear.calls.filter((call) => call.operation === 'FicusAttachPullRequest').length
    await project(stream.id)
    expect(linear.calls.filter((call) => call.operation === 'FicusAttachPullRequest').length).toBe(calls)
  })

  test('the squad setting picks the link kinds', async () => {
    const { stream } = await boundStream({
      integrationSettings: { linear: { version: 1, pullRequestLinks: { origin: 'contributes' } } },
    })
    await setMetadata(stream.id, {
      codeHost: { integration: 'github', repository: 'acme/widgets', changeRequest: { number: 9, url } },
    })
    await project(stream.id)
    expect(linear.attachments.get(`${issue.id}\u0000${url}`)).toMatchObject({ linkKind: 'contributes' })
  })
})

describe('prompts on a bound session', () => {
  test('a member’s stop pauses the stream at once, tells the owner and posts the stopped response', async () => {
    const { squad, sessionId, stream } = await boundStream()
    await prompt(sessionId, member.id, 'stop', 'stop')
    const [paused] = await db.select().from(workStreams).where(eq(workStreams.id, stream.id))
    expect(paused!.pause?.reason).toBe('Stopped from Linear by Mira Member')
    const owner = stream.ownerAgentId ?? squad.managerAgentId!
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, owner))
    expect(notices.some((notice) => notice.subject === 'Work stream paused from Linear')).toBe(true)
    await drainLinearOutbox()
    expect(bodies(sessionId)).toContainEqual(['response', LINEAR_STOP_TEXT.stopped])
  })

  test('a guest’s stop only notifies the owner', async () => {
    const { squad, sessionId, stream } = await boundStream()
    await prompt(sessionId, guest.id, 'stop', 'stop')
    const [unpaused] = await db.select().from(workStreams).where(eq(workStreams.id, stream.id))
    expect(unpaused!.pause).toBeNull()
    const owner = stream.ownerAgentId ?? squad.managerAgentId!
    const notices = await db.select().from(inbox).where(eq(inbox.recipientId, owner))
    expect(notices.some((notice) => notice.subject === 'Stop request from Linear')).toBe(true)
    await drainLinearOutbox()
    expect(bodies(sessionId)).toContainEqual(['response', LINEAR_STOP_TEXT.passed])
  })
})

describe('questions as elicitations', () => {
  test('an exact select reply from a linked user with answer permission answers the question', async () => {
    const { sessionId, stream } = await boundStream()
    const userId = await addUser()
    await db
      .insert(userLinearIdentities)
      .values({ userId, organizationId: fixture.organizationId, linearUserId: member.id })
    const { questionId } = await askQuestion(stream.id, userId, selectQuestion)
    await project(stream.id)
    const elicitation = linear.activitiesFor(sessionId).find((activity) => activity.content.type === 'elicitation')!
    expect(elicitation.content.body).toContain('Which database should the cache use?')
    expect(elicitation.content.body).toContain('Reply here or answer in Ficus.')

    await prompt(sessionId, member.id, '  redis ')
    const [answered] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(answered).toMatchObject({ status: 'answered', answer: 'redis', answeredByUserId: userId })
    expect(answered!.answerProvenance).toMatchObject({ integration: 'linear', linearUserId: member.id, sessionId })
    const [mirror] = await db.select().from(linearQuestionMirrors).where(eq(linearQuestionMirrors.questionId, questionId))
    expect(mirror!.state).toBe('answered_in_linear')
    // An answer from Linear posts no "answered in Ficus" thought.
    await project(stream.id)
    expect(bodies(sessionId).some(([, body]) => String(body).startsWith('Answered in Ficus'))).toBe(false)
  })

  test('free text, unlinked authors and users without permission reach the asking agent as candidates', async () => {
    const { sessionId, stream } = await boundStream()
    const owner = await addUser()
    const stranger = await addUser()
    await db
      .insert(userLinearIdentities)
      .values({ userId: stranger, organizationId: fixture.organizationId, linearUserId: member.id })
    const { agentId, questionId } = await askQuestion(stream.id, owner, selectQuestion)
    await project(stream.id)
    // Linked, but not allowed to answer this agent.
    await prompt(sessionId, member.id, 'Postgres')
    // Not an option.
    await prompt(sessionId, member.id, 'Use whatever is cheapest')
    const [open] = await db.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    expect(open!.status).toBe('open')
    const candidates = await db.select().from(inbox).where(eq(inbox.recipientId, agentId))
    expect(candidates.filter((message) => message.subject === 'Candidate answer from Linear')).toHaveLength(2)
    expect(candidates[0]!.content).toContain('Mira Member')
    expect(candidates[0]!.content).toContain(`ficus agent-question resolve ${questionId}`)
  })

  test('an answer in Ficus posts the chosen label and later replies are ordinary prompts', async () => {
    const { sessionId, stream } = await boundStream()
    const owner = await addUser()
    const { questionId } = await askQuestion(stream.id, owner, selectQuestion)
    await project(stream.id)
    await db
      .update(agentQuestions)
      .set({ status: 'answered', answer: 'pg', answeredByUserId: owner, answeredAt: new Date() })
      .where(eq(agentQuestions.id, questionId))
    await project(stream.id)
    expect(bodies(sessionId)).toContainEqual(['thought', 'Answered in Ficus: Postgres'])
    const [mirror] = await db.select().from(linearQuestionMirrors).where(eq(linearQuestionMirrors.questionId, questionId))
    expect(mirror!.state).toBe('answered_in_ficus')
  })

  test('an unlinked member gets the account link on the next elicitation, only with a public URL', async () => {
    process.env.APP_URL = 'https://ficus.example.com'
    const { sessionId, stream } = await boundStream()
    const owner = await addUser()
    await askQuestion(stream.id, owner, selectQuestion)
    await project(stream.id)
    await prompt(sessionId, member.id, 'redis')
    await askQuestion(stream.id, owner, { type: 'text', question: 'Anything else?' })
    await project(stream.id)
    const elicitations = linear.activitiesFor(sessionId).filter((activity) => activity.content.type === 'elicitation')
    const last = linear.calls.filter((call) => call.operation === 'FicusAgentActivity').at(-1)!
    expect(elicitations).toHaveLength(2)
    expect(last.variables.input).toMatchObject({
      signal: 'auth',
      signalMetadata: { url: 'https://ficus.example.com/settings?setting=linear-account' },
    })
  })

  test('exact matching accepts option values or labels, case-insensitively, and nothing else', () => {
    const select = { id: 'q', type: 'select' as const, question: 'Pick', options: selectQuestion.options }
    expect(matchLinearSelectReply(select, 'POSTGRES')).toBe('pg')
    expect(matchLinearSelectReply(select, 'redis')).toBe('redis')
    expect(matchLinearSelectReply(select, 'redis please')).toBeNull()
    const multi = { ...select, type: 'multi-select' as const }
    expect(matchLinearSelectReply(multi, 'Postgres, redis')).toBe('pg, redis')
    expect(matchLinearSelectReply(multi, 'pg\nRedis\npg')).toBe('pg, redis')
    expect(matchLinearSelectReply(multi, 'pg, mysql')).toBeNull()
    expect(matchLinearSelectReply({ id: 'q', type: 'text', question: 'Why?' }, 'pg')).toBeNull()
  })
})

describe('--linear-session', () => {
  test('opens a session on the tracked issue, binds it and announces the binding', async () => {
    const squad = await fixture.addSquad({ teamIds: [teamId] })
    const [stream] = await db
      .insert(workStreams)
      .values({
        squadId: squad.id,
        title: 'Manual stream',
        metadata: {
          tracked: [
            {
              integration: 'linear',
              repository: 'eng',
              kind: 'issue',
              number: 7,
              externalId: issue.id,
              connectionId: fixture.connectionId,
            },
          ],
        },
      })
      .returning()
    const result = await openLinearSessionForStream(stream!.id, {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 7,
      externalId: issue.id,
    })
    expect(result.created).toBe(true)
    const [session] = await db.select().from(linearAgentSessions).where(eq(linearAgentSessions.id, result.sessionId))
    expect(session).toMatchObject({ workStreamId: stream!.id, primary: true, trigger: 'proactive', disposition: 'bound' })
    expect(bodies(result.sessionId)[0]).toEqual(['thought', 'Ficus started tracking this work.'])
    // Asking again returns the bound session instead of opening another.
    const again = await openLinearSessionForStream(stream!.id, {
      integration: 'linear',
      repository: 'eng',
      kind: 'issue',
      number: 7,
      externalId: issue.id,
    })
    expect(again).toMatchObject({ sessionId: result.sessionId, created: false })
  })
})
