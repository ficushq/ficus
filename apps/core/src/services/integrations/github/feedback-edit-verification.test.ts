import { expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import type { GitHubEditorVerification } from '@ficus/shared'
import { db, squads, integrationOutputEvents, githubFeedbackRevisions, githubTrustedAuthors } from '../../../db'
import { githubOutputAdapter } from '../outputs/github'
import type { VerifiedIngressEvent } from '../types'
import { GitHubApiUnavailableError } from '../../github/api-client'
import { captureRelevantGitHubFeedback } from './feedback-admission'
import { isTrustedGitHubFeedbackContent } from './feedback-trust'
import type { GitHubEditHistoryTarget } from './feedback-edit-history'

/**
 * Regression tests for trusted GitHub authors held as "unknown_editor" (polled reviews, auto-merge
 * actions) and for verifying every editor of edited content from GitHub's edit history.
 */

const noah = { id: 11, login: 'noahsaso', type: 'User' }
const agent = { id: 22, login: 'ficusagent', type: 'User' }
const outsider = { id: 33, login: 'outsider', type: 'User' }
const actionsBot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }
const identity = (user: { id: number; login: string; type: string }) => ({
  accountId: String(user.id),
  login: user.login,
  accountType: user.type as 'User' | 'Bot',
})
const submittedAt = '2026-10-16T17:00:00Z'
const repository = { id: 10, full_name: 'ficushq/ficus' }
const pullRequest = {
  id: 700,
  node_id: 'PR_node',
  number: 602,
  title: 'Fix things',
  body: 'Description',
  user: agent,
  state: 'open',
  created_at: '2026-10-16T16:00:00Z',
  updated_at: '2026-10-16T17:00:05Z',
  head: { sha: 'a'.repeat(40) },
}

function review(kind: 'webhook' | 'poll', body = 'Looks good', user = noah): VerifiedIngressEvent {
  return {
    type: 'pull_request_review',
    githubObservation: kind === 'webhook' ? { kind, deliveryId: `review-${body}` } : { kind },
    ...(kind === 'poll' ? { metadata: { synthetic: true } } : {}),
    payload: {
      action: 'submitted',
      repository,
      pull_request: pullRequest,
      sender: user,
      review: { id: 900, node_id: 'PRR_node', user, body, state: 'approved', submitted_at: submittedAt },
    },
  }
}
function comment(
  action: 'created' | 'edited',
  body: string,
  sender = noah,
  user = noah,
  kind: 'webhook' | 'poll' = 'webhook'
): VerifiedIngressEvent {
  return {
    type: 'issue_comment',
    githubObservation: kind === 'webhook' ? { kind, deliveryId: `comment-${action}-${body}` } : { kind },
    payload: {
      action,
      repository,
      sender,
      issue: { id: 701, number: 602, title: 'T', body: 'B', updated_at: submittedAt, pull_request: {} },
      comment: {
        id: 950,
        node_id: 'IC_node',
        user,
        body,
        created_at: submittedAt,
        updated_at: action === 'edited' ? '2026-10-16T17:05:00Z' : submittedAt,
      },
    },
  }
}

async function fixture() {
  const squadId = crypto.randomUUID()
  const eventIds: string[] = []
  await db.insert(squads).values({ id: squadId, name: 'Edit verification', purpose: 'Test' })
  for (const user of [noah, agent])
    await db.insert(githubTrustedAuthors).values({
      squadId,
      accountId: String(user.id),
      login: user.login,
      accountType: 'User',
      addedByUserId: crypto.randomUUID(),
    })
  const calls: GitHubEditHistoryTarget[] = []
  return {
    squadId,
    calls,
    async capture(
      input: VerifiedIngressEvent,
      history: GitHubEditorVerification | null | Error = { attribution: 'creation', editor: null, editors: [] }
    ) {
      const fact = githubOutputAdapter.normalize(input)[0]!
      const [row] = await db
        .insert(integrationOutputEvents)
        .values({
          integration: 'github',
          sourceKey: crypto.randomUUID(),
          eventKey: fact.eventKey,
          authority: { kind: 'connection', squadId, connectionId: crypto.randomUUID(), connectionRevision: 'r1' },
          fact,
        })
        .returning()
      eventIds.push(row!.id)
      return captureRelevantGitHubFeedback(row!, {
        authorizeSource: async () => true,
        // The text is current: a conflict witness never decides these cases.
        readCurrent: async (_event, content) => ({ contentHash: content.contentHash }),
        verifyEditors: async (_event, target) => {
          calls.push(target)
          if (history instanceof Error) throw history
          return history
        },
      })
    },
    async close() {
      await db.delete(squads).where(eq(squads.id, squadId))
      await db.delete(integrationOutputEvents).where(inArray(integrationOutputEvents.id, eventIds))
    },
  }
}

