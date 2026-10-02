import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  squads,
  integrationOutputEvents,
  githubFeedbackObjects,
  githubFeedbackRevisions,
  githubFeedbackSources,
} from '../../../db'
import { githubOutputAdapter } from '../outputs/github'
import type { VerifiedIngressEvent } from '../types'
import * as store from './feedback-store'

const time = '2026-10-02T10:00:00Z'
function event(body = 'A', updatedAt = time, review = false, transportId?: string): VerifiedIngressEvent {
  return {
    type: review ? 'pull_request_review' : 'issue_comment',
    githubObservation: { kind: 'webhook', deliveryId: transportId },
    payload: {
      action: review ? 'submitted' : 'created',
      repository: { id: 10, full_name: 'acme/project' },
      ...(review
        ? { pull_request: { id: 100, number: 3, updated_at: time } }
        : { issue: { id: 100, number: 3, updated_at: time } }),
      [review ? 'review' : 'comment']: {
        id: 9,
        user: { id: 2, login: 'outside', type: 'User' },
        body,
        state: 'commented',
        created_at: time,
        updated_at: updatedAt,
        submitted_at: time,
      },
    },
  }
}
async function fixture() {
  const squadIds = [crypto.randomUUID(), crypto.randomUUID()]
  const eventIds: string[] = []
  await db.insert(squads).values(squadIds.map((id) => ({ id, name: 'Feedback store', purpose: 'Test' })))
  return {
    squadIds,
    trackEvent(id: string) {
      eventIds.push(id)
    },
    async source(input: VerifiedIngressEvent, squadId = squadIds[0], connectionId = crypto.randomUUID()) {
      const fact = githubOutputAdapter.normalize(input)[0]!
      const [row] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: fact.eventKey,
          authority: { kind: 'connection', squadId, connectionId, connectionRevision: crypto.randomUUID() },
          fact,
        })
        .returning()
      eventIds.push(row!.id)
      return row!.id
    },
    async capture(
      input: VerifiedIngressEvent,
      options: { squadId?: string; current?: string | null; transportKey?: string } = {}
    ) {
      const id = await this.source(input, options.squadId)
      return store.captureGitHubFeedback(id, {
        authorizeSource: async () => true,
        transportKey: options.transportKey,
        ...(options.current !== undefined
          ? { readCurrent: async () => (options.current === null ? null : { contentHash: options.current! }) }
          : {}),
      })
    },
    async close() {
      await db.delete(squads).where(inArray(squads.id, squadIds))
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
    },
  }
}

test('immutable exact version changes at equal timestamps without inheriting decisions', async () => {
  expect(store.captureGitHubFeedback).toBeDefined()
  const h = await fixture()
  try {
    const a = await h.capture(event('A'))
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'allow_once', decidedByUserId: crypto.randomUUID(), decidedAt: new Date(), decisionVersion: 1 })
      .where(eq(githubFeedbackRevisions.id, a.revision.id))
    const b = await h.capture(event('B'))
    expect(b.revision.id).not.toBe(a.revision.id)
    expect(b.revision.sequence).toBe(2)
    expect(b.revision.decision).toBe('pending')
    const [stored] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, a.revision.id))
    expect(stored!.envelope!.body).toContain('A')
    expect(stored!.envelope!.body).not.toContain('B')
  } finally {
    await h.close()
  }
})

test('equivalent simultaneous webhook/poll/two-connection observations have one squad-local revision and canonical key', async () => {
  const h = await fixture()
  try {
    const ids = await Promise.all([h.source(event()), h.source({ ...event(), githubObservation: { kind: 'poll' } })])
    const [a, b] = await Promise.all(
      ids.map((id) => store.captureGitHubFeedback(id, { authorizeSource: async () => true }))
    )
    expect(a.revision.id).toBe(b.revision.id)
    expect(a.canonicalKey).toBe(b.canonicalKey)
    expect(
      await db.select().from(githubFeedbackSources).where(eq(githubFeedbackSources.revisionId, a.revision.id))
    ).toHaveLength(2)
    const other = await h.capture(event(), { squadId: h.squadIds[1] })
    expect(other.revision.id).not.toBe(a.revision.id)
    expect(other.canonicalKey).not.toBe(a.canonicalKey)
  } finally {
    await h.close()
  }
})

