import { describe, expect, test } from 'bun:test'
import { GitHubApiUnavailableError } from '../github/api-client'
import {
  buildCommitsQuery,
  collectGitHubActivity,
  contributionsWindow,
  DerivationError,
  MAX_PAGES,
  USER_ACTIVITY_QUERY,
  type GraphqlFn,
} from './github-activity'

const repo = (nameWithOwner = 'acme/api', isPrivate = false) => ({ nameWithOwner, isPrivate })
const page = <T>(nodes: T[], hasNextPage = false, endCursor: string | null = null) => ({
  pageInfo: { hasNextPage, endCursor },
  nodes,
})
const pr = (createdAt: string, repository = repo()) => ({
  createdAt,
  title: 'Title',
  body: 'Body text here.',
  repository,
})
const comment = (createdAt: string, repository = repo()) => ({
  createdAt,
  updatedAt: createdAt,
  body: 'A comment.',
  repository,
})

function userData(over: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'U_1',
      pullRequests: page([pr('2026-05-01T00:00:00Z')]),
      issueComments: page([comment('2026-05-02T00:00:00Z')]),
      contributionsCollection: {
        pullRequestReviewContributions: {
          nodes: [
            {
              pullRequestReview: {
                createdAt: '2026-05-03T00:00:00Z',
                body: 'Review body.',
                comments: { nodes: [{ body: 'Inline note.' }] },
                repository: repo(),
              },
            },
          ],
        },
        commitContributionsByRepository: [{ repository: repo() }, { repository: repo('acme/skip') }],
      },
      ...over,
    },
  }
}

function fakeGraphql(responses: Array<unknown | ((variables: Record<string, unknown>) => unknown)>) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const graphql: GraphqlFn = async <T>(query: string, variables: Record<string, unknown>) => {
    calls.push({ query, variables })
    const next = responses[calls.length - 1]
    return (typeof next === 'function' ? next(variables) : next) as T
  }
  return { calls, graphql }
}

const commitsData = {
  r0: {
    nameWithOwner: 'acme/api',
    isPrivate: false,
    defaultBranchRef: {
      target: {
        history: { nodes: [{ committedDate: '2026-05-04T00:00:00Z', messageHeadline: 'fix: x', messageBody: 'Why.' }] },
      },
    },
  },
}

