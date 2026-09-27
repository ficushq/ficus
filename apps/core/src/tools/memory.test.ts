import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, writeFile, readFile } from 'fs/promises'
import { join } from 'path'
import { db } from '../db'
import { squads, memoryDocuments, memoryChunks, squadMemoryGrants } from '../db/schema'
import { eq } from 'drizzle-orm'
import { createMemoryTools, type MemoryToolWithKey } from './memory'
import { ensureSquadMemoryPath } from '../services/memory/paths'
import { IndexingService } from '../services/memory/indexer/IndexingService'
import { SquadMemoryGrant } from '../entities/SquadMemoryGrant'

const indexingService = IndexingService.instance()

describe('memory tools', () => {
  const testSquadId = crypto.randomUUID()
  let memoryPath: string
  let tools: MemoryToolWithKey[]

  beforeAll(async () => {
    // Create test squad
    await db.insert(squads).values({
      id: testSquadId,
      name: 'Memory Tools Test Squad',
      purpose: 'Testing memory tools',
      status: 'active',
    })
    memoryPath = ensureSquadMemoryPath(testSquadId)
    tools = createMemoryTools(testSquadId)
  })

  afterAll(async () => {
    // Clean up
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    await db.delete(squads).where(eq(squads.id, testSquadId))
    try {
      await rm(memoryPath, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  beforeEach(async () => {
    // Clean documents before each test
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, testSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, testSquadId))
    try {
      await rm(memoryPath, { recursive: true, force: true })
    } catch {
      // Ignore
    }
    await mkdir(memoryPath, { recursive: true })
  })

  function getTool(name: string): MemoryToolWithKey {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not found`)
    return tool
  }

  // Helper to execute tool with correct signature
  async function exec(tool: MemoryToolWithKey, params: unknown) {
    return await tool.execute('call1', params, undefined, undefined, {} as never)
  }

  describe('memory_get', () => {
    it('reads a memory file', async () => {
      const filePath = join(memoryPath, 'test.md')
      await writeFile(filePath, '# Test\n\nHello world')

      const tool = getTool('memory_get')
      const result = await exec(tool, { path: `/memory/${testSquadId}/test.md` })

      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { text: string }).text).toContain('Hello world')
    })

    it('exposes the source squad in details', async () => {
      const filePath = join(memoryPath, 'source.md')
      await writeFile(filePath, '# Source\n\nHello source')

      const tool = getTool('memory_get')
      const result = await exec(tool, { path: `/memory/${testSquadId}/source.md` })

      expect(result.details).toMatchObject({ path: `/memory/${testSquadId}/source.md`, sourceSquadId: testSquadId })
    })

    it('returns error for non-existent file', async () => {
      const tool = getTool('memory_get')
      const result = await exec(tool, { path: `/memory/${testSquadId}/nonexistent.md` })

      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { text: string }).text).toContain('does not exist')
    })

    it('rejects an out-of-tree absolute path', async () => {
      const result = await exec(getTool('memory_get'), { path: '/etc/passwd' })
      expect((result.content[0] as { text: string }).text).toContain(`/memory/${testSquadId}/`)
    })

    it('reads a namespaced path and round-trips to disk', async () => {
      await writeFile(join(memoryPath, 'test.md'), '# Test\n\nHello world')
      const result = await exec(getTool('memory_get'), { path: `/memory/${testSquadId}/test.md` })
      expect((result.content[0] as { text: string }).text).toContain('Hello world')
      expect((result.content[0] as { text: string }).text).toContain(`/memory/${testSquadId}/test.md`)
      expect(result.details).toMatchObject({ path: `/memory/${testSquadId}/test.md` })
    })

    it('accepts a bare relative path + squad arg', async () => {
      await writeFile(join(memoryPath, 'bare.md'), '# Bare\n\nbare body')
      const result = await exec(getTool('memory_get'), { path: 'bare.md', squad: testSquadId })
      expect((result.content[0] as { text: string }).text).toContain('bare body')
    })

    it('rejects a path in another squad namespace', async () => {
      const other = crypto.randomUUID()
      const result = await exec(getTool('memory_get'), { path: `/memory/${other}/x.md` })
      expect((result.content[0] as { text: string }).text).toContain('does not match')
    })
  })

  describe('memory_write', () => {
    it('creates a new file', async () => {
      const tool = getTool('memory_write')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/new.md`,
        content: '# New File\n\nContent here.',
      })

      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('success')

      const filePath = join(memoryPath, 'new.md')
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('# New File\n\nContent here.')
    })

    it('overwrites existing file', async () => {
      const filePath = join(memoryPath, 'existing.md')
      await writeFile(filePath, 'Old content')

      const tool = getTool('memory_write')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/existing.md`,
        content: 'New content',
      })

      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('success')
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('New content')
    })

    it('rejects invalid paths', async () => {
      const tool = getTool('memory_write')
      const result = await exec(tool, {
        path: '/memory/../etc/passwd',
        content: 'malicious',
      })

      expect((result.content[0] as { text: string }).text).toContain('MEMORY_PATH_INVALID')
    })

    it('writes to a granted target squad when targetSquadId is provided', async () => {
      const callerSquadId = crypto.randomUUID()
      const targetSquadId = crypto.randomUUID()
      await db.insert(squads).values([
        { id: callerSquadId, name: 'Tool Caller', purpose: 'caller', status: 'active' },
        { id: targetSquadId, name: 'Tool Target', purpose: 'target', status: 'active' },
      ])
      await SquadMemoryGrant.create({
        sourceSquadId: targetSquadId,
        granteeSquadId: callerSquadId,
        policy: { write: { sourceTypes: ['memory_file'], paths: ['/memory/shared/**'] } },
      })

      try {
        const tool = createMemoryTools(callerSquadId).find((t) => t.name === 'memory_write')!
        const result = await exec(tool, {
          path: `/memory/${callerSquadId}/shared/note.md`,
          content: '# hi\n',
          targetSquadId,
        })
        expect((result.details as { targetSquadId?: string } | undefined)?.targetSquadId).toBe(targetSquadId)
        expect((result.content[0] as { text: string }).text).toContain('wrote')
      } finally {
        await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
        await db.delete(squads).where(eq(squads.id, callerSquadId))
        await db.delete(squads).where(eq(squads.id, targetSquadId))
      }
    })

    it('rejects a squad arg that is not the bound squad', async () => {
      const result = await exec(getTool('memory_write'), { path: 'x.md', content: 'hi', squad: crypto.randomUUID() })
      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('does not match')
    })
  })

  describe('memory_patch', () => {
    it('replaces exact single match', async () => {
      const filePath = join(memoryPath, 'patch.md')
      await writeFile(filePath, 'Hello world!')

      const tool = getTool('memory_patch')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/patch.md`,
        match: 'world',
        replacement: 'universe',
      })

      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('success')
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('Hello universe!')
    })

    it('surfaces PATCH_NO_MATCH errors', async () => {
      const filePath = join(memoryPath, 'nomatch.md')
      await writeFile(filePath, 'Hello world!')

      const tool = getTool('memory_patch')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/nomatch.md`,
        match: 'nonexistent',
        replacement: 'something',
      })

      expect((result.content[0] as { text: string }).text).toContain('PATCH_NO_MATCH')
    })

    it('surfaces PATCH_AMBIGUOUS_MATCH errors', async () => {
      const filePath = join(memoryPath, 'ambiguous.md')
      await writeFile(filePath, 'foo bar foo baz foo')

      const tool = getTool('memory_patch')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/ambiguous.md`,
        match: 'foo',
        replacement: 'qux',
      })

      expect((result.content[0] as { text: string }).text).toContain('PATCH_AMBIGUOUS_MATCH')
      expect((result.content[0] as { text: string }).text).toContain('3')
    })
  })

  describe('memory_append', () => {
    it('appends content to existing file', async () => {
      const filePath = join(memoryPath, 'append.md')
      await writeFile(filePath, 'Line 1')

      const tool = getTool('memory_append')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/append.md`,
        content: '\nLine 2',
      })

      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('success')
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('Line 1\nLine 2')
    })

    it('creates file if not exists', async () => {
      const tool = getTool('memory_append')
      const result = await exec(tool, {
        path: `/memory/${testSquadId}/newappend.md`,
        content: 'First content',
      })

      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('success')
      const filePath = join(memoryPath, 'newappend.md')
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('First content')
    })
  })

  describe('memory_search', () => {
    it('searches indexed documents', async () => {
      // Create and index a file
      const filePath = join(memoryPath, 'searchable.md')
      const content = `---
title: JWT Auth Decision
kind: decision
---

# JWT Authentication

We decided to use JWT tokens for stateless authentication.`
      await writeFile(filePath, content)
      await indexingService.indexFile({ squadId: testSquadId, path: '/memory/searchable.md', content })

      const tool = getTool('memory_search')
      const result = await exec(tool, { query: 'JWT authentication' })

      expect(result.content[0].type).toBe('text')
      // Should find the document
      expect((result.content[0] as { text: string }).text).toContain('searchable.md')
    })

    it('appends a channel-invisible provenance block and structured details', async () => {
      const filePath = join(memoryPath, 'provenance.md')
      const content = `---
title: Provenance Policy
kind: reference
sensitivity: public
---

# Provenance Policy

Unique provenance needle text for structured search results.`
      await writeFile(filePath, content)
      await indexingService.indexFile({ squadId: testSquadId, path: '/memory/provenance.md', content })

      const tool = getTool('memory_search')
      const result = await exec(tool, { query: 'Unique provenance needle' })
      const text = (result.content[0] as { text: string }).text

      expect(text).toContain(`1. /memory/${testSquadId}/provenance.md`)
      const match = text.match(/<!--ficus:memory-provenance\s+(\[.*\])\s*-->/s)
      expect(match).not.toBeNull()
      const parsed = JSON.parse(match![1]) as Array<{ sourceSquadId: string; path: string; sensitivity: string }>
      expect(parsed[0]).toMatchObject({ sourceSquadId: testSquadId, path: `/memory/${testSquadId}/provenance.md` })
      expect((result.details as any).results[0]).toMatchObject({
        sourceSquadId: testSquadId,
        path: `/memory/${testSquadId}/provenance.md`,
      })
    })

    it('returns no results message when nothing found', async () => {
      const tool = getTool('memory_search')
      const result = await exec(tool, { query: 'xyzzy nonexistent query 12345' })

      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('no')
    })

    it('exposes external source types in the search parameter schema', () => {
      const tool = getTool('memory_search')
      const sourceTypeSchema = (tool.parameters as any).properties.sourceTypes.items.anyOf
      const literals = sourceTypeSchema.map((entry: { const: string }) => entry.const)

      expect(literals).toContain('slack_thread')
      expect(literals).toContain('github_issue')
      expect(literals).toContain('linear_issue')
      expect(literals).toContain('memory_file')
      expect(literals).toContain('workspace_file')
    })

    it('can filter indexed external source documents', async () => {
      const [doc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'github_issue',
          sourceId: 'acme/widgets#42',
          title: 'GitHub Issue',
          path: 'acme/widgets#42',
          frontmatter: { kind: 'issue' },
          sensitivity: 'internal',
          contentHash: 'github-issue-hash',
        })
        .returning()

      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: doc.id,
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        content: 'needle-github-only content from an external issue',
        contentHash: 'github-issue-chunk-hash',
        sensitivity: 'internal',
        metadata: { sourceType: 'github_issue' },
      })

      const tool = getTool('memory_search')
      const result = await exec(tool, { query: 'needle-github-only', sourceTypes: ['github_issue'] })
      const text = (result.content[0] as { text: string }).text

      expect(text).toContain('GitHub Issue')
      expect((result.details as any).results[0]).toMatchObject({ sourceType: 'github_issue' })
    })

    it('does not return agent thread documents while thread search is temporarily disabled', async () => {
      const [doc] = await db
        .insert(memoryDocuments)
        .values({
          squadId: testSquadId,
          sourceType: 'agent_thread',
          sourceId: crypto.randomUUID(),
          title: 'Agent Thread',
          path: null,
          frontmatter: { kind: 'thread' },
          sensitivity: 'internal',
          contentHash: 'thread-hash',
        })
        .returning()

      await db.insert(memoryChunks).values({
        squadId: testSquadId,
        documentId: doc.id,
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        content: 'needle-thread-only content from an agent conversation',
        contentHash: 'thread-chunk-hash',
        sensitivity: 'internal',
        metadata: { sourceType: 'agent_thread' },
      })

      const tool = getTool('memory_search')
      const result = await exec(tool, { query: 'needle-thread-only', sourceTypes: ['agent_thread'] })

      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { text: string }).text).toBe('No matching documents found.')
    })

    it('strips the caller namespace from an input paths glob and re-prefixes output', async () => {
      const content = '# Searchable\n\nunique-needle token here'
      await indexingService.indexFile({ squadId: testSquadId, path: '/memory/needle.md', content })
      const result = await exec(getTool('memory_search'), {
        query: 'unique-needle',
        paths: [`/memory/${testSquadId}/**`],
      })
      const text = (result.content[0] as { text: string }).text
      expect(text).toContain(`/memory/${testSquadId}/needle.md`) // input glob matched (stripped to /memory/**) AND output re-prefixed
    })
  })

  describe('memory_backlinks', () => {
    it('returns backlinks for a document', async () => {
      // Create two files with one linking to the other
      const targetPath = join(memoryPath, 'target.md')
      const sourcePath = join(memoryPath, 'source.md')

      await writeFile(targetPath, '# Target Document\n\nThis is the target.')
      await writeFile(sourcePath, '# Source\n\nLinks to [[target]].')

      // Index both
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/target.md',
        content: await readFile(targetPath, 'utf-8'),
      })
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/source.md',
        content: await readFile(sourcePath, 'utf-8'),
      })

      const tool = getTool('memory_backlinks')
      const result = await exec(tool, { path: `/memory/${testSquadId}/target.md` })

      expect(result.content[0].type).toBe('text')
      // Should find the source document as a backlink
      expect((result.content[0] as { text: string }).text).toContain('source.md')
    })

    it('returns empty when no backlinks exist', async () => {
      const filePath = join(memoryPath, 'orphan.md')
      await writeFile(filePath, '# Orphan\n\nNo one links to me.')
      await indexingService.indexFile({
        squadId: testSquadId,
        path: '/memory/orphan.md',
        content: await readFile(filePath, 'utf-8'),
      })

      const tool = getTool('memory_backlinks')
      const result = await exec(tool, { path: `/memory/${testSquadId}/orphan.md` })

      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { text: string }).text.toLowerCase()).toContain('no backlinks')
    })
  })

  describe('tool metadata', () => {
    it('creates tools with correct names', () => {
      const names = tools.map((t) => t.name)
      expect(names).toContain('memory_search')
      expect(names).toContain('memory_get')
      expect(names).toContain('memory_write')
      expect(names).toContain('memory_patch')
      expect(names).toContain('memory_append')
      expect(names).toContain('memory_backlinks')
    })

    it('each tool has description and parameters', () => {
      for (const tool of tools) {
        expect(tool.description).toBeDefined()
        expect(tool.description.length).toBeGreaterThan(10)
        expect(tool.parameters).toBeDefined()
      }
    })

    it('path param descriptions show the runtime-resolved memory root, never a mismatched container literal', () => {
      const pathTools = ['memory_get', 'memory_write', 'memory_patch', 'memory_append', 'memory_backlinks']
      const pathDescription = (list: MemoryToolWithKey[], name: string): string => {
        const tool = list.find((t) => t.name === name)
        if (!tool) throw new Error(`Tool ${name} not found`)
        return (tool.parameters as { properties: { path: { description: string } } }).properties.path.description
      }

      const prev = process.env.FICUS_SANDBOX_RUNTIME
      try {
        // Container runtimes: the root IS the container literal.
        process.env.FICUS_SANDBOX_RUNTIME = 'docker-socket'
        const containerTools = createMemoryTools(testSquadId)
        for (const name of pathTools) {
          expect(pathDescription(containerTools, name)).toContain(`/memory/${testSquadId}/<rel>`)
        }

        // vm runtime: show the squad box's ~/memory, not /memory/<squadId>.
        process.env.FICUS_SANDBOX_RUNTIME = 'vm'
        const vmTools = createMemoryTools(testSquadId)
        for (const name of pathTools) {
          expect(pathDescription(vmTools, name)).toContain('/home/box_')
          expect(pathDescription(vmTools, name)).not.toContain(`/memory/${testSquadId}`)
        }
      } finally {
        if (prev === undefined) delete process.env.FICUS_SANDBOX_RUNTIME
        else process.env.FICUS_SANDBOX_RUNTIME = prev
      }
    })
  })
})

describe('memory_search cross-squad', () => {
  const callerSquadId = crypto.randomUUID()
  const sourceSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: callerSquadId, name: 'Caller', purpose: 'Test', status: 'active' },
      { id: sourceSquadId, name: 'Source', purpose: 'Test', status: 'active' },
    ])
    await indexingService.indexFile({
      squadId: sourceSquadId,
      path: '/memory/company/policy.md',
      content: '---\ntitle: Policy\n---\n\nWidget policy details.\n',
    })
  })

  afterAll(async () => {
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, callerSquadId))
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, sourceSquadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, sourceSquadId))
    await db.delete(squads).where(eq(squads.id, callerSquadId))
    await db.delete(squads).where(eq(squads.id, sourceSquadId))
  })

  it('finds granted results through the tool', async () => {
    await SquadMemoryGrant.create({
      sourceSquadId,
      granteeSquadId: callerSquadId,
      policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'] } },
    })

    const tools = createMemoryTools(callerSquadId)
    const searchTool = tools.find((t) => t.name === 'memory_search')!
    const result = await searchTool.execute('call-1', { query: 'widget' }, undefined, undefined, {} as never)
    const text = (result.content?.[0] as { type: string; text: string }).text
    expect(text).toContain('policy.md')
    expect(text).toContain('Source squad:')
    expect(text).toContain('Sensitivity:')
  })
})

describe('memory_search layered defaults', () => {
  const squadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values({
      id: squadId,
      name: 'Defaults Squad',
      purpose: 'Test',
      status: 'active',
      metadata: { memory: { searchDefaults: { sensitivity: 'public' } } },
    })
    await indexingService.indexFile({
      squadId,
      path: '/memory/public.md',
      content: '---\ntitle: Public\nsensitivity: public\n---\n\npublic widget note\n',
    })
    await indexingService.indexFile({
      squadId,
      path: '/memory/internal.md',
      content: '---\ntitle: Internal\nsensitivity: internal\n---\n\ninternal widget note\n',
    })
  })

  afterAll(async () => {
    await db.delete(memoryChunks).where(eq(memoryChunks.squadId, squadId))
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squadId))
    await db.delete(squads).where(eq(squads.id, squadId))
  })

  it('applies squad-default sensitivity ceiling when request does not override it', async () => {
    const tools = createMemoryTools(squadId)
    const searchTool = tools.find((t) => t.name === 'memory_search')!
    const result = await searchTool.execute('call-1', { query: 'widget note' }, undefined, undefined, {} as never)
    const text = (result.content?.[0] as { text: string }).text
    expect(text).toContain('public.md')
    expect(text).not.toContain('internal.md')
  })

  it('applies agent-type and agent defaults between squad and request layers', async () => {
    const tools = createMemoryTools(squadId, {
      searchDefaults: {
        agentType: { sensitivity: 'internal' },
        agent: { paths: ['/memory/internal.md'] },
      },
    })
    const searchTool = tools.find((t) => t.name === 'memory_search')!
    const result = await searchTool.execute(
      'call-agent-defaults',
      { query: 'widget note' },
      undefined,
      undefined,
      {} as never
    )
    const text = (result.content?.[0] as { text: string }).text
    expect(text).toContain('internal.md')
    expect(text).not.toContain('public.md')
  })

  it('allows request sensitivity to override squad default', async () => {
    const tools = createMemoryTools(squadId)
    const searchTool = tools.find((t) => t.name === 'memory_search')!
    const result = await searchTool.execute(
      'call-2',
      { query: 'widget note', sensitivity: 'internal' },
      undefined,
      undefined,
      {} as never
    )
    const text = (result.content?.[0] as { text: string }).text
    expect(text).toContain('internal.md')
  })
})