test('a polled review by a trusted author is verified as never edited and delivered automatically', async () => {
  const h = await fixture()
  try {
    const captured = await h.capture(review('poll'))
    expect(captured.revision).toMatchObject({
      decision: 'automatic',
      reason: 'trusted_author',
      attribution: 'creation',
      releaseState: 'ready',
    })
    expect(captured.revision.author).toEqual(identity(noah))
    // One bounded history read, bound to the exact captured object and text.
    expect(h.calls).toEqual([
      {
        capturedSource: 'poll',
        nodeId: 'PRR_node',
        objectKind: 'review',
        nativeId: '900',
        repositoryId: '10',
        author: identity(noah),
        body: 'Looks good',
      },
    ])
  } finally {
    await h.close()
  }
})

test('missing, unverifiable or failed edit history keeps a polled review held', async () => {
  const h = await fixture()
  try {
    const held = await h.capture(review('poll', 'Unverifiable'), null)
    expect(held.revision).toMatchObject({ decision: 'pending', reason: 'unknown_editor', attribution: 'unknown' })
    // An ordinary provider error is uncertainty: held.
    const failed = await h.capture(review('poll', 'Errored'), new Error('boom'))
    expect(failed.revision).toMatchObject({ decision: 'pending', reason: 'unknown_editor' })
    // GitHub not answering at all defers the capture: nothing is written.
    const before = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    await expect(h.capture(review('poll', 'Outage'), new GitHubApiUnavailableError('http_502'))).rejects.toThrow(
      'feedback_provider_unavailable'
    )
    const after = await db.select().from(githubFeedbackRevisions).where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(after).toHaveLength(before.length)
  } finally {
    await h.close()
  }
})

test('auto_merge_enabled by a trusted account is a delivered status action without title or body', async () => {
  const h = await fixture()
  const autoMerge = (deliveryId: string, user = agent): VerifiedIngressEvent => ({
    type: 'pull_request',
    githubObservation: { kind: 'webhook', deliveryId },
    payload: {
      action: 'auto_merge_enabled',
      repository,
      sender: agent,
      pull_request: { ...pullRequest, user, auto_merge: { merge_method: 'squash' } },
    },
  })
  try {
    // The PR description was edited since creation and its history cannot be verified: facts only.
    const captured = await h.capture(autoMerge('auto-merge'), null)
    expect(captured.revision).toMatchObject({ decision: 'automatic', attribution: 'creation' })
    expect(captured.revision.author).toEqual(identity(agent))
    expect(captured.revision.envelope!.data).toMatchObject({ action: 'auto_merge_enabled', mergeMethod: 'squash' })
    expect(JSON.stringify(captured.revision.envelope)).not.toContain('Description')
    expect(h.calls).toMatchObject([{ objectKind: 'pull_request', nodeId: 'PR_node', title: 'Fix things' }])
  } finally {
    await h.close()
  }
})

