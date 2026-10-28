import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { InboxMessage } from '../../../entities/InboxMessage'
import { githubOutputAdapter } from '../outputs/github'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import { Agent } from '../../../entities/Agent'
import { app } from '../../../index'
import {
  agentTokens,
  chatSendReceipts,
  agents,
  db,
  inbox,
  integrationAuditEvents,
  integrationConnections,
  integrationOutputEvents,
  githubFeedbackRevisions,
  messages,
  roleAssignments,
  roles,
  settings,
  squads,
} from '../../../db'
import {
  authHeaders,
  cleanupTestRbac,
  createTestAdmin,
  createTestAgentToken,
  createTestUser,
  type TestUser,
} from '../../../test-utils/rbac'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { invalidatePermissionCache } from '../../rbac/permissions'
import { defaultNotificationContent } from '../outputs/default-routing'
import { isCurrentIntegrationNotification } from '../outputs/runtime'
import { setGitHubAuthorFilter } from './author-filter-setting'

// Pre-feature fixtures: raw GitHub notifications persisted before the trust gate existed (or while a
// squad's filter was OFF). They have no capture, revision or projection proof.
const PREFIX = `ghup-${crypto.randomUUID().slice(0, 8)}`
const SENTINEL = `LEGACY-UNTRUSTED-${crypto.randomUUID()}`
const squadOn = crypto.randomUUID()
const squadOff = crypto.randomUUID()
const agentOn = crypto.randomUUID()
const agentOff = crypto.randomUUID()
const roleId = crypto.randomUUID()
const ENABLED_KEY = '__integration-enabled:github'
let previousEnabled: string | undefined
let human: TestUser
let admin: TestUser
let tokenOn: string
let tokenOff: string
const connections: Array<
  Awaited<ReturnType<typeof createTestGitHubConnection>> & { squadId: string; revision: string }
> = []
const eventIds: string[] = []

async function legacyNotification(
  squadId: string,
  agentId: string,
  options: { delivered?: boolean; status?: boolean; integration?: string } = {}
) {
  const integration = options.integration ?? 'github'
  const connection = connections.find((item) => item.squadId === squadId)!
  const [event] = await db
    .insert(integrationOutputEvents)
    .values({
      integration,
      sourceKey: options.status ? `github-status:legacy:${crypto.randomUUID()}` : `legacy:${crypto.randomUUID()}`,
      eventKey: crypto.randomUUID(),
      authority:
        integration === 'github'
          ? { kind: 'connection', connectionId: connection.id, connectionRevision: connection.revision, squadId }
          : { kind: 'instance' },
      fact: {
        output: options.status ? 'pull_request.ci_completed' : 'issue.comment',
        version: 1,
        resourceKey: 'acme/project#9',
        eventKey: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        subject: options.status ? 'CI passed: acme/project 9' : `GitHub comment ${SENTINEL}`,
        body: options.status ? 'CI passed' : SENTINEL,
        data: { repository: 'acme/project', issue: { number: 9 }, action: 'created' },
      },
      matchedAt: new Date(),
    } as typeof integrationOutputEvents.$inferInsert)
    .returning()
  eventIds.push(event!.id)
  // Persisted directly: these rows predate the gate, so no current send path may (re)create them.
  const [message] = await db
    .insert(inbox)
    .values({
      senderType: 'system',
      recipientType: 'agent',
      recipientId: agentId,
      subject: event!.fact.subject,
      content: defaultNotificationContent(event!, undefined, undefined, squadId),
      metadata: { source: 'integration-notification', integrationEventId: event!.id },
      deliveredAt: options.delivered ? new Date() : null,
    })
    .returning()
  return { event: event!, message: message! }
}

const listAs = (token: string, agentId: string, query = '') =>
  app.request(`/api/inbox/agent/${agentId}${query}`, { headers: authHeaders(token) })

