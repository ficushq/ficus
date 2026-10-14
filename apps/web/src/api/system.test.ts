import { describe, expect, mock, test } from 'bun:test'
import { makeIdleConsultantsDormantInChunks, removeDormantAgents } from './system'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`)

describe('storage cleanup API client', () => {
  test('idle-consultant apply sends sequential chunks of 25, reports progress and merges results', async () => {
    const fetcher = mock(async (_path: string, init?: RequestInit) => {
      const { agentIds } = JSON.parse(String(init?.body)) as { agentIds: string[] }
      return { dormant: agentIds.slice(1), deferred: [], skipped: [{ id: agentIds[0]!, reason: 'became active' }] }
    })
    const progress: string[] = []
    const result = await makeIdleConsultantsDormantInChunks(
      'squad',
      90,
      ids(60),
      (made, total) => progress.push(`${made}/${total}`),
      fetcher as never
    )
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).agentIds.length)).toEqual([25, 25, 10])
    expect(fetcher.mock.calls[0]![0]).toBe('/squads/squad/idle-consultants/dormant')
    expect(progress).toEqual(['24/60', '48/60', '57/60'])
    expect(result.dormant).toHaveLength(57)
    expect(result.skipped).toHaveLength(3)
    expect(result.error).toBeUndefined()
  })

  test('idle-consultant apply keeps what succeeded when a later chunk fails', async () => {
    let call = 0
    const fetcher = mock(async (_path: string, init?: RequestInit) => {
      if (++call === 2) throw new Error('Server unavailable')
      return { dormant: JSON.parse(String(init?.body)).agentIds, deferred: [], skipped: [] }
    })
    const result = await makeIdleConsultantsDormantInChunks('squad', 90, ids(60), undefined, fetcher as never)
    expect(result.dormant).toHaveLength(25)
    expect(result.error).toBe('Server unavailable')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('remove-now keeps the accepted ids of earlier chunks when a later chunk fails', async () => {
    let call = 0
    const fetcher = mock(async (_path: string, init?: RequestInit) => {
      if (++call === 2) throw new Error('Gateway timeout')
      return { accepted: JSON.parse(String(init?.body)).agentIds, skipped: [] }
    })
    const result = await removeDormantAgents(ids(700), fetcher as never)
    expect(result.accepted).toHaveLength(500)
    expect(result.error).toBe('Gateway timeout')
  })

  test('remove-now with a failing first chunk reports the error', async () => {
    const fetcher = mock(async () => {
      throw new Error('Forbidden')
    })
    await expect(removeDormantAgents(ids(3), fetcher as never)).rejects.toThrow('Forbidden')
  })
})
