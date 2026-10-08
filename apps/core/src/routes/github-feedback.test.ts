import { afterAll, beforeAll, describe, expect, spyOn, test, mock } from 'bun:test'
import { and, eq, inArray, or } from 'drizzle-orm'
import { CSRF_HEADER } from '@ficus/shared/http-headers'
import { app } from '../index'
import {
  db,
  agents,
  agentTokens,
  githubFeedbackDecisions,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
  githubPersonalIdentities,
  githubTrustedAuthors,
  integrationAuditEvents,
  integrationConnections,
  integrationOutputEvents,
  roleAssignments,
  roles,
  settings,
  squads,
} from '../db'
import { authHeaders, cleanupTestRbac, createTestAgentToken, createTestUser, type TestUser } from '../test-utils/rbac'
import { createTestGitHubConnection } from '../test-utils/github-connection'
import { invalidatePermissionCache } from '../services/rbac/permissions'
import { eventEmitter } from '../lib/infra/event-emitter'
import { WebSocketManager } from '../services/ws/manager'
import { setupEventBridge } from '../services/ws/bridge'

const PREFIX = `ghfb-${crypto.randomUUID().slice(0, 8)}`
const BODY = `UNTRUSTED-BODY-${crypto.randomUUID()}`
const squadA = crypto.randomUUID()
const squadB = crypto.randomUUID()
const agentId = crypto.randomUUID()
const roleIds = { moderator: crypto.randomUUID(), reader: crypto.randomUUID() }
let moderator: TestUser, reader: TestUser, outsider: TestUser
let agentToken: string
let connection: Awaited<ReturnType<typeof createTestGitHubConnection>>
const eventIds: string[] = []
const emitted: unknown[] = []
const stopListening = eventEmitter.on('githubFeedback.updated', (data) => emitted.push(data))

async function revision(
  options: { body?: string; decision?: 'pending' | 'allow_once'; releaseState?: 'held' | 'retry' } = {}
) {
  const [object] = await db
    .insert(githubFeedbackObjects)
    .values({ squadId: squadA, repositoryId: '77', objectKind: 'issue_comment', nativeId: crypto.randomUUID() })
    .returning()
  const decided = options.decision === 'allow_once'
  const [row] = await db
    .insert(githubFeedbackRevisions)
    .values({
      objectId: object!.id,
      squadId: squadA,
      sequence: 1,
      contentHash: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
      byteCount: 10,
      attribution: 'creation',
      reason: decided ? 'human_allowed' : 'untrusted_author',
      decision: options.decision ?? 'pending',
      releaseState: options.releaseState ?? 'held',
      ...(decided ? { decidedByUserId: moderator.id, decidedAt: new Date() } : {}),
      nextAttemptAt: options.releaseState === 'retry' ? new Date(Date.now() + 60_000) : null,
      author: { accountId: '4242', login: 'outsider-gh', accountType: 'User' },
      routingProvenance: [{ kind: 'squad_rule', id: 'rule-1', fingerprint: 'secret-fingerprint' }],
      envelope: {
        output: 'issue.comment',
        version: 1,
        resourceKey: 'acme/project#9',
        eventKey: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        data: {
          repository: 'acme/project',
          issue: { number: 9 },
          state: '',
          content: { body: options.body ?? BODY, title: '' },
          notificationTruncated: false,
        },
        subject: 'GitHub issue comment: acme/project 9',
        body: options.body ?? BODY,
        url: 'https://github.com/acme/project/issues/9#issuecomment-1',
      },
    })
    .returning()
  const [event] = await db
    .insert(integrationOutputEvents)
    .values({
      integration: 'github',
      sourceKey: `test:${row!.id}`,
      eventKey: row!.id,
      authority: { kind: 'connection', connectionId: connection.id, squadId: squadA },
      fact: row!.envelope!,
    })
    .returning()
  eventIds.push(event!.id)
  await db.insert(githubFeedbackSources).values({
    revisionId: row!.id,
    eventId: event!.id,
    squadId: squadA,
    authority: { kind: 'connection', connectionId: connection.id, squadId: squadA },
  })
  return row!
}

