import { useEnabledIntegrationFixtures } from '../../../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
const githubFixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
afterEach(async () => {
  for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
})
import { createTestGitHubConnection } from '../../../test-utils/github-connection'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryChunks, memoryDocuments, squads } from '../../../db/schema'
import { Squad } from '../../../entities/Squad'
import { SquadSourceConfig } from '../../../entities/SquadSourceConfig'
import { GitHubIssueSource, githubIssueSourceId, parseGithubUrl, renderIssueMarkdown } from './GitHubIssueSource'

const originalFetch = globalThis.fetch

afterEach(() => {
  delete process.env.GITHUB_TOKEN
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('parseGithubUrl', () => {
  it('parses issue URLs', () => {
    expect(parseGithubUrl('https://github.com/acme/api/issues/42')).toEqual({
      repo: 'acme/api',
      number: 42,
      kind: 'issue',
    })
  })

  it('parses pull request URLs', () => {
    expect(parseGithubUrl('https://github.com/acme/api/pull/77')).toEqual({
      repo: 'acme/api',
      number: 77,
      kind: 'pull_request',
    })
  })

  it('returns null for unrelated URLs', () => {
    expect(parseGithubUrl('https://example.com')).toBeNull()
  })
})

describe('githubIssueSourceId', () => {
  it('builds a stable repo-number id', () => {
    expect(githubIssueSourceId({ repo: 'acme/api', number: 42 })).toBe('acme/api#42')
  })
})

describe('GitHubIssueSource validation', () => {
  it('validates policy scope arrays', () => {
    const adapter = GitHubIssueSource.instance()
    expect(adapter.validatePolicy({ version: 1, scope: { repos: ['acme/api'], labels: ['bug'] } })).toBeNull()
    expect(adapter.validatePolicy({ version: 1, scope: { repos: [123] } })).toContain(
      'scope.repos must be an array of strings'
    )
  })

  it('validates grant repo filters', () => {
    const adapter = GitHubIssueSource.instance()
    expect(adapter.validateGrantFilter({ repos: ['acme/api'] })).toBeNull()
    expect(adapter.validateGrantFilter({ repos: [1] })).toEqual(['repos must be an array of strings'])
  })

  it('builds a SQL filter for repo grants', () => {
    const adapter = GitHubIssueSource.instance()
    expect(adapter.buildSearchSqlFilter({ repos: ['acme/api'] })).toBeTruthy()
    expect(adapter.buildSearchSqlFilter({ repos: [] })).toBeNull()
  })
})

describe('GitHubIssueSource indexing', () => {
  it('indexes allowed configured repos and writes frontmatter/chunk metadata', async () => {
    const squad = await Squad.create({ name: `github index ${crypto.randomUUID()}`, purpose: 'test' })
    // Author filter OFF: the pre-filter indexing contract (filtered projection: managed-content.test.ts).
    await db.update(squads).set({ githubAuthorFilter: false }).where(eq(squads.id, squad.id))
    await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'], labels: ['bug'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId: squad.id }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search
      if (path === '/repos/acme/api/issues/42') {
        return Response.json({
          number: 42,
          title: 'Fix login',
          body: 'Body text',
          html_url: 'https://github.com/acme/api/issues/42',
          state: 'open',
          labels: [{ name: 'bug' }],
          updated_at: '2026-05-01T00:00:00Z',
          user: { login: 'alice' },
        })
      }
      if (path === '/repos/acme/api/issues/42/comments?per_page=100') {
        return Response.json([
          {
            body: 'Comment text',
            created_at: '2026-05-01T01:00:00Z',
            updated_at: '2026-05-01T01:00:00Z',
            user: { login: 'bob' },
          },
        ])
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const result = await GitHubIssueSource.instance().index(squad.id, 'acme/api#42')

    expect(result.success).toBe(true)
    const [doc] = await db.select().from(memoryDocuments).where(eq(memoryDocuments.id, result.documentId!))
    expect(doc).toMatchObject({ squadId: squad.id, sourceType: 'github_issue', sourceId: 'acme/api#42' })
    expect(doc.frontmatter).toMatchObject({
      kind: 'issue',
      repo: 'acme/api',
      number: 42,
      state: 'open',
      labels: ['bug'],
      sourceLinks: ['https://github.com/acme/api/issues/42'],
    })
    const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, doc.id))
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.some((chunk) => (chunk.metadata as { event?: { actor?: string } }).event?.actor === 'bob')).toBe(true)
  })

  it('fails closed when repo is not configured', async () => {
    const squad = await Squad.create({ name: `github denied ${crypto.randomUUID()}`, purpose: 'test' })
    await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'] } },
    })

    const result = await GitHubIssueSource.instance().index(squad.id, 'other/repo#1')

    expect(result).toMatchObject({ success: false, chunksCreated: 0, error: 'GitHub repo not configured: other/repo' })
    const docs = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squad.id),
          eq(memoryDocuments.sourceType, 'github_issue'),
          eq(memoryDocuments.sourceId, 'other/repo#1')
        )
      )
    expect(docs).toHaveLength(0)
  })

  it('skips configured repos when issue labels do not match policy labels', async () => {
    const squad = await Squad.create({ name: `github labels ${crypto.randomUUID()}`, purpose: 'test' })
    await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'], labels: ['bug'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId: squad.id }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search
      if (path === '/repos/acme/api/issues/99') {
        return Response.json({
          number: 99,
          title: 'Feature',
          body: 'Body text',
          html_url: 'https://github.com/acme/api/issues/99',
          state: 'open',
          labels: [{ name: 'enhancement' }],
          updated_at: '2026-05-01T00:00:00Z',
          user: { login: 'alice' },
        })
      }
      if (path === '/repos/acme/api/issues/99/comments?per_page=100') return Response.json([])
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const result = await GitHubIssueSource.instance().index(squad.id, 'acme/api#99')

    expect(result).toMatchObject({ success: false, error: 'GitHub issue labels not configured: acme/api#99' })
  })

  it('includes configured labels when listing and filters returned issues by label', async () => {
    const squad = await Squad.create({ name: `github list ${crypto.randomUUID()}`, purpose: 'test' })
    await SquadSourceConfig.upsert({
      squadId: squad.id,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'], labels: ['bug'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId: squad.id }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname + new URL(String(url)).search
      expect(path).toContain('labels=bug')
      return Response.json([
        {
          number: 1,
          title: 'Bug',
          html_url: '',
          state: 'open',
          labels: [{ name: 'bug' }],
          updated_at: '2026-05-01T00:00:00Z',
        },
        {
          number: 2,
          title: 'Feature',
          html_url: '',
          state: 'open',
          labels: [{ name: 'enhancement' }],
          updated_at: '2026-05-02T00:00:00Z',
        },
      ])
    }) as unknown as typeof fetch

    const items = await GitHubIssueSource.instance().list(squad.id)

    expect(items).toEqual([{ sourceId: 'acme/api#1', cursor: '2026-05-01T00:00:00Z' }])
  })
})

describe('renderIssueMarkdown', () => {
  it('renders issue body and comments with metadata markers', () => {
    const markdown = renderIssueMarkdown(
      {
        number: 42,
        title: 'Fix login',
        body: 'Body text',
        html_url: 'https://github.com/acme/api/issues/42',
        state: 'open',
        updated_at: '2026-05-01T00:00:00Z',
        user: { login: 'alice' },
      },
      [
        {
          body: 'Comment text',
          created_at: '2026-05-01T01:00:00Z',
          updated_at: '2026-05-01T01:00:00Z',
          user: { login: 'bob' },
        },
      ]
    )
    expect(markdown).toContain('# Fix login')
    expect(markdown).toContain('Body text')
    expect(markdown).toContain('## Comment by bob')
    expect(markdown).toContain('<!-- comment-meta actor=bob ts=2026-05-01T01:00:00Z -->')
  })
})