describe('collectGitHubActivity', () => {
  test('one user request and one commits request when nothing needs paging', async () => {
    const { calls, graphql } = fakeGraphql([userData(), commitsData])
    const result = await collectGitHubActivity(
      {
        squadId: 's',
        login: 'octo',
        filters: { excludeRepositories: ['acme/skip'] },
        now: new Date('2026-06-01T00:00:00Z'),
      },
      { graphql }
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]!.query).toBe(USER_ACTIVITY_QUERY)
    expect(calls[0]!.variables).toMatchObject({
      login: 'octo',
      from: '2025-06-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
    })
    expect(calls[1]!.query).toContain('r0: repository(owner: "acme", name: "api")')
    expect(calls[1]!.query).not.toContain('acme/skip')
    expect(calls[1]!.variables).toEqual({ userId: 'U_1', since: null, until: null })
    expect(result.items.map((i) => i.surface).sort()).toEqual([
      'commits',
      'issue-comments',
      'pull-requests',
      'reviews',
      'reviews',
    ])
    expect(result.requests).toBe(2)
  })

  test('date and repository filters drop items and are counted', async () => {
    const data = userData({
      pullRequests: page([
        pr('2026-05-01T00:00:00Z'),
        pr('2025-01-01T00:00:00Z'),
        pr('2026-04-01T00:00:00Z', repo('other/x')),
      ]),
    })
    const { graphql } = fakeGraphql([data, commitsData])
    const result = await collectGitHubActivity(
      {
        squadId: 's',
        login: 'octo',
        filters: { after: '2026-01-01', repositories: ['acme/api'], surfaces: ['pull-requests'] },
      },
      { graphql }
    )
    expect(result.items).toHaveLength(1)
    expect(result.droppedByFilter).toEqual({ date: 1, repository: 1 })
  })

  test('pages pull requests until the before boundary yields enough, and caps at four pages', async () => {
    const newer = Array.from({ length: 40 }, () => pr('2026-09-01T00:00:00Z'))
    const pageWith = (cursor: string) => ({ user: { pullRequests: page(newer, true, cursor) } })
    const { calls, graphql } = fakeGraphql([
      userData({ pullRequests: page(newer, true, 'c1') }),
      pageWith('c2'),
      pageWith('c3'),
      pageWith('c4'),
    ])
    const result = await collectGitHubActivity(
      { squadId: 's', login: 'octo', filters: { before: '2026-03-01', surfaces: ['pull-requests'] } },
      { graphql }
    )
    expect(calls).toHaveLength(MAX_PAGES)
    expect(calls[1]!.variables).toEqual({ login: 'octo', prCursor: 'c1' })
    expect(result.pagingCapped).toBe(true)
    expect(result.items).toHaveLength(0)
    expect(result.droppedByFilter.date).toBe(160)
  })

  test('stops paging comments once a page reaches back before the after date', async () => {
    const { calls, graphql } = fakeGraphql([
      userData({ issueComments: page([comment('2026-05-01T00:00:00Z'), comment('2025-12-01T00:00:00Z')], true, 'c1') }),
    ])
    const result = await collectGitHubActivity(
      { squadId: 's', login: 'octo', filters: { after: '2026-01-01', surfaces: ['issue-comments'] } },
      { graphql }
    )
    expect(calls).toHaveLength(1)
    expect(result.pagingCapped).toBe(false)
  })

  test('keeps partial data: a missing repository is reported and the other commits are kept', async () => {
    const partialCommits = { ...commitsData, r1: null }
    const { graphql } = fakeGraphql([userData({ contributionsCollection: null, issueComments: null }), partialCommits])
    const result = await collectGitHubActivity(
      { squadId: 's', login: 'octo', filters: { repositories: ['acme/api', 'acme/typo'] } },
      { graphql }
    )
    expect(result.unavailableRepositories).toEqual(['acme/typo'])
    expect(result.items.map((i) => i.surface).sort()).toEqual(['commits', 'pull-requests'])
  })

  test('a repository filter longer than the commit limit reports the repositories not read for commits', async () => {
    const repos = Array.from({ length: 10 }, (_, i) => `acme/r${i}`)
    const { calls, graphql } = fakeGraphql([userData(), {}])
    const result = await collectGitHubActivity(
      { squadId: 's', login: 'octo', filters: { repositories: repos, surfaces: ['commits'] } },
      { graphql }
    )
    expect(calls[1]!.query).toContain('r7: repository(owner: "acme", name: "r7")')
    expect(calls[1]!.query).not.toContain('"r8"')
    expect(result.commitRepositoriesNotSampled).toEqual(['acme/r8', 'acme/r9'])
  })

  test('a login the token cannot see, and an unavailable API, map to derivation errors', async () => {
    await expect(
      collectGitHubActivity({ squadId: 's', login: 'ghost', filters: {} }, { graphql: async () => null })
    ).rejects.toMatchObject({ code: 'derivation_login_not_visible' })
    await expect(
      collectGitHubActivity(
        { squadId: 's', login: 'octo', filters: {} },
        {
          graphql: async () => {
            throw new GitHubApiUnavailableError('no_token')
          },
        }
      )
    ).rejects.toBeInstanceOf(DerivationError)
  })
})

describe('query helpers', () => {
  test('the commits query aliases one block per repository with the date range and author', () => {
    const query = buildCommitsQuery(['a/b', 'c/d'])
    expect(query).toContain('r0: repository(owner: "a", name: "b")')
    expect(query).toContain('r1: repository(owner: "c", name: "d")')
    expect(query).toContain('history(first: 15, since: $since, until: $until, author: { id: $userId })')
  })

  test('the contributions window is the latest year inside the range', () => {
    expect(contributionsWindow({ before: '2026-03-01', after: '2025-09-01' }, new Date())).toEqual({
      from: '2025-09-01T00:00:00.000Z',
      to: '2026-03-01T00:00:00.000Z',
    })
  })
})
