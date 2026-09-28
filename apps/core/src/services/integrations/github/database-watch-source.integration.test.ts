import { createBlankWorkflow, createWorkflowRun } from '@ficus/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../../../db'
import { squads, workStreams, workStreamFlowRuns } from '../../../db/schema'
import { listGitHubPrWorkStreamCandidates } from './database-watch-source'

const squadId = crypto.randomUUID()

afterEach(async () => {
  await db.delete(workStreams).where(eq(workStreams.squadId, squadId))
  await db.delete(squads).where(eq(squads.id, squadId))
})

describe('listGitHubPrWorkStreamCandidates', () => {
  test('excludes done and canceled streams at the database boundary', async () => {
    await db.insert(squads).values({ id: squadId, name: 'Polling source test', purpose: 'test' })
    await db.insert(workStreams).values(
      ['active', 'queued', 'done', 'canceled'].map((status) => ({
        squadId,
        title: status,
        status: status as 'active' | 'queued' | 'done' | 'canceled',
        metadata: { prUrl: `https://github.com/acme/widgets/pull/${status}` },
      }))
    )

    const candidates = await listGitHubPrWorkStreamCandidates()
    const own = candidates.filter((candidate) => candidate.squadId === squadId)

    expect(own.map((candidate) => candidate.status).sort()).toEqual(['active', 'queued'])
  })
})

test('database discovery projects subscriptions from the persisted flow snapshot', async () => {
  await db.insert(squads).values({ id: squadId, name: 'Flow watch source', purpose: 'test' })
  const [stream] = await db
    .insert(workStreams)
    .values({ squadId, title: 'Custom metadata', metadata: { delivery: { number: 7 } } })
    .returning()
  const definition = createBlankWorkflow()
  definition.subscriptions = [
    {
      id: 'feedback',
      source: { integration: 'github', output: 'pull_request.reviewed', version: 1 },
      match: { repository: { value: 'acme/widgets' }, 'pullRequest.number': { streamMetadata: 'delivery.number' } },
      deliver: { to: 'active', whenInactive: 'retain' },
    },
  ]
  await db.insert(workStreamFlowRuns).values({
    workStreamId: stream!.id,
    state: createWorkflowRun(definition),
    source: { schemaVersion: 1, source: { kind: 'inline' }, definition },
    createRequestId: crypto.randomUUID(),
    createRequestHash: 'fixture',
    createdBy: 'test',
  })
  const candidate = (await listGitHubPrWorkStreamCandidates()).find((candidate) => candidate.squadId === squadId)
  expect(candidate?.subscriptions).toEqual(definition.subscriptions)
})
