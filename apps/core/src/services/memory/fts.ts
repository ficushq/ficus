/**
 * Postgres full-text helpers for memory keyword search and outline search.
 *
 * Plain SQL, no extensions and no model calls: this is what memory search
 * runs on when no embeddings are configured.
 */

import { sql, type SQL } from 'drizzle-orm'
import { memoryChunks, memoryDocuments } from '../../db/schema'

const MAX_TERMS = 12

// Postgres's `english` stop words. They produce empty tsqueries (and a server
// NOTICE per query), so they are dropped before any SQL is built.
const STOP_WORDS = new Set(
  (
    'i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers ' +
    'herself it its itself they them their theirs themselves what which who whom this that these those am is ' +
    'are was were be been being have has had having do does did doing a an the and but if or because as until ' +
    'while of at by for with about against between into through during before after above below to from up ' +
    'down in out on off over under again further then once here there when where why how all any both each ' +
    'few more most other some such no nor not only own same so than too very s t can will just don should now'
  ).split(' ')
)

/**
 * Query words worth matching: whitespace-separated, deduplicated, stop words
 * and bare punctuation removed. Hyphenated or dotted identifiers stay whole.
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = []
  for (const raw of query.toLowerCase().split(/\s+/)) {
    const term = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (!term || STOP_WORDS.has(term) || terms.includes(term)) continue
    terms.push(term)
    if (terms.length === MAX_TERMS) break
  }
  return terms
}

/**
 * One query word as a tsquery. Words of three or more characters also match
 * as a prefix ("auth" finds "authentication"), the way the ILIKE search this
 * replaced did.
 */
function termQuery(term: string): SQL {
  const plain = sql`plainto_tsquery('english'::regconfig, ${term})`
  if (term.length < 3) return plain
  return sql`(CASE WHEN numnode(${plain}) = 0 THEN ${plain} ELSE (${plain}::text || ':*')::tsquery END)`
}

/** Matches any of the terms. */
export function anyTermQuery(terms: string[]): SQL {
  return sql`(${sql.join(terms.map(termQuery), sql` || `)})`
}

/** Fraction of the terms `vector` matches (0–1). */
export function termCoverage(vector: SQL, terms: string[]): SQL {
  const hits = terms.map((term) => sql`(${vector} @@ ${termQuery(term)})::int`)
  return sql`((${sql.join(hits, sql` + `)})::float / ${terms.length})`
}

/**
 * A chunk's searchable text: its section heading (weight A) and its content
 * (weight C). Must stay identical to the idx_memory_chunks_fts expression in
 * db/schema.ts so the planner uses that index.
 */
export function chunkSearchVector(): SQL {
  return sql`(setweight(to_tsvector('english'::regconfig, coalesce(${memoryChunks.metadata} ->> 'heading', '')), 'A') || setweight(to_tsvector('english'::regconfig, ${memoryChunks.content}), 'C'))`
}

/** A chunk's section heading alone. */
export function headingSearchVector(): SQL {
  return sql`to_tsvector('english'::regconfig, coalesce(${memoryChunks.metadata} ->> 'heading', ''))`
}

/** A document's title (weight A) and path words (weight B). */
export function documentSearchVector(): SQL {
  return sql`(setweight(to_tsvector('english'::regconfig, coalesce(${memoryDocuments.title}, '')), 'A') || setweight(to_tsvector('english'::regconfig, translate(coalesce(${memoryDocuments.path}, ''), '/._-', '    ')), 'B'))`
}

/** Escape `%`, `_` and `\` for a LIKE/ILIKE pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}
