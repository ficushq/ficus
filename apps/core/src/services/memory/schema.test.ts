import { getPostgresError } from '../../db/errors'
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { squads, memoryDocuments, memoryChunks, memoryLinks } from '../../db/schema'
import { computeContentHash } from './parser'

describe('memory schema', () => {
  const testSquadId = crypto.randomUUID()
  let testDocumentId: string

  beforeAll(async () => {
    // Create a test squad for foreign key constraints
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Memory Schema Test Squad',
      purpose: 'Testing memory schema',
      status: 'active',
    })
  })

  afterAll(async () => {
    // Clean up in reverse order of dependencies
    await db.delete(memoryLinks).where(eq(memoryLinks.squadId, testSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
  })

  describe('memory_documents', () => {
    it('creates document with required fields', async () => {
      const [doc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/test.md',
          title: 'Test Document',
          path: '/memory/test.md',
          frontmatter: { kind: 'test' },
          contentHash: 'abc123',
        })
        .returning()

      testDocumentId = doc.id
      expect(doc.id).toBeDefined()
      expect(doc.squadId).toBe(testSquadId)
      expect(doc.sourceType).toBe('memory_file')
      expect(doc.sourceId).toBe('/memory/test.md')
      expect(doc.frontmatter).toEqual({ kind: 'test' })
      expect(doc.createdAt).toBeDefined()
      expect(doc.updatedAt).toBeDefined()
    })

    it('enforces unique constraint on squad_id + source_type + source_id', async () => {
      // First insert should succeed
      await db.insert(memoryDocuments).values({
        squadId: testSquadId,
        sourceType: 'memory_file',
        sourceId: '/memory/unique-test.md',
        contentHash: 'hash1',
      })

      // Second insert with same squad_id + source_type + source_id should fail
      let error: unknown
      try {
        await db.insert(memoryDocuments).values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/unique-test.md',
          contentHash: 'hash2',
        })
      } catch (e) {
        error = e
      }
      expect(getPostgresError(error)).toEqual({
        code: '23505',
        constraint: 'memory_documents_squad_id_source_type_source_id_unique',
      })
    })

    it('allows same source_id in different squads', async () => {
      const otherSquadId = crypto.randomUUID()
      await db.insert(squads).values({
        id: otherSquadId,
        name: 'Other Squad',
        purpose: 'Testing uniqueness',
        status: 'active',
      })

      try {
        // Should succeed - different squad
        const [doc] = await db
          .insert(memoryDocuments)
          .values({
            squadId: otherSquadId,
            sourceType: 'memory_file',
            sourceId: '/memory/test.md', // Same source_id as testSquadId
            contentHash: 'otherhash',
          })
          .returning()

        expect(doc.id).toBeDefined()
      } finally {
        await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, otherSquadId))
        await db.delete(squads).where(eq(squads.id, otherSquadId))
      }
    })
  })

  describe('memory_chunks', () => {
    it('creates chunk with document reference', async () => {
      const content = 'Test content for the first chunk'
      const [chunk] = await db
        .insert(memoryChunks)
        .values({
          squadId: testSquadId,
          documentId: testDocumentId,
          chunkIndex: 0,
          startLine: 1,
          endLine: 10,
          content,
          contentHash: computeContentHash(content),
          metadata: { heading: 'Introduction' },
        })
        .returning()

      expect(chunk.id).toBeDefined()
      expect(chunk.documentId).toBe(testDocumentId)
      expect(chunk.chunkIndex).toBe(0)
      expect(chunk.content).toBe('Test content for the first chunk')
      expect(chunk.embedding).toBeNull()
    })

    it('enforces unique constraint on document_id + chunk_index', async () => {
      // Create a document for this test
      const [testDoc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/chunk-unique-test.md',
          contentHash: 'uniquetest',
        })
        .returning()

      // Insert first chunk at index 1
      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: testDoc.id,
        chunkIndex: 1,
        content: 'Chunk 1',
        contentHash: computeContentHash('Chunk 1'),
      })

      // Insert second chunk at same index should fail
      let error: unknown
      try {
        await db.insert(memoryChunks).values({
          squadId: testSquadId,
          documentId: testDoc.id,
          chunkIndex: 1,
          content: 'Duplicate chunk 1',
          contentHash: computeContentHash('Duplicate chunk 1'),
        })
      } catch (e) {
        error = e
      }
      expect(getPostgresError(error)).toEqual({
        code: '23505',
        constraint: 'memory_chunks_document_id_chunk_index_unique',
      })
    })

    it('cascades delete when document is deleted', async () => {
      // Create a document with chunks
      const [tempDoc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/cascade-test.md',
          contentHash: 'cascade',
        })
        .returning()

      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: tempDoc.id,
        chunkIndex: 0,
        content: 'Chunk to be cascaded',
        contentHash: computeContentHash('Chunk to be cascaded'),
      })

      // Delete document
      await db.delete(memoryDocuments).where(eq(memoryDocuments.id, tempDoc.id))

      // Chunks should be gone
      const remainingChunks = await db.select().from(memoryChunks).where(eq(memoryChunks.documentId, tempDoc.id))

      expect(remainingChunks.length).toBe(0)
    })
  })

  describe('memory_links', () => {
    it('creates link between documents', async () => {
      // Create target document
      const [targetDoc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/target.md',
          contentHash: 'target',
        })
        .returning()

      const [link] = await db
        .insert(memoryLinks)
        .values({
          squadId: testSquadId,
          sourceDocumentId: testDocumentId,
          targetRaw: '[[target]]',
          targetDocumentId: targetDoc.id,
          targetHeading: null,
        })
        .returning()

      expect(link.id).toBeDefined()
      expect(link.sourceDocumentId).toBe(testDocumentId)
      expect(link.targetDocumentId).toBe(targetDoc.id)
      expect(link.targetRaw).toBe('[[target]]')
    })

    it('allows unresolved links (null targetDocumentId)', async () => {
      const [link] = await db
        .insert(memoryLinks)
        .values({
          squadId: testSquadId,
          sourceDocumentId: testDocumentId,
          targetRaw: '[[nonexistent]]',
          targetDocumentId: null,
          targetHeading: 'Some Heading',
        })
        .returning()

      expect(link.id).toBeDefined()
      expect(link.targetDocumentId).toBeNull()
      expect(link.targetHeading).toBe('Some Heading')
    })

    it('sets target to null when target document is deleted', async () => {
      // Create a target document
      const [targetDoc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'memory_file',
          sourceId: '/memory/to-delete.md',
          contentHash: 'todelete',
        })
        .returning()

      // Create a link to it
      const [link] = await db
        .insert(memoryLinks)
        .values({
          squadId: testSquadId,
          sourceDocumentId: testDocumentId,
          targetRaw: '[[to-delete]]',
          targetDocumentId: targetDoc.id,
        })
        .returning()

      // Delete target document
      await db.delete(memoryDocuments).where(eq(memoryDocuments.id, targetDoc.id))

      // Link should still exist but with null target
      const [updatedLink] = await db.select().from(memoryLinks).where(eq(memoryLinks.id, link.id))

      expect(updatedLink).toBeDefined()
      expect(updatedLink.targetDocumentId).toBeNull()
    })
  })
})