beforeAll(async () => {
  previousEnabled = (await db.select().from(settings).where(eq(settings.key, ENABLED_KEY)))[0]?.value
  await db
    .insert(settings)
    .values({ key: ENABLED_KEY, value: 'true' })
    .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
  await db.insert(squads).values([
    { id: squadOn, name: `${PREFIX} on`, purpose: 'Test', githubAuthorFilter: true },
    { id: squadOff, name: `${PREFIX} off`, purpose: 'Test', githubAuthorFilter: false },
  ])
  await db.insert(roles).values({
    id: roleId,
    slug: `${PREFIX}-mod`,
    name: `${PREFIX} mod`,
    permissions: ['squads:read', 'squads:update'],
  })
  human = await createTestUser({ prefix: PREFIX })
  admin = await createTestAdmin({ prefix: PREFIX })
  await db.insert(roleAssignments).values([
    { subjectType: 'user', subjectId: human.id, roleId, scope: 'squad', squadId: squadOn },
    { subjectType: 'user', subjectId: human.id, roleId, scope: 'squad', squadId: squadOff },
  ])
  invalidatePermissionCache()
  await db.insert(agents).values([
    { id: agentOn, agentTypeId: 'engineer', squadId: squadOn, status: 'idle' },
    { id: agentOff, agentTypeId: 'engineer', squadId: squadOff, status: 'idle' },
  ])
  tokenOn = (await createTestAgentToken({ agentId: agentOn, squadId: squadOn })).token
  tokenOff = (await createTestAgentToken({ agentId: agentOff, squadId: squadOff })).token
  for (const squadId of [squadOn, squadOff]) {
    const connection = await createTestGitHubConnection({ squadId })
    connections.push({ ...connection, squadId, revision: await connectionRevision(connection.id) })
  }
})

async function connectionRevision(id: string) {
  const [row] = await db
    .select({ revision: integrationConnections.materialRevision })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id))
  return row!.revision
}

afterAll(async () => {
  await db.delete(inbox).where(inArray(inbox.recipientId, [agentOn, agentOff]))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
  await db.delete(integrationAuditEvents).where(inArray(integrationAuditEvents.targetId, [squadOn, squadOff]))
  await db.delete(agentTokens).where(inArray(agentTokens.agentId, [agentOn, agentOff]))
  await db.delete(agents).where(inArray(agents.id, [agentOn, agentOff]))
  for (const connection of connections) await connection.dispose()
  await db.delete(squads).where(inArray(squads.id, [squadOn, squadOff]))
  await db.delete(roleAssignments).where(eq(roleAssignments.roleId, roleId))
  await cleanupTestRbac(PREFIX)
  if (previousEnabled === undefined) await db.delete(settings).where(eq(settings.key, ENABLED_KEY))
  else await db.update(settings).set({ value: previousEnabled }).where(eq(settings.key, ENABLED_KEY))
})

