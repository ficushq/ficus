import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, writeFile, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { db } from '../../db'
import { memoryAccessAudit, memoryDocuments, squadMemoryGrants, squads } from '../../db/schema'
import { and, eq } from 'drizzle-orm'
import { WriteService, validateMemoryPath, MemoryWriteError } from './WriteService'
import { SquadMemoryGrant } from '../../entities/SquadMemoryGrant'
import { ensureSquadMemoryPath } from './paths'

const writeService = WriteService.instance()

describe('memory WriteService', () => {
  const testSquadId = crypto.randomUUID()
  let memoryPath: string

  beforeAll(async () => {
    // Create test squad
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Write Service Test Squad',
      purpose: 'Testing memory write service',
      status: 'active',
    })
    memoryPath = ensureSquadMemoryPath(testSquadId)
  })

  afterAll(async () => {
    // Clean up squad
    await db.delete(squads).where(eq(squads.id, testSquadId))
    // Clean up files
    try {
      await rm(memoryPath, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  beforeEach(async () => {
    // Ensure clean memory directory before each test
    try {
      await rm(memoryPath, { recursive: true, force: true })
    } catch {
      // Ignore
    }
    await mkdir(memoryPath, { recursive: true })
  })

  describe('validateMemoryPath', () => {
    it('accepts valid /memory paths', () => {
      expect(() => validateMemoryPath('/memory/test.md')).not.toThrow()
      expect(() => validateMemoryPath('/memory/folder/file.md')).not.toThrow()
      expect(() => validateMemoryPath('/memory/deep/nested/path.md')).not.toThrow()
    })

    it('rejects paths not under /memory', () => {
      expect(() => validateMemoryPath('/other/path.md')).toThrow(MemoryWriteError)
      expect(() => validateMemoryPath('/etc/passwd')).toThrow(MemoryWriteError)
      expect(() => validateMemoryPath('relative/path.md')).toThrow(MemoryWriteError)
    })

    it('rejects path traversal attempts', () => {
      expect(() => validateMemoryPath('/memory/../etc/passwd')).toThrow(MemoryWriteError)
      expect(() => validateMemoryPath('/memory/folder/../../etc/passwd')).toThrow(MemoryWriteError)
      expect(() => validateMemoryPath('/memory/./../../etc/passwd')).toThrow(MemoryWriteError)
    })

    it('rejects null bytes in path', () => {
      expect(() => validateMemoryPath('/memory/file\x00.md')).toThrow(MemoryWriteError)
    })

    it('rejects empty path', () => {
      expect(() => validateMemoryPath('')).toThrow(MemoryWriteError)
    })

    it('rejects non-markdown files outside _system', () => {
      expect(() => validateMemoryPath('/memory/file.txt')).toThrow(MemoryWriteError)
      expect(() => validateMemoryPath('/memory/file.json')).toThrow(MemoryWriteError)
      // _system is allowed for non-markdown
      expect(() => validateMemoryPath('/memory/_system/sync-state.json')).not.toThrow()
    })
  })

  describe('write', () => {
    it('creates a new file with content', async () => {
      const path = '/memory/new-file.md'
      const content = '# Test\n\nThis is new content.'

      const result = await writeService.write(testSquadId, path, content)

      expect(result.success).toBe(true)
      expect(result.path).toBe(path)

      const filePath = join(memoryPath, 'new-file.md')
      const written = await readFile(filePath, 'utf-8')
      expect(written).toBe(content)
    })

    it('overwrites existing file', async () => {
      const path = '/memory/existing.md'
      const filePath = join(memoryPath, 'existing.md')
      await writeFile(filePath, 'Old content')

      const newContent = 'New content'
      const result = await writeService.write(testSquadId, path, newContent)

      expect(result.success).toBe(true)
      const written = await readFile(filePath, 'utf-8')
      expect(written).toBe(newContent)
    })

    it('creates parent directories if needed', async () => {
      const path = '/memory/nested/deep/file.md'
      const content = 'Nested content'

      const result = await writeService.write(testSquadId, path, content)

      expect(result.success).toBe(true)
      const filePath = join(memoryPath, 'nested/deep/file.md')
      const written = await readFile(filePath, 'utf-8')
      expect(written).toBe(content)
    })

    it('rejects invalid paths with MEMORY_PATH_INVALID', async () => {
      const path = '/memory/../etc/passwd'
      const content = 'malicious'

      const result = await writeService.write(testSquadId, path, content)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('MEMORY_PATH_INVALID')
    })

    it('deletes file when content is null', async () => {
      const path = '/memory/to-delete.md'
      const filePath = join(memoryPath, 'to-delete.md')
      await writeFile(filePath, 'This file will be deleted')
      expect(existsSync(filePath)).toBe(true)

      const result = await writeService.write(testSquadId, path, null)

      expect(result.success).toBe(true)
      expect(result.deleted).toBe(true)
      expect(result.path).toBe(path)
      expect(existsSync(filePath)).toBe(false)
    })

    it('returns error when deleting non-existent file', async () => {
      const path = '/memory/does-not-exist.md'

      const result = await writeService.write(testSquadId, path, null)

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('MEMORY_WRITE_FAILED')
      expect(result.error?.message).toContain('does not exist')
    })
  })

  describe('patch', () => {
    it('replaces exact single match', async () => {
      const path = '/memory/patch-test.md'
      const filePath = join(memoryPath, 'patch-test.md')
      await writeFile(filePath, 'Hello world, this is a test.')

      const result = await writeService.patch(testSquadId, path, 'world', 'universe')

      expect(result.success).toBe(true)
      const updated = await readFile(filePath, 'utf-8')
      expect(updated).toBe('Hello universe, this is a test.')
    })

    it('returns PATCH_NO_MATCH when match not found', async () => {
      const path = '/memory/no-match.md'
      const filePath = join(memoryPath, 'no-match.md')
      await writeFile(filePath, 'Hello world')

      const result = await writeService.patch(testSquadId, path, 'nonexistent', 'replacement')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PATCH_NO_MATCH')
    })

    it('returns PATCH_AMBIGUOUS_MATCH when multiple matches found', async () => {
      const path = '/memory/ambiguous.md'
      const filePath = join(memoryPath, 'ambiguous.md')
      await writeFile(filePath, 'foo bar foo baz foo')

      const result = await writeService.patch(testSquadId, path, 'foo', 'qux')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PATCH_AMBIGUOUS_MATCH')
      expect(result.error?.details?.matchCount).toBe(3)
    })

    it('is case-sensitive', async () => {
      const path = '/memory/case-sensitive.md'
      const filePath = join(memoryPath, 'case-sensitive.md')
      await writeFile(filePath, 'Hello World')

      const result = await writeService.patch(testSquadId, path, 'hello', 'hi')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PATCH_NO_MATCH')
    })

    it('is byte-for-byte exact (no whitespace normalization)', async () => {
      const path = '/memory/whitespace.md'
      const filePath = join(memoryPath, 'whitespace.md')
      await writeFile(filePath, 'hello  world') // two spaces

      // Match with one space should fail
      const result = await writeService.patch(testSquadId, path, 'hello world', 'hi there')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('PATCH_NO_MATCH')
    })

    it('rejects empty match string', async () => {
      const path = '/memory/empty-match.md'
      const filePath = join(memoryPath, 'empty-match.md')
      await writeFile(filePath, 'content')

      const result = await writeService.patch(testSquadId, path, '', 'replacement')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('MEMORY_PATH_INVALID')
      expect(result.error?.message).toContain('empty')
    })

    it('handles file not found', async () => {
      const path = '/memory/nonexistent.md'

      const result = await writeService.patch(testSquadId, path, 'match', 'replace')

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('MEMORY_WRITE_FAILED')
    })
  })

  describe('append', () => {
    it('appends content to existing file', async () => {
      const path = '/memory/append-test.md'
      const filePath = join(memoryPath, 'append-test.md')
      await writeFile(filePath, 'Line 1')

      const result = await writeService.append(testSquadId, path, '\nLine 2')

      expect(result.success).toBe(true)
      const updated = await readFile(filePath, 'utf-8')
      expect(updated).toBe('Line 1\nLine 2')
    })

    it('creates file if it does not exist', async () => {
      const path = '/memory/new-append.md'
      const filePath = join(memoryPath, 'new-append.md')

      const result = await writeService.append(testSquadId, path, 'First content')

      expect(result.success).toBe(true)
      const written = await readFile(filePath, 'utf-8')
      expect(written).toBe('First content')
    })

    it('normalizes newlines when appending', async () => {
      const path = '/memory/newline-normalize.md'
      const filePath = join(memoryPath, 'newline-normalize.md')
      await writeFile(filePath, 'Existing content') // no trailing newline

      // Append without leading newline - should add one
      const result = await writeService.append(testSquadId, path, 'Appended content', { ensureNewline: true })

      expect(result.success).toBe(true)
      const updated = await readFile(filePath, 'utf-8')
      expect(updated).toBe('Existing content\nAppended content')
    })
  })

  describe('advisory locking', () => {
    it('allows concurrent writes to different files', async () => {
      const path1 = '/memory/concurrent1.md'
      const path2 = '/memory/concurrent2.md'

      // Start two writes in parallel
      const [result1, result2] = await Promise.all([
        writeService.write(testSquadId, path1, 'Content 1'),
        writeService.write(testSquadId, path2, 'Content 2'),
      ])

      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
    })

    it('serializes writes to the same file', async () => {
      const path = '/memory/serialized.md'
      const filePath = join(memoryPath, 'serialized.md')
      await writeFile(filePath, '0')

      // Start multiple appends in parallel - they should be serialized
      const results = await Promise.all([
        writeService.append(testSquadId, path, '1'),
        writeService.append(testSquadId, path, '2'),
        writeService.append(testSquadId, path, '3'),
      ])

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true)

      // Final content should contain all appends (order may vary due to scheduling)
      const final = await readFile(filePath, 'utf-8')
      expect(final).toContain('0')
      expect(final).toContain('1')
      expect(final).toContain('2')
      expect(final).toContain('3')
    })
  })
})

describe('WriteService cross-squad writes', () => {
  const callerSquadId = crypto.randomUUID()
  const targetSquadId = crypto.randomUUID()
  const allowedPath = '/memory/contributions/engineering/notes.md'
  const deniedPath = '/memory/secrets/api-keys.md'

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'WS Caller', purpose: 'caller', status: 'active' },
      { id: targetSquadId, name: 'WS Target', purpose: 'target', status: 'active' },
    ])
    await SquadMemoryGrant.create({
      sourceSquadId: targetSquadId,
      granteeSquadId: callerSquadId,
      policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/contributions/**'] } },
    })
  })

  afterAll(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, targetSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, callerSquadId))
    await db.delete(squads).where(eq(squads.id, callerSquadId))
    await db.delete(squads).where(eq(squads.id, targetSquadId))
  })

  it('writeAs allows cross-squad write within granted path and audits the access', async () => {
    const result = await writeService.writeAs(callerSquadId, targetSquadId, allowedPath, '# Engineering notes\n')
    expect(result.success).toBe(true)

    const audit = await db.select().from(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    const writeAudits = audit.filter((a) => a.action === 'write' && a.resourcePath === allowedPath)
    expect(writeAudits.length).toBeGreaterThanOrEqual(1)
    expect(writeAudits[0].sourceSquadId).toBe(targetSquadId)
  })

  it('writeAs denies cross-squad write outside granted path', async () => {
    const result = await writeService.writeAs(callerSquadId, targetSquadId, deniedPath, '# leak\n')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('MEMORY_FORBIDDEN')
  })

  it('writeAs to own squad behaves like write (no audit row)', async () => {
    const ownPath = '/memory/notes/own.md'
    const beforeRows = await db
      .select()
      .from(memoryAccessAudit)
      .where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    const result = await writeService.writeAs(callerSquadId, callerSquadId, ownPath, '# own\n')
    expect(result.success).toBe(true)
    const afterRows = await db
      .select()
      .from(memoryAccessAudit)
      .where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    expect(afterRows.length).toBe(beforeRows.length)
  })

  it('patchAs and appendAs respect the same grant', async () => {
    await writeService.writeAs(callerSquadId, targetSquadId, allowedPath, 'hello world\n')
    const patchResult = await writeService.patchAs(callerSquadId, targetSquadId, allowedPath, 'world', 'ficus')
    expect(patchResult.success).toBe(true)

    const appendResult = await writeService.appendAs(callerSquadId, targetSquadId, allowedPath, '\nmore\n')
    expect(appendResult.success).toBe(true)

    const deniedPatch = await writeService.patchAs(callerSquadId, targetSquadId, deniedPath, 'a', 'b')
    expect(deniedPatch.success).toBe(false)
    expect(deniedPatch.error?.code).toBe('MEMORY_FORBIDDEN')
  })
})

describe('WriteService.read cross-squad', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()
  const sharedPath = '/memory/company/policy.md'

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Caller', purpose: 'Test', status: 'active' },
      { id: sourceSquadId, name: 'Source', purpose: 'Test', status: 'active' },
    ])
    await writeService.write(sourceSquadId, sharedPath, '# Source policy\n')
  })

  afterAll(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, sourceSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, callerSquadId))
    await db.delete(squads).where(eq(squads.id, callerSquadId))
    await db.delete(squads).where(eq(squads.id, sourceSquadId))
  })

  beforeEach(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, callerSquadId))
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
  })

  it('returns own squad content first when the path exists in own squad', async () => {
    await writeService.write(callerSquadId, sharedPath, '# Caller policy\n')
    const result = await writeService.read(callerSquadId, sharedPath)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('Caller policy')
      expect(result.sourceSquadId).toBe(callerSquadId)
    }
  })

  it('falls through to a granted source squad when own squad lacks the path', async () => {
    const sourceOnlyPath = '/memory/company/source-only.md'
    await writeService.write(sourceSquadId, sourceOnlyPath, '# Source only\n')
    await db.insert(memoryDocuments).values({
      squadId: sourceSquadId,
      sourceType: 'memory_file',
      sourceId: sourceOnlyPath,
      path: sourceOnlyPath,
      sensitivity: 'internal',
      contentHash: crypto.randomUUID(),
    })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'] } },
    })

    const result = await writeService.read(callerSquadId, sourceOnlyPath)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('Source only')
      expect(result.sourceSquadId).toBe(sourceSquadId)
    }
  })

  it('does not read ungranted paths', async () => {
    await writeService.write(sourceSquadId, '/memory/private.md', '# Private\n')
    const result = await writeService.read(callerSquadId, '/memory/private.md')
    expect(result.success).toBe(false)
  })

  it('does not return cross-squad file content above the grant sensitivity ceiling', async () => {
    const confidentialPath = '/memory/company/confidential.md'
    await writeService.write(sourceSquadId, confidentialPath, '# Confidential\n')
    await db
      .insert(memoryDocuments)
      .values({
        squadId: sourceSquadId,
        sourceType: 'memory_file',
        sourceId: confidentialPath,
        path: confidentialPath,
        sensitivity: 'confidential',
        contentHash: crypto.randomUUID(),
      })
      .onConflictDoUpdate({
        target: [memoryDocuments.squadId, memoryDocuments.sourceType, memoryDocuments.sourceId],
        set: { sensitivity: 'confidential', contentHash: crypto.randomUUID() },
      })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'internal' } },
    })

    const result = await writeService.read(callerSquadId, confidentialPath)

    expect(result.success).toBe(false)
  })

  it('returns cross-squad file content at or below the grant sensitivity ceiling', async () => {
    const internalPath = '/memory/company/internal.md'
    await writeService.write(sourceSquadId, internalPath, '# Internal\n')
    await db
      .insert(memoryDocuments)
      .values({
        squadId: sourceSquadId,
        sourceType: 'memory_file',
        sourceId: internalPath,
        path: internalPath,
        sensitivity: 'internal',
        contentHash: crypto.randomUUID(),
      })
      .onConflictDoUpdate({
        target: [memoryDocuments.squadId, memoryDocuments.sourceType, memoryDocuments.sourceId],
        set: { sensitivity: 'internal', contentHash: crypto.randomUUID() },
      })
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'internal' } },
    })

    const result = await writeService.read(callerSquadId, internalPath)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.content).toContain('Internal')
      expect(result.sourceSquadId).toBe(sourceSquadId)
    }
  })

  it('fails closed for cross-squad file reads when the indexed document is missing', async () => {
    const unindexedPath = '/memory/company/unindexed.md'
    await writeService.write(sourceSquadId, unindexedPath, '# Unindexed\n')
    await db
      .delete(memoryDocuments)
      .where(
        and(
          eq(memoryDocuments.squadId, sourceSquadId),
          eq(memoryDocuments.sourceType, 'memory_file'),
          eq(memoryDocuments.sourceId, unindexedPath)
        )
      )
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'], sensitivity: 'confidential' } },
    })

    const result = await writeService.read(callerSquadId, unindexedPath)

    expect(result.success).toBe(false)
  })
})
