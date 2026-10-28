import { expect, test } from 'bun:test'
import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
import { eq, inArray } from 'drizzle-orm'
import {
  db,
  squads,
  agents,
  inbox,
  executions,
  messages,
  chatSendReceipts,
  githubFeedbackRevisions,
  githubTrustedAuthors,
  integrationOutputEvents,
  integrationOutputDeliveries,
  workStreams,
  workStreamFlowRuns,
} from '../../../db'
import type { VerifiedIngressEvent } from '../types'
import { githubOutputAdapter } from '../outputs/github'
import { captureRelevantGitHubFeedback, isGitHubFeedbackAdmitted } from './feedback-admission'
import { captureGitHubFeedback, recordCanonicalGitHubFeedback } from './feedback-store'
import { decideGitHubEditors } from './feedback-edit-history'
import { lockGitHubOutputAuthority } from './feedback-routing'
import { releaseGitHubFeedback } from './feedback-release'

const bot = { id: 49699333, login: 'dependabot[bot]', type: 'Bot' }
const actor = { __typename: 'Bot', databaseId: bot.id, login: 'dependabot' }
const banner = 'Dependabot is rebasing this PR\n\nDependency update'
const final = 'Dependency update'
const clock = (second: number) => `2026-10-28T04:03:${String(second).padStart(2, '0')}Z`
function observation(
  body: string,
  second: number,
  action = 'edited',
  kind: 'webhook' | 'poll' = 'webhook'
): VerifiedIngressEvent {
  return {
    type: 'pull_request',
    githubObservation: kind === 'webhook' ? { kind, deliveryId: crypto.randomUUID() } : { kind },
    payload: {
      action,
      repository: { id: 10, full_name: 'ficushq/ficus' },
      sender: bot,
      pull_request: {
        id: 700,
        node_id: 'PR_node',
        number: 699,
        title: 'Bump dependency',
        body,
        user: bot,
        created_at: '2026-10-27T00:00:00Z',
        updated_at: clock(second),
      },
    },
  }
}
const history = {
  node: {
    __typename: 'PullRequest',
    databaseId: 700,
    repository: { databaseId: 10 },
    author: actor,
    body: final,
    title: 'Bump dependency',
    lastEditedAt: clock(41),
    editor: actor,
    userContentEdits: { totalCount: 2, nodes: [{ editor: actor }, { editor: actor }] },
    renames: { pageInfo: { hasNextPage: false }, nodes: [] },
  },
}
async function fixture() {
  const squadId = crypto.randomUUID()
  const ids: string[] = []
  await db.insert(squads).values({ id: squadId, name: 'Delayed rebase', purpose: 'Synthetic regression' })
  await db.insert(githubTrustedAuthors).values({
    squadId,
    accountId: String(bot.id),
    login: bot.login,
    accountType: 'Bot',
    addedByUserId: crypto.randomUUID(),
  })
  const [agent] = await db.insert(agents).values({ squadId, agentTypeId: 'feedback-test' }).returning()
  return {
    squadId,
    async capture(input: VerifiedIngressEvent, response: unknown = history) {
      const fact = githubOutputAdapter.normalize(input)[0]!
      const [event] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: fact.eventKey,
          authority: { kind: 'connection', squadId, connectionId: crypto.randomUUID(), connectionRevision: 'r1' },
          fact,
        })
        .returning()
      ids.push(event!.id)
      const captured = await captureRelevantGitHubFeedback(event!, {
        authorizeSource: async () => true,
        readCurrent: async (_event, content) => ({ contentHash: content.contentHash }),
        verifyEditors: async (_event, target) => decideGitHubEditors(target, response),
      })
      return { ...captured, event: event! }
    },
    async row(id: string) {
      return (await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.id, id)))[0]!
    },
    async accept(event: typeof integrationOutputEvents.$inferSelect) {
      return db.transaction(async (tx) => {
        await lockGitHubOutputAuthority(tx, event)
        // Exercise release settlement against real durable agent queue acceptance, not enqueue alone.
        expect(await isGitHubFeedbackAdmitted(tx, event)).toBe(true)
        const [notice] = await tx
          .insert(inbox)
          .values({
            recipientType: 'agent',
            recipientId: agent!.id,
            senderType: 'system',
            subject: 'Feedback',
            content: event.fact.body!,
            deliveredAt: new Date(),
            metadata: { integrationEventId: event.id },
          })
          .returning()
        const [execution] = await tx.insert(executions).values({ agentId: agent!.id }).returning()
        const [message] = await tx
          .insert(messages)
          .values({ agentId: agent!.id, role: 'human', content: event.fact.body! })
          .returning()
        await tx.insert(chatSendReceipts).values({
          agentId: agent!.id,
          clientId: `github-feedback:${event.id}:${notice!.id}`,
          requestHash: 'a'.repeat(64),
          state: 'accepted',
          messageId: message!.id,
          executionId: execution!.id,
          acceptedAt: new Date(),
          disposition: 'turn',
        })
        await tx
          .update(integrationOutputEvents)
          .set({ matchedAt: new Date() })
          .where(eq(integrationOutputEvents.id, event.id))
      })
    },
    async received() {
      return db.select().from(messages).where(eq(messages.agentId, agent!.id))
    },
    async close() {
      const canonical = await db
        .select({ id: integrationOutputEvents.id })
        .from(integrationOutputEvents)
        .where(
          inArray(
            integrationOutputEvents.sourceKey,
            (
              await db
                .select({ id: githubFeedbackRevisions.id })
                .from(githubFeedbackRevisions)
                .where(eq(githubFeedbackRevisions.squadId, squadId))
            ).map(({ id }) => `github-feedback:${squadId}:${id}`)
          )
        )
      ids.push(...canonical.map(({ id }) => id))
      await db.delete(inbox).where(eq(inbox.recipientId, agent!.id))
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, ids))
    },
  }
}