describe('GitHub trust rollout fence for pre-existing queued notifications', () => {
  test('ON squad: undelivered legacy GitHub prose is withheld from every agent-facing inbox read and from acceptance', async () => {
    const pending = await legacyNotification(squadOn, agentOn)
    const historical = await legacyNotification(squadOn, agentOn, { delivered: true })
    const status = await legacyNotification(squadOn, agentOn, { status: true })

    for (const query of ['', '?all=true', '?limit=50', '?limit=50&readState=all', `?limit=50&search=${SENTINEL}`]) {
      const response = await listAs(tokenOn, agentOn, query)
      expect(response.status).toBe(200)
      const text = await response.text()
      // Historical (already delivered) rows keep their receipt and stay readable; they are never replayed.
      if (query.includes('all') || query === `?limit=50&search=${SENTINEL}`)
        expect(text).toContain(historical.message.id)
      expect(text).not.toContain(pending.message.id)
      if (!query.includes('search')) expect(text).toContain(status.message.id)
    }
    const page = (await (await listAs(tokenOn, agentOn, '?limit=50&readState=all')).json()) as { totalCount: number }
    expect(page.totalCount).toBe(2)
    const count = (await (
      await app.request(`/api/inbox/agent/${agentOn}/count`, { headers: authHeaders(tokenOn) })
    ).json()) as {
      count: number
    }
    // historical + status are unread; the withheld row is not counted.
    expect(count.count).toBe(2)
    const single = await app.request(`/api/inbox/message/${pending.message.id}`, { headers: authHeaders(tokenOn) })
    expect(single.status).toBe(403)
    expect(await single.text()).not.toContain(SENTINEL)
    expect(
      (await app.request(`/api/inbox/message/${historical.message.id}`, { headers: authHeaders(tokenOn) })).status
    ).toBe(200)

    // Final acceptance (wake/delivery) also fails closed: no capture/decision/proof exists for it.
    expect(await isCurrentIntegrationNotification(db, agentOn, pending.message.id)).toBe(false)
    // A human operator reading the agent's inbox is no exception: legacy rows are not reviewable
    // queue content, so they stay fenced rather than shown raw.
    const asAdmin = await app.request(`/api/inbox/agent/${agentOn}?all=true`, { headers: authHeaders(admin.token) })
    expect(asAdmin.status).toBe(200)
    const adminText = await asAdmin.text()
    expect(adminText).toContain(historical.message.id)
    expect(adminText).not.toContain(pending.message.id)
  })

  test('OFF withholds unbound legacy GitHub prose, preserving accepted history and other providers', async () => {
    const off = await legacyNotification(squadOff, agentOff)
    const historical = await legacyNotification(squadOff, agentOff, { delivered: true })
    const status = await legacyNotification(squadOff, agentOff, { status: true })
    const linear = await legacyNotification(squadOn, agentOn, { integration: 'linear' })
    const text = await (await listAs(tokenOff, agentOff, '?all=true')).text()
    expect(text).not.toContain(off.message.id)
    expect(text).toContain(historical.message.id)
    expect(text).toContain(status.message.id)
    expect((await app.request(`/api/inbox/message/${off.message.id}`, { headers: authHeaders(tokenOff) })).status).toBe(
      403
    )
    expect(await isCurrentIntegrationNotification(db, agentOff, off.message.id)).toBe(false)
    expect(await (await listAs(tokenOn, agentOn)).text()).toContain(linear.message.id)
    const { renewKnownGitHubOutputs } = await import('./feedback-renewal')
    await renewKnownGitHubOutputs([off.event.id])
    const [audit] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, off.event.id))
    expect(audit!.lastErrorCode).toBe('github_freshness_unbound')
    expect(audit!.fact).toEqual(off.event.fact)
    const [unchanged] = await db.select().from(inbox).where(eq(inbox.id, historical.message.id))
    expect(unchanged).toEqual(historical.message)
  })

  test('toggling cannot restore unbound legacy prose; rows and accepted history stay intact', async () => {
    const queued = await legacyNotification(squadOn, agentOn)
    const fenced = async () => !(await (await listAs(tokenOn, agentOn, '?all=true')).text()).includes(queued.message.id)
    expect(await fenced()).toBe(true)
    // Evaluating the fence twice (restart / repeated read) changes nothing and writes nothing.
    expect(await fenced()).toBe(true)
    const [before] = await db.select().from(inbox).where(eq(inbox.id, queued.message.id))

    await setGitHubAuthorFilter({ type: 'user', userId: human.id } as never, squadOn, false)
    expect(await fenced()).toBe(true)
    expect(await isCurrentIntegrationNotification(db, agentOn, queued.message.id)).toBe(false)
    await setGitHubAuthorFilter({ type: 'user', userId: human.id } as never, squadOn, true)
    expect(await fenced()).toBe(true)
    expect(await isCurrentIntegrationNotification(db, agentOn, queued.message.id)).toBe(false)

    const [after] = await db.select().from(inbox).where(eq(inbox.id, queued.message.id))
    // No rewrite of the original row: receipts, idempotency keys and delivery state are untouched.
    expect(after).toEqual(before!)
  })
})

test('an accepted legacy raw receipt before acknowledgement stays historical and is never replayed', async () => {
  const legacy = await legacyNotification(squadOff, agentOff)
  const clientId = `github-feedback:${legacy.event.id}:${legacy.message.id}`
  const accepted = await (
    await Agent.mustFind(agentOff)
  ).sendMessage(legacy.message.content, { deliveryMode: 'steer', metadata: { clientId } })
  expect(accepted.success).toBe(true)
  const [before] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.clientId, clientId))
  expect(before!.state).toBe('accepted')
  expect(typeof before!.messageId).toBe('string')
  expect(typeof before!.executionId).toBe('string')
  expect(before!.acceptedAt instanceof Date).toBe(true)
  // Reproduce a pre-upgrade accepted inbox message. The current admission fence would correctly
  // reject a new unbound send, so only the synthetic historical message gets its old provenance.
  const [acceptedMessage] = await db.select().from(messages).where(eq(messages.id, before!.messageId!))
  await db
    .update(messages)
    .set({
      metadata: {
        ...(acceptedMessage!.metadata as Record<string, unknown>),
        source: 'inbox',
        inboxMessageIds: [legacy.message.id],
        executionId: before!.executionId,
      },
    })
    .where(eq(messages.id, acceptedMessage!.id))
  expect(await (await listAs(tokenOff, agentOff, '?all=true')).text()).toContain(legacy.message.id)
  const { renewKnownGitHubOutputs } = await import('./feedback-renewal')
  await renewKnownGitHubOutputs([legacy.event.id])
  const [after] = await db.select().from(chatSendReceipts).where(eq(chatSendReceipts.clientId, clientId))
  expect(after).toEqual(before)
  const [unchanged] = await db.select().from(inbox).where(eq(inbox.id, legacy.message.id))
  expect(unchanged).toEqual(legacy.message)
})

