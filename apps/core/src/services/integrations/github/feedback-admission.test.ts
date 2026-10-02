import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { db, squads, users, githubTrustedAuthors, integrationOutputEvents, githubFeedbackRevisions } from '../../../db'
import { githubOutputAdapter } from '../outputs/github'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import * as admission from './feedback-admission'
import type { VerifiedIngressEvent } from '../types'

function input(body = 'SENTINEL', edited = false): VerifiedIngressEvent {
  return {
    type: 'issue_comment',
    githubObservation: { kind: 'webhook' },
    payload: {
      action: edited ? 'edited' : 'created',
      repository: { id: 10, full_name: 'acme/project' },
      issue: { id: 20, number: 3, title: 'UNREVIEWED PARENT' },
      comment: {
        id: 30,
        user: { id: 2, login: 'author', type: 'User' },
        body,
        created_at: '2026-10-02T10:00:00Z',
        updated_at: edited ? '2026-10-02T11:00:00Z' : '2026-10-02T10:00:00Z',
      },
      sender: { id: 4, login: 'editor', type: 'User' },
    },
  }
}
async function fixture() {
  const squadId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    events: string[] = []
  await db.insert(users).values({ id: userId, email: `${userId}@admission.test` })
  await db.insert(squads).values({ id: squadId, name: 'Admission', purpose: 'Test' })
  return {
    squadId,
    async trust(accountId = '2') {
      await db
        .insert(githubTrustedAuthors)
        .values({
          squadId,
          accountId,
          login: accountId === '2' ? 'author' : 'editor',
          accountType: 'User',
          addedByUserId: userId,
        })
        .onConflictDoNothing()
    },
    async source(event = input()) {
      const fact = githubOutputAdapter.normalize(event)[0]!
      const [row] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: fact.eventKey,
          authority: {
            kind: 'connection',
            squadId,
            connectionId: crypto.randomUUID(),
            connectionRevision: crypto.randomUUID(),
          },
          fact,
        })
        .returning()
      events.push(row!.id)
      return row!
    },
    track(id: string) {
      events.push(id)
    },
    async close() {
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, events))
      await db.delete(users).where(eq(users.id, userId))
    },
  }
}

test('fresh automatic capture requires actual author and editor trust; adding trust does not release held history', async () => {
  expect(admission.captureRelevantGitHubFeedback).toBeDefined()
  const h = await fixture()
  try {
    const source = await h.source()
    const held = await admission.captureRelevantGitHubFeedback(source, {
      authorizeSource: async () => true,
      routingProvenance: [],
    })
    expect(held.revision.decision).toBe('pending')
    await h.trust()
    const replay = await admission.captureRelevantGitHubFeedback(source, {
      authorizeSource: async () => true,
      routingProvenance: [],
    })
    expect(replay.revision.id).toBe(held.revision.id)
    expect(replay.revision.decision).toBe('pending')
    const edited = await h.source(input('EDIT', true))
    const unknownEditor = await admission.captureRelevantGitHubFeedback(edited, {
      authorizeSource: async () => true,
      routingProvenance: [],
    })
    expect(unknownEditor.revision.decision).toBe('pending')
    await h.trust('4')
    expect(
      (
        await admission.captureRelevantGitHubFeedback(edited, {
          authorizeSource: async () => true,
          routingProvenance: [],
        })
      ).revision.decision
    ).toBe('pending')
    const freshEdit = input('NEW TRUSTED EDIT', true)
    ;(freshEdit.payload as any).comment.updated_at = '2026-10-02T12:00:00Z'
    const fresh = await h.source(freshEdit)
    expect(
      (
        await admission.captureRelevantGitHubFeedback(fresh, {
          authorizeSource: async () => true,
          routingProvenance: [],
        })
      ).revision.decision
    ).toBe('automatic')
  } finally {
    await h.close()
  }
})

test('canonical automatic feedback binds stored snapshot and checks live trust and source association on every predicate evaluation', async () => {
  const h = await fixture()
  try {
    await h.trust()
    const source = await h.source()
    const captured = await admission.captureRelevantGitHubFeedback(source, {
      authorizeSource: async () => true,
      routingProvenance: [],
    })
    expect(captured.revision.decision).toBe('automatic')
    expect(captured.revision.releaseState).toBe('ready')
    const canonical = await recordCanonicalGitHubFeedback(captured.revision.id, source.id, async () => true)
    h.track(canonical.id)
    expect(await admission.isGitHubFeedbackAdmitted(db, canonical)).toBe(true)
    expect(JSON.stringify(canonical.fact)).not.toContain('UNREVIEWED PARENT')
    expect(await admission.isGitHubFeedbackAdmitted(db, source)).toBe(false)
    const forged = {
      ...source,
      fact: { ...source.fact, github: { content: null, status: null, revisionId: captured.revision.id } },
    }
    expect(await admission.isGitHubFeedbackAdmitted(db, forged)).toBe(false)
    // Even a byte-exact approved envelope cannot confer canonical identity on its original source row.
    expect(await admission.isGitHubFeedbackAdmitted(db, { ...canonical, id: source.id })).toBe(false)
    expect(
      await admission.isGitHubFeedbackAdmitted(db, { ...canonical, fact: { ...canonical.fact, body: 'UNSEEN' } })
    ).toBe(false)
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.squadId, h.squadId))
    expect(await admission.isGitHubFeedbackAdmitted(db, canonical)).toBe(false)
    await expect(recordCanonicalGitHubFeedback(captured.revision.id, source.id, async () => true)).rejects.toThrow(
      'feedback_not_admitted'
    )
  } finally {
    await h.close()
  }
})

test('explicit human approval admits only its exact canonical association; legacy and caller approval flags fail closed', async () => {
  const h = await fixture()
  try {
    const source = await h.source()
    const capture = await captureGitHubFeedback(source.id, { authorizeSource: async () => true })
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'allow_once', decisionVersion: 1, decidedByUserId: crypto.randomUUID(), decidedAt: new Date() })
      .where(eq(githubFeedbackRevisions.id, capture.revision.id))
    const canonical = await recordCanonicalGitHubFeedback(capture.revision.id, source.id, async () => true)
    h.track(canonical.id)
    expect(await admission.isGitHubFeedbackAdmitted(db, canonical)).toBe(true)
    expect(
      await admission.isGitHubFeedbackAdmitted(db, {
        ...source,
        fact: { ...source.fact, github: undefined, data: { ...source.fact.data, approved: true } },
      })
    ).toBe(false)
    await db
      .update(githubFeedbackRevisions)
      .set({ releaseState: 'obsolete' })
      .where(eq(githubFeedbackRevisions.id, capture.revision.id))
    expect(await admission.isGitHubFeedbackAdmitted(db, canonical)).toBe(false)
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'deny' })
      .where(eq(githubFeedbackRevisions.id, capture.revision.id))
    expect(await admission.isGitHubFeedbackAdmitted(db, canonical)).toBe(false)
  } finally {
    await h.close()
  }
})
