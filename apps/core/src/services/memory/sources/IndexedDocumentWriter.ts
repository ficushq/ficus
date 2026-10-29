import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, type DbTx } from '../../../db'
import { memoryChunks, memoryDocuments, memoryLinks } from '../../../db/schema'
import { parseSensitivity, type SensitivityTier } from '../access/sensitivity'
import { getPolicyDefaultSensitivity } from './policy'
import { chunkByLines, chunkMarkdown, computeContentHash, parseWikilinks, type WikiLink } from '../parser'
import type { FetchedContent } from './adapter'
import type { IndexResult } from './types'

const HEADING_REGEX = /^#\s+(.+)$/m

export class IndexedDocumentWriter {
  constructor(private readonly store: typeof db | DbTx = db) {}
  private static _instance: IndexedDocumentWriter | null = null

  static instance(): IndexedDocumentWriter {
    if (!IndexedDocumentWriter._instance) IndexedDocumentWriter._instance = new IndexedDocumentWriter()
    return IndexedDocumentWriter._instance
  }

  static _reset(): void {
    IndexedDocumentWriter._instance = null
  }

  async writeDocument(input: {
    squadId: string
    sourceType: string
    sourceId: string
    fetched: FetchedContent
    adapterDefaultSensitivity: SensitivityTier
    policy?: Record<string, unknown> | null
    chunker?: 'markdown' | 'lines'
  }): Promise<IndexResult> {
    try {
      // A GitHub document's projection and all its chunks form one immutable read generation.
      // A failed replacement must preserve pending recovery and the prior snapshot together.
      if (input.sourceType === 'github_issue' && this.store === db)
        return await db.transaction(async (tx) => {
          const result = await new IndexedDocumentWriter(tx).writeDocument(input)
          if (!result.success) throw new Error(result.error ?? 'GitHub indexing failed')
          return result
        })
      const normalized = this.normalize(
        input.fetched,
        getPolicyDefaultSensitivity(input.policy) ?? input.adapterDefaultSensitivity
      )
      const contentHash = computeContentHash(JSON.stringify(normalized.frontmatter) + '\n' + input.fetched.content)
      const existingDoc = await this.getDocument(input.squadId, input.sourceType, input.sourceId)

      const rawChunks =
        input.fetched.chunks ??
        (input.chunker === 'lines' ? chunkByLines(normalized.bodyContent) : chunkMarkdown(normalized.bodyContent))
      const newChunks = rawChunks.map((chunk) => ({ ...chunk, contentHash: computeContentHash(chunk.content) }))

      if (existingDoc && existingDoc.contentHash === contentHash) {
        await this.updateExistingChunkMetadata(existingDoc.id, newChunks, normalized.chunkMetadata, input.fetched)
        return { success: true, documentId: existingDoc.id, chunksCreated: 0, linksCreated: 0, skipped: true }
      }

      const documentId = await this.upsertDocument({
        squadId: input.squadId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        title: normalized.title,
        path: normalized.path,
        frontmatter: normalized.frontmatter,
        sensitivity: normalized.sensitivity,
        contentHash,
      })

      await this.store
        .update(memoryChunks)
        .set({ sensitivity: normalized.sensitivity })
        .where(eq(memoryChunks.documentId, documentId))
      await this.store.delete(memoryLinks).where(eq(memoryLinks.sourceDocumentId, documentId))

      const existingChunks = await this.store
        .select({
          id: memoryChunks.id,
          chunkIndex: memoryChunks.chunkIndex,
          contentHash: memoryChunks.contentHash,
          metadata: memoryChunks.metadata,
        })
        .from(memoryChunks)
        .where(eq(memoryChunks.documentId, documentId))

      const existingMap = new Map(existingChunks.map((chunk) => [chunk.chunkIndex, chunk]))
      const toDelete: string[] = []
      const toInsert: typeof newChunks = []
      const preserved: number[] = []

      for (const chunk of newChunks) {
        const existing = existingMap.get(chunk.index)
        if (existing && existing.contentHash === chunk.contentHash) {
          preserved.push(chunk.index)
          await this.updateChunkMetadata(existing.id, existing.metadata, chunk, normalized.chunkMetadata, input.fetched)
          existingMap.delete(chunk.index)
        } else if (existing) {
          toDelete.push(existing.id)
          toInsert.push(chunk)
          existingMap.delete(chunk.index)
        } else {
          toInsert.push(chunk)
        }
      }

      for (const [, chunk] of existingMap) toDelete.push(chunk.id)
      if (toDelete.length > 0) await this.store.delete(memoryChunks).where(inArray(memoryChunks.id, toDelete))
      if (toInsert.length > 0) {
        await this.store.insert(memoryChunks).values(
          toInsert.map((chunk) => ({
            squadId: input.squadId,
            documentId,
            chunkIndex: chunk.index,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            contentHash: chunk.contentHash,
            metadata: {
              ...chunk.metadata,
              ...normalized.chunkMetadata,
              ...(input.fetched.chunkMetadataForChunk?.(chunk) ?? {}),
            },
            sensitivity: normalized.sensitivity,
          }))
        )
      }

      const linksCreated = await this.createLinks(input.squadId, documentId, normalized.wikilinks)
      return {
        success: true,
        documentId,
        chunksCreated: toInsert.length,
        chunksPreserved: preserved.length,
        linksCreated,
      }
    } catch (error) {
      return {
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  normalize(fetched: FetchedContent, adapterDefaultSensitivity: SensitivityTier) {
    const frontmatter = fetched.frontmatter ?? {}
    const sensitivity = fetched.sensitivity ?? parseSensitivity(frontmatter.sensitivity) ?? adapterDefaultSensitivity
    const bodyContent = fetched.content
    const title = fetched.title ?? this.extractTitle(frontmatter, bodyContent)
    return {
      frontmatter,
      bodyContent,
      title,
      path: fetched.path ?? null,
      sensitivity,
      chunkMetadata: fetched.chunkMetadata ?? {},
      wikilinks: fetched.wikilinks ?? parseWikilinks(fetched.content),
    }
  }

  private async updateExistingChunkMetadata(
    documentId: string,
    chunks: Array<ReturnType<typeof chunkMarkdown>[number] & { contentHash: string }>,
    chunkMetadata: Record<string, unknown>,
    fetched: FetchedContent
  ): Promise<void> {
    if (!fetched.chunkMetadataForChunk) return
    const existingChunks = await this.store
      .select({ id: memoryChunks.id, chunkIndex: memoryChunks.chunkIndex, metadata: memoryChunks.metadata })
      .from(memoryChunks)
      .where(eq(memoryChunks.documentId, documentId))
    const byIndex = new Map(chunks.map((chunk) => [chunk.index, chunk]))
    for (const existing of existingChunks) {
      const chunk = byIndex.get(existing.chunkIndex)
      if (chunk) await this.updateChunkMetadata(existing.id, existing.metadata, chunk, chunkMetadata, fetched)
    }
  }

  private async updateChunkMetadata(
    chunkId: string,
    existingMetadata: unknown,
    chunk: ReturnType<typeof chunkMarkdown>[number],
    chunkMetadata: Record<string, unknown>,
    fetched: FetchedContent
  ): Promise<void> {
    if (!fetched.chunkMetadataForChunk) return
    const metadata = {
      ...(existingMetadata && typeof existingMetadata === 'object'
        ? (existingMetadata as Record<string, unknown>)
        : {}),
      ...chunk.metadata,
      ...chunkMetadata,
      ...fetched.chunkMetadataForChunk(chunk),
    }
    await this.store.update(memoryChunks).set({ metadata }).where(eq(memoryChunks.id, chunkId))
  }

  private extractTitle(frontmatter: Record<string, unknown>, content: string): string | null {
    if (typeof frontmatter.title === 'string') return frontmatter.title
    return content.match(HEADING_REGEX)?.[1]?.trim() ?? null
  }

  private async getDocument(squadId: string, sourceType: string, sourceId: string) {
    const [doc] = await this.store
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, sourceType),
          eq(memoryDocuments.sourceId, sourceId)
        )
      )
      .limit(1)
    return doc
  }

