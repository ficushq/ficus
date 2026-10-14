/**
 * Memory Indexing Service
 *
 * Orchestrates memory indexing by delegating to registered MemorySourceAdapter
 * implementations. Provides convenience methods and source-agnostic
 * document operations.
 */

import { eq, and } from 'drizzle-orm'
import { db } from '../../../db'
import { memoryDocuments, memoryLinks } from '../../../db/schema'
import { FileSource, type FileContent } from '../sources/FileSource'
import { LinearLiveSource } from '../sources/LinearLiveSource'
import { ThreadSource } from '../sources/ThreadSource'
import { WorkspaceFileSource } from '../sources/WorkspaceFileSource'
import { GitHubIssueSource } from '../sources/GitHubIssueSource'
import { SlackCanvasSource } from '../sources/SlackCanvasSource'
import { SlackThreadSource } from '../sources/SlackThreadSource'
import type { IndexResult } from '../sources/types'
import type { MemorySourceAdapter } from '../sources/adapter'
import type { LiveMemorySourceAdapter } from '../sources/live-adapter'
import { withheldGitHubMemoryDocuments } from '../../integrations/github/managed-content'

// ============================================================================
// Types
// ============================================================================

export interface IndexFileInput {
  squadId: string
  path: string
  content: string
  sourceType?: 'memory_file' | 'agent_thread'
  sourceId?: string
}

// Re-exported from sources/types.ts for convenience
export type { IndexResult } from '../sources/types'

export interface MemoryDocument {
  id: string
  squadId: string
  sourceType: string
  sourceId: string
  title: string | null
  path: string | null
  frontmatter: Record<string, unknown>
  contentHash: string
  createdAt: Date
  updatedAt: Date
}

export interface BacklinkResult {
  sourcePath: string
  sourceTitle: string | null
  heading: string | null
}

// ============================================================================
// Class
// ============================================================================

export class IndexingService {
  private static _instance: IndexingService | null = null

  private adapters: Map<string, MemorySourceAdapter> = new Map()
  private liveAdapters: Map<string, LiveMemorySourceAdapter> = new Map()

  constructor() {
    // Register default sources
    this.registerAdapter(FileSource.instance())
    this.registerAdapter(ThreadSource.instance())
    this.registerAdapter(WorkspaceFileSource.instance())
    this.registerAdapter(SlackThreadSource.instance())
    this.registerAdapter(SlackCanvasSource.instance())
    this.registerAdapter(GitHubIssueSource.instance())
    this.registerLiveAdapter(LinearLiveSource.instance())
  }

  /**
   * Get the shared IndexingService instance.
   */
  static instance(): IndexingService {
    if (!IndexingService._instance) {
      IndexingService._instance = new IndexingService()
    }
    return IndexingService._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    IndexingService._instance = null
  }

  // ==========================================================================
  // Source Management
  // ==========================================================================

  /**
   * Register a memory source adapter.
   */
  registerAdapter(adapter: MemorySourceAdapter): void {
    this.adapters.set(adapter.sourceType, adapter)
  }

  getAdapter(sourceType: string): MemorySourceAdapter | undefined {
    return this.adapters.get(sourceType)
  }

  listAdapters(): MemorySourceAdapter[] {
    return [...this.adapters.values()]
  }

  registerLiveAdapter(adapter: LiveMemorySourceAdapter): void {
    this.liveAdapters.set(adapter.sourceType, adapter)
  }

  getLiveAdapter(sourceType: string): LiveMemorySourceAdapter | undefined {
    return this.liveAdapters.get(sourceType)
  }

  listLiveAdapters(): LiveMemorySourceAdapter[] {
    return [...this.liveAdapters.values()]
  }

  // ==========================================================================
  // Generic Indexing
  // ==========================================================================

  /**
   * Index content from any registered source.
   */
  async index(squadId: string, sourceType: string, sourceId: string): Promise<IndexResult> {
    const source = this.adapters.get(sourceType)
    if (!source) {
      return {
        success: false,
        chunksCreated: 0,
        linksCreated: 0,
        error: `Unknown source type: ${sourceType}`,
      }
    }
    return source.index(squadId, sourceId)
  }

