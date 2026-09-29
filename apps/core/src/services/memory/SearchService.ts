/**
 * Memory Search Service
 *
 * Provides hybrid search over memory documents using:
 * - Vector similarity (pgvector), when embeddings are configured
 * - Keyword matching (Postgres full-text ranking plus exact substrings)
 *
 * Results are ranked using configurable weights and MMR for diversity.
 */

import { db } from '../../db'
import { createLogger } from '../../lib/infra/logger'

const log = createLogger('vector-search')
import { memoryDocuments, memoryChunks } from '../../db/schema'
import { eq, and, ilike, desc, isNotNull, sql, type AnyColumn } from 'drizzle-orm'
import { recordMemoryAccess } from './access/audit'
import { expandReadScope, type AllowedScope } from './access/scope-expander'
import { isAllowedBy, parseSensitivity, type SensitivityTier } from './access/sensitivity'
import { anyTermQuery, chunkSearchVector, documentSearchVector, escapeLike, queryTerms, termCoverage } from './fts'
import { EmbeddingService } from './indexer/EmbeddingService'
import { IndexingService } from './indexer/IndexingService'
import type { LiveMemorySourceAdapter, LiveSearchResult } from './sources/live-adapter'
import { defaultLiveRateLimiter, type LiveRateLimiter } from './sources/live-rate-limiter'

// ============================================================================
// Types
// ============================================================================

export type SourceType = string

export interface SearchOptions {
  limit?: number
  mode?: 'hybrid' | 'vector' | 'keyword'
  // Weights for ranking
  weights?: {
    vector?: number
    keyword?: number
    recency?: number
    linkAuthority?: number
    importance?: number
  }
  // MMR diversity parameter (0-1, higher = more relevance, lower = more diversity)
  mmrLambda?: number

  // Filter options
  sourceTypes?: SourceType[]
  kinds?: string[] // Filter by frontmatter.kind
  tags?: string[] // Filter by frontmatter.tags (any match)
  paths?: string[] // Glob patterns, e.g. ['apps/core/**', 'docs/*.md']
  sensitivity?: SensitivityTier
  sourceSquadIds?: string[]
}

export interface SearchResult {
  documentId: string
  sourceSquadId: string
  path: string | null
  title: string | null
  sourceType?: string // Source type (e.g., "file", "thread")
  sensitivity: SensitivityTier
  score: number
  snippet: string
  chunkIndex: number
  content?: string // Full chunk content for MMR
  frontmatter?: Record<string, unknown>
  provenance?: Record<string, unknown>
  event?: { ts: string; actor?: string }
}

type KeywordResult = SearchResult & { keywordScore: number }

interface KeywordRow {
  documentId: string
  chunkIndex: number
  content: string
  docPath: string | null
  docTitle: string | null
  docSourceType: string
  docSquadId: string
  docSensitivity: string
  docFrontmatter: unknown
  docUpdatedAt: Date
  keywordScore: number
}

/**
 * Keyword score for a chunk that contains the query verbatim but that
 * full-text search missed (e.g. part of a longer identifier).
 */
const SUBSTRING_MATCH_SCORE = 0.5

/** The word to centre a snippet on: the whole query if present, else the first query word found. */
function snippetTerm(content: string, phrase: string, terms: string[]): string {
  const lower = content.toLowerCase()
  if (lower.includes(phrase.toLowerCase())) return phrase
  return terms.find((term) => lower.includes(term)) ?? terms[0] ?? phrase
}

function withoutKeywordScore(results: KeywordResult[]): SearchResult[] {
  return results.map(({ keywordScore: _keywordScore, ...result }) => result)
}