const as = (user: TestUser | string) => ({
  headers: { ...authHeaders(typeof user === 'string' ? user : user.token), 'Content-Type': 'application/json' },
})
const get = (token: TestUser | string, path: string) => app.request(`/api/squads/${path}`, as(token))
const send = (token: TestUser | string, method: string, path: string, body: unknown) =>
  app.request(`/api/squads/${path}`, { ...as(token), method, body: JSON.stringify(body) })
const selection = (row: { id: string; contentHash: string; decisionVersion: number }) => ({
  revisionId: row.id,
  contentHash: row.contentHash,
  decisionVersion: row.decisionVersion,
})

const ENABLED_KEY = '__integration-enabled:github'
let previousEnabled: string | undefined

beforeAll(async () => {
  // Disclosure requires a usable assigned connection, which requires GitHub itself to be enabled.
  previousEnabled = (await db.select().from(settings).where(eq(settings.key, ENABLED_KEY)))[0]?.value
  await db
    .insert(settings)
    .values({ key: ENABLED_KEY, value: 'true' })
    .onConflictDoUpdate({ target: settings.key, set: { value: 'true' } })
  await db.insert(squads).values([
    { id: squadA, name: `${PREFIX} A`, purpose: 'Test' },
    { id: squadB, name: `${PREFIX} B`, purpose: 'Test' },
  ])
  await db.insert(roles).values([
    {
      id: roleIds.moderator,
      slug: `${PREFIX}-mod`,
      name: `${PREFIX} mod`,
      permissions: ['squads:read', 'squads:update'],
    },
    { id: roleIds.reader, slug: `${PREFIX}-read`, name: `${PREFIX} read`, permissions: ['squads:read'] },
  ])
  moderator = await createTestUser({ prefix: PREFIX })
  reader = await createTestUser({ prefix: PREFIX })
  outsider = await createTestUser({ prefix: PREFIX })
  await db.insert(roleAssignments).values([
    { subjectType: 'user', subjectId: moderator.id, roleId: roleIds.moderator, scope: 'squad', squadId: squadA },
    { subjectType: 'user', subjectId: reader.id, roleId: roleIds.reader, scope: 'squad', squadId: squadA },
    { subjectType: 'user', subjectId: outsider.id, roleId: roleIds.moderator, scope: 'squad', squadId: squadB },
  ])
  invalidatePermissionCache()
  await db.insert(agents).values({ id: agentId, agentTypeId: 'system-manager', squadId: squadA, status: 'idle' })
  // Delegated credential: the agent acts for the moderator, yet must never gain human authority.
  agentToken = (await createTestAgentToken({ agentId, squadId: squadA, userId: moderator.id })).token
  connection = await createTestGitHubConnection({ squadId: squadA })
})

