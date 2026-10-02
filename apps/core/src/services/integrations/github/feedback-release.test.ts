import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  squads,
  users,
  agents,
  inbox,
  executions,
  messages,
  chatSendReceipts,
  githubFeedbackRevisions,
  integrationOutputEvents,
  githubTrustedAuthors,
} from '../../../db'
import { githubOutputAdapter } from '../outputs/github'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import * as release from './feedback-release'

async function fixture() {
  const squadId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    events: string[] = [],
    agentIds: string[] = []
  await db.insert(users).values({ id: userId, email: `${userId}@release.test` })
  await db.insert(squads).values({ id: squadId, name: 'Release', purpose: 'Test' })
  const fact = githubOutputAdapter.normalize({
    type: 'issue_comment',
    githubObservation: { kind: 'webhook' },
    payload: {
      action: 'created',
      repository: { id: 10, full_name: 'acme/project' },
      issue: { id: 20, number: 3 },
      comment: {
        id: 30,
        user: { id: 2, login: 'author', type: 'User' },
        body: 'EXACT REVIEWED',
        created_at: '2026-10-02T10:00:00Z',
        updated_at: '2026-10-02T10:00:00Z',
      },
    },
  })[0]!
  const [source] = await db
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
  events.push(source!.id)
  const capture = await captureGitHubFeedback(source!.id, {
    authorizeSource: async () => true,
    routingProvenance: [{ kind: 'pre-flow', id: 'original-recipient' }],
  })
  await db
    .update(githubFeedbackRevisions)
    .set({
      decision: 'allow_once',
      decisionVersion: 1,
      decidedAt: new Date(),
      decidedByUserId: userId,
      releaseState: 'ready',
    })
    .where(eq(githubFeedbackRevisions.id, capture.revision.id))
  return {
    squadId,
    userId,
    revisionId: capture.revision.id,
    source: source!,
    async row() {
      return (
        await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, capture.revision.id))
      )[0]!
    },
    async secondSource() {
      const [other] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: fact.eventKey,
          authority: {
            ...source!.authority,
            kind: 'connection',
            squadId,
            connectionId: crypto.randomUUID(),
            connectionRevision: crypto.randomUUID(),
          },
          fact,
        })
        .returning()
      events.push(other!.id)
      const dedupe = await captureGitHubFeedback(other!.id, { authorizeSource: async () => true })
      expect(dedupe.revision.id).toBe(capture.revision.id)
      return other!
    },
    async due() {
      await db
        .update(githubFeedbackRevisions)
        .set({ nextAttemptAt: null })
        .where(eq(githubFeedbackRevisions.id, capture.revision.id))
    },
    async queued(event: typeof source, accepted = false) {
      const [agent] = await db.insert(agents).values({ agentTypeId: 'release-fixture', squadId }).returning()
      agentIds.push(agent!.id)
      const [notice] = await db
        .insert(inbox)
        .values({
          recipientType: 'agent',
          recipientId: agent!.id,
          senderType: 'system',
          subject: 'Feedback',
          content: 'EXACT REVIEWED',
          deliveredAt: new Date(),
          metadata: { source: 'integration-notification', integrationEventId: event!.id },
        })
        .returning()
      if (accepted) {
        const [execution] = await db.insert(executions).values({ agentId: agent!.id }).returning()
        const [message] = await db
          .insert(messages)
          .values({ agentId: agent!.id, role: 'human', content: 'EXACT REVIEWED' })
          .returning()
        await db.insert(chatSendReceipts).values({
          agentId: agent!.id,
          clientId: `github-feedback:${event!.id}:${notice!.id}`,
          requestHash: 'a'.repeat(64),
          state: 'accepted',
          messageId: message!.id,
          executionId: execution!.id,
          acceptedAt: new Date(),
          disposition: 'turn',
        })
      }
      return notice!
    },
    async close() {
      const rows = await db
        .select({ id: integrationOutputEvents.id })
        .from(integrationOutputEvents)
        .where(eq(integrationOutputEvents.sourceKey, capture.canonicalKey))
      events.push(...rows.map((row) => row.id))
      if (agentIds.length) {
        await db.delete(inbox).where(inArray(inbox.recipientId, agentIds))
        await db.delete(agents).where(inArray(agents.id, agentIds))
      }
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, events))
      await db.delete(users).where(eq(users.id, userId))
    },
  }
}