function asFrontmatter(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export interface HybridScoreInput {
  vectorScore?: number
  keywordScore?: number
  recencyScore?: number
  linkAuthority?: number
  importance?: number
  weights: {
    vector?: number
    keyword?: number
    recency?: number
    linkAuthority?: number
    importance?: number
  }
}

export interface SearchServiceDeps {
  /**
   * Custom embedding service. Defaults to EmbeddingService.instance().
   */
  embeddingService?: EmbeddingService
  liveRateLimiter?: LiveRateLimiter
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_LIMIT = 10
const DEFAULT_WEIGHTS = {
  vector: 0.55,
  keyword: 0.35,
  recency: 0.05,
  linkAuthority: 0.03,
  importance: 0.02,
}
const DEFAULT_MMR_LAMBDA = 0.7

// ============================================================================
// Filter Helpers
// ============================================================================

/**
 * Convert a glob pattern to SQL LIKE pattern.
 * - ** -> % (matches any path segments)
 * - * -> % (matches any characters within a segment)
 * - Escapes SQL special characters _ and %
 */
export function globToLike(glob: string): string {
  // First escape SQL special characters (except our glob patterns)
  let pattern = glob.replace(/%/g, '\\%').replace(/_/g, '\\_')

  // Convert glob patterns to SQL LIKE
  // Replace ** first (matches multiple path segments)
  pattern = pattern.replace(/\*\*/g, '%')
  // Then replace single * (matches any characters)
  pattern = pattern.replace(/\*/g, '%')

  return pattern
}

/**
 * Build SQL filter conditions from search options.
 * Returns an array of SQL conditions to be ANDed with existing conditions.
 */
export function buildFilterConditions(options: SearchOptions): ReturnType<typeof sql>[] {
  const conditions: ReturnType<typeof sql>[] = []

  // Filter by source type
  if (options.sourceTypes?.length) {
    conditions.push(
      sql`${memoryDocuments.sourceType} = ANY(array[${sql.join(
        options.sourceTypes.map((t) => sql`${t}`),
        sql`, `
      )}])`
    )
  }

  // Filter by frontmatter.kind
  if (options.kinds?.length) {
    conditions.push(
      sql`${memoryDocuments.frontmatter}->>'kind' = ANY(array[${sql.join(
        options.kinds.map((k) => sql`${k}`),
        sql`, `
      )}])`
    )
  }

  // Filter by frontmatter.tags (any match using ?| operator)
  if (options.tags?.length) {
    conditions.push(
      sql`${memoryDocuments.frontmatter}->'tags' ?| array[${sql.join(
        options.tags.map((t) => sql`${t}`),
        sql`, `
      )}]`
    )
  }

  // Filter by path globs (OR multiple patterns)
  if (options.paths?.length) {
    const pathConditions = options.paths.map((glob) => sql`${memoryDocuments.path} LIKE ${globToLike(glob)}`)
    if (pathConditions.length === 1) {
      conditions.push(pathConditions[0])
    } else {
      conditions.push(sql`(${sql.join(pathConditions, sql` OR `)})`)
    }
  }

  return conditions
}

function allowedSensitivityList(ceiling: SensitivityTier): SensitivityTier[] {
  const tiers: SensitivityTier[] = ['public', 'internal', 'restricted', 'confidential']
  return tiers.filter((tier) => isAllowedBy(tier, ceiling))
}

/**
 * SQL restricting rows to the caller's allowed read scopes. Queries over
 * chunks use the chunk columns; document-only queries pass the document ones.
 */
export function scopeCondition(
  scopes: AllowedScope[],
  columns: { squadId: AnyColumn; sensitivity: AnyColumn } = {
    squadId: memoryChunks.squadId,
    sensitivity: memoryChunks.sensitivity,
  }
): ReturnType<typeof sql> {
  if (scopes.length === 0) return sql`false`
  const perScope = scopes.map((scope) => {
    const conditions: ReturnType<typeof sql>[] = [sql`${columns.squadId} = ${scope.squadId}`]
    if (scope.filters.sourceTypes?.length) {
      conditions.push(
        sql`${memoryDocuments.sourceType} = ANY(array[${sql.join(
          scope.filters.sourceTypes.map((type) => sql`${type}`),
          sql`, `
        )}])`
      )
    }
    if (scope.filters.paths?.length) {
      const pathConditions = scope.filters.paths.map((glob) => sql`${memoryDocuments.path} LIKE ${globToLike(glob)}`)
      conditions.push(pathConditions.length === 1 ? pathConditions[0] : sql`(${sql.join(pathConditions, sql` OR `)})`)
    }
    if (scope.filters.sensitivityCeiling) {
      const allowed = allowedSensitivityList(scope.filters.sensitivityCeiling)
      conditions.push(
        sql`${columns.sensitivity} = ANY(array[${sql.join(
          allowed.map((tier) => sql`${tier}`),
          sql`, `
        )}])`
      )
    }
    if (scope.filters.sourceFilters) {
      const adapterRegistry = IndexingService.instance()
      for (const [sourceType, filter] of Object.entries(scope.filters.sourceFilters)) {
        const adapterFilter = adapterRegistry.getAdapter(sourceType)?.buildSearchSqlFilter?.(filter)
        if (adapterFilter) conditions.push(sql`(${memoryDocuments.sourceType} != ${sourceType} OR ${adapterFilter})`)
      }
    }
    return sql`(${sql.join(conditions, sql` AND `)})`
  })
  return sql`(${sql.join(perScope, sql` OR `)})`
}

// ============================================================================
// Class
// ============================================================================

export class SearchService {
  private static _instance: SearchService | null = null

  private embeddingService: EmbeddingService | null
  private liveRateLimiter: LiveRateLimiter

  constructor(deps: SearchServiceDeps = {}) {
    this.embeddingService = deps.embeddingService ?? null
    this.liveRateLimiter = deps.liveRateLimiter ?? defaultLiveRateLimiter
  }

  /**
   * Get the shared SearchService instance.
   */
  static instance(): SearchService {
    if (!SearchService._instance) {
      SearchService._instance = new SearchService()
    }
    return SearchService._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    SearchService._instance = null
  }

  /**
   * Get embedding service (lazy initialization).
   */
  private getEmbeddingService(): EmbeddingService {
    if (!this.embeddingService) {
      this.embeddingService = EmbeddingService.instance()
    }
    return this.embeddingService
  }

  // ==========================================================================
  // Main Search Function
  // ==========================================================================

  /**
   * Search memory documents using hybrid retrieval.
   */
  async search(squadId: string, query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? DEFAULT_LIMIT
    const mode = options.mode ?? 'hybrid' // Always use hybrid - gracefully handles missing embeddings
    const weights = { ...DEFAULT_WEIGHTS, ...options.weights }
    const mmrLambda = options.mmrLambda ?? DEFAULT_MMR_LAMBDA

    if (!query.trim()) {
      return []
    }

    const scopes = await expandReadScope(squadId, {
      sourceTypes: options.sourceTypes,
      paths: options.paths,
      sensitivity: options.sensitivity,
      sourceSquadIds: options.sourceSquadIds,
    })
    if (scopes.length === 0) return []

    const { indexedScopes, liveScopesByType } = this.partitionScopesForLiveAdapters(scopes)
    const indexedResultsPromise = (async (): Promise<SearchResult[]> => {
      switch (mode) {
        case 'vector': {
          const vectorResults = await this.vectorSearch(squadId, indexedScopes, query, limit * 2, options)
          // Fall back to keyword if no vector results (no embeddings yet)
          if (vectorResults.length === 0) {
            return withoutKeywordScore(await this.keywordSearch(indexedScopes, query, limit * 2, options))
          }
          return vectorResults
        }
        case 'hybrid':
          return this.hybridSearch(squadId, indexedScopes, query, limit * 2, weights, options)
        case 'keyword':
        default:
          return withoutKeywordScore(await this.keywordSearch(indexedScopes, query, limit * 2, options))
      }
    })()
    const liveResultsPromise = this.searchLiveAdapters(squadId, query, liveScopesByType, limit)

    const [indexedResults, liveResults] = await Promise.all([indexedResultsPromise, liveResultsPromise])
    const results = [...indexedResults, ...liveResults]

    // Apply MMR reranking for diversity
    const reranked = this.applyMmrReranking(results, mmrLambda)

    // Deduplicate by document and take top results
    const seenDocs = new Set<string>()
    const deduped: SearchResult[] = []

    for (const result of reranked) {
      if (!seenDocs.has(result.documentId)) {
        seenDocs.add(result.documentId)
        deduped.push(result)
      }
      if (deduped.length >= limit) break
    }

    await recordMemoryAccess({
      callerSquadId: squadId,
      action: 'search',
      sourceSquadIds: deduped.map((result) => result.sourceSquadId),
      resultCount: deduped.length,
    })

    return deduped
  }

  // ==========================================================================
  // Live Adapter Search
  // ==========================================================================

  private partitionScopesForLiveAdapters(scopes: AllowedScope[]): {
    indexedScopes: AllowedScope[]
    liveScopesByType: Map<string, AllowedScope[]>
  } {
    const registry = IndexingService.instance()
    const liveAdapters = registry.listLiveAdapters()
    const liveTypes = new Set(liveAdapters.map((adapter) => adapter.sourceType))
    const liveScopesByType = new Map<string, AllowedScope[]>()
    const indexedScopes: AllowedScope[] = []

    for (const scope of scopes) {
      const requestedTypes = scope.filters.sourceTypes
      const scopeLiveTypes = requestedTypes?.length
        ? requestedTypes.filter((type) => liveTypes.has(type))
        : [...liveTypes]
      for (const liveType of scopeLiveTypes) {
        const scopedSourceTypes = requestedTypes?.length ? [liveType] : undefined
        liveScopesByType.set(liveType, [
          ...(liveScopesByType.get(liveType) ?? []),
          { ...scope, filters: { ...scope.filters, sourceTypes: scopedSourceTypes } },
        ])
      }

      if (!requestedTypes?.length) {
        indexedScopes.push(scope)
        continue
      }
      const indexedTypes = requestedTypes.filter((type) => !liveTypes.has(type))
      if (indexedTypes.length > 0)
        indexedScopes.push({ ...scope, filters: { ...scope.filters, sourceTypes: indexedTypes } })
    }

    return { indexedScopes, liveScopesByType }
  }

  private async searchLiveAdapters(
    callerSquadId: string,
    query: string,
    scopesByType: Map<string, AllowedScope[]>,
    limit: number
  ): Promise<SearchResult[]> {
    const registry = IndexingService.instance()
    const entries = [...scopesByType.entries()]
    if (entries.length === 0) return []
    const quota = Math.max(1, Math.ceil(limit / entries.length))

    const settled = await Promise.all(
      entries.map(async ([sourceType, scopes]) => {
        const adapter = registry.getLiveAdapter(sourceType)
        if (!adapter || scopes.length === 0) return [] as SearchResult[]
        const results = await this.callLiveAdapter(callerSquadId, query, adapter, scopes)
        return results.slice(0, quota).map((result) => this.liveResultToSearchResult(result))
      })
    )

    return settled.flat()
  }

  private async callLiveAdapter(
    callerSquadId: string,
    query: string,
    adapter: LiveMemorySourceAdapter,
    scopes: AllowedScope[]
  ): Promise<LiveSearchResult[]> {
    const auditSourceSquadIds = Array.from(new Set(scopes.map((scope) => scope.squadId)))
    const rateLimitKey = `${callerSquadId}:${adapter.sourceType}`
    if (!this.liveRateLimiter.take(rateLimitKey, adapter.rateLimit.perMinute)) {
      await this.auditLiveCall(callerSquadId, adapter.sourceType, auditSourceSquadIds, 0)
      return [this.liveErrorResult(adapter, scopes, 'rate_limited')]
    }

    try {
      const results = await Promise.race([
        adapter.search(query, { scopes, callerSquadId, deadlineMs: adapter.timeoutMs }),
        new Promise<LiveSearchResult[]>((_, reject) =>
          setTimeout(() => reject(new Error('live memory source timed out')), adapter.timeoutMs)
        ),
      ])
      await this.auditLiveCall(callerSquadId, adapter.sourceType, auditSourceSquadIds, results.length)
      return results
    } catch (error) {
      const errorKind = error instanceof Error && error.message.includes('timed out') ? 'timeout' : 'failed'
      log.warn(`Live memory source ${adapter.sourceType} failed`, error)
      await this.auditLiveCall(callerSquadId, adapter.sourceType, auditSourceSquadIds, 0)
      return [this.liveErrorResult(adapter, scopes, errorKind)]
    }
  }

  private async auditLiveCall(
    callerSquadId: string,
    sourceType: string,
    sourceSquadIds: string[],
    resultCount: number
  ): Promise<void> {
    await recordMemoryAccess({
      callerSquadId,
      action: `live_search:${sourceType}`,
      sourceSquadIds,
      resultCount,
    })
  }

  private liveErrorResult(adapter: LiveMemorySourceAdapter, scopes: AllowedScope[], error: string): LiveSearchResult {
    return {
      sourceSquadId: scopes[0]?.squadId ?? '',
      sourceType: adapter.sourceType,
      sourceId: `__${error}__`,
      title: null,
      snippet: '',
      score: 0,
      sensitivity: adapter.defaultSensitivity,
      provenance: { error },
    }
  }

  private liveResultToSearchResult(result: LiveSearchResult): SearchResult {
    return {
      documentId: `live:${result.sourceType}:${result.sourceSquadId}:${result.sourceId}`,
      sourceSquadId: result.sourceSquadId,
      path: null,
      title: result.title,
      sourceType: result.sourceType,
      sensitivity: result.sensitivity,
      score: result.score,
      snippet: result.snippet,
      chunkIndex: 0,
      content: result.snippet,
      provenance: result.provenance,
      event: result.event,
    }
  }

  // ==========================================================================
  // Keyword Search
  // ==========================================================================

  /**
   * Keyword search: Postgres full-text ranking over chunk headings and
   * content, plus exact substring matches for identifiers and error strings
   * the text parser would split. Ranked in SQL before the limit, so an older
   * strong match is not cut in favour of a newer weak one.
   */
  private async keywordSearch(
    scopes: AllowedScope[],
    query: string,
    limit: number,
    filters: SearchOptions = {}
  ): Promise<KeywordResult[]> {
    const terms = queryTerms(query)
    const phrase = query.trim()
    const [ranked, exact] = await Promise.all([
      terms.length > 0 ? this.fullTextRows(scopes, terms, phrase, limit, filters) : Promise.resolve([]),
      phrase.length >= 3 ? this.substringRows(scopes, phrase, limit, filters) : Promise.resolve([]),
    ])

    // A chunk both queries found keeps its full-text score, which already
    // credits the verbatim match.
    const rows = new Map<string, KeywordRow>()
    for (const row of [...ranked, ...exact]) {
      const key = `${row.documentId}-${row.chunkIndex}`
      if (!rows.has(key)) rows.set(key, row)
    }

    return [...rows.values()]
      .map((row) => {
        const importance = asFrontmatter(row.docFrontmatter)?.importance
        const score = this.calculateHybridScore({
          keywordScore: row.keywordScore,
          recencyScore: this.calculateRecencyScore(row.docUpdatedAt),
          importance: typeof importance === 'number' ? importance : 0.5,
          weights: DEFAULT_WEIGHTS,
        })
        return {
          documentId: row.documentId,
          sourceSquadId: row.docSquadId,
          path: row.docPath,
          title: row.docTitle,
          sourceType: row.docSourceType,
          sensitivity: parseSensitivity(row.docSensitivity),
          score,
          keywordScore: row.keywordScore,
          snippet: this.extractSnippet(row.content, snippetTerm(row.content, phrase, terms), 200),
          chunkIndex: row.chunkIndex,
          content: row.content,
          frontmatter: asFrontmatter(row.docFrontmatter),
        }
      })
      .sort((a, b) => b.score - a.score)
  }

  private keywordColumns() {
    return {
      documentId: memoryChunks.documentId,
      chunkIndex: memoryChunks.chunkIndex,
      content: memoryChunks.content,
      docPath: memoryDocuments.path,
      docTitle: memoryDocuments.title,
      docSourceType: memoryDocuments.sourceType,
      docSquadId: memoryDocuments.squadId,
      docSensitivity: memoryDocuments.sensitivity,
      docFrontmatter: memoryDocuments.frontmatter,
      docUpdatedAt: memoryDocuments.updatedAt,
    }
  }

  private async fullTextRows(
    scopes: AllowedScope[],
    terms: string[],
    phrase: string,
    limit: number,
    filters: SearchOptions
  ): Promise<KeywordRow[]> {
    const vector = chunkSearchVector()
    const anyTerm = anyTermQuery(terms)
    // coverage: share of query words present; density: ts_rank squashed to
    // 0–1; title: the document title or path mentions a query word; phrase:
    // the whole query appears verbatim.
    const keywordScore = sql<number>`least(1.0,
      0.55 * ${termCoverage(vector, terms)}
      + 0.3 * (ts_rank(${vector}, ${anyTerm}, 1) / (ts_rank(${vector}, ${anyTerm}, 1) + 0.1))
      + 0.1 * (${documentSearchVector()} @@ ${anyTerm})::int
      + 0.15 * (${memoryChunks.content} ILIKE ${`%${escapeLike(phrase)}%`})::int
    )::float8`
    return db
      .select({ ...this.keywordColumns(), keywordScore })
      .from(memoryChunks)
      .innerJoin(memoryDocuments, eq(memoryChunks.documentId, memoryDocuments.id))
      .where(and(scopeCondition(scopes), sql`${vector} @@ ${anyTerm}`, ...buildFilterConditions(filters)))
      .orderBy(desc(keywordScore), desc(memoryDocuments.updatedAt))
      .limit(limit)
  }

  private async substringRows(
    scopes: AllowedScope[],
    phrase: string,
    limit: number,
    filters: SearchOptions
  ): Promise<KeywordRow[]> {
    const rows = await db
      .select(this.keywordColumns())
      .from(memoryChunks)
      .innerJoin(memoryDocuments, eq(memoryChunks.documentId, memoryDocuments.id))
      .where(
        and(
          scopeCondition(scopes),
          ilike(memoryChunks.content, `%${escapeLike(phrase)}%`),
          ...buildFilterConditions(filters)
        )
      )
      .orderBy(desc(memoryDocuments.updatedAt))
      .limit(limit)
    return rows.map((row) => ({ ...row, keywordScore: SUBSTRING_MATCH_SCORE }))
  }

  // ==========================================================================
  // Vector Search
  // ==========================================================================

  /**
   * Search using vector similarity (pgvector cosine distance).
   * Only searches chunks that have embeddings.
   */
  private async vectorSearch(
    squadId: string,
    scopes: AllowedScope[],
    query: string,
    limit: number,
    filters: SearchOptions = {}
  ): Promise<SearchResult[]> {
    const embeddingService = this.getEmbeddingService()

    // Check if embeddings are enabled
    if (!embeddingService.isEnabled()) {
      return []
    }

    try {
      // Get the embedding model for this squad
      const model = await embeddingService.getSquadEmbeddingModel(squadId)

      // Generate embedding for the query
      const queryEmbedding = await embeddingService.generateQueryEmbedding(query, model)

      // Build filter conditions
      const filterConditions = buildFilterConditions(filters)

      // Search using cosine distance
      // pgvector uses <=> for cosine distance (1 - similarity)
      const rows = await db
        .select({
          documentId: memoryChunks.documentId,
          chunkIndex: memoryChunks.chunkIndex,
          content: memoryChunks.content,
          docPath: memoryDocuments.path,
          docTitle: memoryDocuments.title,
          docSourceType: memoryDocuments.sourceType,
          docSquadId: memoryDocuments.squadId,
          docSensitivity: memoryDocuments.sensitivity,
          docFrontmatter: memoryDocuments.frontmatter,
          docUpdatedAt: memoryDocuments.updatedAt,
          distance: sql<number>`${memoryChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`,
        })
        .from(memoryChunks)
        .innerJoin(memoryDocuments, eq(memoryChunks.documentId, memoryDocuments.id))
        .where(and(scopeCondition(scopes), isNotNull(memoryChunks.embedding), ...filterConditions))
        .orderBy(sql`${memoryChunks.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`)
        .limit(limit)

      // Convert distance to similarity score (1 - distance for cosine)
      return rows.map((row) => {
        const vectorScore = 1 - (row.distance || 0)

        return {
          documentId: row.documentId,
          sourceSquadId: row.docSquadId,
          path: row.docPath,
          title: row.docTitle,
          sourceType: row.docSourceType,
          sensitivity: parseSensitivity(row.docSensitivity),
          score: vectorScore,
          snippet: this.extractSnippet(row.content, query, 200),
          chunkIndex: row.chunkIndex,
          content: row.content,
          frontmatter: asFrontmatter(row.docFrontmatter),
        }
      })
    } catch (e) {
      log.error('Error:', e)
      return []
    }
  }

  /**
   * Hybrid search combining vector and keyword results.
   * Merges results from both methods and applies weighted scoring.
   */
  private async hybridSearch(
    squadId: string,
    scopes: AllowedScope[],
    query: string,
    limit: number,
    weights: typeof DEFAULT_WEIGHTS,
    filters: SearchOptions = {}
  ): Promise<SearchResult[]> {
    // Run both searches in parallel
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(squadId, scopes, query, limit, filters),
      this.keywordSearch(scopes, query, limit, filters),
    ])

    // Create a map to merge results by chunk
    const resultMap = new Map<string, SearchResult & { vectorScore: number; keywordScore: number }>()

    // Add vector results
    for (const result of vectorResults) {
      const key = `${result.documentId}-${result.chunkIndex}`
      resultMap.set(key, {
        ...result,
        vectorScore: result.score,
        keywordScore: 0,
      })
    }

    // Merge keyword results
    for (const result of keywordResults) {
      const key = `${result.documentId}-${result.chunkIndex}`
      const existing = resultMap.get(key)
      if (existing) {
        existing.keywordScore = result.keywordScore
      } else {
        resultMap.set(key, {
          ...result,
          vectorScore: 0,
          keywordScore: result.keywordScore,
        })
      }
    }

    // Calculate hybrid scores
    const results = Array.from(resultMap.values()).map((result) => {
      const hybridScore = this.calculateHybridScore({
        vectorScore: result.vectorScore,
        keywordScore: result.keywordScore,
        weights,
      })

      return {
        documentId: result.documentId,
        path: result.path,
        title: result.title,
        sourceSquadId: result.sourceSquadId,
        sourceType: result.sourceType,
        sensitivity: result.sensitivity,
        score: hybridScore,
        snippet: result.snippet,
        chunkIndex: result.chunkIndex,
        content: result.content,
        frontmatter: result.frontmatter,
      }
    })

    // Sort by score
    return results.sort((a, b) => b.score - a.score)
  }

  // ==========================================================================
  // Hybrid Scoring
  // ==========================================================================

  /**
   * Calculate hybrid score from multiple signals.
   */
  calculateHybridScore(input: HybridScoreInput): number {
    const { vectorScore = 0, keywordScore = 0, recencyScore = 0, linkAuthority = 0, importance = 0.5, weights } = input

    const wv = weights.vector ?? DEFAULT_WEIGHTS.vector
    const wk = weights.keyword ?? DEFAULT_WEIGHTS.keyword
    const wr = weights.recency ?? DEFAULT_WEIGHTS.recency
    const wl = weights.linkAuthority ?? DEFAULT_WEIGHTS.linkAuthority
    const wi = weights.importance ?? DEFAULT_WEIGHTS.importance

    return wv * vectorScore + wk * keywordScore + wr * recencyScore + wl * linkAuthority + wi * importance
  }

  /**
   * Calculate recency score (0-1) based on document update time.
   * More recent documents get higher scores.
   */
  private calculateRecencyScore(updatedAt: Date): number {
    const now = Date.now()
    const docTime = updatedAt.getTime()
    const ageMs = now - docTime

    // Decay over 90 days
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
    const score = Math.max(0, 1 - ageMs / ninetyDaysMs)

    return score
  }

  // ==========================================================================
  // MMR Reranking
  // ==========================================================================

  /**
   * Apply Maximal Marginal Relevance reranking for diversity.
   *
   * MMR balances relevance and diversity:
   * MMR = λ * sim(d, q) - (1-λ) * max(sim(d, di))
   *
   * @param results - Initial search results sorted by relevance
   * @param lambda - Trade-off parameter (0-1). Higher = more relevance, lower = more diversity
   */
  applyMmrReranking(results: SearchResult[], lambda: number = DEFAULT_MMR_LAMBDA): SearchResult[] {
    if (results.length <= 1 || lambda >= 1.0) {
      return results
    }

    const selected: SearchResult[] = []
    const remaining = [...results]

    // Always select the top result first
    const top = remaining.shift()!
    selected.push(top)

    while (remaining.length > 0) {
      let bestIdx = 0
      let bestMmrScore = -Infinity

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]

        // Relevance term (normalized score)
        const relevance = candidate.score

        // Diversity term - max similarity to already selected
        let maxSimilarity = 0
        for (const sel of selected) {
          const sim = this.calculateContentSimilarity(candidate.content || '', sel.content || '')
          if (sim > maxSimilarity) maxSimilarity = sim
        }

        // MMR score
        const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity

        if (mmrScore > bestMmrScore) {
          bestMmrScore = mmrScore
          bestIdx = i
        }
      }

      // Add best MMR candidate to selected
      selected.push(remaining.splice(bestIdx, 1)[0])
    }

    return selected
  }

  /**
   * Calculate content similarity using Jaccard coefficient on word sets.
   * Simple but effective for diverse ranking.
   */
  private calculateContentSimilarity(content1: string, content2: string): number {
    const words1 = new Set(
      content1
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    )
    const words2 = new Set(
      content2
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    )

    if (words1.size === 0 || words2.size === 0) {
      return 0
    }

    // Jaccard similarity: intersection / union
    let intersection = 0
    for (const word of words1) {
      if (words2.has(word)) intersection++
    }

    const union = words1.size + words2.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Extract a snippet around the first occurrence of a term.
   */
  extractSnippet(content: string, term: string, maxLength: number): string {
    const lowerContent = content.toLowerCase()
    const lowerTerm = term.toLowerCase()
    const idx = lowerContent.indexOf(lowerTerm)

    if (idx === -1) {
      // Term not found, return start of content
      return content.slice(0, maxLength) + (content.length > maxLength ? '...' : '')
    }

    // Calculate window around match
    const contextBefore = Math.floor((maxLength - term.length) / 2)
    const start = Math.max(0, idx - contextBefore)
    const end = Math.min(content.length, start + maxLength)

    let snippet = content.slice(start, end)

    // Add ellipsis if truncated
    if (start > 0) snippet = '...' + snippet
    if (end < content.length) snippet = snippet + '...'

    return snippet
  }
}