afterAll(async () => {
  stopListening()
  await db.delete(githubFeedbackDecisions).where(inArray(githubFeedbackDecisions.squadId, [squadA, squadB]))
  await db
    .delete(integrationAuditEvents)
    .where(
      or(
        inArray(integrationAuditEvents.targetId, [squadA, squadB]),
        inArray(integrationAuditEvents.squadId, [squadA, squadB])
      )
    )
  await db.delete(squads).where(inArray(squads.id, [squadA, squadB]))
  if (eventIds.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
  await db.delete(agentTokens).where(eq(agentTokens.agentId, agentId))
  await db.delete(agents).where(eq(agents.id, agentId))
  await connection?.dispose()
  await db.delete(roleAssignments).where(inArray(roleAssignments.roleId, Object.values(roleIds)))
  await cleanupTestRbac(PREFIX)
  if (previousEnabled === undefined) await db.delete(settings).where(eq(settings.key, ENABLED_KEY))
  else await db.update(settings).set({ value: previousEnabled }).where(eq(settings.key, ENABLED_KEY))
})

describe('mounted GitHub feedback moderation routes', () => {
  test('unauthenticated and non-human principals (including a delegated agent) get nothing and change nothing', async () => {
    const row = await revision()
    expect((await app.request(`/api/squads/${squadA}/github-feedback/summary`)).status).toBe(401)
    const reads = [
      `${squadA}/github-feedback/summary`,
      `${squadA}/github-feedback/revisions`,
      `${squadA}/github-feedback/revisions/${row.id}`,
      `${squadA}/github-feedback/trusted-authors`,
    ]
    for (const path of reads) {
      const response = await get(agentToken, path)
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(BODY)
    }
    const writes: Array<[string, string, unknown]> = [
      [
        'POST',
        `${squadA}/github-feedback/decisions`,
        { requestId: crypto.randomUUID(), action: 'allow_trust', selections: [selection(row)] },
      ],
      ['POST', `${squadA}/github-feedback/revisions/${row.id}/retry`, {}],
      ['PUT', `${squadA}/github-feedback/author-filter`, { enabled: false }],
      ['PUT', `${squadA}/github-feedback/untrusted-handling`, { handling: 'screen' }],
      ['POST', `${squadA}/github-feedback/trusted-authors/resolve`, { login: 'someone' }],
      ['POST', `${squadA}/github-feedback/trusted-authors`, { login: 'someone', accountId: '9' }],
      ['DELETE', `${squadA}/github-feedback/trusted-authors/4242`, undefined],
    ]
    for (const [method, path, body] of writes) expect((await send(agentToken, method, path, body)).status).toBe(403)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, row.id))
    expect(after).toMatchObject({ decision: 'pending', decisionVersion: 0 })
    expect(await db.select().from(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, squadA))).toEqual([])
    const [squad] = await db.select().from(squads).where(eq(squads.id, squadA))
    expect(squad!.githubAuthorFilter).toBe(true)
    expect(squad!.githubUntrustedHandling).toBe('hold')
  })

  test('a reader sees the safe queue and exact reviewed content but cannot act', async () => {
    const row = await revision()
    const summary = await (await get(reader, `${squadA}/github-feedback/summary`)).json()
    expect(summary).toMatchObject({ canModerate: false, authorFilterEnabled: true })
    expect(summary.pending).toBeGreaterThanOrEqual(1)
    const listResponse = await get(reader, `${squadA}/github-feedback/revisions?limit=100`)
    expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
    const listText = await listResponse.text()
    expect(listText).not.toContain(BODY) // Lists carry scalar facts only.
    const list = JSON.parse(listText)
    expect(list.canModerate).toBe(false)
    expect(list.items.find((item: { id: string }) => item.id === row.id)).toMatchObject({
      repository: 'acme/project',
      number: 9,
      isPullRequest: false,
      objectKind: 'issue_comment',
      author: { accountId: '4242', login: 'outsider-gh' },
      contentAvailable: true,
    })
    const detail = await (await get(reader, `${squadA}/github-feedback/revisions/${row.id}`)).json()
    expect(detail).toMatchObject({
      canModerate: false,
      content: { body: BODY, deliveryText: BODY },
      contentWithheld: null,
      url: 'https://github.com/acme/project/issues/9#issuecomment-1',
      authorTrust: [],
      routes: [{ kind: 'squad_rule', id: 'rule-1', workStreamId: null, recipientId: null }],
    })
    expect(JSON.stringify(detail)).not.toContain('secret-fingerprint')
    const denied = await send(reader, 'POST', `${squadA}/github-feedback/decisions`, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [selection(row)],
    })
    expect(denied.status).toBe(403)
    expect((await send(reader, 'PUT', `${squadA}/github-feedback/author-filter`, { enabled: false })).status).toBe(403)
    expect(
      (await send(reader, 'PUT', `${squadA}/github-feedback/untrusted-handling`, { handling: 'screen' })).status
    ).toBe(403)
    expect(
      (await send(reader, 'POST', `${squadA}/github-feedback/trusted-authors`, { login: 'x', accountId: '9' })).status
    ).toBe(403)
    expect((await send(reader, 'DELETE', `${squadA}/github-feedback/trusted-authors/4242`, undefined)).status).toBe(403)
  })

  test('out-of-squad humans cannot see or act, and a squad-bound lookup never reveals another squad’s revision', async () => {
    const row = await revision()
    expect((await get(outsider, `${squadA}/github-feedback/summary`)).status).toBe(403)
    expect((await get(outsider, `${squadA}/github-feedback/revisions/${row.id}`)).status).toBe(403)
    // Authorized in B, asking for A's revision through B: indistinguishable from missing.
    const crossed = await get(outsider, `${squadB}/github-feedback/revisions/${row.id}`)
    expect(crossed.status).toBe(404)
    expect(await crossed.text()).not.toContain(BODY)
    const forged = await send(outsider, 'POST', `${squadB}/github-feedback/decisions`, {
      requestId: crypto.randomUUID(),
      action: 'allow_once',
      selections: [selection(row)],
    })
    expect(forged.status).toBe(409)
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, row.id))
    expect(after!.decision).toBe('pending')
  })

  test('strict bodies, bounded pagination and alternate verbs fail safely', async () => {
    const first = await revision()
    await revision()
    const base = `${squadA}/github-feedback/revisions`
    // Keyset traversal one row at a time visits every revision exactly once (microsecond-safe cursor).
    const all = await (await get(moderator, `${base}?limit=100`)).json()
    expect(all.nextCursor).toBeNull()
    expect(all.items.map((item: { id: string }) => item.id)).toContain(first.id)
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: { items: Array<{ id: string }>; nextCursor: string | null } = await (
        await get(moderator, `${base}?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      ).json()
      expect(page.items.length).toBeLessThanOrEqual(1)
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor
    } while (cursor && seen.length <= all.items.length)
    expect(seen).toEqual(all.items.map((item: { id: string }) => item.id))
    for (const query of ['?limit=101', '?limit=0', '?cursor=bad', '?queue=all', '?extra=1'])
      expect((await get(moderator, `${base}${query}`)).status).toBe(400)
    // Forged authority fields are rejected rather than ignored.
    for (const forged of [{ userId: reader.id }, { authorId: '1' }, { squadId: squadB }]) {
      const response = await send(moderator, 'POST', `${squadA}/github-feedback/decisions`, {
        requestId: crypto.randomUUID(),
        action: 'allow_once',
        selections: [selection(first)],
        ...forged,
      })
      expect(response.status).toBe(400)
    }
    const forgedSelection = await send(moderator, 'POST', `${squadA}/github-feedback/decisions`, {
      requestId: crypto.randomUUID(),
      action: 'allow_once',
      selections: [{ ...selection(first), author: { accountId: '1' } }],
    })
    expect(forgedSelection.status).toBe(400)
    expect(
      (
        await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors`, {
          login: 'a',
          accountId: '1',
          accountType: 'Bot',
        })
      ).status
    ).toBe(400)
    for (const method of ['PATCH', 'PUT', 'DELETE'])
      expect([404, 405]).toContain((await send(moderator, method, `${squadA}/github-feedback/decisions`, {})).status)
    expect([404, 405]).toContain((await get(moderator, `${squadA}/github-feedback/decisions`)).status)
    expect((await get(moderator, `not-a-uuid/github-feedback/summary`)).status).toBe(400)
  })

  test('cookie-authenticated browser mutations require the CSRF header', async () => {
    const row = await revision()
    const body = JSON.stringify({ requestId: crypto.randomUUID(), action: 'deny', selections: [selection(row)] })
    const cookie = { Cookie: `ficus_session=${moderator.token}`, 'Content-Type': 'application/json' }
    const path = `/api/squads/${squadA}/github-feedback/decisions`
    const missing = await app.request(path, { method: 'POST', headers: cookie, body })
    expect(missing.status).toBe(403)
    expect(
      (await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, row.id)))[0]!.decision
    ).toBe('pending')
    const ok = await app.request(path, { method: 'POST', headers: { ...cookie, [CSRF_HEADER]: '1' }, body })
    expect(ok.status).toBe(202)
  })

  test('a human moderator decides atomically with idempotent replay, conflicts and content-free invalidation', async () => {
    const row = await revision()
    emitted.length = 0
    const request = { requestId: crypto.randomUUID(), action: 'allow_once', selections: [selection(row)] }
    const response = await send(moderator, 'POST', `${squadA}/github-feedback/decisions`, request)
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      decisions: [{ revisionId: row.id, action: 'allow_once', decisionVersion: 1 }],
    })
    expect(emitted).toEqual([{ squadId: squadA }])
    // Same request replays; a different request on the now-stale selection conflicts.
    expect((await send(moderator, 'POST', `${squadA}/github-feedback/decisions`, request)).status).toBe(202)
    const stale = await send(moderator, 'POST', `${squadA}/github-feedback/decisions`, {
      ...request,
      requestId: crypto.randomUUID(),
      action: 'deny',
    })
    expect(stale.status).toBe(409)
    expect((await stale.json()).code).toBe('moderation_selection_conflict')
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, row.id))
    expect(after).toMatchObject({ decision: 'allow_once', releaseState: 'ready', decidedByUserId: moderator.id })
    const audit = await db
      .select()
      .from(integrationAuditEvents)
      .where(
        and(eq(integrationAuditEvents.squadId, squadA), eq(integrationAuditEvents.action, 'github.feedback.moderate'))
      )
    expect(audit.some((entry) => entry.userId === moderator.id && entry.outcome === 'allowed')).toBe(true)
    const releasing = await (
      await get(moderator, `${squadA}/github-feedback/revisions?queue=releasing&limit=100`)
    ).json()
    expect(releasing.items.map((item: { id: string }) => item.id)).toContain(row.id)
  })

  test('revoked exact source access withholds the body while the decision metadata stays reviewable', async () => {
    const row = await revision()
    await db.update(integrationConnections).set({ enabled: false }).where(eq(integrationConnections.id, connection.id))
    try {
      const response = await get(moderator, `${squadA}/github-feedback/revisions/${row.id}`)
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).not.toContain(BODY)
      expect(JSON.parse(text)).toMatchObject({ content: null, contentWithheld: 'source_access_unavailable', url: null })
    } finally {
      await db.update(integrationConnections).set({ enabled: true }).where(eq(integrationConnections.id, connection.id))
    }
  })

  test('retry only clears the backoff of an allowed failing release', async () => {
    const failing = await revision({ decision: 'allow_once', releaseState: 'retry' })
    const pending = await revision()
    emitted.length = 0
    expect((await send(moderator, 'POST', `${squadA}/github-feedback/revisions/${failing.id}/retry`, {})).status).toBe(
      202
    )
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, failing.id))
    expect(after).toMatchObject({ nextAttemptAt: null, decision: 'allow_once', releaseState: 'retry' })
    expect(emitted).toEqual([{ squadId: squadA }])
    const refused = await send(moderator, 'POST', `${squadA}/github-feedback/revisions/${pending.id}/retry`, {})
    expect(refused.status).toBe(409)
    expect(
      (await send(moderator, 'POST', `${squadA}/github-feedback/revisions/${failing.id}/retry`, { force: true })).status
    ).toBe(400)
    const summary = await (await get(moderator, `${squadA}/github-feedback/summary`)).json()
    expect(summary.failing).toBeGreaterThanOrEqual(1)
  })

  test('trusted authors: server-resolved add, origin-accurate removal and confirmed-account binding', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://api.github.com/users/helper-bot%5Bbot%5D')
        return new Response(JSON.stringify({ id: 5150, login: 'helper-bot[bot]', type: 'Bot' }), { status: 200 })
      if (url === 'https://api.github.com/users/moderator-gh')
        return new Response(JSON.stringify({ id: 6060, login: 'moderator-gh', type: 'User' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as typeof fetch)
    try {
      const resolved = await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors/resolve`, {
        login: 'helper-bot[bot]',
      })
      expect(await resolved.json()).toEqual({ accountId: '5150', login: 'helper-bot[bot]', accountType: 'Bot' })
      expect(await db.select().from(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, squadA))).toEqual([])
      // A rename/reuse between preview and add is refused rather than trusting a different account.
      const mismatch = await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors`, {
        login: 'helper-bot[bot]',
        accountId: '9999',
      })
      expect(mismatch.status).toBe(409)
      expect(
        (await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors/resolve`, { login: 'nobody-here' }))
          .status
      ).toBe(400)
      emitted.length = 0
      const added = await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors`, {
        login: 'helper-bot[bot]',
        accountId: '5150',
      })
      expect(added.status).toBe(201)
      expect(emitted).toEqual([{ squadId: squadA }])

      // Moderator's own linked identity is dynamic trust; a manual grant for the same account is separate.
      await db.insert(githubPersonalIdentities).values({
        userId: moderator.id,
        accountId: '6060',
        login: 'moderator-gh',
        linkedAt: new Date(),
        unlinkedAt: null,
      })
      expect(
        (
          await send(moderator, 'POST', `${squadA}/github-feedback/trusted-authors`, {
            login: 'moderator-gh',
            accountId: '6060',
          })
        ).status
      ).toBe(201)
      const list = await (await get(reader, `${squadA}/github-feedback/trusted-authors`)).json()
      expect(list.canManage).toBe(false)
      const byId = Object.fromEntries(list.authors.map((author: { accountId: string }) => [author.accountId, author]))
      expect(byId['5150'].origins).toEqual([{ kind: 'manual', addedByUserId: moderator.id }])
      expect(byId['6060'].origins).toEqual(
        expect.arrayContaining([
          { kind: 'manual', addedByUserId: moderator.id },
          { kind: 'linked_user', userId: moderator.id },
        ])
      )
      // The reader's linked account confers nothing: no squads:update.
      await db
        .insert(githubPersonalIdentities)
        .values({ userId: reader.id, accountId: '7070', login: 'reader-gh', linkedAt: new Date(), unlinkedAt: null })
      const again = await (await get(moderator, `${squadA}/github-feedback/trusted-authors`)).json()
      expect(again.canManage).toBe(true)
      expect(again.authors.some((author: { accountId: string }) => author.accountId === '7070')).toBe(false)

      const removed = await send(moderator, 'DELETE', `${squadA}/github-feedback/trusted-authors/6060`, undefined)
      expect(await removed.json()).toEqual({
        removed: true,
        remainingOrigins: [{ kind: 'linked_user', userId: moderator.id }],
      })
      const gone = await send(moderator, 'DELETE', `${squadA}/github-feedback/trusted-authors/5150`, undefined)
      expect((await gone.json()).remainingOrigins).toEqual([])
      expect(
        (await send(moderator, 'DELETE', `${squadA}/github-feedback/trusted-authors/not-an-id`, undefined)).status
      ).toBe(400)
    } finally {
      fetchSpy.mockRestore()
      await db
        .delete(githubPersonalIdentities)
        .where(inArray(githubPersonalIdentities.userId, [moderator.id, reader.id]))
    }
  })

  test('only a human with squad update can switch the author filter; OFF releases held events once', async () => {
    const row = await revision()
    emitted.length = 0
    const off = await send(moderator, 'PUT', `${squadA}/github-feedback/author-filter`, { enabled: false })
    expect(off.status).toBe(200)
    const result = await off.json()
    expect(result.enabled).toBe(false)
    expect(result.released).toBeGreaterThanOrEqual(1)
    expect(emitted).toEqual([{ squadId: squadA }])
    const [after] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, row.id))
    expect(after).toMatchObject({ decision: 'allow_once', reason: 'filter_disabled', releaseState: 'ready' })
    expect((await (await get(reader, `${squadA}/github-feedback/summary`)).json()).authorFilterEnabled).toBe(false)
    expect((await send(moderator, 'PUT', `${squadA}/github-feedback/author-filter`, { enabled: 'no' })).status).toBe(
      400
    )
    expect((await send(moderator, 'PUT', `${squadA}/github-feedback/author-filter`, { enabled: true })).status).toBe(
      200
    )
  })
})

