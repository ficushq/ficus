import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import {
  squads,
  memoryDocuments,
  memoryChunks,
  memoryLinks,
  squadMemoryGrants,
  memoryAccessAudit,
} from '../../db/schema'
import { SquadMemoryGrant } from '../../entities/SquadMemoryGrant'
import { SearchService, globToLike, buildFilterConditions } from './SearchService'
import { IndexingService } from './indexer/IndexingService'
import type { MemorySourceAdapter } from './sources/adapter'
import { FileSource } from './sources/FileSource'

const searchService = SearchService.instance()
const indexingService = IndexingService.instance()

// SearchService tests exercise real Postgres FTS/trigram queries against the
// shared test database. Under full-suite load, individual queries can exceed
// Bun's default 5s timeout, so give these integration-style assertions a
// consistent timeout instead of patching one observed slow case at a time.
const SEARCH_INTEGRATION_TIMEOUT_MS = 15_000

describe('SearchService', () => {
  const testSquadId = crypto.randomUUID()

  beforeAll(async () => {
    // Create a test squad
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Memory Search Test Squad',
      purpose: 'Testing memory search',
      status: 'active',
    })

    // Index some test documents for search
    await indexingService.indexFile({
      squadId: testSquadId,
      path: '/memory/decisions/auth.md',
      content: `---
title: JWT Auth Decision
kind: decision
tags: [auth, backend, security]
importance: 0.9
---

# JWT Authentication Decision

We decided to use JWT tokens for API authentication.

## Rationale

JWTs are stateless and work well with our microservices architecture.
They contain encoded claims that can be verified without database lookups.

## Implementation

Use RS256 algorithm with rotating keys.
Tokens expire after 15 minutes.
Refresh tokens valid for 7 days.`,
    })

    await indexingService.indexFile({
      squadId: testSquadId,
      path: '/memory/patterns/react-query.md',
      content: `---
title: React Query Patterns
kind: pattern
tags: [frontend, react, data-fetching]
importance: 0.7
---

# React Query Patterns

Best practices for using React Query in our codebase.

## Query Keys

Always use consistent query keys from queryOptions.ts.
Never inline queryKey definitions.

## Mutations

Use onSuccess callbacks for cache invalidation.
Show loading states during mutations.`,
    })

    await indexingService.indexFile({
      squadId: testSquadId,
      path: '/memory/debugging/websocket-issues.md',
      content: `---
title: WebSocket Troubleshooting
kind: debugging
tags: [websocket, networking, debugging]
importance: 0.6
---

# WebSocket Troubleshooting

Common issues and fixes for WebSocket connections.

## Authentication Failures

If WebSocket authentication fails, check token expiration.
JWTs may have expired before connection.

## Reconnection

Implement exponential backoff for reconnection.
Max retry delay should be 30 seconds.`,
    })

    // Additional test document for filter testing
    await indexingService.indexFile({
      squadId: testSquadId,
      path: '/memory/runbooks/deployment.md',
      content: `---
title: Deployment Runbook
kind: runbook
tags: [deployment, devops, security]
importance: 0.8
---

# Deployment Runbook

Steps for deploying to production.

## Pre-deployment

Check authentication and security settings.
Verify JWT token handling is correct.

## Post-deployment

Monitor for websocket reconnection issues.`,
    })
  })

  afterAll(async () => {
    // Clean up
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  describe('search', () => {
    it(
      'finds documents matching search terms',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT authentication')

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((r) => r.path?.includes('auth'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns document frontmatter with search results',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT authentication')
        const authResult = results.find((result) => result.path === '/memory/decisions/auth.md')

        expect(authResult?.frontmatter).toMatchObject({ kind: 'decision', tags: expect.arrayContaining(['auth']) })
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns empty array for empty query',
      async () => {
        const results = await searchService.search(testSquadId, '')
        expect(results).toEqual([])
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns empty array for whitespace-only query',
      async () => {
        const results = await searchService.search(testSquadId, '   ')
        expect(results).toEqual([])
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'matches partial terms',
      async () => {
        const results = await searchService.search(testSquadId, 'websocket')

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((r) => r.path?.includes('websocket'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'ranks more relevant results higher',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication JWT token')

        // Auth doc should rank higher than WebSocket doc (which mentions JWT once)
        expect(results.length).toBeGreaterThan(0)
        if (results.length >= 2) {
          const authDoc = results.find((r) => r.path?.includes('auth'))
          const wsDoc = results.find((r) => r.path?.includes('websocket'))

          if (authDoc && wsDoc) {
            expect(authDoc.score).toBeGreaterThanOrEqual(wsDoc.score)
          }
        }
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'respects limit option',
      async () => {
        const results = await searchService.search(testSquadId, 'patterns', { limit: 1 })
        expect(results.length).toBeLessThanOrEqual(1)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'includes snippets around matches',
      async () => {
        const results = await searchService.search(testSquadId, 'stateless')

        expect(results.length).toBeGreaterThan(0)
        expect(results[0].snippet).toContain('stateless')
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'searches across multiple documents',
      async () => {
        const results = await searchService.search(testSquadId, 'query patterns authentication', {
          limit: 10,
        })

        // Should find results from different documents
        const paths = results.map((r) => r.path)
        const uniquePaths = [...new Set(paths)]

        expect(uniquePaths.length).toBeGreaterThanOrEqual(1)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('keyword mode', () => {
    it(
      'uses keyword-only search when mode is keyword',
      async () => {
        const results = await searchService.search(testSquadId, 'React Query', {
          mode: 'keyword',
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((r) => r.path?.includes('react-query'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('extractSnippet', () => {
    it('extracts context around match', () => {
      const content = 'This is a long piece of text. The important keyword is here. More text follows after.'
      const snippet = searchService.extractSnippet(content, 'keyword', 50)

      expect(snippet).toContain('keyword')
      expect(snippet.length).toBeLessThanOrEqual(60) // Allow for ellipsis
    })

    it('adds ellipsis when truncated', () => {
      const content = 'Start. Middle content with the match. End of the very long text here.'
      const snippet = searchService.extractSnippet(content, 'match', 30)

      expect(snippet).toContain('...')
    })

    it('handles match at start', () => {
      const content = 'Keyword at the start of this text.'
      const snippet = searchService.extractSnippet(content, 'Keyword', 50)

      expect(snippet.startsWith('Keyword')).toBe(true)
    })

    it('handles match at end', () => {
      const content = 'Text with keyword at the end keyword'
      const snippet = searchService.extractSnippet(content, 'keyword', 50)

      expect(snippet).toContain('keyword')
    })

    it('returns start of content when no match', () => {
      const content = 'This content does not contain the search term.'
      const snippet = searchService.extractSnippet(content, 'xyz', 20)

      expect(snippet.startsWith('This')).toBe(true)
    })
  })

  describe('calculateHybridScore', () => {
    it('combines vector and keyword scores with weights', () => {
      const score = searchService.calculateHybridScore({
        vectorScore: 0.8,
        keywordScore: 0.6,
        recencyScore: 0,
        linkAuthority: 0,
        importance: 0,
        weights: { vector: 0.55, keyword: 0.35, recency: 0.1, linkAuthority: 0, importance: 0 },
      })

      // Expected: 0.8 * 0.55 + 0.6 * 0.35 = 0.44 + 0.21 = 0.65
      expect(score).toBeCloseTo(0.65, 2)
    })

    it('handles zero scores', () => {
      const score = searchService.calculateHybridScore({
        vectorScore: 0,
        keywordScore: 0.5,
        recencyScore: 0,
        linkAuthority: 0,
        importance: 0,
        weights: { vector: 0.5, keyword: 0.5, recency: 0, linkAuthority: 0, importance: 0 },
      })

      expect(score).toBeCloseTo(0.25, 2)
    })

    it('applies recency boost', () => {
      const recentScore = searchService.calculateHybridScore({
        vectorScore: 0.5,
        keywordScore: 0.5,
        recencyScore: 1.0, // Very recent
        weights: { vector: 0.4, keyword: 0.4, recency: 0.2 },
      })

      const oldScore = searchService.calculateHybridScore({
        vectorScore: 0.5,
        keywordScore: 0.5,
        recencyScore: 0.0, // Very old
        weights: { vector: 0.4, keyword: 0.4, recency: 0.2 },
      })

      expect(recentScore).toBeGreaterThan(oldScore)
    })
  })

  describe('applyMmrReranking', () => {
    it('promotes diversity in results', () => {
      // Simulate results with similar content
      const results = [
        { documentId: '1', score: 1.0, content: 'JWT authentication tokens', path: '/a' },
        { documentId: '2', score: 0.9, content: 'JWT token validation', path: '/b' },
        { documentId: '3', score: 0.8, content: 'React Query patterns', path: '/c' },
        { documentId: '4', score: 0.7, content: 'JWT refresh tokens', path: '/d' },
      ]

      const reranked = searchService.applyMmrReranking(results as any, 0.7)

      // Should not just be sorted by score - diversity should play a role
      expect(reranked.length).toBe(4)

      // First result should still be highest scoring
      expect(reranked[0].documentId).toBe('1')

      // The diverse result (React Query) should be boosted up
      const reactQueryIdx = reranked.findIndex((r) => r.documentId === '3')
      const lastJwtIdx = reranked.findIndex((r) => r.documentId === '4')

      // React Query should appear before some JWT results due to diversity
      expect(reactQueryIdx).toBeLessThan(lastJwtIdx)
    })

    it('preserves order when lambda is 1 (no diversity penalty)', () => {
      const results = [
        { documentId: '1', score: 1.0, content: 'a', path: '/a' },
        { documentId: '2', score: 0.9, content: 'b', path: '/b' },
        { documentId: '3', score: 0.8, content: 'c', path: '/c' },
      ]

      const reranked = searchService.applyMmrReranking(results as any, 1.0)

      expect(reranked.map((r) => r.documentId)).toEqual(['1', '2', '3'])
    })
  })

  describe('globToLike', () => {
    it('converts ** to %', () => {
      expect(globToLike('apps/**')).toBe('apps/%')
      expect(globToLike('apps/**/test')).toBe('apps/%/test')
    })

    it('converts single * to %', () => {
      expect(globToLike('patterns/*.md')).toBe('patterns/%.md')
      expect(globToLike('*.ts')).toBe('%.ts')
    })

    it('escapes SQL special characters', () => {
      expect(globToLike('file_name.md')).toBe('file\\_name.md')
      expect(globToLike('100%')).toBe('100\\%')
    })

    it('handles combined patterns', () => {
      expect(globToLike('apps/core/**/*.ts')).toBe('apps/core/%/%.ts')
    })
  })

  describe('buildFilterConditions', () => {
    it('returns empty array for no filters', () => {
      const conditions = buildFilterConditions({})
      expect(conditions).toEqual([])
    })

    it('returns conditions for sourceTypes', () => {
      const conditions = buildFilterConditions({ sourceTypes: ['memory_file'] })
      expect(conditions.length).toBe(1)
    })

    it('returns conditions for kinds', () => {
      const conditions = buildFilterConditions({ kinds: ['decision', 'pattern'] })
      expect(conditions.length).toBe(1)
    })

    it('returns conditions for tags', () => {
      const conditions = buildFilterConditions({ tags: ['auth', 'security'] })
      expect(conditions.length).toBe(1)
    })

    it('returns conditions for paths', () => {
      const conditions = buildFilterConditions({ paths: ['decisions/**'] })
      expect(conditions.length).toBe(1)
    })

    it('returns multiple conditions for combined filters', () => {
      const conditions = buildFilterConditions({
        sourceTypes: ['memory_file'],
        kinds: ['decision'],
        tags: ['auth'],
        paths: ['decisions/**'],
      })
      expect(conditions.length).toBe(4)
    })
  })

  describe('filter by kind', () => {
    it(
      'filters results by single kind',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          kinds: ['decision'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Should only return the auth decision doc
        expect(results.every((r) => r.path?.includes('auth') || r.path?.includes('decisions'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'filters results by multiple kinds',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT', {
          kinds: ['decision', 'debugging'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Should return auth (decision) and websocket (debugging) docs that mention JWT
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns empty for non-matching kind',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT', {
          kinds: ['nonexistent-kind'],
        })

        expect(results.length).toBe(0)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('filter by tags', () => {
    it(
      'filters results by single tag',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          tags: ['security'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Should return docs with security tag (auth and deployment)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'filters results by multiple tags (any match)',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          tags: ['frontend', 'backend'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Auth doc has backend tag
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns empty for non-matching tags',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT', {
          tags: ['nonexistent-tag'],
        })

        expect(results.length).toBe(0)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('filter by path', () => {
    it(
      'filters results by path glob',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          paths: ['/memory/decisions/**'],
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.every((r) => r.path?.startsWith('/memory/decisions/'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'filters results by multiple path globs',
      async () => {
        const results = await searchService.search(testSquadId, 'JWT', {
          paths: ['/memory/decisions/**', '/memory/debugging/**'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Should match docs in either path
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'filters results by file extension glob',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          paths: ['**.md'],
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.every((r) => r.path?.endsWith('.md'))).toBe(true)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('combined filters', () => {
    it(
      'applies multiple filters with AND semantics',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          kinds: ['decision'],
          tags: ['security'],
          paths: ['/memory/decisions/**'],
        })

        expect(results.length).toBeGreaterThan(0)
        // Only auth decision should match all filters
        expect(results[0].path).toBe('/memory/decisions/auth.md')
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )

    it(
      'returns empty when filters exclude all',
      async () => {
        const results = await searchService.search(testSquadId, 'authentication', {
          kinds: ['decision'],
          paths: ['/memory/patterns/**'], // auth is in decisions, not patterns
        })

        expect(results.length).toBe(0)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })

  describe('empty filters', () => {
    it(
      'returns all matching results when filters are empty arrays',
      async () => {
        const resultsWithoutFilters = await searchService.search(testSquadId, 'JWT')
        const resultsWithEmptyFilters = await searchService.search(testSquadId, 'JWT', {
          sourceTypes: [],
          kinds: [],
          tags: [],
          paths: [],
        })

        // Empty arrays should not filter anything
        expect(resultsWithEmptyFilters.length).toBe(resultsWithoutFilters.length)
      },
      SEARCH_INTEGRATION_TIMEOUT_MS
    )
  })
})

describe('SearchService cross-squad', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Caller', purpose: 'Test caller', status: 'active' },
      { id: sourceSquadId, name: 'Source', purpose: 'Test source', status: 'active' },
    ])

    await indexingService.indexFile({
      squadId: callerSquadId,
      path: '/memory/notes/own.md',
      content: '---\ntitle: Own Note\n---\n\nThis note about widgets lives in caller squad.\n',
    })
    await indexingService.indexFile({
      squadId: sourceSquadId,
      path: '/memory/company/policy.md',
      content: '---\ntitle: Policy\n---\n\nThe company widget policy is comprehensive.\n',
    })
    await indexingService.indexFile({
      squadId: sourceSquadId,
      path: '/memory/company/secret.md',
      content: '---\ntitle: Secret\nsensitivity: restricted\n---\n\nThe restricted widget memo.\n',
    })
  })

  afterAll(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    for (const squadId of [callerSquadId, sourceSquadId]) {
      await db.delete(memoryLinks).where(eq(memoryLinks.squadId, squadId))
      await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
      await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
      await db.delete(squads).where(eq(squads.id, squadId))
    }
  })

  it(
    'returns only own results when no grant exists',
    async () => {
      const results = await searchService.search(callerSquadId, 'widget')
      const squadIds = new Set(results.map((r) => r.sourceSquadId))
      expect(squadIds.has(callerSquadId)).toBe(true)
      expect(squadIds.has(sourceSquadId)).toBe(false)
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'returns granted results and provenance when a grant exists',
    async () => {
      await SquadMemoryGrant.create({
        sourceSquadId,
        granteeSquadId: callerSquadId,
        policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'internal' } },
      })

      const results = await searchService.search(callerSquadId, 'widget')
      expect(results.some((r) => r.sourceSquadId === callerSquadId && r.sensitivity === 'internal')).toBe(true)
      expect(results.some((r) => r.sourceSquadId === sourceSquadId && r.path === '/memory/company/policy.md')).toBe(
        true
      )
      expect(results.some((r) => r.sourceSquadId === sourceSquadId && r.path === '/memory/company/secret.md')).toBe(
        false
      )
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'does not reveal granted-source documents through unrelated requested paths',
    async () => {
      await SquadMemoryGrant.create({
        sourceSquadId,
        granteeSquadId: callerSquadId,
        policy: { read: { paths: ['/memory/company/**'] } },
      })

      const results = await searchService.search(callerSquadId, 'company widget policy', {
        paths: ['/memory/secrets/**'],
      })

      expect(results.some((r) => r.sourceSquadId === sourceSquadId)).toBe(false)
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'records an audit row when granted results are returned',
    async () => {
      await searchService.search(callerSquadId, 'company widget policy')

      const rows = await db.select().from(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
      expect(rows.some((r) => r.sourceSquadId === sourceSquadId && r.action === 'search')).toBe(true)
      expect(rows.some((r) => r.sourceSquadId === callerSquadId)).toBe(false)
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )
})

describe('SearchService source-specific grant filters', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()
  const originalMemoryFileAdapter = FileSource.instance()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Source Filter Caller', purpose: 'Testing memory search', status: 'active' },
      { id: sourceSquadId, name: 'Source Filter Source', purpose: 'Testing memory search', status: 'active' },
    ])

    await indexingService.indexFile({
      squadId: sourceSquadId,
      path: '/memory/source-filter/allowed.md',
      content: '---\ntitle: Allowed\n---\n\nThe channelneedle adapter filter should allow this document.\n',
    })
    await indexingService.indexFile({
      squadId: sourceSquadId,
      path: '/memory/source-filter/blocked.md',
      content: '---\ntitle: Blocked\n---\n\nThe channelneedle adapter filter should block this document.\n',
    })
  })

  afterAll(async () => {
    indexingService.registerAdapter(originalMemoryFileAdapter)
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    for (const squadId of [callerSquadId, sourceSquadId]) {
      await db.delete(memoryLinks).where(eq(memoryLinks.squadId, squadId))
      await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
      await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
      await db.delete(squads).where(eq(squads.id, squadId))
    }
  })

  it(
    'narrows granted search results with adapter buildSearchSqlFilter',
    async () => {
      const filteredMemoryFileAdapter = Object.assign(
        Object.create(Object.getPrototypeOf(originalMemoryFileAdapter)),
        originalMemoryFileAdapter,
        {
          sourceType: 'memory_file',
          validateGrantFilter(filter: unknown) {
            return filter && typeof filter === 'object' && typeof (filter as { path?: unknown }).path === 'string'
              ? null
              : ['path must be a string']
          },
          buildSearchSqlFilter(filter: unknown) {
            return sql`${memoryDocuments.path} = ${(filter as { path: string }).path}`
          },
        }
      ) as MemorySourceAdapter
      indexingService.registerAdapter(filteredMemoryFileAdapter)

      await SquadMemoryGrant.create({
        sourceSquadId,
        granteeSquadId: callerSquadId,
        policy: {
          read: {
            sourceTypes: ['memory_file'],
            paths: ['/memory/source-filter/**'],
            sourceFilters: { memory_file: { path: '/memory/source-filter/allowed.md' } },
          },
        },
      })

      const results = await searchService.search(callerSquadId, 'channelneedle')

      expect(
        results.some(
          (result) => result.sourceSquadId === sourceSquadId && result.path === '/memory/source-filter/allowed.md'
        )
      ).toBe(true)
      expect(
        results.some(
          (result) => result.sourceSquadId === sourceSquadId && result.path === '/memory/source-filter/blocked.md'
        )
      ).toBe(false)
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )
})

describe('SearchService keyword ranking', () => {
  const squadId = crypto.randomUUID()
  const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)

  beforeAll(async () => {
    await db.insert(squads).values({ id: squadId, name: 'Keyword Ranking', purpose: 'Test', status: 'active' })
    await indexingService.indexFile({
      squadId,
      path: '/memory/playbooks/pool.md',
      content:
        '# Connection pool exhaustion\n\nWhen the Postgres connection pool is exhausted, raise the pool size and close idle connections.',
    })
    await db
      .update(memoryDocuments)
      .set({ updatedAt: oldDate })
      .where(sql`${memoryDocuments.squadId} = ${squadId} AND ${memoryDocuments.path} = '/memory/playbooks/pool.md'`)
    // Newer documents that each mention one query word.
    for (let i = 0; i < 12; i++) {
      await indexingService.indexFile({
        squadId,
        path: `/memory/notes/note-${i}.md`,
        content: `# Note ${i}\n\nThe office wifi connection dropped again on day ${i}.`,
      })
    }
    await indexingService.indexFile({
      squadId,
      path: '/memory/runbooks/release.md',
      content: '# Release\n\nThe deployment checklist lives here.\n\n## Rollback\n\nRevert the tag and redeploy.',
    })
    await indexingService.indexFile({
      squadId,
      path: '/memory/notes/history.md',
      content: '# History\n\nA long story about the project, its people and its tools, where once a rollback happened.',
    })
    await indexingService.indexFile({
      squadId,
      path: '/memory/incidents/socket.md',
      content: '# Socket incident\n\nClients failed with WSX-4471b while reconnecting.',
    })
  })

  afterAll(async () => {
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it(
    'ranks an older document matching every word above newer partial matches before applying the limit',
    async () => {
      const results = await searchService.search(squadId, 'connection pool exhaustion', { mode: 'keyword', limit: 3 })
      expect(results[0]?.path).toBe('/memory/playbooks/pool.md')
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'matches other forms of a word',
    async () => {
      const results = await searchService.search(squadId, 'deploying', { mode: 'keyword' })
      expect(results.map((r) => r.path)).toContain('/memory/runbooks/release.md')
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'matches a word prefix',
    async () => {
      const results = await searchService.search(squadId, 'exhaust', { mode: 'keyword' })
      expect(results[0]?.path).toBe('/memory/playbooks/pool.md')
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'ranks a section heading match above a passing mention',
    async () => {
      const results = await searchService.search(squadId, 'rollback', { mode: 'keyword' })
      const paths = results.map((r) => r.path)
      expect(paths.indexOf('/memory/runbooks/release.md')).toBeGreaterThanOrEqual(0)
      expect(paths.indexOf('/memory/runbooks/release.md')).toBeLessThan(paths.indexOf('/memory/notes/history.md'))
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'finds exact identifiers, including a fragment of one',
    async () => {
      const whole = await searchService.search(squadId, 'WSX-4471b', { mode: 'keyword' })
      expect(whole[0]?.path).toBe('/memory/incidents/socket.md')
      const fragment = await searchService.search(squadId, '4471', { mode: 'keyword' })
      expect(fragment.map((r) => r.path)).toContain('/memory/incidents/socket.md')
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )

  it(
    'does not expose the internal keyword score',
    async () => {
      const [result] = await searchService.search(squadId, 'rollback', { mode: 'keyword' })
      expect(result).toBeDefined()
      expect('keywordScore' in result).toBe(false)
    },
    SEARCH_INTEGRATION_TIMEOUT_MS
  )
})
