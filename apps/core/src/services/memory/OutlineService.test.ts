import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../db'
import { memoryAccessAudit, memoryChunks, memoryDocuments, squadMemoryGrants, squads } from '../../db/schema'
import { SquadMemoryGrant } from '../../entities/SquadMemoryGrant'
import { IndexingService } from './indexer/IndexingService'
import { formatTrail } from './outline'
import { OutlineService } from './OutlineService'

const indexing = IndexingService.instance()
const outline = OutlineService.instance()

// Real Postgres full-text queries against the shared test database; allow
// for full-suite load like the SearchService integration tests.
const TIMEOUT_MS = 15_000

describe('OutlineService', () => {
  const squadId = crypto.randomUUID()
  const otherSquadId = crypto.randomUUID()

  beforeAll(async () => {
    await db.insert(squads).values([
      { id: squadId, name: 'Outline', purpose: 'Test', status: 'active' },
      { id: otherSquadId, name: 'Other', purpose: 'Test', status: 'active' },
    ])
    await indexing.indexFile({
      squadId,
      path: '/memory/decisions/auth.md',
      content: [
        '---',
        'title: JWT Auth Decision',
        '---',
        '',
        '# JWT Authentication Decision',
        '',
        'We use JWTs.',
        '',
        '## Rationale',
        '',
        'Stateless.',
        '',
        '```bash',
        '# rotate keys',
        'ficus secret rotate',
        '```',
        '',
        '## Implementation',
        '',
        'RS256.',
        '',
        '### Key rotation',
        '',
        'Rotate monthly.',
      ].join('\n'),
    })
    await indexing.indexFile({
      squadId,
      path: '/memory/runbooks/deploy.md',
      content: '# Deployment Runbook\n\nShip it.\n\n## Rollback\n\nRevert the tag.',
    })
    await indexing.indexFile({
      squadId,
      path: '/memory/people/owners.md',
      content: '---\ntitle: Service owners\n---\n\nAlice owns billing.',
    })
    await db.insert(memoryDocuments).values({
      squadId,
      sourceType: 'agent_thread',
      sourceId: crypto.randomUUID(),
      title: 'engineer thread',
      path: null,
      contentHash: 'thread',
    })
    await indexing.indexFile({
      squadId: otherSquadId,
      path: '/memory/company/rollback.md',
      content: '# Company rollback policy\n\n## Rollback\n\nAsk first.',
    })
  })

  afterAll(async () => {
    await db.delete(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, squadId))
    await db.delete(squadMemoryGrants).where(eq(squadMemoryGrants.granteeSquadId, squadId))
    for (const id of [squadId, otherSquadId]) {
      await db.delete(memoryChunks).where(eq(memoryChunks.squadId, id))
      await db.delete(memoryDocuments).where(eq(memoryDocuments.squadId, id))
      await db.delete(squads).where(eq(squads.id, id))
    }
  })

  it(
    'lists the top level with unpathed sources, and only the caller squad',
    async () => {
      const root = await outline.browse(squadId, undefined)
      expect(root.kind).toBe('folder')
      if (root.kind !== 'folder') return
      expect(root.entries).toEqual([
        expect.objectContaining({ name: 'memory', kind: 'folder', documentCount: 3, sourceSquadId: squadId }),
      ])
      expect(root.unpathed).toEqual([{ sourceSquadId: squadId, sourceType: 'agent_thread', documentCount: 1 }])
    },
    TIMEOUT_MS
  )

  it(
    'lists a folder as subfolders and documents',
    async () => {
      const folder = await outline.browse(squadId, '/memory')
      if (folder.kind !== 'folder') throw new Error('expected a folder')
      expect(folder.entries.map((entry) => [entry.name, entry.kind])).toEqual([
        ['decisions', 'folder'],
        ['people', 'folder'],
        ['runbooks', 'folder'],
      ])
      const people = await outline.browse(squadId, '/memory/people/')
      if (people.kind !== 'folder') throw new Error('expected a folder')
      expect(people.entries).toEqual([
        expect.objectContaining({
          name: 'owners.md',
          path: '/memory/people/owners.md',
          kind: 'document',
          title: 'Service owners',
        }),
      ])
      expect(people.unpathed).toEqual([])
    },
    TIMEOUT_MS
  )

  it(
    'returns a document heading tree, ignoring # lines in code fences',
    async () => {
      const result = await outline.browse(squadId, '/memory/decisions/auth.md')
      if (result.kind !== 'document') throw new Error('expected a document')
      const [document] = result.documents
      expect(document.title).toBe('JWT Auth Decision')
      expect(document.sections.map((section) => formatTrail(section.trail))).toEqual([
        'JWT Authentication Decision',
        'JWT Authentication Decision › Rationale',
        'JWT Authentication Decision › Implementation',
        'JWT Authentication Decision › Implementation › Key rotation',
      ])
      const rationale = document.sections[1]
      expect(rationale.endLine).toBeGreaterThan(rationale.startLine)
      expect(document.sections[3].endLine).toBe(document.lineCount)
    },
    TIMEOUT_MS
  )

  it(
    'finds sections by heading words with their trail',
    async () => {
      const matches = await outline.search(squadId, 'rollback')
      expect(matches[0]).toMatchObject({ document: { path: '/memory/runbooks/deploy.md' } })
      expect(formatTrail(matches[0].section!.trail)).toBe('Deployment Runbook › Rollback')
      expect(matches.every((match) => match.document.sourceSquadId === squadId)).toBe(true)
    },
    TIMEOUT_MS
  )

  it(
    'finds a document by title when no heading matches',
    async () => {
      const matches = await outline.search(squadId, 'owners')
      expect(matches).toEqual([
        expect.objectContaining({
          document: expect.objectContaining({ path: '/memory/people/owners.md' }),
          section: null,
        }),
      ])
    },
    TIMEOUT_MS
  )

  it(
    'does not search content',
    async () => {
      expect(await outline.search(squadId, 'billing')).toEqual([])
    },
    TIMEOUT_MS
  )

  it(
    'includes granted squads within the grant, and audits the cross-squad read',
    async () => {
      await SquadMemoryGrant.create({
        sourceSquadId: otherSquadId,
        granteeSquadId: squadId,
        policy: { read: { sourceTypes: ['memory_file'], paths: ['/memory/company/**'] } },
      })
      const matches = await outline.search(squadId, 'rollback')
      expect(matches.some((match) => match.document.sourceSquadId === otherSquadId)).toBe(true)

      const audits = await db.select().from(memoryAccessAudit).where(eq(memoryAccessAudit.callerSquadId, squadId))
      expect(audits.some((audit) => audit.action === 'outline' && audit.sourceSquadId === otherSquadId)).toBe(true)
    },
    TIMEOUT_MS
  )
})