  private async upsertDocument(params: {
    squadId: string
    sourceType: string
    sourceId: string
    title: string | null
    path: string | null
    frontmatter: Record<string, unknown>
    sensitivity: SensitivityTier
    contentHash: string
  }): Promise<string> {
    const existing = await this.getDocument(params.squadId, params.sourceType, params.sourceId)
    if (existing) {
      await this.store
        .update(memoryDocuments)
        .set({
          ...params,
          // Recovery is acknowledged only after fresh/admissible indexing completes.
          frontmatter:
            params.sourceType === 'github_issue'
              ? sql`${JSON.stringify(params.frontmatter)}::jsonb || case when ${memoryDocuments.frontmatter} ? 'githubReindex'
                then jsonb_build_object('githubReindex', ${memoryDocuments.frontmatter}->'githubReindex') else '{}'::jsonb end`
              : params.frontmatter,
          updatedAt: new Date(),
        })
        .where(eq(memoryDocuments.id, existing.id))
      return existing.id
    }
    const [doc] = await this.store.insert(memoryDocuments).values(params).returning()
    return doc.id
  }

  private async createLinks(squadId: string, sourceDocumentId: string, wikilinks: WikiLink[]): Promise<number> {
    if (wikilinks.length === 0) return 0
    await this.store.insert(memoryLinks).values(
      await Promise.all(
        wikilinks.map(async (link) => ({
          squadId,
          sourceDocumentId,
          targetRaw: link.raw,
          targetDocumentId: await this.resolveLinkTarget(squadId, link.target),
          targetHeading: link.heading,
        }))
      )
    )
    return wikilinks.length
  }

  private async resolveLinkTarget(squadId: string, target: string): Promise<string | null> {
    const normalizedTargets = [target, `/memory/${target}`, `/memory/${target}.md`, `${target}.md`]
    for (const path of normalizedTargets) {
      const [doc] = await this.store
        .select({ id: memoryDocuments.id })
        .from(memoryDocuments)
        .where(
          and(
            eq(memoryDocuments.squadId, squadId),
            eq(memoryDocuments.sourceType, 'memory_file'),
            eq(memoryDocuments.sourceId, path)
          )
        )
        .limit(1)
      if (doc) return doc.id
    }
    return null
  }
}