test.each(['webhook', 'poll'] as const)(
  'delayed Dependabot %s banner edit, synchronize and removal deliver only final text',
  async (kind) => {
    const h = await fixture()
    try {
      // Every capture happens AFTER removal; every history query sees the final body.
      const edit = await h.capture(observation(banner, 20, 'edited', kind))
      expect(edit.revision.attribution).toBe('verified_edit')
      const synchronize = await h.capture(observation(banner, 37, 'synchronize', kind))
      const removal = await h.capture(observation(final, 41, 'edited', kind))
      expect((await h.row(edit.revision.id)).releaseState).toBe('obsolete')
      expect((await h.row(synchronize.revision.id)).releaseState).toBe('obsolete')
      const delivered: string[] = []
      await releaseGitHubFeedback(
        {
          authorizeSource: async () => true,
          route: async (event) => {
            delivered.push(event.fact.body!)
            await h.accept(event)
          },
        },
        { revisionIds: [...new Set([edit.revision.id, synchronize.revision.id, removal.revision.id])] }
      )
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).not.toContain('rebasing')
      expect((await h.row(removal.revision.id)).releaseState).toBe('delivered')
      const rows = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
      expect(rows.filter((r) => r.decision === 'pending' && r.releaseState !== 'obsolete')).toHaveLength(0)
    } finally {
      await h.close()
    }
  }
)

test('an untrusted past editor in complete current history still holds authentic stale text', async () => {
  const h = await fixture()
  try {
    const outside = { __typename: 'User', databaseId: 33, login: 'outsider' }
    const result = await h.capture(observation(banner, 20), {
      node: {
        ...history.node,
        userContentEdits: { totalCount: 3, nodes: [{ editor: actor }, { editor: outside }, { editor: actor }] },
      },
    })
    expect(result.revision).toMatchObject({
      attribution: 'verified_edit',
      decision: 'pending',
      reason: 'untrusted_editor',
      releaseState: 'held',
    })
  } finally {
    await h.close()
  }
})

test('a newer capture during release preparation revokes the lease and canonical admission', async () => {
  const h = await fixture()
  try {
    const old = await h.capture(observation(final, 20))
    const canonical = await recordCanonicalGitHubFeedback(old.revision.id, old.event.id, async () => true)
    let routed = 0
    let captured = false
    await releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        prepareSource: async () => {
          if (!captured) {
            captured = true
            await h.capture(observation('Newest', 41), { node: { ...history.node, body: 'Newest' } })
          }
          return true
        },
        route: async () => {
          routed++
        },
      },
      { revisionIds: [old.revision.id] }
    )
    expect(routed).toBe(0)
    expect(await isGitHubFeedbackAdmitted(db, canonical)).toBe(false)
    expect(await h.row(old.revision.id)).toMatchObject({
      releaseState: 'obsolete',
      leaseToken: null,
      nextAttemptAt: null,
    })
    await expect(recordCanonicalGitHubFeedback(old.revision.id, old.event.id, async () => true)).rejects.toThrow(
      'feedback_not_admitted'
    )
  } finally {
    await h.close()
  }
})