test('a matching client ID on an unrelated accepted send cannot authorize unbound legacy inbox prose', async () => {
  const legacy = await legacyNotification(squadOff, agentOff)
  const clientId = `github-feedback:${legacy.event.id}:${legacy.message.id}`
  expect(
    (
      await (
        await Agent.mustFind(agentOff)
      ).sendMessage('Unrelated accepted message', { deliveryMode: 'steer', metadata: { clientId } })
    ).success
  ).toBe(true)
  expect(await (await listAs(tokenOff, agentOff, '?all=true')).text()).not.toContain(legacy.message.id)
})

let nativeId = 1000
function readFixture() {
  const id = ++nativeId
  const first = '2026-10-02T10:00:00Z'
  const next = '2026-10-02T10:01:00Z'
  const input = (body: string, updatedAt = first, action = 'edited') => ({
    type: 'issues',
    githubObservation: { kind: 'webhook' as const, deliveryId: crypto.randomUUID() },
    payload: {
      action,
      repository: { id: 10, full_name: 'acme/project' },
      sender: { id: 2, login: 'outside', type: 'User' },
      issue: {
        id,
        number: 9,
        title: `Read fixture ${id}`,
        body,
        user: { id: 2, login: 'outside', type: 'User' },
        created_at: first,
        updated_at: updatedAt,
      },
      assignee: { login: 'ficus-bot' },
    },
  })
  const source = async (
    body: string,
    options: { newer?: boolean; filtered?: boolean; action?: boolean; at?: string } = {}
  ) => {
    const connection = connections.find((item) => item.squadId === squadOff)!
    const [fact] = githubOutputAdapter.normalize(
      input(body, options.at ?? (options.newer ? next : first), options.action ? 'assigned' : 'edited')
    )
    const [event] = await db
      .insert(integrationOutputEvents)
      .values({
        integration: 'github',
        sourceKey: crypto.randomUUID(),
        eventKey: fact!.eventKey,
        authority: {
          kind: 'connection',
          connectionId: connection.id,
          connectionRevision: connection.revision,
          squadId: squadOff,
        },
        fact: fact!,
      })
      .returning()
    eventIds.push(event!.id)
    const captured = await captureGitHubFeedback(event!.id, {
      authorizeSource: async () => true,
      ...(options.filtered ? { decideParent: async () => true } : { unfiltered: 'content' as const }),
    })
    if (!options.filtered && fact!.github?.rawParent)
      await captureGitHubFeedback(event!.id, { authorizeSource: async () => true, unfiltered: 'parent' })
    return { event: event!, ...captured }
  }
  const notice = async (event: typeof integrationOutputEvents.$inferSelect) =>
    (
      await db
        .insert(inbox)
        .values({
          senderType: 'system',
          recipientType: 'agent',
          recipientId: agentOff,
          subject: event.fact.subject,
          // A queued snapshot may predate compact notification formatting; retain its actual prose.
          content: event.fact.body,
          metadata: { source: 'integration-notification', integrationEventId: event.id },
        })
        .returning()
    )[0]!
  return { id, source, notice }
}
async function assertReadVisibility(notice: typeof inbox.$inferSelect, visible: boolean) {
  const marker = notice.content.match(/(?:OLD_INBOX_BANNER|PARENT_OLD)_\d+/)?.[0]
  expect(marker).toBeDefined()
  const entity = await InboxMessage.listForRecipient('agent', agentOff, { includeRead: true })
  expect(entity.some((item) => item.id === notice.id)).toBe(visible)
  for (const query of [
    '?all=true',
    '?limit=50&readState=all',
    `?limit=50&readState=all&search=${encodeURIComponent(marker!)}`,
  ]) {
    const response = await listAs(tokenOff, agentOff, query)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text.includes(notice.id)).toBe(visible)
    if (query.includes('search=')) expect((JSON.parse(text) as { totalCount: number }).totalCount).toBe(visible ? 1 : 0)
  }
  expect((await app.request(`/api/inbox/message/${notice.id}`, { headers: authHeaders(tokenOff) })).status).toBe(
    visible ? 200 : 403
  )
}
const unreadCount = async () =>
  (
    (await (await app.request(`/api/inbox/agent/${agentOff}/count`, { headers: authHeaders(tokenOff) })).json()) as {
      count: number
    }
  ).count