describe('GitHub untrusted handling route', () => {
  test('only a human with squad update can choose decision-model screening; it defaults to hold', async () => {
    const before = await (await get(reader, `${squadA}/github-feedback/summary`)).json()
    expect(before).toMatchObject({ untrustedHandling: 'hold', decisionModelConfigured: false })
    emitted.length = 0
    const screen = await send(moderator, 'PUT', `${squadA}/github-feedback/untrusted-handling`, { handling: 'screen' })
    expect(screen.status).toBe(200)
    expect(await screen.json()).toEqual({ handling: 'screen' })
    expect(emitted).toEqual([{ squadId: squadA }])
    expect((await (await get(reader, `${squadA}/github-feedback/summary`)).json()).untrustedHandling).toBe('screen')
    for (const body of [{ handling: 'allow' }, { handling: 'screen', extra: true }, {}])
      expect((await send(moderator, 'PUT', `${squadA}/github-feedback/untrusted-handling`, body)).status).toBe(400)
    const hold = await send(moderator, 'PUT', `${squadA}/github-feedback/untrusted-handling`, { handling: 'hold' })
    expect(hold.status).toBe(200)
    const [squad] = await db.select().from(squads).where(eq(squads.id, squadA))
    expect(squad!.githubUntrustedHandling).toBe('hold')
  })
})

