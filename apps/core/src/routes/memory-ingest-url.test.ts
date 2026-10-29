import { useEnabledIntegrationFixtures } from '../test-utils/enabled-integrations'
useEnabledIntegrationFixtures('github')
const githubFixtures: Awaited<ReturnType<typeof createTestGitHubConnection>>[] = []
afterEach(async () => {
  for (const fixture of githubFixtures.splice(0)) await fixture.dispose()
})
import { createTestGitHubConnection } from '../test-utils/github-connection'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { FetchedContent } from '../services/memory/sources'
import { SlackThreadSource } from '../services/memory/sources/SlackThreadSource'
import { db, memoryDocuments, memoryLinks, memoryChunks, squads, squadSourceConfigs } from '../db'
import { identityMiddleware } from '../middleware/identity'
import { authHeaders, cleanupTestRbac, createTestAdmin, type TestUser } from '../test-utils'
import { memoryRouter } from './memory'

const originalFetch = globalThis.fetch
const originalSlackFetch = SlackThreadSource.prototype.fetch

const app = new Hono()
app.use('*', identityMiddleware)
app.route('/api/memory', memoryRouter)

const rbacPrefix = `memory-ingest-rbac-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let admin: TestUser

describe('POST /api/memory/:squadId/ingest-url', () => {
  const squadId = crypto.randomUUID()

  beforeAll(async () => {
    admin = await createTestAdmin({ prefix: rbacPrefix, canonicalAdmin: true })
    await db.insert(squads).values({ id: squadId, name: 'ingest-url test', purpose: 'testing', status: 'active' })
  })

  afterEach(async () => {
    delete process.env.GITHUB_TOKEN
    globalThis.fetch = originalFetch
    SlackThreadSource.prototype.fetch = originalSlackFetch
    await db.delete(squadSourceConfigs).where(eq(squadSourceConfigs.squadId, squadId))
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, squadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
  })

  afterAll(async () => {
    await db.delete(squads).where(eq(squads.id, squadId))
    await cleanupTestRbac(rbacPrefix)
  })

  it('ingests a Slack thread URL and stores a memory document', async () => {
    SlackThreadSource.prototype.fetch = async (_squadId: string, sourceId: string): Promise<FetchedContent | null> => ({
      content: '### U1 — 1715800000.123456\n\nRoot message',
      title: 'Root message',
      path: null,
      frontmatter: {
        kind: 'slack_thread',
        sourceLinks: ['https://slack.com/archives/C0123ABCDE/p1715800000123456'],
        channelId: 'C0123ABCDE',
        threadTs: '1715800000.123456',
        rootUser: 'U1',
        messageCount: 1,
      },
      chunkMetadata: { sourceType: 'slack_thread', parent: { sourceId } },
      chunkMetadataForChunk: () => ({ event: { actor: 'U1', ts: '1715800000.123456' } }),
    })

    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({
        url: 'https://acme.slack.com/archives/C0123ABCDE/p1715800000123456?thread_ts=1715800000.123456',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      sourceType: 'slack_thread',
      sourceId: 'C0123ABCDE:1715800000.123456',
      result: { success: true },
    })

    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'slack_thread'),
          eq(memoryDocuments.sourceId, 'C0123ABCDE:1715800000.123456')
        )
      )
    expect(doc.frontmatter).toMatchObject({ kind: 'slack_thread', channelId: 'C0123ABCDE' })
  })

  it('ingests a canonical slack.com thread URL and stores a memory document', async () => {
    SlackThreadSource.prototype.fetch = async (_squadId: string, sourceId: string): Promise<FetchedContent | null> => ({
      content: '### U1 — 1779405248.857339\n\nRoot message',
      title: 'Root message',
      path: null,
      frontmatter: {
        kind: 'slack_thread',
        sourceLinks: ['https://slack.com/archives/C0B3U3X19E2/p1779405248857339'],
        channelId: 'C0B3U3X19E2',
        threadTs: '1779405248.857339',
        rootUser: 'U1',
        messageCount: 1,
      },
      chunkMetadata: { sourceType: 'slack_thread', parent: { sourceId } },
      chunkMetadataForChunk: () => ({ event: { actor: 'U1', ts: '1779405248.857339' } }),
    })

    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://slack.com/archives/C0B3U3X19E2/p1779405248857339' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      sourceType: 'slack_thread',
      sourceId: 'C0B3U3X19E2:1779405248.857339',
      result: { success: true },
    })
  })

  it('ingests a GitHub issue URL and stores a memory document', async () => {
    await db.insert(squadSourceConfigs).values({
      squadId,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname + parsed.search
      if (path === '/repos/acme/api') return Response.json({ id: 1 })
      if (path === '/repos/acme/api/pulls/43') return Response.json({ id: 4300 })
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
      if (path === '/repos/acme/api/issues/42/comments?per_page=100') return Response.json([])
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://github.com/acme/api/issues/42' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      sourceType: 'github_issue',
      sourceId: 'acme/api#42',
      result: { success: true },
    })

    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'github_issue'),
          eq(memoryDocuments.sourceId, 'acme/api#42')
        )
      )
    expect(doc.frontmatter).toMatchObject({ kind: 'issue', repo: 'acme/api', number: 42 })
  })

  it('reports an explicit ingestion failure when repository identity is unavailable', async () => {
    await db.insert(squadSourceConfigs).values({
      squadId,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname
      if (path === '/repos/acme/api') return new Response('unavailable', { status: 503 })
      if (path.endsWith('/comments')) return Response.json([])
      return Response.json({
        id: 42,
        number: 42,
        title: 'Preserve identity',
        body: 'body',
        state: 'open',
        updated_at: '2026-05-01T00:00:00Z',
        html_url: 'https://github.com/acme/api/issues/42',
      })
    }) as unknown as typeof fetch
    const response = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://github.com/acme/api/issues/42' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      result: { success: false, reason: 'unavailable', error: 'GitHub content fetch unavailable' },
    })
    expect(await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))).toEqual([])
  })

  it('ingests a GitHub pull request URL and stores a github_issue memory document', async () => {
    await db.insert(squadSourceConfigs).values({
      squadId,
      sourceType: 'github_issue',
      enabled: true,
      policy: { version: 1, scope: { repos: ['acme/api'] } },
    })
    githubFixtures.push(await createTestGitHubConnection({ squadId }))
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname + parsed.search
      if (path === '/repos/acme/api') return Response.json({ id: 1 })
      if (path === '/repos/acme/api/pulls/43') return Response.json({ id: 4300 })
      if (path === '/repos/acme/api/issues/43') {
        return Response.json({
          number: 43,
          title: 'Improve auth',
          body: 'Body text',
          html_url: 'https://github.com/acme/api/pull/43',
          state: 'open',
          labels: [],
          pull_request: {},
          updated_at: '2026-05-01T00:00:00Z',
          user: { login: 'alice' },
        })
      }
      if (path === '/repos/acme/api/issues/43/comments?per_page=100') return Response.json([])
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://github.com/acme/api/pull/43' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ sourceType: 'github_issue', sourceId: 'acme/api#43', result: { success: true } })

    const [doc] = await db
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'github_issue'),
          eq(memoryDocuments.sourceId, 'acme/api#43')
        )
      )
    expect(doc.frontmatter).toMatchObject({ kind: 'pull_request', repo: 'acme/api', number: 43 })
  })

  it('fails closed for unsupported URLs', async () => {
    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://linear.app/acme/issue/ENG-42/fix-login' }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unsupported URL' })
  })

  it('fails closed when source policy denies the Slack channel', async () => {
    await db.insert(squadSourceConfigs).values({
      squadId,
      sourceType: 'slack_thread',
      enabled: true,
      policy: { version: 1, scope: { channelIds: ['C_ALLOWED'] } },
    })

    const res = await app.request(`/api/memory/${squadId}/ingest-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(admin.token) },
      body: JSON.stringify({ url: 'https://acme.slack.com/archives/CDENIED/p1715800000123456' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.result.error).toBe('Slack channel not configured: CDENIED')
  })
})
