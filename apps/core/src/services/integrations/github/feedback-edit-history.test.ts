import { describe, expect, test } from 'bun:test'
import { GitHubApiUnavailableError } from '../../github/api-client'
import {
  GITHUB_EDIT_HISTORY_LIMIT,
  decideGitHubEditors,
  readGitHubEditorVerification,
  type GitHubEditHistoryTarget,
} from './feedback-edit-history'

const noah = { accountId: '11', login: 'noahsaso', accountType: 'User' as const }
const agent = { accountId: '22', login: 'ficusagent', accountType: 'User' as const }
const actor = (identity: { accountId: string; login: string }, type = 'User') => ({
  __typename: type,
  login: identity.login,
  databaseId: Number(identity.accountId),
})
const review: GitHubEditHistoryTarget = {
  nodeId: 'PRR_node',
  objectKind: 'review',
  nativeId: '900',
  repositoryId: '10',
  author: noah,
  body: 'Looks good',
}
function node(overrides: Record<string, unknown> = {}) {
  return {
    node: {
      __typename: 'PullRequestReview',
      databaseId: 900,
      repository: { databaseId: 10 },
      author: actor(noah),
      body: 'Looks good',
      lastEditedAt: null,
      editor: null,
      userContentEdits: { totalCount: 0, nodes: [] },
      ...overrides,
    },
  }
}
const edited = (...editors: unknown[]) => ({
  lastEditedAt: '2026-10-16T10:00:00Z',
  editor: editors[0],
  userContentEdits: { totalCount: editors.length, nodes: editors.map((editor) => ({ editor })) },
})