test('reviews A-B-A need new sequences; delayed transport replay cannot flip head or resurrect approval', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A', time, true), { transportKey: 'delivery-A' })
    const inputB = event('B', time, true)
    const bHash = githubOutputAdapter.normalize(inputB)[0]!.github!.content!.contentHash
    const b = await h.capture(inputB, { transportKey: 'delivery-B', current: bHash })
    const aHash = a.revision.contentHash
    const a2 = await h.capture(event('A', time, true), { transportKey: 'delivery-A2', current: aHash })
    expect(a2.revision.id).not.toBe(a.revision.id)
    expect(a2.revision.sequence).toBe(3)
    expect(a2.revision.decision).toBe('pending')
    const replay = await h.capture(event('A', time, true), { transportKey: 'delivery-A' })
    expect(replay.revision.id).toBe(a.revision.id)
    expect(replay.disposition).toBe('replay')
    const [object] = await db
      .select()
      .from(githubFeedbackObjects)
      .where(eq(githubFeedbackObjects.id, b.revision.objectId))
    expect(object!.currentRevisionId).toBe(a2.revision.id)
  } finally {
    await h.close()
  }
})

test('ambiguous, stale and vanished current observations stay held without replacing current head', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A', '2026-10-02T12:00:00Z'))
    const stale = await h.capture(event('STALE', time))
    expect(stale.revision.reason).toBe('stale_observation')
    expect(stale.revision.decision).toBe('pending')
    const review = await h.capture(event('R', time, true))
    for (const current of [undefined, null, 'a'.repeat(64)]) {
      const changed = await h.capture(event('EDIT', time, true), { current })
      expect(changed.revision.reason).toBe('ambiguous_observation')
      expect(changed.revision.releaseState).toBe('held')
    }
    const objects = await db
      .select()
      .from(githubFeedbackObjects)
      .where(inArray(githubFeedbackObjects.id, [a.revision.objectId, review.revision.objectId]))
    expect(objects.map((row) => row.currentRevisionId).sort()).toEqual([a.revision.id, review.revision.id].sort())
  } finally {
    await h.close()
  }
})

test('pending snapshot is not strengthened by a replay and unauthorised sources cannot create queue rows', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event())
    const duplicate = await h.capture(event())
    expect(duplicate.revision.decision).toBe('pending')
    expect(duplicate.revision.id).toBe(a.revision.id)
    const id = await h.source(event('NO ACCESS'), h.squadIds[1])
    await expect(store.captureGitHubFeedback(id, { authorizeSource: async () => false })).rejects.toThrow(
      'feedback_source_unavailable'
    )
    expect(
      await db.select().from(githubFeedbackObjects).where(eq(githubFeedbackObjects.squadId, h.squadIds[1]))
    ).toHaveLength(0)
  } finally {
    await h.close()
  }
})

test('unknown IDs are source-bound quarantines and oversized content has hash-only non-releasable evidence', async () => {
  const h = await fixture()
  try {
    const unknown = event()
    delete (unknown.payload as any).repository.id
    delete (unknown.payload as any).comment.id
    const a = await h.capture(unknown)
    const b = await h.capture(unknown)
    expect(a.revision.objectId).not.toBe(b.revision.objectId)
    expect(a.revision.reason).toBe('unknown_identity')
    const huge = await h.capture(event('X'.repeat(270000)))
    expect(huge.revision.envelope).toBeNull()
    expect(huge.revision.reason).toBe('content_unavailable')
    expect(huge.revision.contentHash).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    await h.close()
  }
})

test('equal-clock conflicting content is ambiguous without a fresh exact-current witness', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A'))
    const b = await h.capture(event('B'))
    expect(b.revision.reason).toBe('ambiguous_observation')
    const [object] = await db
      .select()
      .from(githubFeedbackObjects)
      .where(eq(githubFeedbackObjects.id, a.revision.objectId))
    expect(object!.currentRevisionId).toBe(a.revision.id)
  } finally {
    await h.close()
  }
})