describe('GitHub feedback WebSocket invalidations', () => {
  const openSocket = () => ({ readyState: WebSocket.OPEN, send: mock((_data: string) => 0) }) as any

  test('squad invalidation follows squad ACL and identity invalidation reaches only that user', async () => {
    const manager = new WebSocketManager()
    const stop = setupEventBridge(manager)
    try {
      const sockets = { moderator: openSocket(), outsider: openSocket(), agent: openSocket() }
      const ids = {
        moderator: manager.addClient(sockets.moderator, { type: 'user', userId: moderator.id }),
        outsider: manager.addClient(sockets.outsider, { type: 'user', userId: outsider.id }),
        agent: manager.addClient(sockets.agent, { type: 'agent', agentId, squadId: squadA, userId: moderator.id }),
      }
      for (const id of Object.values(ids)) await manager.subscribe(id, 'squads')
      for (const socket of Object.values(sockets)) socket.send.mockClear()

      const events = (socket: any) =>
        socket.send.mock.calls.map((call: [string]) => JSON.parse(call[0])).filter((m: any) => m.type === 'event')
      eventEmitter.emit('githubFeedback.updated', { squadId: squadA })
      // Delivery awaits DB-backed ACL checks; wait for the authorized socket, bounded.
      for (let i = 0; i < 200 && events(sockets.moderator).length < 1; i++) await new Promise((r) => setTimeout(r, 10))
      // The outsider's ACL check runs in the same broadcast; this settles it deterministically.
      await manager.broadcast('squads', 'githubFeedback.updated', { squadId: squadA })
      sockets.moderator.send.mock.calls.pop()
      expect(events(sockets.moderator)).toEqual([
        { type: 'event', topic: 'squads', event: 'githubFeedback.updated', data: { squadId: squadA } },
      ])
      expect(events(sockets.outsider)).toEqual([])
      for (const socket of Object.values(sockets)) socket.send.mockClear()

      eventEmitter.emit('githubIdentity.updated', { userId: moderator.id })
      expect(events(sockets.moderator)).toEqual([
        { type: 'event', topic: 'squads', event: 'githubIdentity.updated', data: { userId: moderator.id } },
      ])
      // Neither another human nor an agent carrying the same delegated userId receives it.
      expect(events(sockets.outsider)).toEqual([])
      expect(events(sockets.agent)).toEqual([])
    } finally {
      stop()
    }
  })
})
