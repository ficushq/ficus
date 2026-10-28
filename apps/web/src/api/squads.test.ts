import { describe, expect, mock, test, beforeEach } from 'bun:test'

const apiFetchCalls: Array<[string, RequestInit | undefined]> = []

const apiFetchMock = mock(async (path: string, init?: RequestInit) => {
  apiFetchCalls.push([path, init])
  return {} as never
})

import { listDoneWorkStreams, listActiveWorkStreams, listSquadAgentsWithRecent, listSquads } from './squads'

describe('squads work stream api', () => {
  beforeEach(() => {
    apiFetchCalls.length = 0
  })

  test('listSquads uses only its constructed client and preserves the status request', async () => {
    await listSquads('active', apiFetchMock)

    expect(apiFetchCalls).toEqual([['/squads?status=active', undefined]])
  })

  test('listActiveWorkStreams requests only active statuses', async () => {
    await listActiveWorkStreams('squad-1', apiFetchMock)

    expect(apiFetchCalls).toEqual([['/workstreams?statuses=queued%2Cactive&squadId=squad-1', undefined]])
  })

  test('listDoneWorkStreams builds a paginated done work stream URL', async () => {
    await listDoneWorkStreams({ squadId: 'squad-1', statuses: ['done'], limit: 50, cursor: 'cursor-1' }, apiFetchMock)

    expect(apiFetchCalls).toEqual([['/workstreams?statuses=done&limit=50&squadId=squad-1&cursor=cursor-1', undefined]])
  })

  test('listDoneWorkStreams builds an aggregate multi-squad URL', async () => {
    await listDoneWorkStreams({ squadIds: ['squad-2', 'squad-1'], statuses: ['done'], limit: 50 }, apiFetchMock)

    expect(apiFetchCalls).toEqual([['/workstreams?statuses=done&limit=50&squadIds=squad-1%2Csquad-2', undefined]])
  })

  test('listSquadAgentsWithRecent requests a page of recently terminated agents', async () => {
    await listSquadAgentsWithRecent('squad-1', { terminatedLimit: 20, terminatedOffset: 40 }, apiFetchMock)

    expect(apiFetchCalls).toEqual([
      ['/squads/squad-1/agents?includeRecentlyTerminated=true&terminatedLimit=20&terminatedOffset=40', undefined],
    ])
  })

  test('listAttentionWorkStreams asks the server to respect attention', async () => {
    const { listAttentionWorkStreams } = await import('./squads')
    await listAttentionWorkStreams(apiFetchMock)

    expect(apiFetchCalls.at(-1)).toEqual(['/workstreams?statuses=queued%2Cactive&respectAttention=true', undefined])
  })

  test('subscribeSquad sends levels only when they were chosen', async () => {
    const { subscribeSquad } = await import('./squads')
    await subscribeSquad('squad-1', undefined, apiFetchMock)
    expect(apiFetchCalls.at(-1)).toEqual(['/squads/squad-1/subscribe', { method: 'POST' }])

    await subscribeSquad('squad-1', { decisions: 'mute', progress: 'notify' }, apiFetchMock)
    expect(apiFetchCalls.at(-1)).toEqual([
      '/squads/squad-1/subscribe',
      { method: 'POST', body: JSON.stringify({ attention: { decisions: 'mute', progress: 'notify' } }) },
    ])
  })
})

test('listSquadActivity serializes normalized filters and pagination', async () => {
  const { listSquadActivity } = await import('./squads')
  await listSquadActivity(
    'squad-1',
    {
      limit: 25,
      cursor: 'next',
      verbose: true,
      agentIds: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
      kinds: ['wait', 'message'],
    },
    apiFetchMock
  )
  expect(apiFetchCalls.at(-1)).toEqual([
    '/squads/squad-1/activity?limit=25&cursor=next&verbose=true&agentId=00000000-0000-4000-8000-000000000001&agentId=00000000-0000-4000-8000-000000000002&kind=message&kind=wait',
    undefined,
  ])
})

test('listSquadActivity forwards an abort signal for canonical head reconciliation', async () => {
  const { listSquadActivity } = await import('./squads')
  const controller = new AbortController()
  await listSquadActivity('squad-1', { signal: controller.signal }, apiFetchMock)
  expect(apiFetchCalls.at(-1)).toEqual(['/squads/squad-1/activity', { signal: controller.signal }])
})

test('Feed completion queries use exact unseen semantics with existing squad filters and paging', async () => {
  const calls: string[] = []
  await listDoneWorkStreams(
    { feedUpdates: true, statuses: ['done'], squadIds: ['b', 'a'], cursor: 'next', limit: 20 },
    (async (path: string) => {
      calls.push(path)
      return {}
    }) as never
  )
  expect(calls).toEqual(['/workstreams?statuses=done&limit=20&squadIds=a%2Cb&feedUpdates=true&cursor=next'])
})
