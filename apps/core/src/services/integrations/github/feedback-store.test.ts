import { expect, spyOn, test } from 'bun:test'
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
import { GitHubApiUnavailableError } from '../../github/api-client'

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
    async source(
      input: VerifiedIngressEvent,
      squadId: string | undefined = squadIds[0],
      connectionId = crypto.randomUUID()
    ) {
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
      options: { squadId?: string; current?: string | null | Error; transportKey?: string } = {}
    ) {
      const id = await this.source(input, options.squadId)
      return store.captureGitHubFeedback(id, {
        authorizeSource: async () => true,
        transportKey: options.transportKey,
        // No real GitHub I/O in tests: without a stated answer the witness gives none (an explicit denial).
        readCurrent: async () => {
          if (options.current instanceof Error) throw options.current
          return options.current == null ? null : { contentHash: options.current }
        },
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
    for (const current of [null, 'a'.repeat(64), new Error('unexpected witness failure')]) {
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
    // The same immutable text is a replay of the held version: no new revision, no upgrade.
    expect(webhook.disposition).toBe('replay')
    expect(webhook.revision.id).toBe(held.revision.id)
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

test('exact current-version replays dedupe before any provider-current requests', async () => {
  const h = await fixture()
  try {
    const first = await h.capture(event('DUPLICATE'))
    const id = await h.source(event('DUPLICATE'))
    let providerReads = 0
    const replay = await store.captureGitHubFeedback(id, {
      authorizeSource: async () => true,
      readCurrent: async () => {
        providerReads++
        return null
      },
    })
    expect(replay.revision.id).toBe(first.revision.id)
    expect(providerReads).toBe(0)
  } finally {
    await h.close()
  }
})

test('a GitHub outage during the current-version witness defers the capture instead of holding it as ambiguous', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A'))
    const revisions = () =>
      db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.objectId, a.revision.objectId))
    for (const reason of ['http_503', 'http_429', 'no_token', 'network']) {
      await expect(h.capture(event('B'), { current: new GitHubApiUnavailableError(reason) })).rejects.toThrow(
        'feedback_provider_unavailable'
      )
    }
    // Nothing was written: no held review item, and the known head is untouched.
    expect((await revisions()).map((row) => row.id)).toEqual([a.revision.id])
    // After recovery the same version is captured normally from the current-version witness.
    const inputB = event('B')
    const b = await h.capture(inputB, {
      current: githubOutputAdapter.normalize(inputB)[0]!.github!.content!.contentHash,
    })
    expect(b.revision.reason).not.toBe('ambiguous_observation')
    expect(b.revision.sequence).toBe(2)
    const [object] = await db
      .select()
      .from(githubFeedbackObjects)
      .where(eq(githubFeedbackObjects.id, a.revision.objectId))
    expect(object!.currentRevisionId).toBe(b.revision.id)
    expect((await revisions()).some((row) => row.reason === 'ambiguous_observation')).toBe(false)
  } finally {
    await h.close()
  }
})

test('newer captures obsolete every older pending hold and replay cannot resurrect it', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('Untrusted old author'))
    expect(a.revision.reason).toBe('untrusted_author')
    const b = await h.capture(event('Final', '2026-10-02T10:01:00Z'))
    const [old] = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, a.revision.id))
    expect(old!.releaseState).toBe('obsolete')
    expect(old!.decision).toBe('pending') // preserve audit, not a fabricated human decision
    expect(old!.envelope).toEqual(a.revision.envelope)
    const replay = await h.capture(event('Untrusted old author'))
    expect(replay.revision.releaseState).toBe('obsolete')
    expect(b.revision.releaseState).toBe('held')
  } finally {
    await h.close()
  }
})

test('identical-text newer replay advances freshness without replacing immutable revision or decision', async () => {
  const h = await fixture()
  try {
    const a = await h.capture(event('A', time))
    const noOp = await h.capture(event('A', '2026-10-02T10:03:00Z'))
    expect(noOp.revision.id).toBe(a.revision.id)
    expect(noOp.revision.providerVersion).toBe(a.revision.providerVersion)
    expect(noOp.revision.decision).toBe('pending')
    const b = await h.capture(event('B', '2026-10-02T10:02:00Z'))
    expect(b.revision.releaseState).toBe('obsolete')
    const [current] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, a.revision.id))
    expect(current!.releaseState).toBe('held')
    const [object] = await db
      .select()
      .from(githubFeedbackObjects)
      .where(eq(githubFeedbackObjects.id, a.revision.objectId))
    expect(object!.providerVersion).toBe('2026-10-02T10:03:00.000Z')
    expect(object!.currentRevisionId).toBe(a.revision.id)
  } finally {
    await h.close()
  }
})