test('parent text is quoted only when its trusted author provably wrote it, by the verified history', async () => {
  const h = await fixture()
  const autoMerge = (deliveryId: string, prUpdatedAt: string): VerifiedIngressEvent => ({
    type: 'pull_request',
    githubObservation: { kind: 'webhook', deliveryId },
    payload: {
      action: 'auto_merge_enabled',
      repository,
      sender: agent,
      pull_request: { ...pullRequest, updated_at: prUpdatedAt },
    },
  })
  try {
    const own = await h.capture(autoMerge('own', '2026-10-16T17:00:06Z'), {
      attribution: 'verified_edit',
      editor: identity(agent),
      editors: [identity(agent)],
    })
    expect(own.revision.envelope!.data.parentContent).toMatchObject({ body: 'Description', title: 'Fix things' })
    // Edited by someone else (even someone trusted): the text is not the author's, so facts only.
    const shared = await h.capture(autoMerge('shared', '2026-10-16T17:00:07Z'), {
      attribution: 'verified_edit',
      editor: identity(noah),
      editors: [identity(agent), identity(noah)],
    })
    expect(shared.revision.envelope!.data.parentContent).toBeUndefined()
    expect(shared.revision.decision).toBe('automatic')
  } finally {
    await h.close()
  }
})

test('an author self-edit and an edit by another trusted user are delivered; every editor is bound', async () => {
  const h = await fixture()
  try {
    const self = await h.capture(comment('edited', 'Self edit', noah), {
      attribution: 'verified_edit',
      editor: identity(noah),
      editors: [identity(noah)],
    })
    expect(self.revision).toMatchObject({ decision: 'automatic', attribution: 'verified_edit' })
    expect(self.revision.envelope!.data.editors).toEqual([identity(noah)])
    // The signed sender is passed on as an editor to verify, never trusted by itself.
    expect(h.calls.at(-1)).toMatchObject({ objectKind: 'issue_comment', editedBy: identity(noah) })

    const other = await h.capture(comment('edited', 'Edited by the agent', agent), {
      attribution: 'verified_edit',
      editor: identity(agent),
      editors: [identity(noah), identity(agent)],
    })
    expect(other.revision.id).not.toBe(self.revision.id)
    expect(other.revision).toMatchObject({ decision: 'automatic', attribution: 'verified_edit' })
    expect(other.revision.editor).toEqual(identity(agent))
  } finally {
    await h.close()
  }
})

test('an edit by an untrusted user stays held even though the author is trusted', async () => {
  const h = await fixture()
  try {
    const captured = await h.capture(comment('edited', 'Injected', outsider), {
      attribution: 'verified_edit',
      editor: identity(outsider),
      editors: [identity(noah), identity(outsider)],
    })
    expect(captured.revision).toMatchObject({ decision: 'pending', reason: 'untrusted_editor', releaseState: 'held' })
    // A trusted last editor does not vouch for an untrusted editor earlier in the history.
    const laundered = await h.capture(comment('edited', 'Touched up', noah), {
      attribution: 'verified_edit',
      editor: identity(noah),
      editors: [identity(noah), identity(outsider)],
    })
    expect(laundered.revision).toMatchObject({ decision: 'pending', reason: 'untrusted_editor' })
    expect(await isTrustedGitHubFeedbackContent(db, h.squadId, laundered.revision)).toBe(false)
  } finally {
    await h.close()
  }
})

test('removing trust from any editor revokes an automatic verified edit at the live recheck', async () => {
  const h = await fixture()
  try {
    const captured = await h.capture(comment('edited', 'Edited by the agent', agent), {
      attribution: 'verified_edit',
      editor: identity(agent),
      editors: [identity(noah), identity(agent)],
    })
    expect(captured.revision.decision).toBe('automatic')
    expect(await isTrustedGitHubFeedbackContent(db, h.squadId, captured.revision)).toBe(true)
    // The last editor stays trusted; only the earlier co-editor loses trust.
    await db.delete(githubTrustedAuthors).where(eq(githubTrustedAuthors.accountId, String(noah.id)))
    await db.insert(githubTrustedAuthors).values({
      squadId: h.squadId,
      accountId: String(outsider.id),
      login: outsider.login,
      accountType: 'User',
      addedByUserId: crypto.randomUUID(),
    })
    const coEdited = { ...captured.revision, author: identity(outsider) }
    expect(await isTrustedGitHubFeedbackContent(db, h.squadId, coEdited)).toBe(false)
  } finally {
    await h.close()
  }
})

