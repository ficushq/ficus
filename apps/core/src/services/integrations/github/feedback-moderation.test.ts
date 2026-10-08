import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  squads,
  users,
  roles,
  roleAssignments,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackDecisions,
  githubFeedbackSources,
  githubTrustedAuthors,
  integrationAuditEvents,
  integrationConnectionAssignments,
  integrationOutputEvents,
} from '../../../db'
import type { GitHubFeedbackSelection } from '@ficus/shared'
import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import * as service from './feedback-moderation'
useEnabledIntegrationFixtures('github')

async function fixture() {
  const squadId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    roleId = crypto.randomUUID()
  await db.insert(users).values({ id: userId, email: `${userId}@moderation.test` })
  await db.insert(squads).values({ id: squadId, name: 'Moderation', purpose: 'Test' })
  await db
    .insert(roles)
    .values({ id: roleId, slug: roleId, name: `Moderator ${roleId}`, permissions: ['squads:update'] })
  await db.insert(roleAssignments).values({ subjectType: 'user', subjectId: userId, roleId, scope: 'squad', squadId })
  // Every captured revision has a source the squad could read when it was captured.
  const connection = await createTestGitHubConnection({ squadId })
  const revisions: string[] = []
  const events: string[] = []
  return {
    squadId,
    userId,
    connection,
    human: { type: 'user', userId } as const,
    async revision(author = true, content = true): Promise<GitHubFeedbackSelection> {
      const [object] = await db
        .insert(githubFeedbackObjects)
        .values({ squadId, repositoryId: '1', objectKind: 'issue_comment', nativeId: crypto.randomUUID() })
        .returning()
      const envelope = content
        ? {
            output: 'issue.comment',
            version: 1,
            resourceKey: 'acme/project#1',
            eventKey: crypto.randomUUID(),
            occurredAt: new Date(0).toISOString(),
            data: { repository: 'acme/project', issue: { number: 1 }, content: { body: 'REVIEWED' } },
            subject: 'Feedback',
            body: 'REVIEWED',
          }
        : null
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
          envelope,
        })
        .returning()
      revisions.push(revision!.id)
      const authority = { kind: 'connection' as const, connectionId: connection.id, squadId }
      const [event] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: `moderation:${revision!.id}`,
          eventKey: revision!.id,
          authority,
          fact: envelope ?? {
            output: 'issue.comment',
            version: 1,
            resourceKey: 'acme/project#1',
            eventKey: crypto.randomUUID(),
            occurredAt: new Date(0).toISOString(),
            data: {},
            subject: '',
            body: '',
          },
        })
        .returning()
      events.push(event!.id)
      await db
        .insert(githubFeedbackSources)
        .values({ revisionId: revision!.id, eventId: event!.id, squadId, authority })
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
      if (events.length) await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, events))
      await connection.dispose()
      await db.delete(users).where(eq(users.id, userId))
    },
  }
}

test('allowing needs a squad connection that can still read the source; denying never does', async () => {
  const h = await fixture()
  try {
    const selection = await h.revision()
    // The connection the squad captured through is no longer assigned to the squad.
    await db
      .delete(integrationConnectionAssignments)
      .where(eq(integrationConnectionAssignments.connectionId, h.connection.id))
    for (const action of ['allow_once', 'allow_trust'] as const)
      await expect(
        service.moderateGitHubFeedback(h.human, h.squadId, {
          requestId: crypto.randomUUID(),
          action,
          selections: [selection],
        })
      ).rejects.toMatchObject({ code: 'moderation_content_unavailable', status: 409 })
    expect(await db.select().from(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))).toEqual([])
    const denied = await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [selection],
    })
    expect(denied).toHaveLength(1)
    expect((await h.rows())[0]).toMatchObject({ decision: 'deny', releaseState: 'held' })
  } finally {
    await h.close()
  }
})

test('a human can deny an allowed revision that is still releasing, and only that', async () => {
  const h = await fixture()
  try {
    const stuck = await h.revision()
    const delivered = await h.revision()
    await db
      .update(githubFeedbackRevisions)
      .set({
        decision: 'allow_once',
        decisionVersion: 1,
        decidedByUserId: h.userId,
        decidedAt: new Date(),
        releaseState: 'retained',
        attempts: 12,
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(githubFeedbackRevisions.id, stuck.revisionId))
    await db
      .update(githubFeedbackRevisions)
      .set({
        decision: 'allow_once',
        decisionVersion: 1,
        decidedByUserId: h.userId,
        decidedAt: new Date(),
        releaseState: 'delivered',
      })
      .where(eq(githubFeedbackRevisions.id, delivered.revisionId))
    const current = (id: string) => ({ ...stuck, revisionId: id, decisionVersion: 1 })
    // Allowing again is not a decision on an allowed row.
    await expect(
      service.moderateGitHubFeedback(h.human, h.squadId, {
        requestId: crypto.randomUUID(),
        action: 'allow_once',
        selections: [current(stuck.revisionId)],
      })
    ).rejects.toMatchObject({ code: 'moderation_selection_conflict' })
    // Delivered history is final.
    await expect(
      service.moderateGitHubFeedback(h.human, h.squadId, {
        requestId: crypto.randomUUID(),
        action: 'deny',
        selections: [current(delivered.revisionId)],
      })
    ).rejects.toMatchObject({ code: 'moderation_selection_conflict' })
    const denied = await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [current(stuck.revisionId)],
    })
    expect(denied).toHaveLength(1)
    const [row] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, stuck.revisionId))
    // The lease is taken away so a worker mid-attempt cannot settle over the human's decision.
    expect(row).toMatchObject({
      decision: 'deny',
      decisionVersion: 2,
      releaseState: 'held',
      reason: 'human_denied',
      leaseToken: null,
      leaseExpiresAt: null,
    })
    const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.targetId, h.squadId))
    expect(
      audit.some((row) => row.action === 'github.feedback.moderate' && row.code === 'deny' && row.recordCount === 1)
    ).toBe(true)
  } finally {
    await h.close()
  }
})

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
    const otherUserId = crypto.randomUUID()
    await db.insert(users).values({ id: otherUserId, email: `${otherUserId}@moderation.test` })
    const [assignment] = await db.select().from(roleAssignments).where(eq(roleAssignments.subjectId, h.userId))
    await db.insert(roleAssignments).values({
      subjectType: 'user',
      subjectId: otherUserId,
      roleId: assignment!.roleId,
      scope: 'squad',
      squadId: h.squadId,
    })
    try {
      await expect(
        service.moderateGitHubFeedback({ type: 'user', userId: otherUserId }, h.squadId, input)
      ).rejects.toMatchObject({ code: 'moderation_request_conflict' })
    } finally {
      await db.delete(roleAssignments).where(eq(roleAssignments.subjectId, otherUserId))
      await db.delete(users).where(eq(users.id, otherUserId))
    }
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
  const other = await fixture()
  try {
    const foreign = await other.revision()
    const a = await h.revision(),
      b = await h.revision()
    for (const invalid of [
      { ...b, contentHash: 'b'.repeat(64) },
      { ...b, decisionVersion: 1 },
      { ...b, revisionId: crypto.randomUUID() },
      foreign,
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
    expect((await other.rows())[0]!.decision).toBe('pending')
    const result = await service.moderateGitHubFeedback(h.human, h.squadId, {
      requestId: crypto.randomUUID(),
      action: 'deny',
      selections: [b, a],
    })
    expect(result).toHaveLength(2)
    expect((await h.rows()).every((row) => row.decision === 'deny' && row.releaseState === 'held')).toBe(true)
  } finally {
    await other.close()
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