  /**
   * Index all content from all registered sources.
   */
  async indexAllSources(squadId: string): Promise<Map<string, IndexResult[]>> {
    const results = new Map<string, IndexResult[]>()

    for (const [sourceType, source] of this.adapters) {
      const sourceResults = await source.indexAll(squadId)
      results.set(sourceType, sourceResults)
    }

    return results
  }

  // ==========================================================================
  // Convenience Methods (delegate to FileSource)
  // ==========================================================================

  /**
   * Index a single markdown file into the memory system.
   * Convenience method that delegates to FileSource.
   */
  async indexFile(input: IndexFileInput): Promise<IndexResult> {
    const { squadId, path, content } = input
    const fileSource = FileSource.instance()
    const results = await fileSource.indexFiles(squadId, [{ path, content }])
    return results[0]
  }

  /**
   * Index multiple markdown files in batch.
   * Convenience method that delegates to FileSource.
   */
  async indexFiles(squadId: string, files: FileContent[]): Promise<IndexResult[]> {
    return FileSource.instance().indexFiles(squadId, files)
  }

  // ==========================================================================
  // Document Operations (source-agnostic)
  // ==========================================================================

  /**
   * Delete a memory document and its associated chunks/links.
   */
  async deleteDocument(squadId: string, path: string): Promise<boolean> {
    const doc = await this.getDocumentByPath(squadId, path)

    if (!doc) {
      return false
    }

    await db.delete(memoryDocuments).where(eq(memoryDocuments.id, doc.id))
    return true
  }

  // ==========================================================================
  // Document Queries
  // ==========================================================================

  /**
   * Get a memory document by its path.
   */
  async getDocumentByPath(
    squadId: string,
    path: string,
    // Callers holding an open transaction MUST pass it: a pool read while a
    // transaction connection is held is hold-and-wait on the shared pool.
    executor: Pick<typeof db, 'select'> = db
  ): Promise<MemoryDocument | undefined> {
    const [doc] = await executor
      .select()
      .from(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, squadId),
          eq(memoryDocuments.sourceType, 'memory_file'),
          eq(memoryDocuments.sourceId, path)
        )
      )
      .limit(1)

    return doc as MemoryDocument | undefined
  }

  /**
   * Get a memory document by source type and ID.
   */
  async getDocumentBySourceId(
    squadId: string,
    sourceType: string,
    sourceId: string
  ): Promise<MemoryDocument | undefined> {
    const [doc] = await db
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

    return doc as MemoryDocument | undefined
  }

  // ==========================================================================
  // Backlinks
  // ==========================================================================

  /**
   * Get all documents that link to a given document.
   */
  async getBacklinks(squadId: string, targetPath: string): Promise<BacklinkResult[]> {
    // First, find the target document
    const targetDoc = await this.getDocumentByPath(squadId, targetPath)

    if (!targetDoc) {
      return []
    }

    // Find all links pointing to this document
    const links = await db
      .select({
        sourceDocumentId: memoryLinks.sourceDocumentId,
        sourceDocPath: memoryDocuments.path,
        sourceDocTitle: memoryDocuments.title,
        targetHeading: memoryLinks.targetHeading,
      })
      .from(memoryLinks)
      .innerJoin(memoryDocuments, eq(memoryLinks.sourceDocumentId, memoryDocuments.id))
      .where(and(eq(memoryLinks.squadId, squadId), eq(memoryLinks.targetDocumentId, targetDoc.id)))

    // A GitHub source document's title is prose; it is listed only while the author filter admits it.
    const withheld = await withheldGitHubMemoryDocuments(
      squadId,
      links.map((link) => link.sourceDocumentId)
    )
    return links
      .filter((link) => !withheld.has(link.sourceDocumentId))
      .map((link) => ({
        sourcePath: link.sourceDocPath ?? '',
        sourceTitle: link.sourceDocTitle,
        heading: link.targetHeading,
      }))
  }
}
