import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db, memoryDocuments, squads } from '../../db'
import { Squad } from '../../entities/Squad'
import { ingestWorkspaceFiles } from './workspace-files'

describe('ingestWorkspaceFiles', () => {
  let squad: Squad

  beforeEach(async () => {
    squad = await Squad.create({ name: `ws-ingest-${Date.now()}`, purpose: 'test' })
  })

  afterEach(async () => {
    await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, squad.id))
    await db.delete(squads).where(eq(squads.id, squad.id))
  })

  test('returns squadFound false for an unknown squad', async () => {
    const result = await ingestWorkspaceFiles('nope', { files: [] })
    expect(result.squadFound).toBe(false)
    expect(result.indexed).toBe(0)
  })

  test('never indexes the workspace settings directory', async () => {
    const result = await ingestWorkspaceFiles(squad.id, {
      files: [
        { path: '.ficus/notes.md', content: '# Settings', event: 'change' },
        { path: './.FICUS/other.md', content: '# Settings', event: 'change' },
        { path: 'docs/.ficus/kept.md', content: '# Kept', event: 'change' },
      ],
    })
    expect(result.indexed).toBe(1)
    const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, squad.id))
    expect(
      docs.map((doc) => doc.path ?? doc.sourceId).every((value) => !/\/\.ficus\/notes|other\.md/i.test(value))
    ).toBe(true)
  })

  test('indexes changes, deletes on delete, and reconciles stale docs away', async () => {
    const first = await ingestWorkspaceFiles(squad.id, {
      files: [
        { path: 'docs/a.md', content: '# A', event: 'change' },
        { path: 'docs/b.md', content: '# B', event: 'change' },
      ],
      reconcile: true,
    })
    expect(first.squadFound).toBe(true)
    expect(first.indexed).toBe(2)

    const second = await ingestWorkspaceFiles(squad.id, {
      files: [
        { path: 'docs/a.md', content: '# A2', event: 'change' },
        { path: 'docs/b.md', content: null, event: 'delete' },
      ],
      reconcile: true,
    })
    expect(second.indexed).toBe(1)
    expect(second.deleted).toBe(1)

    const docs = await db.select().from(memoryDocuments).where(eq(memoryDocuments.squadId, squad.id))
    expect(docs.length).toBe(1) // only a.md survives (delete + reconcile removed b.md)
    expect(docs[0].path).toBe(`/workspace/${squad.id}/docs/a.md`)
  })

  test('records workspaceScanStatus on the squad row when reconciling', async () => {
    await ingestWorkspaceFiles(squad.id, {
      files: [
        { path: 'docs/a.md', content: '# A', event: 'change' },
        { path: 'docs/huge.md', content: null, event: 'change' },
      ],
      reconcile: true,
      skipped: [{ path: 'docs/huge.md', reason: 'file_too_large', detail: '200KB exceeds 100KB limit' }],
    })

    const row = await Squad.mustFind(squad.id)
    const memory = row.metadata?.memory as
      | {
          workspaceScanStatus?: { lastScan?: string; filesIndexed?: number; skipped?: unknown[] }
        }
      | undefined
    const scanStatus = memory?.workspaceScanStatus
    expect(scanStatus?.lastScan).toBeTruthy()
    expect(scanStatus?.filesIndexed).toBe(2) // both change events, including the skipped one
    expect(Array.isArray(scanStatus?.skipped)).toBe(true)
  })

  test('non-reconcile runs do not touch workspaceScanStatus', async () => {
    await ingestWorkspaceFiles(squad.id, { files: [{ path: 'docs/a.md', content: '# A', event: 'change' }] })
    const row = await Squad.mustFind(squad.id)
    const memory = row.metadata?.memory as { workspaceScanStatus?: unknown } | undefined
    expect(memory?.workspaceScanStatus).toBeUndefined()
  })
})