for (const transition of [false, true])
  test(`stale bound raw inbox reads are fenced across all APIs${transition ? ' after ON/OFF transitions' : ''}`, async () => {
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
    const h = readFixture()
    const baseline = await unreadCount()
    const a = await h.source(`OLD_INBOX_BANNER_${h.id}`)
    const notice = await h.notice(a.event)
    expect(await unreadCount()).toBe(baseline + 1)
    await assertReadVisibility(notice, true)
    if (transition) await db.update(squads).set({ githubAuthorFilter: true }).where(eq(squads.id, squadOff))
    await h.source(`NEW_INBOX_TEXT_${h.id}`, { newer: true, filtered: transition })
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
    await assertReadVisibility(notice, false)
    expect(await unreadCount()).toBe(baseline)
    const [unchanged] = await db.select().from(inbox).where(eq(inbox.id, notice.id))
    expect(unchanged).toEqual(notice)
    await db.update(inbox).set({ deliveredAt: new Date() }).where(eq(inbox.id, notice.id))
    await assertReadVisibility(notice, true) // Accepted history, not a new delivery.
  })

for (const canonical of [false, true])
  test(`${canonical ? 'approved canonical' : 'raw OFF'} queued quotation disappears from every read when its parent changes`, async () => {
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
    const h = readFixture()
    await h.source(`PARENT_OLD_${h.id}`)
    if (canonical) await db.update(squads).set({ githubAuthorFilter: true }).where(eq(squads.id, squadOff))
    const action = await h.source(`PARENT_OLD_${h.id}`, { action: true, filtered: canonical })
    let event = action.event
    if (canonical) {
      expect(action.revision.envelope!.data.parentContent).toBeDefined()
      await db
        .update(githubFeedbackRevisions)
        .set({ decision: 'allow_once', decidedByUserId: human.id, decidedAt: new Date(), releaseState: 'ready' })
        .where(eq(githubFeedbackRevisions.id, action.revision.id))
      event = await recordCanonicalGitHubFeedback(action.revision.id, action.event.id, async () => true)
      eventIds.push(event.id)
    }
    const notice = await h.notice(event)
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
    await assertReadVisibility(notice, true)
    await h.source(`PARENT_NEW_${h.id}`, { newer: true })
    await assertReadVisibility(notice, false)
    expect((await db.select().from(inbox).where(eq(inbox.id, notice.id)))[0]).toEqual(notice)
  })

for (const canonical of [false, true])
  test(`${canonical ? 'canonical' : 'raw'} undelivered inbox cannot reuse another delivery's settled old revision`, async () => {
    await db.update(squads).set({ githubAuthorFilter: canonical }).where(eq(squads.id, squadOff))
    const h = readFixture()
    const old = await h.source(`OLD_INBOX_BANNER_${h.id}`, { filtered: canonical })
    let event = old.event
    if (canonical) {
      await db
        .update(githubFeedbackRevisions)
        .set({ decision: 'allow_once', decidedByUserId: human.id, decidedAt: new Date(), releaseState: 'ready' })
        .where(eq(githubFeedbackRevisions.id, old.revision.id))
      event = await recordCanonicalGitHubFeedback(old.revision.id, old.event.id, async () => true)
      eventIds.push(event.id)
    }
    await db
      .update(githubFeedbackRevisions)
      .set({ releaseState: 'delivered' })
      .where(eq(githubFeedbackRevisions.id, old.revision.id))
    const notice = await h.notice(event)
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
    await assertReadVisibility(notice, true)
    await h.source(`NEW_INBOX_TEXT_${h.id}`, { newer: true })
    expect(
      (await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, old.revision.id)))[0]!
        .releaseState
    ).toBe('delivered')
    await assertReadVisibility(notice, false)
  })

test('inbox currentness honors identical-text watermark over a delayed different-text revision', async () => {
  await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squadOff))
  const h = readFixture()
  const old = await h.source(`OLD_INBOX_BANNER_${h.id}`)
  const notice = await h.notice(old.event)
  const noOp = await h.source(`OLD_INBOX_BANNER_${h.id}`, { at: '2026-10-02T10:03:00Z' })
  expect(noOp.revision.id).toBe(old.revision.id)
  const delayed = await h.source(`NEW_INBOX_TEXT_${h.id}`, { at: '2026-10-02T10:02:00Z' })
  expect(delayed.revision.releaseState).toBe('obsolete')
  await assertReadVisibility(notice, true)
})
