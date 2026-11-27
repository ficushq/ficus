import { describe, expect, test } from 'bun:test'
import type { WorkStream } from '@ficus/shared'
import { createStatusTools, VOICE_FINISHED_LIMIT, voiceWorkStreamStatus } from './statusTools'

function stream(overrides: Partial<WorkStream> = {}): WorkStream {
  return {
    id: 'ws-1',
    squadId: 'squad-1',
    title: 'Status voice fixture',
    description: '',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    agentIds: [],
    dependsOn: [],
    metadata: {},
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides,
  } as WorkStream
}

describe('voiceWorkStreamStatus', () => {
  test('explicit empty waits override stale wait-derived state', () => {
    expect(voiceWorkStreamStatus(stream({ status: 'queued', derivedState: 'in_review', openWaits: [] }))).toBe('queued')
  })

  test('uses shared wait precedence regardless of input order', () => {
    const workStream = stream({
      openWaits: [{ type: 'manual' }, { type: 'dependency' }, { type: 'question' }, { type: 'review' }] as NonNullable<
        WorkStream['openWaits']
      >,
    })
    expect(voiceWorkStreamStatus(workStream)).toBe('in_review')
  })
})

describe('get_work', () => {
  const squadId = '11111111-1111-4111-8111-111111111111'
  function tools(overrides: Partial<Parameters<typeof createStatusTools>[0]> = {}) {
    return createStatusTools({
      listSquads: async () => [{ id: squadId, name: 'Ficus', createdAt: '2026-01-01' }] as any,
      listSquadAgents: async () =>
        [{ id: 'a1', agentTypeId: 'engineer', status: 'idle', metadata: { name: 'Ava' } }] as any,
      listActiveWorkStreams: async (id) => [stream({ id: id ? 'ws-s' : 'ws-1', squadId: id ?? 'squad-1' })],
      listDoneWorkStreams: async () => ({
        items: [stream({ id: 'ws-2', status: 'done', derivedState: 'done' })],
        hasMore: true,
        nextCursor: 'next',
        totalCount: 900,
      }),
      getAgent: async () => {
        throw new Error('Unexpected agent request')
      },
      getActiveExecution: async () => {
        throw new Error('Unexpected execution request')
      },
      getWorkStream: async (id) => stream({ id, title: 'Full stream' }),
      ...overrides,
    })
  }
  const env = { navigate() {} }

  test('lists active work across squads by default and includes finished work on request', async () => {
    const { getWorkTool } = tools()
    const active = (await getWorkTool.execute({}, env)) as any
    expect(active.workStreams.map((w: any) => w.id)).toEqual(['ws-1'])
    const all = (await getWorkTool.execute({ includeFinished: true }, env)) as any
    expect(all.workStreams.map((w: any) => w.id)).toEqual(['ws-1', 'ws-2'])
  })

  test('reads open work and one page of finished work, never the unfiltered list', async () => {
    const active: Array<string | undefined> = []
    const done: unknown[] = []
    const { getWorkTool } = tools({
      listActiveWorkStreams: async (id) => {
        active.push(id)
        return []
      },
      listDoneWorkStreams: async (opts) => {
        done.push(opts)
        return { items: [], hasMore: false, nextCursor: null, totalCount: 0 }
      },
    })
    await getWorkTool.execute({}, env)
    await getWorkTool.execute({ squadId: 'ficus' }, env)
    expect(active).toEqual([undefined, squadId])
    expect(done).toEqual([])
    await getWorkTool.execute({ squadId: 'ficus', includeFinished: true }, env)
    expect(done).toEqual([{ squadId, limit: VOICE_FINISHED_LIMIT, omitDescription: true, cursor: undefined }])
  })

  test('finished work says how much there is and pages on with its cursor instead of stopping', async () => {
    const reads: Array<{ active?: string; done?: unknown }> = []
    const { getWorkTool } = tools({
      listActiveWorkStreams: async (id) => {
        reads.push({ active: id })
        return [stream({ id: 'open', squadId })]
      },
      listDoneWorkStreams: async (opts) => {
        reads.push({ done: opts })
        const next = opts.cursor === 'page-2'
        return {
          items: [stream({ id: next ? 'older' : 'newer', squadId, status: 'done', derivedState: 'done' })],
          hasMore: !next,
          nextCursor: next ? null : 'page-2',
          totalCount: 2,
        }
      },
    })
    const first = (await getWorkTool.execute({ squadId: 'ficus', includeFinished: true }, env)) as any
    expect(first.workStreams.map((w: any) => w.id)).toEqual(['open', 'newer'])
    expect(first.finished).toEqual({ totalCount: 2, nextCursor: 'page-2' })
    expect(first.agents).toHaveLength(1)

    reads.length = 0
    const second = (await getWorkTool.execute({ squadId: 'ficus', finishedCursor: 'page-2' }, env)) as any
    expect(second.workStreams.map((w: any) => w.id)).toEqual(['older'])
    expect(second.finished).toEqual({ totalCount: 2, nextCursor: null })
    // Only the next finished page: no open work or agents again.
    expect(second.agents).toBeUndefined()
    expect(reads).toEqual([{ done: { squadId, limit: VOICE_FINISHED_LIMIT, omitDescription: true, cursor: 'page-2' } }])
    expect(await getWorkTool.execute({ workStreamId: 'ws-1', finishedCursor: 'page-2' }, env)).toHaveProperty('error')
  })

  test('a squad reference resolves the slug and returns agents with work', async () => {
    const { getWorkTool } = tools()
    const result = (await getWorkTool.execute({ squadId: 'ficus' }, env)) as any
    expect(result.agents).toEqual([{ id: 'a1', type: 'engineer', status: 'idle', name: 'Ava' }])
    expect(result.workStreams.map((w: any) => w.id)).toEqual(['ws-s'])
    expect(await getWorkTool.execute({ squadId: 'missing' }, env)).toHaveProperty('error')
  })

  test('a work stream reference returns the full stream and rejects mixed references', async () => {
    const { getWorkTool } = tools()
    const result = (await getWorkTool.execute({ workStreamId: 'work:ws-9' }, env)) as any
    expect(result.workStream).toMatchObject({ id: 'ws-9', title: 'Full stream' })
    expect(await getWorkTool.execute({ squadId: 'ficus', workStreamId: 'ws-9' }, env)).toHaveProperty('error')
  })
})