test('provider-current witness raced by another observer cannot advance head and conflicting delivery IDs reject', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A', time, true), { transportKey: 'native-A' })
    const inputB = event('B', time, true)
    const id = await h.source(inputB)
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const atRead = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pendingB = store.captureGitHubFeedback(id, {
      authorizeSource: async () => true,
      readCurrent: async () => {
        entered()
        await barrier
        return { contentHash: githubOutputAdapter.normalize(inputB)[0]!.github!.content!.contentHash }
      },
    })
    await atRead
    const inputC = event('C', time, true)
    const c = await h.capture(inputC, {
      current: githubOutputAdapter.normalize(inputC)[0]!.github!.content!.contentHash,
    })
    release()
    expect((await pendingB).revision.reason).toBe('ambiguous_observation')
    const [object] = await db
      .select()
      .from(githubFeedbackObjects)
      .where(eq(githubFeedbackObjects.id, a.revision.objectId))
    expect(object!.currentRevisionId).toBe(c.revision.id)
    await expect(h.capture(event('FORGED', time, true), { transportKey: 'native-A' })).rejects.toThrow(
      'feedback_transport_conflict'
    )
  } finally {
    await h.close()
  }
})

test('stronger attribution for an already-held material version never becomes a fresh automatic candidate', async () => {
  const h = await fixture()
  try {
    const input = event('UNCHANGED', time, true)
    const poll = { ...input, githubObservation: { kind: 'poll' as const } }
    const held = await h.capture(poll)
    const webhook = await h.capture(input)
    expect(webhook.revision.id).not.toBe(held.revision.id)
    expect(webhook.revision.attribution).toBe('creation')
    expect(webhook.revision.reason).toBe('previously_held')
    expect(webhook.revision.decision).toBe('pending')
  } finally {
    await h.close()
  }
})

test('canonical admitted event is durable across source connections and uses only the immutable reviewed snapshot', async () => {
  expect(store.recordCanonicalGitHubFeedback).toBeDefined()
  const h = await fixture()
  try {
    const idA = await h.source(event('REVIEWED'))
    const idB = await h.source({ ...event('REVIEWED'), githubObservation: { kind: 'poll' } })
    const a = await store.captureGitHubFeedback(idA, { authorizeSource: async () => true })
    const b = await store.captureGitHubFeedback(idB, { authorizeSource: async () => true })
    expect(b.revision.id).toBe(a.revision.id)
    await expect(store.recordCanonicalGitHubFeedback(a.revision.id, idA, async () => true)).rejects.toThrow(
      'feedback_not_admitted'
    )
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'allow_once', decidedByUserId: crypto.randomUUID(), decidedAt: new Date(), decisionVersion: 1 })
      .where(eq(githubFeedbackRevisions.id, a.revision.id))
    // The raw source can never replace the reviewed text, even on a later retrieval/retry.
    const changed = githubOutputAdapter.normalize(event('UNSEEN'))[0]!
    await db.update(integrationOutputEvents).set({ fact: changed }).where(eq(integrationOutputEvents.id, idA))
    const [first, replay] = await Promise.all([
      store.recordCanonicalGitHubFeedback(a.revision.id, idA, async () => true),
      store.recordCanonicalGitHubFeedback(a.revision.id, idB, async () => true),
    ])
    h.trackEvent(first.id)
    expect(first.id).toBe(replay.id)
    expect(first.sourceKey).toBe(a.canonicalKey)
    expect(first.fact.body).toContain('REVIEWED')
    expect(JSON.stringify(first.fact)).not.toContain('UNSEEN')
    expect(first.matchedAt).toBeNull()
    await expect(store.recordCanonicalGitHubFeedback(a.revision.id, idA, async () => false)).rejects.toThrow(
      'feedback_source_unavailable'
    )
  } finally {
    await h.close()
  }
})