test('an untrusted bot comment is still held as untrusted, with no history read', async () => {
  const h = await fixture()
  try {
    const captured = await h.capture(comment('created', 'CI report', actionsBot, actionsBot))
    expect(captured.revision).toMatchObject({
      decision: 'pending',
      reason: 'untrusted_author',
      attribution: 'creation',
    })
    // Untrusted authors cost no provider requests: their content is held either way.
    const polled = await h.capture(review('poll', 'Bot review', outsider))
    expect(polled.revision).toMatchObject({ decision: 'pending' })
    expect(h.calls).toEqual([])
  } finally {
    await h.close()
  }
})

test('poll and webhook observations of the same review are one revision; replays read no history', async () => {
  const h = await fixture()
  try {
    const webhook = await h.capture(review('webhook'))
    expect(webhook.revision.decision).toBe('automatic')
    expect(h.calls).toEqual([])
    // The poller saw the same review late: a replay of the delivered revision, never a held copy.
    const poll = await h.capture(review('poll'))
    expect(poll.disposition).toBe('replay')
    expect(poll.revision.id).toBe(webhook.revision.id)
    const again = await h.capture(review('poll'))
    expect(again.revision.id).toBe(webhook.revision.id)
    expect(h.calls).toEqual([])
    const revisions = await db
      .select()
      .from(githubFeedbackRevisions)
      .where(eq(githubFeedbackRevisions.squadId, h.squadId))
    expect(revisions).toHaveLength(1)

    // Poll first, then webhook: also one delivered revision.
    const first = await h.capture(review('poll', 'Polled first'))
    expect(first.revision.decision).toBe('automatic')
    const late = await h.capture(review('webhook', 'Polled first'))
    expect(late.revision.id).toBe(first.revision.id)
  } finally {
    await h.close()
  }
})

test('a later edit is a new version, verified again on its own history', async () => {
  const h = await fixture()
  try {
    const first = await h.capture(comment('edited', 'Version 1', noah), {
      attribution: 'verified_edit',
      editor: identity(noah),
      editors: [identity(noah)],
    })
    expect(first.revision.decision).toBe('automatic')
    const second = await h.capture(comment('edited', 'Version 2', outsider), {
      attribution: 'verified_edit',
      editor: identity(outsider),
      editors: [identity(noah), identity(outsider)],
    })
    expect(second.revision.id).not.toBe(first.revision.id)
    expect(second.revision).toMatchObject({ decision: 'pending', reason: 'untrusted_editor' })
    expect(h.calls.map((call) => call.body)).toEqual(['Version 1', 'Version 2'])
  } finally {
    await h.close()
  }
})

test('trusted poll author with contradictory empty edit history remains held as unknown_editor', async () => {
  const { decideGitHubEditors } = await import('./feedback-edit-history')
  const h = await fixture()
  try {
    const verified = decideGitHubEditors(
      {
        nodeId: 'PRR_node',
        objectKind: 'review',
        nativeId: '900',
        repositoryId: '10',
        author: identity(noah),
        body: 'Captured X',
        capturedSource: 'poll',
      },
      {
        node: {
          __typename: 'PullRequestReview',
          databaseId: 900,
          repository: { databaseId: 10 },
          author: { __typename: 'User', databaseId: noah.id, login: noah.login },
          body: 'Current Y',
          lastEditedAt: null,
          editor: null,
          userContentEdits: { totalCount: 0, nodes: [] },
        },
      }
    )
    expect(verified).toBeNull()
    const result = await h.capture(review('poll', 'Captured X'), verified)
    expect(result.revision.decision).toBe('pending')
    expect(result.revision.reason).toBe('unknown_editor')
    expect(result.revision.attribution).toBe('unknown')
  } finally {
    await h.close()
  }
})