describe('decideGitHubEditors', () => {
  test('never edited: creation by the numeric author (a polled review)', () => {
    expect(decideGitHubEditors(review, node())).toEqual({ attribution: 'creation', editor: null, editors: [] })
  })

  test.each(['webhook', 'poll'] as const)(
    'authentic stale %s text uses the complete conservative editor set',
    (capturedSource) => {
      const result = decideGitHubEditors(
        { ...review, capturedSource, body: 'Old captured text', editedBy: agent },
        node(edited(actor(noah)))
      )
      expect(result).toEqual({ attribution: 'verified_edit', editor: agent, editors: [noah, agent] })
    }
  )

  test('authentic stale text still refuses incomplete history and unidentified editors', () => {
    const target = { ...review, capturedSource: 'webhook' as const, body: 'Old' }
    for (const overrides of [
      { databaseId: 901 },
      { repository: { databaseId: 11 } },
      { author: actor(agent) },
      { __typename: 'IssueComment' },
      edited(null),
      edited({ __typename: 'Mannequin', login: 'm' }),
      { userContentEdits: { totalCount: 2, nodes: [{ editor: actor(noah) }] } },
    ])
      expect(decideGitHubEditors(target, node(overrides))).toBeNull()
  })

  test('self-edit and edits by others list every distinct editor, sorted by numeric ID', () => {
    expect(decideGitHubEditors(review, node(edited(actor(noah), actor(noah))))).toEqual({
      attribution: 'verified_edit',
      editor: noah,
      editors: [noah],
    })
    expect(decideGitHubEditors(review, node(edited(actor(agent), actor(noah))))).toEqual({
      attribution: 'verified_edit',
      editor: agent,
      editors: [noah, agent],
    })
  })

  test('the signed webhook sender of an edit is always one of the editors', () => {
    const outsider = { accountId: '33', login: 'outsider', accountType: 'User' as const }
    const result = decideGitHubEditors({ ...review, editedBy: outsider }, node(edited(actor(noah))))
    expect(result).toMatchObject({ attribution: 'verified_edit', editor: outsider })
    expect(result!.editors.map((editor) => editor.accountId)).toEqual(['11', '33'])
  })

  test('a bot editor is identified by numeric ID with its REST login', () => {
    const result = decideGitHubEditors(review, node(edited(actor({ accountId: '41', login: 'github-actions' }, 'Bot'))))
    expect(result!.editors).toEqual([{ accountId: '41', login: 'github-actions[bot]', accountType: 'Bot' }])
  })

  test('fails closed on anything that does not prove the captured version', () => {
    const cases: Array<[string, GitHubEditHistoryTarget, unknown]> = [
      ['different text (a later edit)', review, node({ body: 'Changed' })],
      ['different native object', review, node({ databaseId: 901 })],
      ['different repository', review, node({ repository: { databaseId: 11 } })],
      ['different author', review, node({ author: actor(agent) })],
      ['different kind', review, node({ __typename: 'IssueComment' })],
      ['deleted (ghost) editor', review, node(edited(null))],
      ['mannequin editor', review, node(edited({ __typename: 'Mannequin', login: 'm' }))],
      ['edited flag without a known editor', review, node({ lastEditedAt: '2026-10-16T10:00:00Z', editor: null })],
      [
        'truncated history',
        review,
        node({
          lastEditedAt: '2026-10-16T10:00:00Z',
          editor: actor(noah),
          userContentEdits: { totalCount: GITHUB_EDIT_HISTORY_LIMIT + 1, nodes: [{ editor: actor(noah) }] },
        }),
      ],
      ['missing history', review, node({ userContentEdits: null })],
      ['no node', review, { node: null }],
    ]
    for (const [, target, response] of cases) expect(decideGitHubEditors(target, response)).toBeNull()
  })

  test('issue and pull request titles: renames are edits, and the title must match', () => {
    const pr: GitHubEditHistoryTarget = {
      ...review,
      objectKind: 'pull_request',
      nodeId: 'PR_node',
      nativeId: '700',
      title: 'Title',
      body: 'Body',
    }
    const base = {
      __typename: 'PullRequest',
      databaseId: 700,
      body: 'Body',
      title: 'Title',
      renames: { pageInfo: { hasNextPage: false }, nodes: [] },
    }
    expect(decideGitHubEditors(pr, node(base))).toEqual({ attribution: 'creation', editor: null, editors: [] })
    expect(
      decideGitHubEditors(
        pr,
        node({ ...base, renames: { pageInfo: { hasNextPage: false }, nodes: [{ actor: actor(agent) }] } })
      )
    ).toEqual({ attribution: 'verified_edit', editor: agent, editors: [agent] })
    expect(decideGitHubEditors(pr, node({ ...base, title: 'Other' }))).toBeNull()
    expect(
      decideGitHubEditors(pr, node({ ...base, renames: { pageInfo: { hasNextPage: true }, nodes: [] } }))
    ).toBeNull()
  })

  test.each(['issue', 'pull_request'] as const)(
    '%s: a complete filtered rename history ignores the unfiltered timeline count',
    (objectKind) => {
      const target: GitHubEditHistoryTarget = { ...review, objectKind, title: 'Title' }
      const parent = {
        __typename: objectKind === 'issue' ? 'Issue' : 'PullRequest',
        title: 'Title',
        ...edited(actor(agent)),
      }
      // GitHub returned totalCount=112 but no rename nodes for the affected PR.
      // That count includes ordinary timeline events, even with itemTypes filtering.
      for (const nodes of [[], [{ actor: actor(agent) }, { actor: actor(noah) }]]) {
        expect(
          decideGitHubEditors(
            target,
            node({ ...parent, renames: { totalCount: 112, pageInfo: { hasNextPage: false }, nodes } })
          )
        ).toEqual({
          attribution: 'verified_edit',
          editor: agent,
          editors: nodes.length ? [noah, agent] : [agent],
        })
      }
    }
  )

  test('filtered rename history still fails closed on truncation, missing pagination or unknown actors', () => {
    const target: GitHubEditHistoryTarget = { ...review, objectKind: 'pull_request', title: 'Title' }
    for (const renames of [
      null,
      { nodes: [] },
      { pageInfo: {}, nodes: [] },
      { pageInfo: { hasNextPage: null }, nodes: [] },
      { pageInfo: { hasNextPage: 'false' }, nodes: [] },
      { pageInfo: { hasNextPage: false } },
      { totalCount: 1, pageInfo: { hasNextPage: true }, nodes: [{ actor: actor(agent) }] },
      { pageInfo: { hasNextPage: false }, nodes: [null] },
      { pageInfo: { hasNextPage: false }, nodes: [{ actor: null }] },
    ]) {
      expect(decideGitHubEditors(target, node({ __typename: 'PullRequest', title: 'Title', renames }))).toBeNull()
    }
  })
})

describe('readGitHubEditorVerification', () => {
  const authority = { kind: 'connection' as const, connectionId: 'c', connectionRevision: 'r1', squadId: 's' }
  test('one query through the squad connection; a refusal is null, an outage throws to defer', async () => {
    const calls: unknown[] = []
    const answer = await readGitHubEditorVerification(authority, review, async (_query, variables, squadId, id) => {
      calls.push([variables, squadId, id])
      return node() as never
    })
    expect(answer).toEqual({ attribution: 'creation', editor: null, editors: [] })
    expect(calls).toEqual([[{ id: 'PRR_node' }, 's', 'c']])
    expect(await readGitHubEditorVerification(authority, review, async () => null)).toBeNull()
    await expect(
      readGitHubEditorVerification(authority, review, async () => {
        throw new GitHubApiUnavailableError('http_502')
      })
    ).rejects.toBeInstanceOf(GitHubApiUnavailableError)
  })
})

test('authentic stale poll text contradicting a complete empty history is not a verified edit', () => {
  expect(
    decideGitHubEditors({ ...review, capturedSource: 'poll', body: 'Captured X' }, node({ body: 'Current Y' }))
  ).toBeNull()
})
