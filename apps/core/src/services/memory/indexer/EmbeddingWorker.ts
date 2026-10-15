/**
 * Memory Embedding Worker
 *
 * Background worker that generates embeddings for memory chunks.
 * Processes chunks without embeddings in batches.
 */

import { db } from '../../../db'
import { memoryChunks } from '../../../db/schema'
import { eq, isNull, and } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { PeriodicRunner } from '../../../lib/infra'
import { EmbeddingService } from './EmbeddingService'
import { getSettingsStore } from '../../settings'
import { createLogger } from '../../../lib/infra/logger'

const log = createLogger('embedding')

// --- Types ---

export interface EmbeddingWorkerStats {
  processed: number
  failed: number
  skipped: number
  totalTokens: number
}

export interface EmbeddingWorkerOptions {
  batchSize?: number
  maxChunks?: number
  squadId?: string
}

// --- Constants ---

const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_CHUNKS = 100
const DEFAULT_INTERVAL_MS = 30000

// --- Worker ---

export class EmbeddingWorker extends PeriodicRunner {
  private static loggedDisabled = false
  private static _instance: EmbeddingWorker | null = null

  static instance(): EmbeddingWorker {
    if (!EmbeddingWorker._instance) {
      EmbeddingWorker._instance = new EmbeddingWorker()
    }
    return EmbeddingWorker._instance
  }

  static _reset(): void {
    if (EmbeddingWorker._instance) {
      void EmbeddingWorker._instance.stop()
    }
    EmbeddingWorker._instance = null
  }

  constructor(options?: { intervalMs?: number }) {
    super({
      name: 'EmbeddingWorker',
      intervalMs: options?.intervalMs ?? DEFAULT_INTERVAL_MS,
    })
  }

  protected async runTask(): Promise<void> {
    await this.processQueue()
  }

  /**
   * Process chunks that need embeddings.
   * Returns stats about the processing run.
   */
  async processQueue(options: EmbeddingWorkerOptions = {}): Promise<EmbeddingWorkerStats> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS

    const stats: EmbeddingWorkerStats = {
      processed: 0,
      failed: 0,
      skipped: 0,
      totalTokens: 0,
    }

    const embeddingService = EmbeddingService.instance()

    // Check if embeddings are enabled
    if (!embeddingService.isEnabled()) {
      if (!EmbeddingWorker.loggedDisabled) {
        log.info('Embeddings disabled (no OPENAI_API_KEY)')
        EmbeddingWorker.loggedDisabled = true
      }
      return stats
    }

    // Check if embeddings are enabled in settings
    const embeddingsEnabled = getSettingsStore().getTyped('EMBEDDINGS_ENABLED')
    if (!embeddingsEnabled) {
      if (!EmbeddingWorker.loggedDisabled) {
        log.info('Embeddings disabled in settings')
        EmbeddingWorker.loggedDisabled = true
      }
      return stats
    }

    // Find chunks without embeddings
    const conditions = [isNull(memoryChunks.embedding)]
    if (options.squadId) {
      conditions.push(eq(memoryChunks.squadId, options.squadId))
    }

    const chunksToProcess = await db
      .select({
        id: memoryChunks.id,
        squadId: memoryChunks.squadId,
        content: memoryChunks.content,
      })
      .from(memoryChunks)
      .where(and(...conditions))
      .limit(maxChunks)

    if (chunksToProcess.length === 0) {
      // log.info('No chunks need embeddings')
      return stats
    }

    log.info(`Processing ${chunksToProcess.length} chunks`)

    // Group chunks by squad for proper model selection
    const chunksBySquad = new Map<string, typeof chunksToProcess>()
    for (const chunk of chunksToProcess) {
      const existing = chunksBySquad.get(chunk.squadId) || []
      existing.push(chunk)
      chunksBySquad.set(chunk.squadId, existing)
    }

    // Process each squad's chunks
    for (const [squadId, squadChunks] of chunksBySquad) {
      const model = await embeddingService.getSquadEmbeddingModel(squadId)

      // Process in batches
      for (let i = 0; i < squadChunks.length; i += batchSize) {
        const batch = squadChunks.slice(i, i + batchSize)
        const texts = batch.map((c) => c.content)

        try {
          const embeddings = await embeddingService.generateEmbeddings(texts, model, {
            feature: 'embedding:index',
            attribution: { squadId },
          })

          // Update chunks with embeddings
          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j]
            const embedding = embeddings[j]

            await db
              .update(memoryChunks)
              .set({
                embedding: embedding.embedding,
                metadata: sql`${memoryChunks.metadata} || ${JSON.stringify({
                  embeddingModel: embedding.model,
                  embeddingTokens: embedding.tokens,
                  embeddedAt: new Date().toISOString(),
                })}::jsonb`,
              })
              .where(eq(memoryChunks.id, chunk.id))

            stats.processed++
            stats.totalTokens += embedding.tokens
          }

          log.info(`Batch complete: ${batch.length} chunks, ${embeddings.reduce((sum, e) => sum + e.tokens, 0)} tokens`)
        } catch (e) {
          const error = e as Error
          log.error(`Batch failed:`, error.message)
          stats.failed += batch.length
        }
      }
    }

    log.info(`Complete: ${stats.processed} processed, ${stats.failed} failed, ${stats.totalTokens} tokens`)

    return stats
  }

  /**
   * Get count of chunks that need embeddings.
   */
  async getQueueSize(squadId?: string): Promise<number> {
    const conditions = [isNull(memoryChunks.embedding)]
    if (squadId) {
      conditions.push(eq(memoryChunks.squadId, squadId))
    }

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(memoryChunks)
      .where(and(...conditions))

    return Number(result[0]?.count || 0)
  }

  /**
   * Clear embeddings for a squad (useful for reprocessing with different model).
   */
  async clearEmbeddings(squadId: string): Promise<number> {
    const result = await db
      .update(memoryChunks)
      .set({ embedding: null })
      .where(eq(memoryChunks.squadId, squadId))
      .returning({ id: memoryChunks.id })

    return result.length
  }
}
