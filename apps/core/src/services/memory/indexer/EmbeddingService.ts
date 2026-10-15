/**
 * Memory Embedding Service
 *
 * Generates embeddings for memory chunks using OpenAI's embedding API.
 * Supports configurable models per squad.
 */

import OpenAI from 'openai'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { squads } from '../../../db/schema'
import { getOpenAIServiceKey } from '../../integrations/openai-services/settings'
import { recordInferenceUsage } from '../../inference-usage'
import type { InferenceAttribution } from '../../inference-usage/types'

// --- Types ---

export interface EmbeddingResult {
  embedding: number[]
  model: string
  tokens: number
}

export interface EmbeddingConfig {
  model: string
  dimensions: number
}

/** What an embedding call is for, in the inference cost ledger. */
export interface EmbeddingUsageContext {
  feature: 'embedding:index' | 'embedding:search'
  attribution?: InferenceAttribution
}

export interface EmbeddingServiceDeps {
  /**
   * OpenAI API key. If not provided, uses the separately enabled OpenAI API services integration.
   */
  apiKey?: string
}

// --- Constants ---

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_DIMENSIONS = 1536

const MODEL_CONFIGS: Record<string, EmbeddingConfig> = {
  'text-embedding-3-small': { model: 'text-embedding-3-small', dimensions: 1536 },
  'text-embedding-3-large': { model: 'text-embedding-3-large', dimensions: 3072 },
  'text-embedding-ada-002': { model: 'text-embedding-ada-002', dimensions: 1536 },
}

// --- Class ---

export class EmbeddingService {
  private static _instance: EmbeddingService | null = null

  private openai: OpenAI | null = null
  private injectedApiKey: string | undefined
  private clientApiKey: string | undefined

  private get apiKey() {
    return this.injectedApiKey ?? getOpenAIServiceKey()
  }

  constructor(deps: EmbeddingServiceDeps = {}) {
    this.injectedApiKey = deps.apiKey
  }

  /**
   * Get the shared EmbeddingService instance.
   */
  static instance(): EmbeddingService {
    if (!EmbeddingService._instance) {
      EmbeddingService._instance = new EmbeddingService()
    }
    return EmbeddingService._instance
  }

  /**
   * Reset the shared instance (for testing).
   */
  static _reset(): void {
    EmbeddingService._instance = null
  }

  /**
   * Check if embeddings are enabled (API key is configured).
   */
  isEnabled(): boolean {
    return !!this.apiKey
  }

  /**
   * Get or create the OpenAI client.
   */
  private getOpenAI(): OpenAI {
    const apiKey = this.apiKey
    if (!this.openai || apiKey !== this.clientApiKey) {
      if (!apiKey) {
        throw new Error('Configure OpenAI API services in Settings → Integrations to use embeddings.')
      }
      this.openai = new OpenAI({ apiKey })
      this.clientApiKey = apiKey
    }
    return this.openai
  }

  private recordUsage(model: string, tokens: number | undefined, usage: EmbeddingUsageContext | undefined): void {
    recordInferenceUsage({
      feature: usage?.feature ?? 'embedding:index',
      provider: 'openai',
      model,
      accountId: 'openai-services',
      billing: 'api',
      tokens: { input: tokens ?? 0 },
      attribution: usage?.attribution,
    })
  }

  /**
   * Generate embedding for a single text.
   */
  async generateEmbedding(
    text: string,
    model: string = DEFAULT_MODEL,
    usage?: EmbeddingUsageContext
  ): Promise<EmbeddingResult> {
    const openai = this.getOpenAI()
    const config = MODEL_CONFIGS[model] || MODEL_CONFIGS[DEFAULT_MODEL]

    const response = await openai.embeddings.create({
      model: config.model,
      input: text,
    })
    this.recordUsage(config.model, response.usage?.total_tokens, usage)

    return {
      embedding: response.data[0].embedding,
      model: config.model,
      tokens: response.usage?.total_tokens || 0,
    }
  }

  /**
   * Generate embeddings for multiple texts (batch).
   * More efficient than calling generateEmbedding multiple times.
   */
  async generateEmbeddings(
    texts: string[],
    model: string = DEFAULT_MODEL,
    usage?: EmbeddingUsageContext
  ): Promise<EmbeddingResult[]> {
    if (texts.length === 0) {
      return []
    }

    const openai = this.getOpenAI()
    const config = MODEL_CONFIGS[model] || MODEL_CONFIGS[DEFAULT_MODEL]

    const response = await openai.embeddings.create({
      model: config.model,
      input: texts,
    })
    this.recordUsage(config.model, response.usage?.total_tokens, usage)

    const tokensPerText = Math.ceil((response.usage?.total_tokens || 0) / texts.length)

    return response.data.map((item) => ({
      embedding: item.embedding,
      model: config.model,
      tokens: tokensPerText,
    }))
  }

  /**
   * Generate embedding for a query (for search).
   * Same as generateEmbedding but returns just the vector.
   */
  async generateQueryEmbedding(
    query: string,
    model: string = DEFAULT_MODEL,
    attribution?: InferenceAttribution
  ): Promise<number[]> {
    const result = await this.generateEmbedding(query, model, { feature: 'embedding:search', attribution })
    return result.embedding
  }

  /**
   * Get the embedding model configured for a squad.
   */
  async getSquadEmbeddingModel(squadId: string): Promise<string> {
    const squad = await db.query.squads.findFirst({
      where: eq(squads.id, squadId),
    })

    if (!squad) {
      return DEFAULT_MODEL
    }

    const metadata = squad.metadata as Record<string, unknown> | null
    const memoryConfig = metadata?.memory as { embeddingModel?: string } | undefined
    return memoryConfig?.embeddingModel || DEFAULT_MODEL
  }

  /**
   * Get embedding configuration for a squad.
   */
  async getSquadEmbeddingConfig(squadId: string): Promise<EmbeddingConfig> {
    const model = await this.getSquadEmbeddingModel(squadId)
    return MODEL_CONFIGS[model] || MODEL_CONFIGS[DEFAULT_MODEL]
  }

  /**
   * Get the dimensions for a model.
   */
  getModelDimensions(model: string): number {
    return MODEL_CONFIGS[model]?.dimensions || DEFAULT_DIMENSIONS
  }

  /**
   * Validate that an embedding has the correct dimensions for a model.
   */
  validateEmbeddingDimensions(embedding: number[], model: string): boolean {
    const expected = this.getModelDimensions(model)
    return embedding.length === expected
  }
}
