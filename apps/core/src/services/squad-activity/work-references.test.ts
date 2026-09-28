import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { SquadActivityItem } from '@ficus/shared'
import { db } from '../../db'
import { squads, workStreams } from '../../db/schema'
import { addWorkReferences } from './work-references'

const createdSquads: string[] = []
afterEach(async () => {
  for (const id of createdSquads.splice(0)) {
    await db.delete(workStreams).where(eq(workStreams.squadId, id))
    await db.delete(squads).where(eq(squads.id, id))
  }
})

async function createSquadWithWorkStream(title = 'Work references test stream') {
  const [squad] = await db
    .insert(squads)
    .values({ name: `work-references-${crypto.randomUUID()}`, purpose: 'test' })
    .returning()
  createdSquads.push(squad.id)
  const [stream] = await db.insert(workStreams).values({ squadId: squad.id, title }).returning()
  return stream
}

const item = (overrides: Partial<SquadActivityItem>): SquadActivityItem => ({
  id: `40:${crypto.randomUUID()}`,
  at: '2026-08-26T12:00:00.000Z',
  agentId: null,
  agentTypeId: null,
  kind: 'issue',
  preview: [{ text: 'summary' }],
  summary: 'summary',
  ref: { type: 'pr', url: 'https://github.com/x/y/pull/1' },
  ...overrides,
})

describe('addWorkReferences', () => {
  test('enriches an issue ref carrying a workStreamId with the work stream number', async () => {
    const stream = await createSquadWithWorkStream()
    const issueItem = item({
      kind: 'issue',
      preview: [{ text: 'Fix the bug' }],
      summary: 'Fix the bug',
      ref: { type: 'issue', url: 'https://github.com/x/y/issues/1', workStreamId: stream.id },
    })
    const [enriched] = await addWorkReferences([issueItem])
    expect(enriched.ref).toEqual({
      type: 'issue',
      url: 'https://github.com/x/y/issues/1',
      workStreamId: stream.id,
      workStreamNumber: stream.number,
    })
    // Issue summaries describe the issue, not the storage key — must be left untouched.
    expect(enriched.summary).toBe('Fix the bug')
  })

  test('leaves an issue ref without a workStreamId untouched', async () => {
    const issueItem = item({
      kind: 'issue',
      preview: [{ text: 'Fix the bug' }],
      summary: 'Fix the bug',
      ref: { type: 'issue', url: 'https://github.com/x/y/issues/1' },
    })
    const [result] = await addWorkReferences([issueItem])
    expect(result).toBe(issueItem)
  })

  test('leaves a pr ref untouched', async () => {
    const prItem = item({ kind: 'pr', ref: { type: 'pr', url: 'https://github.com/x/y/pull/1' } })
    const [result] = await addWorkReferences([prItem])
    expect(result).toBe(prItem)
  })

  test('enriches a workstream ref with its number and rewrites the [ws-… summary prefix', async () => {
    const stream = await createSquadWithWorkStream()
    const workstreamItem = item({
      kind: 'workstream',
      preview: [{ text: `[ws-${stream.id.replace(/-/g, '')} created` }],
      summary: `[ws-${stream.id.replace(/-/g, '')} created`,
      ref: { type: 'workstream', workStreamId: stream.id },
    })
    const [enriched] = await addWorkReferences([workstreamItem])
    expect(enriched.ref).toEqual({ type: 'workstream', workStreamId: stream.id, workStreamNumber: stream.number })
    expect(enriched.summary).toBe(`[#${stream.number} created`)
    expect(enriched.preview).toEqual([{ text: `[#${stream.number} created` }])
  })

  test('leaves a ref pointing at an unknown work stream id unchanged', async () => {
    const unknownId = crypto.randomUUID()
    const workstreamItem = item({
      kind: 'workstream',
      preview: [{ text: `[ws-deadbeef created` }],
      summary: `[ws-deadbeef created`,
      ref: { type: 'workstream', workStreamId: unknownId },
    })
    const [result] = await addWorkReferences([workstreamItem])
    expect(result).toBe(workstreamItem)
  })
})
