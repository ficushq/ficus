/**
 * Memory Outline Service
 *
 * A browsable, searchable map of indexed memory: folders, documents and
 * their heading trees. Agents navigate it to find the section they need,
 * then read that section, without embeddings or model calls.
 *
 * The tree comes from what indexing already stores: document paths and
 * titles, and the section heading recorded on each chunk.
 */

import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { db } from '../../db'
import { memoryChunks, memoryDocuments } from '../../db/schema'
import { recordMemoryAccess } from './access/audit'
import { expandReadScope, type AllowedScope, type ScopeRequest } from './access/scope-expander'
import { anyTermQuery, documentSearchVector, escapeLike, headingSearchVector, queryTerms, termCoverage } from './fts'
import { buildSections, type OutlineHeading, type OutlineSection } from './outline'
import { scopeCondition } from './SearchService'
import { withheldGitHubMemoryDocuments } from '../integrations/github/managed-content'

export type OutlineScope = ScopeRequest

export interface OutlineDocument {
  documentId: string
  sourceSquadId: string
  sourceType: string
  path: string | null
  title: string | null
}

export interface DocumentOutline extends OutlineDocument {
  sections: OutlineSection[]
  lineCount: number
}

export interface FolderEntry {
  sourceSquadId: string
  name: string
  /** Full path of the child: a folder prefix (no trailing slash) or a document path. */
  path: string
  kind: 'folder' | 'document'
  documentCount: number
  title: string | null
}

export interface UnpathedGroup {
  sourceSquadId: string
  sourceType: string
  documentCount: number
}

export type OutlineBrowse =
  | { kind: 'document'; documents: DocumentOutline[] }
  | { kind: 'folder'; prefix: string; entries: FolderEntry[]; truncated: boolean; unpathed: UnpathedGroup[] }

export interface OutlineMatch {
  document: OutlineDocument
  /** The matching section; null when the document's title or path matched. */
  section: OutlineSection | null
  score: number
}

