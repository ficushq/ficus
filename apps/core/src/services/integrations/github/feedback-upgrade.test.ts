import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { app } from '../../../index'
import {
  agentTokens,
  agents,
  db,
  inbox,
  integrationAuditEvents,
  integrationConnections,
  integrationOutputEvents,
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

  test('OFF squad (rollout default for existing squads) and other providers keep pre-feature behavior', async () => {
    const off = await legacyNotification(squadOff, agentOff)
    const linear = await legacyNotification(squadOn, agentOn, { integration: 'linear' })
    expect(await (await listAs(tokenOff, agentOff)).text()).toContain(off.message.id)
    expect((await app.request(`/api/inbox/message/${off.message.id}`, { headers: authHeaders(tokenOff) })).status).toBe(
      200
    )
    expect(await isCurrentIntegrationNotification(db, agentOff, off.message.id)).toBe(true)
    expect(await (await listAs(tokenOn, agentOn)).text()).toContain(linear.message.id)
  })

  test('toggling is idempotent: OFF restores pre-feature visibility, ON fences again, delivered rows never replay', async () => {
    const queued = await legacyNotification(squadOn, agentOn)
    const fenced = async () => !(await (await listAs(tokenOn, agentOn, '?all=true')).text()).includes(queued.message.id)
    expect(await fenced()).toBe(true)
    // Evaluating the fence twice (restart / repeated read) changes nothing and writes nothing.
    expect(await fenced()).toBe(true)
    const [before] = await db.select().from(inbox).where(eq(inbox.id, queued.message.id))

    await setGitHubAuthorFilter({ type: 'user', userId: human.id } as never, squadOn, false)
    expect(await fenced()).toBe(false)
    expect(await isCurrentIntegrationNotification(db, agentOn, queued.message.id)).toBe(true)
    await setGitHubAuthorFilter({ type: 'user', userId: human.id } as never, squadOn, true)
    expect(await fenced()).toBe(true)
    expect(await isCurrentIntegrationNotification(db, agentOn, queued.message.id)).toBe(false)

    const [after] = await db.select().from(inbox).where(eq(inbox.id, queued.message.id))
    // No rewrite of the original row: receipts, idempotency keys and delivery state are untouched.
    expect(after).toEqual(before!)
  })
})
