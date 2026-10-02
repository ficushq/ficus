import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  db,
  squads,
  users,
  roles,
  roleAssignments,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackDecisions,
  githubTrustedAuthors,
  integrationAuditEvents,
} from '../../../db'
import type { GitHubFeedbackSelection } from '@ficus/shared'
import * as service from './feedback-moderation'

async function fixture() {
  const squadId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    roleId = crypto.randomUUID()
  await db.insert(users).values({ id: userId, email: `${userId}@moderation.test` })
  await db.insert(squads).values({ id: squadId, name: 'Moderation', purpose: 'Test' })
  await db.insert(roles).values({ id: roleId, slug: roleId, name: 'Moderator', permissions: ['squads:update'] })
  await db.insert(roleAssignments).values({ subjectType: 'user', subjectId: userId, roleId, scope: 'squad', squadId })
  const revisions: string[] = []
  return {
    squadId,
    userId,
    human: { type: 'user', userId } as const,
    async revision(author = true, content = true): Promise<GitHubFeedbackSelection> {
      const [object] = await db
        .insert(githubFeedbackObjects)
        .values({ squadId, repositoryId: '1', objectKind: 'issue_comment', nativeId: crypto.randomUUID() })
        .returning()
      const [revision] = await db
        .insert(githubFeedbackRevisions)
        .values({
          objectId: object!.id,
          squadId,
          sequence: 1,
          contentHash: 'a'.repeat(64),
          byteCount: 10,
          attribution: 'creation',
          reason: content ? 'untrusted_author' : 'content_unavailable',
          author: author ? { accountId: '123', login: 'outside', accountType: 'User' } : null,
          envelope: content
            ? {
                output: 'issue.comment',
                version: 1,
                resourceKey: 'acme/project#1',
                eventKey: crypto.randomUUID(),
                data: { repository: 'acme/project', issue: { number: 1 }, content: { body: 'REVIEWED' } },
                subject: 'Feedback',
                body: 'REVIEWED',
              }
            : null,
        })
        .returning()
      revisions.push(revision!.id)
      return {
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        decisionVersion: revision!.decisionVersion,
      }
    },
    async rows() {
      return db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, squadId))
    },
    async decisions() {
      return db.select().from(githubFeedbackDecisions).where(eq(githubFeedbackDecisions.squadId, squadId))
    },
    async close() {
      await db.delete(githubFeedbackDecisions).where(eq(githubFeedbackDecisions.squadId, squadId))
      await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, squadId))
      await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.userId, userId))
      await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, userId))
      await db.delete(roles).where(eq(roles.id, roleId))
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(users).where(eq(users.id, userId))
    },
  }
}

test('concurrent human allow and deny have one CAS winner and one content-free decision audit', async () => {
  expect(service.moderateGitHubFeedback).toBeDefined()
  const h = await fixture()
  try {
    const selection = await h.revision()
    const results = await Promise.allSettled(
      ['allow_once', 'deny'].map((action) =>
        service.moderateGitHubFeedback(h.human, h.squadId, {
          requestId: crypto.randomUUID(),
          action: action as 'allow_once' | 'deny',
          selections: [selection],
        })
      )
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(await h.decisions()).toHaveLength(1)
    expect((await h.rows())[0]!.decisionVersion).toBe(1)
    expect(JSON.stringify(await h.decisions())).not.toContain('REVIEWED')
  } finally {
    await h.close()
  }
})

test('same request is idempotent; changed payload or human cannot reuse its authority', async () => {
  const h = await fixture()
  try {
    const input = { requestId: crypto.randomUUID(), action: 'allow_once' as const, selections: [await h.revision()] }
    const first = await service.moderateGitHubFeedback(h.human, h.squadId, input)
    expect(await service.moderateGitHubFeedback(h.human, h.squadId, input)).toEqual(first)
    await expect(
      service.moderateGitHubFeedback(h.human, h.squadId, { ...input, action: 'deny' })
    ).rejects.toMatchObject({ code: 'moderation_request_conflict' })
    await expect(
      service.moderateGitHubFeedback(
        { type: 'agent', agentId: crypto.randomUUID(), squadId: h.squadId, userId: h.userId },
        h.squadId,
        input
      )
    ).rejects.toMatchObject({ code: 'human_required' })
    expect(await h.decisions()).toHaveLength(1)
    expect((await h.rows())[0]!.releaseState).toBe('ready')
  } finally {
    await h.close()
  }
})

test('bounded bulk is all-or-nothing on hash, version, missing or cross-squad revisions', async () => {
  const h = await fixture()
  try {
    const a = await h.revision(),
      b = await h.revision()
    for (const invalid of [
      { ...b, contentHash: 'b'.repeat(64) },
      { ...b, decisionVersion: 1 },
      { ...b, revisionId: crypto.randomUUID() },
    ]) {
      await expect(
        service.moderateGitHubFeedback(h.human, h.squadId, {
          requestId: crypto.randomUUID(),
          action: 'allow_once',
          selections: [a, invalid],
        })
      ).rejects.toMatchObject({ code: 'moderation_selection_conflict' })
      expect((await h.rows()).every((row) => row.decision === 'pending' && row.releaseState === 'held')).toBe(true)
      expect(await h.decisions()).toHaveLength(0)
    }
    const result = await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [b, a],
    })
    expect(result).toHaveLength(2)
    expect((await h.rows()).every((row) => row.decision === 'deny' && row.releaseState === 'held')).toBe(true)
  } finally {
    await h.close()
  }
})

test('allow and trust changes only selected history and uses stored numeric author identity', async () => {
  const h = await fixture()
  try {
    const selected = await h.revision(),
      other = await h.revision()
    await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'allow_trust',
      selections: [selected],
    })
    const rows = await h.rows()
    expect(rows.find((row) => row.id === other.revisionId)!.decision).toBe('pending')
    expect(rows.find((row) => row.id === other.revisionId)!.releaseState).toBe('held')
    const trust = await db.select().from(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    expect(trust).toHaveLength(1)
    expect(trust[0]).toMatchObject({ accountId: '123', login: 'outside', addedByUserId: h.userId })
    const unknown = await h.revision(false)
    await expect(
      service.moderateGitHubFeedback(h.human, h.squadId, {
        requestId: crypto.randomUUID(),
        action: 'allow_trust',
        selections: [unknown],
      })
    ).rejects.toMatchObject({ code: 'moderation_author_unavailable' })
    // Human can review unknown-author text once, but cannot release hash-only oversized evidence.
    await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'allow_once',
      selections: [unknown],
    })
    const huge = await h.revision(true, false)
    await expect(
      service.moderateGitHubFeedback(h.human, h.squadId, {
        requestId: crypto.randomUUID(),
        action: 'allow_once',
        selections: [huge],
      })
    ).rejects.toMatchObject({ code: 'moderation_content_unavailable' })
  } finally {
    await h.close()
  }
})
