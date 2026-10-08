import { expect, test } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import {
  db,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackScreenings,
  integrationAuditEvents,
  roleAssignments,
  roles,
  squads,
  users,
} from '../../../db'
import { getGitHubFeedbackSummary } from './feedback-review'
import { SCREEN_PENDING_BATCH, screenPendingGitHubFeedback } from './feedback-screen-pending'

const ENVELOPE = {
  output: 'issue.comment',
  version: 1,
  resourceKey: 'acme/project#1',
  eventKey: 'e',
  occurredAt: new Date(0).toISOString(),
  data: { repository: 'acme/project', issue: { number: 1 }, content: { body: 'please review' } },
  subject: 'Feedback',
  body: 'please review',
}

type RevisionPatch = Partial<typeof githubFeedbackRevisions.$inferInsert>

async function fixture(options: { handling?: 'hold' | 'screen'; filter?: boolean } = {}) {
  const squadId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    readerId = crypto.randomUUID(),
    roleId = crypto.randomUUID(),
    readerRoleId = crypto.randomUUID()
  await db.insert(users).values([
    { id: userId, email: `${userId}@screen-pending.test` },
    { id: readerId, email: `${readerId}@screen-pending.test` },
  ])
  await db.insert(squads).values({
    id: squadId,
    name: 'Screen pending',
    purpose: 'Test',
    githubAuthorFilter: options.filter ?? true,
    githubUntrustedHandling: options.handling ?? 'screen',
  })
  await db.insert(roles).values([
    { id: roleId, slug: roleId, name: `Moderator ${roleId}`, permissions: ['squads:read', 'squads:update'] },
    { id: readerRoleId, slug: readerRoleId, name: `Reader ${readerRoleId}`, permissions: ['squads:read'] },
  ])
  await db.insert(roleAssignments).values([
    { subjectType: 'user', subjectId: userId, roleId, scope: 'squad', squadId },
    { subjectType: 'user', subjectId: readerId, roleId: readerRoleId, scope: 'squad', squadId },
  ])
  const scheduled: string[][] = []
  return {
    squadId,
    human: { type: 'user', userId } as const,
    reader: { type: 'user', userId: readerId } as const,
    scheduled,
    /** No model calls: record what would be kicked. */
    schedule: (ids: string[]) => void scheduled.push(ids),
    async revisions(count: number, patch: RevisionPatch = {}) {
      const objects = await db
        .insert(githubFeedbackObjects)
        .values(
          Array.from({ length: count }, () => ({
            squadId,
            repositoryId: '1',
            objectKind: 'issue_comment',
            nativeId: crypto.randomUUID(),
          }))
        )
        .returning()
      const rows = await db
        .insert(githubFeedbackRevisions)
        .values(
          objects.map((object) => ({
            objectId: object.id,
            squadId,
            sequence: 1,
            contentHash: 'b'.repeat(64),
            byteCount: 10,
            attribution: 'creation' as const,
            reason: 'untrusted_author',
            author: { accountId: '123', login: 'outside', accountType: 'User' as const },
            envelope: ENVELOPE,
            ...patch,
          }))
        )
        .returning()
      return rows.map((row) => row.id)
    },
    async screen(revisionId: string, patch: Partial<typeof githubFeedbackScreenings.$inferInsert>) {
      await db.insert(githubFeedbackScreenings).values({
        revisionId,
        squadId,
        contentHash: 'b'.repeat(64),
        decisionVersion: 0,
        ...patch,
      })
    },
    async screenings() {
      return db.select().from(githubFeedbackScreenings).where(eq(githubFeedbackScreenings.squadId, squadId))
    },
    async audits() {
      return db
        .select()
        .from(integrationAuditEvents)
        .where(
          and(
            eq(integrationAuditEvents.targetId, squadId),
            eq(integrationAuditEvents.action, 'github.feedback.screen_pending')
          )
        )
    },
    async close() {
      await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, squadId))
      await db.delete(roleAssignments).where(inArray(roleAssignments.subjectId, [userId, readerId]))
      await db.delete(roles).where(inArray(roles.id, [roleId, readerRoleId]))
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(users).where(inArray(users.id, [userId, readerId]))
    },
  }
}

test('human-only with squad update, and refused unless the filter is on and set to screen', async () => {
  const h = await fixture()
  try {
    await h.revisions(1)
    const agent = { type: 'agent', agentId: crypto.randomUUID() } as never
    await expect(screenPendingGitHubFeedback(agent, h.squadId, { schedule: h.schedule })).rejects.toMatchObject({
      code: 'human_required',
      status: 403,
    })
    await expect(screenPendingGitHubFeedback(h.reader, h.squadId, { schedule: h.schedule })).rejects.toMatchObject({
      code: 'squad_update_required',
      status: 403,
    })
    expect(await h.screenings()).toEqual([])
    expect(h.scheduled).toEqual([])
    expect((await h.audits()).map((row) => [row.outcome, row.code])).toEqual([
      ['denied', 'human_required'],
      ['denied', 'squad_update_required'],
    ])
  } finally {
    await h.close()
  }
  for (const [options, code] of [
    [{ handling: 'hold' as const }, 'screening_not_enabled'],
    [{ filter: false }, 'author_filter_off'],
  ] as const) {
    const off = await fixture(options)
    try {
      await off.revisions(1)
      await expect(
        screenPendingGitHubFeedback(off.human, off.squadId, { schedule: off.schedule })
      ).rejects.toMatchObject({ code, status: 409 })
      expect(await off.screenings()).toEqual([])
    } finally {
      await off.close()
    }
  }
})