test('duplicate workers hold one lease, route the immutable canonical identity, and never report delivered merely on enqueue', async () => {
  expect(release.releaseGitHubFeedback).toBeDefined()
  const h = await fixture()
  let first: Promise<number> | undefined
  let unblock!: () => void, entered!: () => void
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  try {
    let calls = 0
    const deps: release.GitHubFeedbackReleaseDependencies = {
      authorizeSource: async () => true,
      route: async (event: typeof h.source, provenance: Array<{ kind: string; id: string }>) => {
        calls++
        expect(event.sourceKey).toBe(`github-feedback:${h.squadId}:${h.revisionId}`)
        expect(event.fact.body).toContain('EXACT REVIEWED')
        expect(provenance).toEqual([{ kind: 'pre-flow', id: 'original-recipient' }])
        await h.queued(event, false)
        entered()
        await barrier
        return { state: 'retained' as const, reason: 'recipient_waiting' }
      },
    }
    first = release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })
    await started
    expect(await release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })).toBe(0)
    unblock()
    expect(await first).toBe(1)
    expect(calls).toBe(1)
    expect(await h.row()).toMatchObject({
      releaseState: 'retained',
      leaseToken: null,
      attempts: 1,
      reason: 'recipient_waiting',
    })
  } finally {
    unblock?.()
    await first
    await h.close()
  }
})

test('partial send failure stays retryable with the same event identity and content-free error', async () => {
  const h = await fixture()
  try {
    const ids: string[] = []
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          ids.push(event.id)
          throw new Error('RAW PROVIDER/FEEDBACK SENTINEL')
        },
      },
      { revisionIds: [h.revisionId] }
    )
    expect(await h.row()).toMatchObject({
      releaseState: 'retry',
      reason: 'release_routing_failed',
      attempts: 1,
      leaseToken: null,
    })
    expect(JSON.stringify(await h.row())).not.toContain('RAW PROVIDER/FEEDBACK SENTINEL')
    await h.due()
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          ids.push(event.id)
          return { state: 'retained', reason: 'recipient_waiting' }
        },
      },
      { revisionIds: [h.revisionId] }
    )
    expect(new Set(ids).size).toBe(1)
    expect((await h.row()).attempts).toBe(2)
  } finally {
    await h.close()
  }
})

test('revoked source prevents routing; revoked automatic trust becomes pending and later trust cannot release history', async () => {
  const h = await fixture()
  try {
    let calls = 0
    const route: release.GitHubFeedbackReleaseDependencies['route'] = async () => {
      calls++
      return { state: 'retained' as const, reason: 'recipient_waiting' }
    }
    await release.releaseGitHubFeedback({ authorizeSource: async () => false, route }, { revisionIds: [h.revisionId] })
    expect(calls).toBe(0)
    expect((await h.row()).reason).toBe('source_unavailable')
    await h.due()
    await db
      .update(githubFeedbackRevisions)
      .set({ decision: 'automatic', decidedAt: null, decidedByUserId: null })
      .where(eq(githubFeedbackRevisions.id, h.revisionId))
    await release.releaseGitHubFeedback({ authorizeSource: async () => true, route }, { revisionIds: [h.revisionId] })
    expect(calls).toBe(0)
    expect(await h.row()).toMatchObject({ decision: 'pending', releaseState: 'held', reason: 'trust_revoked' })
    await db
      .insert(githubTrustedAuthors)
      .values({ squadId: h.squadId, accountId: '2', login: 'author', accountType: 'User', addedByUserId: h.userId })
    await h.due()
    await release.releaseGitHubFeedback({ authorizeSource: async () => true, route }, { revisionIds: [h.revisionId] })
    expect(calls).toBe(0)
    expect((await h.row()).decision).toBe('pending')
  } finally {
    await h.close()
  }
})