test.each(['equal', 'both missing', 'old missing', 'new missing'])(
  '%s provider clocks use sequence for obsolescence, even when the newer capture is ambiguous',
  async (clocks) => {
    const h = await fixture()
    try {
      const aInput = event('A', time, clocks === 'both missing')
      const bInput = event('B', time, clocks === 'both missing')
      if (clocks === 'old missing') delete (aInput.payload.comment as Record<string, unknown>).updated_at
      if (clocks === 'new missing') delete (bInput.payload.comment as Record<string, unknown>).updated_at
      const a = await h.capture(aInput)
      const b = await h.capture(bInput)
      expect(b.revision.objectId).toBe(a.revision.objectId)
      expect(b.revision.sequence).toBeGreaterThan(a.revision.sequence)
      expect(
        (await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, a.revision.id)))[0]!
          .releaseState
      ).toBe('obsolete')
      expect(b.revision.releaseState).toBe('held')
    } finally {
      await h.close()
    }
  }
)

test('obsolescence identity is squad, repository, kind and native ID, never just native ID', async () => {
  const h = await fixture()
  try {
    const original = await h.capture(event('Original'))
    const differentRepo = event('Other repo', '2026-10-02T10:01:00Z')
    differentRepo.payload.repository = { id: 11, full_name: 'acme/other' }
    const differentNative = event('Other native', '2026-10-02T10:01:00Z')
    ;(differentNative.payload.comment as Record<string, unknown>).id = 99
    await h.capture(differentRepo)
    await h.capture(differentNative)
    await h.capture(event('Other kind', '2026-10-02T10:01:00Z', true))
    await h.capture(event('Other squad', '2026-10-02T10:01:00Z'), { squadId: h.squadIds[1] })
    const [stored] = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.id, original.revision.id))
    expect(stored!.releaseState).toBe('held')
  } finally {
    await h.close()
  }
})

test('replaying the same captured poll source after a newer version retains its obsolete audit identity', async () => {
  const h = await fixture()
  try {
    const input = { ...event('Old'), githubObservation: { kind: 'poll' as const } }
    const id = await h.source(input)
    const first = await store.captureGitHubFeedback(id, { authorizeSource: async () => true })
    await h.capture(event('New', '2026-10-02T10:01:00Z'))
    const replay = await store.captureGitHubFeedback(id, { authorizeSource: async () => true })
    expect(replay.revision.id).toBe(first.revision.id)
    expect(replay.revision.releaseState).toBe('obsolete')
  } finally {
    await h.close()
  }
})

for (const clocks of ['equal', 'both missing', 'old missing', 'new missing'] as const)
  test(`OFF ${clocks} clocks record sequence freshness without a current-text provider witness`, async () => {
    const provider = await import('./feedback-provider')
    const current = spyOn(provider, 'readCurrentGitHubFeedback').mockRejectedValue(
      new GitHubApiUnavailableError('http_503')
    )
    const trust = await import('./feedback-trust')
    const authorTrust = spyOn(trust, 'resolveGitHubAuthorTrust')
    const h = await fixture()
    try {
      await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, h.squadIds[0]!))
      const oldInput = event('OLD_RAW', time)
      const newInput = event('NEW_RAW', time)
      if (clocks === 'both missing' || clocks === 'old missing')
        delete (oldInput.payload.comment as Record<string, unknown>).updated_at
      if (clocks === 'both missing' || clocks === 'new missing')
        delete (newInput.payload.comment as Record<string, unknown>).updated_at
      const ids = [await h.source(oldInput), await h.source(newInput)]
      const old = await store.captureGitHubFeedback(ids[0]!, {
        unfiltered: 'content',
        authorizeSource: async () => true,
      })
      const fresh = await store.captureGitHubFeedback(ids[1]!, {
        unfiltered: 'content',
        authorizeSource: async () => true,
      })
      expect(fresh.revision.sequence).toBeGreaterThan(old.revision.sequence)
      expect(fresh.revision.decision).toBe('historical')
      expect(fresh.revision.releaseState).toBe('retained')
      const [object] = await db
        .select()
        .from(githubFeedbackObjects)
        .where(eq(githubFeedbackObjects.id, fresh.revision.objectId))
      expect(object!.currentRevisionId).toBe(fresh.revision.id)
      const [prior] = await db
        .select()
        .from(githubFeedbackRevisions)
        .where(eq(githubFeedbackRevisions.id, old.revision.id))
      expect(prior!.releaseState).toBe('obsolete')
      const { isUnfilteredGitHubEvent } = await import('./author-filter')
      const [source] = await db.select().from(integrationOutputEvents).where(eq(integrationOutputEvents.id, ids[1]!))
      expect(await isUnfilteredGitHubEvent(db, source!)).toBe(true)
      expect(current).not.toHaveBeenCalled()
      expect(authorTrust).not.toHaveBeenCalled()
    } finally {
      authorTrust.mockRestore()
      current.mockRestore()
      await h.close()
    }
  })