test('queues only pending revisions held for an untrusted author, and kicks exactly those', async () => {
  const h = await fixture()
  try {
    const eligible = await h.revisions(2)
    await h.revisions(1, { reason: 'unknown_editor' })
    await h.revisions(1, { reason: 'source_unverified' })
    await h.revisions(1, { envelope: null })
    await h.revisions(1, {
      decision: 'deny',
      decisionVersion: 1,
      reason: 'human_denied',
      decidedAt: new Date(),
      decidedByUserId: h.human.userId,
    })
    await h.revisions(1, {
      decision: 'allow_once',
      decisionVersion: 1,
      reason: 'human_allowed',
      releaseState: 'ready',
      decidedAt: new Date(),
      decidedByUserId: h.human.userId,
    })
    expect((await getGitHubFeedbackSummary(h.human, h.squadId)).screenable).toBe(2)
    expect(await screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule })).toEqual({
      queued: 2,
      skipped: 0,
      more: false,
    })
    const rows = await h.screenings()
    expect(rows.map((row) => row.revisionId).sort()).toEqual([...eligible].sort())
    expect(rows.every((row) => row.state === 'queued' && row.decisionVersion === 0)).toBe(true)
    expect(h.scheduled.map((ids) => [...ids].sort())).toEqual([[...eligible].sort()])
    expect((await getGitHubFeedbackSummary(h.human, h.squadId)).screenable).toBe(0)
    expect((await h.audits()).map((row) => [row.outcome, row.recordCount, row.actorKey])).toEqual([
      ['allowed', 2, `user:${h.human.userId}`],
    ])
  } finally {
    await h.close()
  }
})

test('a double click queues each revision once', async () => {
  const h = await fixture()
  try {
    await h.revisions(3)
    const [first, second] = await Promise.all([
      screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule }),
      screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule }),
    ])
    expect([first!.queued, second!.queued].sort()).toEqual([0, 3])
    expect([first!.skipped, second!.skipped].sort()).toEqual([0, 3])
    expect(await h.screenings()).toHaveLength(3)
    expect(h.scheduled.flat()).toHaveLength(3)
  } finally {
    await h.close()
  }
})

test(`queues at most ${SCREEN_PENDING_BATCH} per call and reports when more remain`, async () => {
  const h = await fixture()
  try {
    await h.revisions(SCREEN_PENDING_BATCH + 1)
    expect(await screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule })).toEqual({
      queued: SCREEN_PENDING_BATCH,
      skipped: 0,
      more: true,
    })
    expect(await screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule })).toEqual({
      queued: 1,
      skipped: SCREEN_PENDING_BATCH,
      more: false,
    })
    expect(await h.screenings()).toHaveLength(SCREEN_PENDING_BATCH + 1)
  } finally {
    await h.close()
  }
})

test('re-screens results without a verdict (unavailable, unconfigured, skipped, source unavailable), never a verdict or a live screen', async () => {
  const h = await fixture()
  try {
    const [unavailable, unconfigured, skipped, sourceUnavailable, unsafe, uncertain, tooLong, queued, running] =
      await h.revisions(9)
    const verdict = {
      instructsAgent: 0.9,
      intent: 'malicious' as const,
      intentConfidence: 0.9,
      intentProbabilities: null,
      providerId: 'p',
      model: 'm',
      latencyMs: 1,
    }
    for (const [id, outcome] of [
      [unavailable, 'unavailable'],
      [unconfigured, 'unconfigured'],
      [skipped, 'skipped'],
      [sourceUnavailable, 'source_unavailable'],
      [unsafe, 'unsafe'],
      [uncertain, 'uncertain'],
      [tooLong, 'too_long'],
    ] as const)
      await h.screen(id!, { state: 'held', outcome, attempts: 3, verdict, screenedAt: new Date() })
    await h.screen(queued!, {})
    await h.screen(running!, {
      state: 'running',
      attempts: 1,
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    expect((await getGitHubFeedbackSummary(h.human, h.squadId)).screenable).toBe(4)
    expect(await screenPendingGitHubFeedback(h.human, h.squadId, { schedule: h.schedule })).toEqual({
      queued: 4,
      skipped: 5,
      more: false,
    })
    const byId = new Map((await h.screenings()).map((row) => [row.revisionId, row]))
    for (const id of [unavailable, unconfigured, skipped, sourceUnavailable])
      expect(byId.get(id!)).toMatchObject({
        state: 'queued',
        attempts: 0,
        outcome: null,
        verdict: null,
        screenedAt: null,
      })
    for (const [id, outcome] of [
      [unsafe, 'unsafe'],
      [uncertain, 'uncertain'],
      [tooLong, 'too_long'],
    ] as const)
      expect(byId.get(id!)).toMatchObject({ state: 'held', outcome })
    expect(byId.get(running!)).toMatchObject({ state: 'running', attempts: 1 })
    expect(h.scheduled.flat().sort()).toEqual([unavailable, unconfigured, skipped, sourceUnavailable].sort())
  } finally {
    await h.close()
  }
})
