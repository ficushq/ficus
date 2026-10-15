/**
 * EmbeddingService Tests
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

// Mock OpenAI module BEFORE importing EmbeddingService
const mockCreate = mock(() =>
  Promise.resolve({
    data: [{ embedding: new Array(1536).fill(0.1) }],
    usage: { total_tokens: 10 },
  })
)

mock.module('openai', () => ({
  default: class OpenAI {
    embeddings = {
      create: mockCreate,
    }
  },
}))

// Import after mock setup
import { EmbeddingService } from './EmbeddingService'
import { db } from '../../../db'
import { squads } from '../../../db/schema'
import { eq } from 'drizzle-orm'
import { flushInferenceUsage, setInferenceUsageSinkForTest } from '../../inference-usage'
import type { InferenceUsageEvent } from '../../inference-usage/types'

describe('EmbeddingService', () => {
  describe('constructor and isEnabled', () => {
    it('is enabled when apiKey is provided', () => {
      const service = new EmbeddingService({ apiKey: 'test-key' })
      expect(service.isEnabled()).toBe(true)
    })

    it('is disabled when no apiKey is provided and env var is not set', () => {
      const originalKey = process.env.OPENAI_API_KEY
      delete process.env.OPENAI_API_KEY

      const service = new EmbeddingService({})
      expect(service.isEnabled()).toBe(false)

      if (originalKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalKey
    })

    it('falls back to env var when no apiKey provided', () => {
      const originalKey = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = 'env-key'

      const service = new EmbeddingService({})
      expect(service.isEnabled()).toBe(true)

      if (originalKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalKey
    })
  })

  describe('getModelDimensions', () => {
    const service = new EmbeddingService({ apiKey: 'test' })

    it('returns 1536 for text-embedding-3-small', () => {
      expect(service.getModelDimensions('text-embedding-3-small')).toBe(1536)
    })

    it('returns 3072 for text-embedding-3-large', () => {
      expect(service.getModelDimensions('text-embedding-3-large')).toBe(3072)
    })

    it('returns default 1536 for unknown models', () => {
      expect(service.getModelDimensions('unknown-model')).toBe(1536)
    })
  })

  describe('validateEmbeddingDimensions', () => {
    const service = new EmbeddingService({ apiKey: 'test' })

    it('returns true for correct dimensions', () => {
      const embedding = new Array(1536).fill(0.1)
      expect(service.validateEmbeddingDimensions(embedding, 'text-embedding-3-small')).toBe(true)
    })

    it('returns false for incorrect dimensions', () => {
      const embedding = new Array(512).fill(0.1)
      expect(service.validateEmbeddingDimensions(embedding, 'text-embedding-3-small')).toBe(false)
    })
  })

  describe('getSquadEmbeddingModel', () => {
    let testSquadId: string

    beforeEach(async () => {
      const [squad] = await db
        .insert(squads)
        .values({
          name: 'Test Squad',
          purpose: 'Testing',
          metadata: {},
        })
        .returning()
      testSquadId = squad.id
    })

    afterEach(async () => {
      await db.delete(squads).where(eq(squads.id, testSquadId))
    })

    it('returns default model when squad has no config', async () => {
      const service = new EmbeddingService({ apiKey: 'test' })
      const model = await service.getSquadEmbeddingModel(testSquadId)
      expect(model).toBe('text-embedding-3-small')
    })

    it('returns default model when squad not found', async () => {
      const service = new EmbeddingService({ apiKey: 'test' })
      // Use a valid UUID format that doesn't exist in the database
      const model = await service.getSquadEmbeddingModel('00000000-0000-0000-0000-000000000000')
      expect(model).toBe('text-embedding-3-small')
    })

    it('returns configured model from squad metadata', async () => {
      await db
        .update(squads)
        .set({
          metadata: {
            memory: {
              embeddingModel: 'text-embedding-3-large',
            },
          },
        })
        .where(eq(squads.id, testSquadId))

      const service = new EmbeddingService({ apiKey: 'test' })
      const model = await service.getSquadEmbeddingModel(testSquadId)
      expect(model).toBe('text-embedding-3-large')
    })
  })

  describe('generateEmbedding', () => {
    beforeEach(() => {
      mockCreate.mockClear()
    })

    it('generates embedding for text', async () => {
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.5) }],
        usage: { total_tokens: 15 },
      })

      const service = new EmbeddingService({ apiKey: 'test-key' })
      const result = await service.generateEmbedding('test text')

      expect(result.embedding).toHaveLength(1536)
      expect(result.model).toBe('text-embedding-3-small')
      expect(result.tokens).toBe(15)
    })

    it('uses specified model', async () => {
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(3072).fill(0.5) }],
        usage: { total_tokens: 20 },
      })

      const service = new EmbeddingService({ apiKey: 'test-key' })
      const result = await service.generateEmbedding('test text', 'text-embedding-3-large')

      expect(result.model).toBe('text-embedding-3-large')
    })
  })

  describe('generateEmbeddings', () => {
    beforeEach(() => {
      mockCreate.mockClear()
    })

    it('generates embeddings for multiple texts', async () => {
      mockCreate.mockResolvedValueOnce({
        data: [
          { embedding: new Array(1536).fill(0.1) },
          { embedding: new Array(1536).fill(0.2) },
          { embedding: new Array(1536).fill(0.3) },
        ],
        usage: { total_tokens: 30 },
      })

      const service = new EmbeddingService({ apiKey: 'test-key' })
      const results = await service.generateEmbeddings(['text 1', 'text 2', 'text 3'])

      expect(results).toHaveLength(3)
      expect(results[0].tokens).toBe(10) // 30 / 3
    })

    it('returns empty array for empty input', async () => {
      const service = new EmbeddingService({ apiKey: 'test-key' })
      const results = await service.generateEmbeddings([])

      expect(results).toEqual([])
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })

  describe('generateQueryEmbedding', () => {
    beforeEach(() => {
      mockCreate.mockClear()
    })

    it('returns just the embedding array', async () => {
      mockCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.7) }],
        usage: { total_tokens: 5 },
      })

      const service = new EmbeddingService({ apiKey: 'test-key' })
      const embedding = await service.generateQueryEmbedding('search query')

      expect(embedding).toHaveLength(1536)
      expect(embedding[0]).toBe(0.7)
    })
  })
})

describe('EmbeddingService.instance() singleton', () => {
  beforeEach(() => {
    EmbeddingService._reset()
  })

  afterEach(() => {
    EmbeddingService._reset()
  })

  it('returns the same instance on multiple calls', () => {
    const service1 = EmbeddingService.instance()
    const service2 = EmbeddingService.instance()
    expect(service1).toBe(service2)
  })

  it('returns new instance after reset', () => {
    const service1 = EmbeddingService.instance()
    EmbeddingService._reset()
    const service2 = EmbeddingService.instance()
    expect(service1).not.toBe(service2)
  })

  describe('inference cost ledger', () => {
    afterEach(() => setInferenceUsageSinkForTest(undefined))

    it('records indexing and search embeddings with their tokens and attribution', async () => {
      const seen: InferenceUsageEvent[] = []
      setInferenceUsageSinkForTest((event) => void seen.push(event))
      const squadId = '66666666-6666-4666-8666-666666666666'
      const service = new EmbeddingService({ apiKey: 'test-key' })
      await service.generateEmbeddings(['a'], 'text-embedding-3-small', {
        feature: 'embedding:index',
        attribution: { squadId },
      })
      await service.generateQueryEmbedding('q', 'text-embedding-3-large', { squadId })
      await flushInferenceUsage()
      expect(seen).toEqual([
        expect.objectContaining({
          feature: 'embedding:index',
          provider: 'openai',
          model: 'text-embedding-3-small',
          accountId: 'openai-services',
          billing: 'api',
          tokens: { input: 10 },
          attribution: { squadId },
        }),
        expect.objectContaining({
          feature: 'embedding:search',
          model: 'text-embedding-3-large',
          tokens: { input: 10 },
        }),
      ])
    })
  })
})
