import { createHash } from 'node:crypto'
import { expect, test } from 'bun:test'
import { inArray, sql } from 'drizzle-orm'
import { db, githubFeedbackObjects, memoryDocuments, setDatabaseQueryObserverForTest, squads } from '../../../db'
import { withheldGitHubMemoryDocuments } from './managed-content'

/** Exercise a maximum-size shared read, not a mocked overflow of the revision query. */
test('large shared reads stay current and use identity indexes in bounded batches', async () => {
  const source = crypto.randomUUID(),
    caller = crypto.randomUUID()
  await db
    .insert(squads)
    .values(
      [source, caller].map((id) => ({ id, name: 'memory scale fixture', purpose: 'test', githubAuthorFilter: false }))
    )
  try {
    // 20,200 relevant captures plus 50,000 unrelated objects, with realistic identity statistics.
    await db.execute(sql`insert into github_feedback_objects (squad_id, repository_id, object_kind, native_id)
      select squad, '900001', case when n % 101 = 0 then 'issue' else 'issue_comment' end, (100000 + n)::text
      from (values (${source}::uuid), (${caller}::uuid)) s(squad) cross join generate_series(0, 10099) n`)
    await db.execute(sql`insert into github_feedback_revisions (object_id, squad_id, sequence, content_hash, byte_count, attribution, decision, provider_version, envelope)
      select id, squad_id, 1, repeat('a',64), 0, 'creation', 'automatic', '2026-05-01T00:00:00Z', '{"data":{"content":{"body":"","title":""}}}'::jsonb
      from github_feedback_objects where squad_id in (${source}::uuid, ${caller}::uuid)`)
    await db.execute(sql`insert into github_feedback_objects (squad_id, repository_id, object_kind, native_id)
      select ${source}::uuid, '999999', 'issue_comment', n::text from generate_series(1,50000) n`)
    await db.execute(sql`analyze github_feedback_objects`)
    await db.execute(sql`analyze github_feedback_revisions`)
    const hash = createHash('sha256').update('').digest('hex')
    const documents = await db
      .insert(memoryDocuments)
      .values(
        Array.from({ length: 100 }, (_, number) => ({
          squadId: source,
          sourceType: 'github_issue',
          sourceId: `scale/repo#${number}`,
          contentHash: `scale-${number}`,
          frontmatter: {
            githubProjection: {
              schema: 2,
              repositoryId: '900001',
              filtered: false,
              parentWithheld: false,
              withheldComments: 0,
              items: Array.from({ length: 101 }, (_, item) => ({
                kind: item === 0 ? 'issue' : 'issue_comment',
                nativeId: String(100000 + number * 101 + item),
                author: '123',
                basis: 'unfiltered',
                sequence: 0,
                bodyHash: hash,
                ...(item === 0 ? { titleHash: hash } : {}),
                providerVersion: '2026-05-01T00:00:00Z',
              })),
            },
          },
        }))
      )
      .returning({ id: memoryDocuments.id })
    let observed: { query: string; params: unknown[] } | undefined
    let revisionQueries = 0
    setDatabaseQueryObserverForTest((query, params) => {
      if (query.includes('github_memory_revision_batch')) {
        observed ??= { query, params }
        revisionQueries++
      }
    })
    const start = performance.now()
    try {
      expect(
        (
          await withheldGitHubMemoryDocuments(
            caller,
            documents.map((doc) => doc.id)
          )
        ).size
      ).toBe(0)
    } finally {
      setDatabaseQueryObserverForTest(undefined)
    }
    expect(revisionQueries).toBe(41)
    expect(observed).toBeDefined()
    const statement = sql.join(
      observed!.query
        .split(/(\$\d+)/)
        .map((part) => (/^\$\d+$/.test(part) ? sql`${observed!.params[Number(part.slice(1)) - 1]}` : sql.raw(part))),
      sql.raw('')
    )
    const result = await db.execute(sql`explain (analyze, buffers, format json) ${statement}`)
    type Plan = {
      'Node Type'?: string
      'Relation Name'?: string
      'Index Name'?: string
      'Actual Rows'?: number
      'Actual Loops'?: number
      Plans?: Plan[]
    }
    const plan = (result[0]!['QUERY PLAN'] as Array<{ Plan: Plan; 'Execution Time': number }>)[0]!
    const nodes: Plan[] = []
    const visit = (node: Plan) => {
      nodes.push(node)
      node.Plans?.forEach(visit)
    }
    visit(plan.Plan)
    const objectAccess = nodes.filter((node) => node['Relation Name'] === 'github_feedback_objects')
    console.log(
      'GitHub memory scale EXPLAIN:',
      JSON.stringify({
        objects: 70200,
        captures: 20200,
        documents: 100,
        revisionQueries,
        readWallMs: Math.round(performance.now() - start),
        batchExecutionMs: plan['Execution Time'],
        access: objectAccess.map((node) => ({
          type: node['Node Type'],
          index: node['Index Name'],
          rows: node['Actual Rows'],
          loops: node['Actual Loops'],
        })),
      })
    )
    expect(objectAccess.length).toBeGreaterThan(0)
    expect(objectAccess.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false)
    expect(nodes.some((node) => node['Index Name'] === 'github_feedback_object_identity')).toBe(true)
  } finally {
    setDatabaseQueryObserverForTest(undefined)
    await db.delete(memoryDocuments).where(inArray(memoryDocuments.squadId, [source, caller]))
    await db.delete(githubFeedbackObjects).where(inArray(githubFeedbackObjects.squadId, [source, caller]))
    await db.delete(squads).where(inArray(squads.id, [source, caller]))
    await db.execute(sql`analyze github_feedback_objects`)
    await db.execute(sql`analyze github_feedback_revisions`)
  }
}, 120_000)
