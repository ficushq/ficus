import { describe, expect, test } from 'bun:test'
import { squadsResource, WS_ACTIVE_STATUSES } from './squads'
import type { Agent, WorkStream, WorkStreamStatus, WorkStreamWait } from '@ficus/shared'
import type { Transport, RequestOptions } from '../transport'

function mockTransport(responder?: (path: string, options?: RequestOptions) => unknown) {
  const calls: Array<{ path: string; options?: RequestOptions }> = []
  const t: Transport = {
    request: async <T>(path: string, options?: RequestOptions) => {
      calls.push({ path, options })
      return (responder?.(path, options) ?? undefined) as T
    },
    openStream: async () => {
      throw new Error('not used')
    },
    wsUrl: (path: string) => `ws://test${path}`,
    url: (path: string) => `http://test/api${path}`,
  }
  return { t, calls }
}

describe('squadsResource', () => {
  test('listSquadWorkStreams reads the squad-scoped route with its open statuses', async () => {
    const { t, calls } = mockTransport(() => [])
    await squadsResource(t).listSquadWorkStreams('sq-1', ['queued', 'active'])
    await squadsResource(t).listSquadWorkStreams('sq-1', WS_ACTIVE_STATUSES)
    expect(calls.map((call) => call.path)).toEqual([
      '/workstreams?squadId=sq-1&statuses=queued,active',
      '/workstreams?squadId=sq-1&statuses=queued,active',
    ])
  })

  test('listAllWorkStreams lists open work across squads', async () => {
    const { t, calls } = mockTransport(() => [])
    await squadsResource(t).listAllWorkStreams(['queued', 'active'])
    await squadsResource(t).listAllWorkStreams(['active'])
    expect(calls.map((call) => call.path)).toEqual([
      '/workstreams?statuses=queued,active',
      '/workstreams?statuses=active',
    ])
  })

  test('listAllWorkStreams can respect attention and omit descriptions, as a feed does', async () => {
    const { t, calls } = mockTransport(() => [])
    await squadsResource(t).listAllWorkStreams(['queued', 'active'], { respectAttention: true, omitDescription: true })
    await squadsResource(t).listAllWorkStreams(['queued'], { respectAttention: true })
    expect(calls.map((call) => call.path)).toEqual([
      '/workstreams?statuses=queued,active&respectAttention=true&omitDescription=true',
      '/workstreams?statuses=queued&respectAttention=true',
    ])
  })

  test('a caller holding open statuses as WorkStreamStatus[] compiles and reads them', async () => {
    // As mobile declares its own WS_ACTIVE_STATUSES: the element type is not narrowed to open statuses.
    const open: WorkStreamStatus[] = ['queued', 'active']
    const { t, calls } = mockTransport(() => [])
    await squadsResource(t).listSquadWorkStreams('sq-1', open)
    await squadsResource(t).listAllWorkStreams([...open], { respectAttention: true })
    expect(calls.map((call) => call.path)).toEqual([
      '/workstreams?squadId=sq-1&statuses=queued,active',
      '/workstreams?statuses=queued,active&respectAttention=true',
    ])
  })

  test('the unpaged lists refuse a read without statuses or with finished statuses', () => {
    const { t, calls } = mockTransport(() => [])
    const squads = squadsResource(t)
    expect(() => squads.listSquadWorkStreams('sq-1', [])).toThrow('needs open statuses')
    expect(() => squads.listAllWorkStreams([])).toThrow('needs open statuses')
    expect(() => squads.listSquadWorkStreams('sq-1', ['queued', 'done'])).toThrow('cannot ask for done')
    expect(() => squads.listAllWorkStreams(['canceled'])).toThrow('cannot ask for canceled')
    // Callers outside TypeScript's reach (or a cast) cannot leave the statuses out either.
    const unchecked = squads as unknown as {
      listSquadWorkStreams: (squadId: string) => Promise<WorkStream[]>
      listAllWorkStreams: () => Promise<WorkStream[]>
    }
    expect(() => unchecked.listAllWorkStreams()).toThrow()
    expect(() => unchecked.listSquadWorkStreams('sq-1')).toThrow()
    expect(calls).toEqual([])
  })

  test('finished work is read through the paged list, with a limit', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await squadsResource(t).listDoneWorkStreamsPage({ squadId: 'sq-1' })
    expect(calls[0].path).toBe('/workstreams?statuses=done,canceled&limit=50&squadId=sq-1')
  })

  test('getWorkStream fetches a single work stream by ID', async () => {
    const mockWorkStream = { id: 'ws-1', title: 'Test work stream' } as WorkStream
    const { t, calls } = mockTransport((path) => {
      if (path === '/workstreams/ws-1') return mockWorkStream
      throw new Error(`Unexpected path: ${path}`)
    })

    const result = await squadsResource(t).getWorkStream('ws-1')

    expect(result).toEqual(mockWorkStream)
    expect(calls[0].path).toBe('/workstreams/ws-1')
  })

  test('resolveWorkStreamWait resolves the exact wait and returns its snapshot', async () => {
    const wait = { id: 'wait-2', type: 'review' } as unknown as WorkStreamWait
    const { t, calls } = mockTransport(() => ({ id: 'ws-1', wait }))

    const result = await squadsResource(t).resolveWorkStreamWait('ws-1', 'wait-2', {
      resolution: 'sent_back',
      note: 'Fix the regression',
    })

    expect(calls[0]).toEqual({
      path: '/workstreams/ws-1/waits/wait-2/resolve',
      options: {
        method: 'POST',
        body: { resolution: 'sent_back', note: 'Fix the regression' },
      },
    })
    expect(result.wait).toEqual(wait)
  })

  test('listActiveWorkStreamsPage requests active statuses with limit and cursor', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await squadsResource(t).listActiveWorkStreamsPage('sq-1', { limit: 25, cursor: 'ws-25' })
    expect(calls[0].path).toBe('/workstreams?statuses=queued,active&limit=25&squadId=sq-1&cursor=ws-25')
  })

  test('listDoneWorkStreamsPage defaults to done and canceled statuses', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, totalCount: 0 }))
    await squadsResource(t).countActiveWorkStreams('sq-1')
    expect(calls[0].path).toBe('/workstreams?statuses=queued,active&limit=1&squadId=sq-1&countOnly=true')

    calls.length = 0
    await squadsResource(t).listDoneWorkStreamsPage({ squadId: 'sq-1', limit: 10 })
    expect(calls[0].path).toBe('/workstreams?statuses=done,canceled&limit=10&squadId=sq-1')
  })

  test('listSquadAgents unwraps { agents }', async () => {
    const responseAgents = [{ id: 'a1' }] as unknown as Agent[]
    const { t, calls } = mockTransport(() => ({ agents: responseAgents }))
    const agents = await squadsResource(t).listSquadAgents('sq-1')
    expect(calls[0].path).toBe('/squads/sq-1/agents')
    expect(agents).toEqual(responseAgents)
  })

  test('terminateSquadAgent issues a DELETE to the squad agent route', async () => {
    const { t, calls } = mockTransport(() => undefined)
    await squadsResource(t).terminateSquadAgent('sq-1', 'ag-9')
    expect(calls[0].path).toBe('/squads/sq-1/agents/ag-9')
    expect(calls[0].options?.method).toBe('DELETE')
  })

  test('listSquadActivity hits the squad-scoped activity route with no params by default', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null }))
    await squadsResource(t).listSquadActivity('sq-1')
    expect(calls[0].path).toBe('/squads/sq-1/activity')
  })

  test('listSquadActivity forwards limit, cursor, and deduped sorted kinds', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null }))
    await squadsResource(t).listSquadActivity('sq-1', {
      limit: 50,
      cursor: 'act-9',
      kinds: ['pr', 'message', 'pr'],
    })
    expect(calls[0].path).toBe('/squads/sq-1/activity?limit=50&cursor=act-9&kind=message&kind=pr')
  })

  test('listGlobalActivity hits the cross-squad route with no squadId in the path', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, squads: {} }))
    await squadsResource(t).listGlobalActivity()
    expect(calls[0].path).toBe('/activity')
  })

  test('listGlobalActivity forwards limit, cursor, and deduped sorted kinds identically to the per-squad path', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, squads: {} }))
    await squadsResource(t).listGlobalActivity({ limit: 50, cursor: 'act-9', kinds: ['pr', 'message', 'pr'] })
    expect(calls[0].path).toBe('/activity?limit=50&cursor=act-9&kind=message&kind=pr')
  })

  test('activity lists forward Show everything and the work stream filter', async () => {
    const { t, calls } = mockTransport(() => ({ items: [], hasMore: false, nextCursor: null, squads: {} }))
    const streamId = '0f8d1f0e-6c1a-4f5e-9d2b-1a2b3c4d5e6f'
    await squadsResource(t).listGlobalActivity({ verbose: true, workStreamId: streamId })
    await squadsResource(t).listSquadActivity('sq-1', { verbose: false, workStreamId: streamId, kinds: ['message'] })
    expect(calls.map((call) => call.path)).toEqual([
      `/activity?verbose=true&workStreamId=${streamId}`,
      `/squads/sq-1/activity?workStreamId=${streamId}&kind=message`,
    ])
  })

  test('presence calls hit the global and squad presence routes', async () => {
    const { t, calls } = mockTransport(() => ({
      workingAgentIds: [],
      workingCount: 0,
      needsYouCount: 0,
      streamCount: 0,
    }))
    await squadsResource(t).getGlobalActivityPresence()
    await squadsResource(t).getSquadActivityPresence('sq-1')
    expect(calls.map((call) => call.path)).toEqual(['/activity/presence', '/squads/sq-1/activity/presence'])
  })
})