test('a new authorized observation cannot grant access to the revoked authority of the canonical event', async () => {
  const h = await fixture()
  try {
    const canonical = await recordCanonicalGitHubFeedback(h.revisionId, h.source.id, async () => true)
    const other = await h.secondSource()
    let calls = 0
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async (event) =>
          event.authority.kind === 'connection' &&
          other.authority.kind === 'connection' &&
          event.authority.connectionId === other.authority.connectionId,
        route: async () => {
          calls++
          return { state: 'retained', reason: 'recipient_waiting' }
        },
      },
      { revisionIds: [h.revisionId] }
    )
    expect(calls).toBe(0)
    expect((await h.row()).reason).toBe('source_unavailable')
    const aliases = await db
      .select()
      .from(integrationOutputEvents)
      .where(eq(integrationOutputEvents.sourceKey, canonical.sourceKey))
    expect(aliases).toHaveLength(1)
    expect(aliases[0]!.authority).toEqual(h.source.authority)
  } finally {
    await h.close()
  }
})

test('a stale worker cannot overwrite settlement after lease takeover', async () => {
  const h = await fixture()
  let unblock!: () => void, entered!: () => void
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let pending: Promise<number> | undefined
  try {
    const ids: string[] = []
    pending = release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          ids.push(event.id)
          entered()
          await barrier
          return { state: 'obsolete', reason: 'routing_changed' }
        },
      },
      { revisionIds: [h.revisionId] }
    )
    await started
    await db
      .update(githubFeedbackRevisions)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(githubFeedbackRevisions.id, h.revisionId))
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          ids.push(event.id)
          return { state: 'retained', reason: 'recipient_waiting' }
        },
      },
      { revisionIds: [h.revisionId] }
    )
    unblock()
    await pending
    expect(new Set(ids).size).toBe(1)
    expect(await h.row()).toMatchObject({
      releaseState: 'retained',
      reason: 'recipient_waiting',
      leaseToken: null,
      attempts: 2,
    })
  } finally {
    unblock?.()
    await pending
    await h.close()
  }
})

test('durable acceptance receipts survive a crash before settlement without another route/send', async () => {
  const h = await fixture()
  try {
    let calls = 0
    const deps: release.GitHubFeedbackReleaseDependencies = {
      authorizeSource: async () => true,
      route: async (event: typeof h.source) => {
        calls++
        await h.queued(event, true)
        await db
          .update(integrationOutputEvents)
          .set({ matchedAt: new Date() })
          .where(eq(integrationOutputEvents.id, event.id))
        throw new Error('crash after durable acceptance')
      },
    }
    expect(await release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })).toBe(1)
    expect((await h.row()).releaseState).toBe('delivered')
    expect(await release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })).toBe(0)
    expect(calls).toBe(1)
  } finally {
    await h.close()
  }
})

test('a successful first target cannot settle incomplete routing or partial acceptance', async () => {
  const h = await fixture()
  try {
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          await h.queued(event, true)
          throw new Error('before remaining targets were persisted')
        },
      },
      { revisionIds: [h.revisionId] }
    )
    expect((await h.row()).releaseState).toBe('retry')
    await h.due()
    await release.releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          await h.queued(event, false)
          await db
            .update(integrationOutputEvents)
            .set({ matchedAt: new Date() })
            .where(eq(integrationOutputEvents.id, event.id))
          return { state: 'retained', reason: 'recipient_waiting' }
        },
      },
      { revisionIds: [h.revisionId] }
    )
    expect((await h.row()).releaseState).toBe('retained')
  } finally {
    await h.close()
  }
})

test('expired crash lease is recovered; obsolete routing is terminal and cannot be revived by retries', async () => {
  const h = await fixture()
  try {
    await db
      .update(githubFeedbackRevisions)
      .set({ leaseToken: crypto.randomUUID(), leaseExpiresAt: new Date(0), attempts: 1 })
      .where(eq(githubFeedbackRevisions.id, h.revisionId))
    let calls = 0
    const deps: release.GitHubFeedbackReleaseDependencies = {
      authorizeSource: async () => true,
      route: async () => {
        calls++
        return { state: 'obsolete' as const, reason: 'routing_changed' }
      },
    }
    expect(await release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })).toBe(1)
    expect(await h.row()).toMatchObject({
      releaseState: 'obsolete',
      attempts: 2,
      leaseToken: null,
      nextAttemptAt: null,
    })
    expect(await release.releaseGitHubFeedback(deps, { revisionIds: [h.revisionId] })).toBe(0)
    expect(calls).toBe(1)
  } finally {
    await h.close()
  }
})