test('out-of-order capture behind a delivered newer revision is immediately obsolete', async () => {
  const h = await fixture()
  try {
    const newest = await h.capture(observation(final, 41))
    await releaseGitHubFeedback(
      { authorizeSource: async () => true, route: (event) => h.accept(event) },
      { revisionIds: [newest.revision.id] }
    )
    const old = await h.capture(observation(banner, 20))
    expect(old.revision.releaseState).toBe('obsolete')
    expect((await h.row(newest.revision.id)).releaseState).toBe('delivered')
    const replay = await captureGitHubFeedback(old.event.id, { authorizeSource: async () => true })
    expect(replay.revision.id).toBe(old.revision.id)
    expect(replay.revision.releaseState).toBe('obsolete')
  } finally {
    await h.close()
  }
})

test('capture after routing preflight but before final acceptance fences outdated agent text', async () => {
  const h = await fixture()
  try {
    const old = await h.capture(observation(final, 20))
    let attempted = 0
    await releaseGitHubFeedback(
      {
        authorizeSource: async () => true,
        route: async (event) => {
          attempted++
          await h.capture(observation('Newest', 41), { node: { ...history.node, body: 'Newest' } })
          await h.accept(event) // final authority-locked admission refuses the now-obsolete snapshot
        },
      },
      { revisionIds: [old.revision.id] }
    )
    expect(attempted).toBe(1)
    expect(await h.received()).toHaveLength(0)
    expect((await h.row(old.revision.id)).releaseState).toBe('obsolete')
  } finally {
    await h.close()
  }
})

test('obsolescence supersedes unfinished canonical flow deliveries, preserving accepted receipts and raw status', async () => {
  const h = await fixture()
  try {
    const old = await h.capture(observation(final, 20))
    const canonical = await recordCanonicalGitHubFeedback(old.revision.id, old.event.id, async () => true)
    const [stream] = await db
      .insert(workStreams)
      .values({ squadId: h.squadId, title: 'Synthetic audience' })
      .returning()
    const definition = createBlankWorkflow()
    await db.insert(workStreamFlowRuns).values({
      workStreamId: stream!.id,
      source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
      state: createWorkflowRun(definition),
      createdBy: 'test',
      createRequestId: crypto.randomUUID(),
      createRequestHash: 'a'.repeat(64),
    })
    const deliveries = await db
      .insert(integrationOutputDeliveries)
      .values(
        (['pending', 'queued', 'delivered', 'superseded', 'raw'] as const).map((status) => ({
          eventId: status === 'raw' ? old.event.id : canonical.id,
          workStreamId: stream!.id,
          subscriptionId: status,
          subscription: {
            id: status,
            source: { integration: 'github', output: 'pull_request.updated', version: 1 },
            match: {},
            deliver: { to: 'active', whenInactive: 'retain' },
          },
          status: status === 'raw' ? 'pending' : status,
        }))
      )
      .returning()
    await h.capture(observation('Newest', 41), { node: { ...history.node, body: 'Newest' } })
    const rows = await db
      .select()
      .from(integrationOutputDeliveries)
      .where(
        inArray(
          integrationOutputDeliveries.id,
          deliveries.map(({ id }) => id)
        )
      )
    expect(Object.fromEntries(rows.map((row) => [row.subscriptionId, row.status]))).toEqual({
      pending: 'superseded',
      queued: 'superseded',
      delivered: 'delivered',
      superseded: 'superseded',
      raw: 'pending',
    })
  } finally {
    await h.close()
  }
})

test('payload metadata cannot authenticate stale text without verified ingress provenance', async () => {
  const h = await fixture()
  try {
    const input = observation(banner, 20)
    delete input.githubObservation
    input.metadata = { synthetic: true, signed: true, githubObservation: { kind: 'webhook' } }
    const captured = await h.capture(input)
    expect(captured.revision).toMatchObject({ attribution: 'unknown', decision: 'pending', reason: 'unknown_editor' })
  } finally {
    await h.close()
  }
})

test('obsolete parent revisions cannot vouch for quoting the old parent prose in another action', async () => {
  const { isGitHubParentTextAdmissible } = await import('./feedback-parent')
  const h = await fixture()
  try {
    const old = await h.capture(observation(final, 20))
    await h.capture(observation('Newest', 41), { node: { ...history.node, body: 'Newest' } })
    expect(
      await isGitHubParentTextAdmissible(db, h.squadId, {
        objectKind: 'action',
        repositoryId: '10',
        parentText: {
          objectKind: 'pull_request',
          nativeId: '700',
          title: 'Bump dependency',
          body: final,
          author: { accountId: String(bot.id), login: bot.login, accountType: 'Bot' },
          unchanged: false,
          contentHash: old.revision.contentHash,
          byteCount: old.revision.byteCount,
          delivery: old.revision.envelope!,
        },
      })
    ).toBe(false)
  } finally {
    await h.close()
  }
})