const DEFAULT_FOLDER_LIMIT = 100
const DEFAULT_MATCH_LIMIT = 15
const HEADING_LINE = /^(#{1,6})\s+(.+)$/

const documentScope = (scopes: AllowedScope[]) =>
  scopeCondition(scopes, { squadId: memoryDocuments.squadId, sensitivity: memoryDocuments.sensitivity })

const documentColumns = {
  documentId: memoryDocuments.id,
  sourceSquadId: memoryDocuments.squadId,
  sourceType: memoryDocuments.sourceType,
  path: memoryDocuments.path,
  title: memoryDocuments.title,
}

export class OutlineService {
  private static _instance: OutlineService | null = null

  static instance(): OutlineService {
    if (!OutlineService._instance) OutlineService._instance = new OutlineService()
    return OutlineService._instance
  }

  static _reset(): void {
    OutlineService._instance = null
  }

  /**
   * Browse the map. A document path returns its heading tree; a folder path
   * (or none, for the root) lists the folder's immediate children.
   */
  async browse(
    squadId: string,
    path: string | undefined,
    scope: OutlineScope = {},
    options: { limit?: number } = {}
  ): Promise<OutlineBrowse> {
    const scopes = await expandReadScope(squadId, scope)
    if (path && !path.endsWith('/')) {
      const documents = await db
        .select(documentColumns)
        .from(memoryDocuments)
        .where(and(documentScope(scopes), eq(memoryDocuments.path, path)))
      const withheld = await withheldGitHubMemoryDocuments(
        squadId,
        documents.map((document) => document.documentId)
      )
      const visible = documents.filter((document) => !withheld.has(document.documentId))
      if (visible.length > 0) {
        const outlines = await this.withSections(visible)
        await this.audit(squadId, outlines, path)
        return { kind: 'document', documents: outlines }
      }
    }

    const prefix = path ? (path.endsWith('/') ? path : `${path}/`) : '/'
    const limit = options.limit ?? DEFAULT_FOLDER_LIMIT
    // Inlined (an integer we computed), not a bind parameter: GROUP BY must
    // see the same expression as the select list.
    const rest = sql`substr(${memoryDocuments.path}, ${sql.raw(String(prefix.length + 1))})`
    const name = sql<string>`split_part(${rest}, '/', 1)`
    const rows = await db
      .select({
        sourceSquadId: memoryDocuments.squadId,
        name,
        documentCount: sql<number>`count(*)::int`,
        isDocument: sql<boolean>`bool_and(strpos(${rest}, '/') = 0)`,
        title: sql<string | null>`min(${memoryDocuments.title})`,
      })
      .from(memoryDocuments)
      .where(and(documentScope(scopes), sql`${memoryDocuments.path} LIKE ${`${escapeLike(prefix)}%`}`))
      .groupBy(memoryDocuments.squadId, name)
      .orderBy(memoryDocuments.squadId, name)
      .limit(limit + 1)

    const unpathed =
      prefix === '/'
        ? await db
            .select({
              sourceSquadId: memoryDocuments.squadId,
              sourceType: memoryDocuments.sourceType,
              documentCount: sql<number>`count(*)::int`,
            })
            .from(memoryDocuments)
            .where(and(documentScope(scopes), isNull(memoryDocuments.path)))
            .groupBy(memoryDocuments.squadId, memoryDocuments.sourceType)
            .orderBy(memoryDocuments.squadId, memoryDocuments.sourceType)
        : []

    const entries: FolderEntry[] = rows.slice(0, limit).map((row) => ({
      sourceSquadId: row.sourceSquadId,
      name: row.name,
      path: `${prefix}${row.name}`,
      kind: row.isDocument ? 'document' : 'folder',
      documentCount: row.documentCount,
      title: row.isDocument ? row.title : null,
    }))
    await recordMemoryAccess({
      callerSquadId: squadId,
      action: 'outline',
      sourceSquadIds: [...entries, ...unpathed].map((entry) => entry.sourceSquadId),
      resultCount: entries.length,
      resourcePath: prefix,
    })
    return { kind: 'folder', prefix, entries, truncated: rows.length > limit, unpathed }
  }

  /**
   * Search the map: documents whose title or path, and sections whose
   * heading, match the query words. Content is not searched; that is what
   * memory search is for.
   */
  async search(
    squadId: string,
    query: string,
    scope: OutlineScope = {},
    options: { limit?: number } = {}
  ): Promise<OutlineMatch[]> {
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const scopes = await expandReadScope(squadId, scope)
    const limit = options.limit ?? DEFAULT_MATCH_LIMIT
    const anyTerm = anyTermQuery(terms)

    const docVector = documentSearchVector()
    const docScore = rankScore(docVector, anyTerm, terms)
    const documentHits = await db
      .select({ ...documentColumns, score: docScore })
      .from(memoryDocuments)
      .where(and(documentScope(scopes), sql`${docVector} @@ ${anyTerm}`))
      .orderBy(desc(docScore), desc(memoryDocuments.updatedAt))
      .limit(limit)

    const headingVector = headingSearchVector()
    const headingScore = sql<number>`(0.9 * ${rankScore(headingVector, anyTerm, terms)} + 0.1 * (${docVector} @@ ${anyTerm})::int)::float8`
    const headingHits = await db
      .select({ ...documentColumns, startLine: memoryChunks.startLine, score: headingScore })
      .from(memoryChunks)
      .innerJoin(memoryDocuments, eq(memoryChunks.documentId, memoryDocuments.id))
      .where(and(scopeCondition(scopes), sql`${headingVector} @@ ${anyTerm}`))
      .orderBy(desc(headingScore), desc(memoryDocuments.updatedAt))
      .limit(limit * 3)

    // GitHub titles/headings the author filter no longer admits are dropped before section assembly.
    const withheld = await withheldGitHubMemoryDocuments(squadId, [
      ...documentHits.map((hit) => hit.documentId),
      ...headingHits.map((hit) => hit.documentId),
    ])
    const visibleDocumentHits = documentHits.filter((hit) => !withheld.has(hit.documentId))
    const visibleHeadingHits = headingHits.filter((hit) => !withheld.has(hit.documentId))
    const sectionsByDocument = new Map(
      (await this.withSections(uniqueDocuments(visibleHeadingHits))).map((outline) => [
        outline.documentId,
        outline.sections,
      ])
    )
    const matches = new Map<string, OutlineMatch>()
    for (const hit of visibleHeadingHits) {
      const section = innermostSection(sectionsByDocument.get(hit.documentId) ?? [], hit.startLine)
      if (!section) continue
      const key = `${hit.documentId}:${section.startLine}`
      if (!matches.has(key)) matches.set(key, { document: pickDocument(hit), section, score: hit.score })
    }
    const documentsWithSections = new Set([...matches.values()].map((match) => match.document.documentId))
    for (const hit of visibleDocumentHits) {
      if (documentsWithSections.has(hit.documentId)) continue
      matches.set(hit.documentId, { document: pickDocument(hit), section: null, score: hit.score })
    }

    const ranked = [...matches.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    await this.audit(
      squadId,
      ranked.map((match) => match.document)
    )
    return ranked
  }

  /** Heading trees for the given documents, rebuilt from their chunks. */
  private async withSections(documents: OutlineDocument[]): Promise<DocumentOutline[]> {
    if (documents.length === 0) return []
    const chunks = await db
      .select({
        documentId: memoryChunks.documentId,
        heading: sql<string | null>`${memoryChunks.metadata} ->> 'heading'`,
        head: sql<string>`left(${memoryChunks.content}, 300)`,
        startLine: memoryChunks.startLine,
        endLine: memoryChunks.endLine,
      })
      .from(memoryChunks)
      .where(
        inArray(
          memoryChunks.documentId,
          documents.map((document) => document.documentId)
        )
      )
      .orderBy(memoryChunks.documentId, memoryChunks.chunkIndex)

    const byDocument = new Map<string, { headings: OutlineHeading[]; lastLine: number }>()
    for (const chunk of chunks) {
      const entry = byDocument.get(chunk.documentId) ?? { headings: [], lastLine: 0 }
      byDocument.set(chunk.documentId, entry)
      entry.lastLine = Math.max(entry.lastLine, chunk.endLine ?? 0)
      // A section's first chunk opens with its heading line; later chunks of
      // a long section carry the heading in metadata but do not start one.
      const opening = chunk.head.split('\n', 1)[0].match(HEADING_LINE)
      if (!opening || chunk.startLine === null || opening[2].trim() !== chunk.heading?.trim()) continue
      entry.headings.push({ heading: opening[2].trim(), level: opening[1].length, startLine: chunk.startLine })
    }

    return documents.map((document) => {
      const entry = byDocument.get(document.documentId)
      return {
        ...pickDocument(document),
        sections: entry ? buildSections(entry.headings, entry.lastLine) : [],
        lineCount: entry?.lastLine ?? 0,
      }
    })
  }

  private async audit(callerSquadId: string, documents: OutlineDocument[], resourcePath?: string): Promise<void> {
    await recordMemoryAccess({
      callerSquadId,
      action: 'outline',
      sourceSquadIds: documents.map((document) => document.sourceSquadId),
      resultCount: documents.length,
      resourcePath,
    })
  }
}

/** Coverage of the query words plus squashed ts_rank, 0–1. */
function rankScore(vector: SQL, anyTerm: SQL, terms: string[]): SQL<number> {
  return sql<number>`(0.6 * ${termCoverage(vector, terms)} + 0.4 * (ts_rank(${vector}, ${anyTerm}) / (ts_rank(${vector}, ${anyTerm}) + 0.1)))::float8`
}

function pickDocument(row: OutlineDocument): OutlineDocument {
  return {
    documentId: row.documentId,
    sourceSquadId: row.sourceSquadId,
    sourceType: row.sourceType,
    path: row.path,
    title: row.title,
  }
}

function uniqueDocuments(rows: OutlineDocument[]): OutlineDocument[] {
  const seen = new Map<string, OutlineDocument>()
  for (const row of rows) if (!seen.has(row.documentId)) seen.set(row.documentId, pickDocument(row))
  return [...seen.values()]
}

/** The deepest section containing `line`. */
function innermostSection(sections: OutlineSection[], line: number | null): OutlineSection | undefined {
  if (line === null) return undefined
  let found: OutlineSection | undefined
  for (const section of sections) {
    if (section.startLine <= line && line <= section.endLine && (!found || section.level > found.level)) {
      found = section
    }
  }
  return found
}
