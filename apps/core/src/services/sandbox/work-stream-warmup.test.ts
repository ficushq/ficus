import { expect, mock, test } from 'bun:test'
import {
  WARMUP_RETRY_BASE_MS,
  WARMUP_RETRY_MAX_MS,
  WarmupBackoff,
  warmupWorkStreamAgentSandboxes,
} from './work-stream-warmup'

const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000)
const log = { info: () => {}, warn: () => {} }
const agent = (id: string, lastMessageAt: Date | null) =>
  ({ id, lastMessageAt, status: 'idle', terminatedAt: null, parentAgentId: null }) as any

test('warms every member of a stream when one member is recently active', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => (id === 'a' ? agent(id, minsAgo(2)) : agent(id, minsAgo(90)))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  const warmed = ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()
  expect(warmed).toEqual(['a', 'b'])
})

test('does not warm a stream with no recently active member', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(90))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  expect(ensureAgent).not.toHaveBeenCalled()
})

test('dedupes an agent shared across two active streams', async () => {
  const listStreams = async () =>
    [
      { assigneeAgentId: null, agentIds: ['a', 'shared'] },
      { assigneeAgentId: null, agentIds: ['shared', 'c'] },
    ] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent })

  const warmed = ensureAgent.mock.calls.map((c) => (c as any[])[0].id)
  expect(warmed.filter((id) => id === 'shared').length).toBe(1)
})

// Perf: the sweep used to resolve activity with one eager `Agent.find` per
// member PER STREAM. Every member of every stream must now be resolved by a
// single set-based activity query for the whole pass.
test('resolves the activity of every member of every stream with ONE batched query', async () => {
  const listStreams = async () =>
    [
      { assigneeAgentId: null, agentIds: ['a', 'shared'] },
      { assigneeAgentId: 'shared', agentIds: ['c'] },
    ] as any
  const calls: string[][] = []
  const loadAgentActivity = async (ids: string[]) => {
    calls.push([...ids].sort())
    return ids.map((id) => agent(id, minsAgo(1)))
  }
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, {
    listStreams,
    loadAgentActivity,
    loadAgent: async (id: string) => agent(id, minsAgo(1)),
    ensureAgent,
  })

  expect(calls).toEqual([['a', 'c', 'shared']])
  expect(ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()).toEqual(['a', 'c', 'shared'])
})

test('never issues an activity query when no stream has members', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: [] }] as any
  let called = 0
  const loadAgentActivity = async () => {
    called++
    return []
  }
  const ensureAgent = mock(async () => 'ensured' as const)

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgentActivity, ensureAgent })

  expect(called).toBe(0)
  expect(ensureAgent).not.toHaveBeenCalled()
})

test('a failing ensure does not abort the rest', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a', 'b'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async (a: any) => {
    if (a.id === 'a') throw new Error('boom')
    return 'ensured' as const
  })

  // Own backoff state, so the failure does not hold 'a' back in later tests.
  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent, backoff: new WarmupBackoff() })

  expect(ensureAgent.mock.calls.length).toBe(2)
})

// Socket activation (spec D2): the tick learns each box's liveness from one
// `ss -ltnH` per machine and hands this sweep a resolver. Forwarding it is what
// stops every keep-warm ensure from HTTP-probing — and so WAKING — an idle box.
test('forwards the caller liveness resolver to each ensure', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['a'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  const ensureAgent = mock(async () => 'ensured' as const)
  const resolveBoxLiveness = () => 'listening' as const

  await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent, resolveBoxLiveness })

  expect((ensureAgent.mock.calls[0] as any[])[1]).toEqual({ resolveBoxLiveness })
})

// A sandbox that cannot come up (a busy box port, a broken machine) used to be
// re-ensured on every 60s tick. Failed warmups now back off per agent.
test('backs off an agent whose warmup keeps failing, doubling to a cap, and resets on success', async () => {
  const listStreams = async () => [{ assigneeAgentId: null, agentIds: ['broken', 'fine'] }] as any
  const loadAgent = async (id: string) => agent(id, minsAgo(1))
  let brokenFails = true
  const ensureAgent = mock(async (a: { id: string }) => {
    if (a.id === 'broken' && brokenFails) throw new Error('port busy')
    return 'ensured' as const
  })
  const backoff = new WarmupBackoff()
  let clock = 0
  const tick = async () => {
    ensureAgent.mockClear()
    await warmupWorkStreamAgentSandboxes(log, { listStreams, loadAgent, ensureAgent, backoff, now: () => clock })
    return ensureAgent.mock.calls.map((c) => (c as any[])[0].id).sort()
  }

  expect(await tick()).toEqual(['broken', 'fine'])
  // Waits WARMUP_RETRY_BASE_MS, then twice that, and so on.
  const attemptsAt: number[] = []
  for (clock = 60_000; clock <= 40 * 60_000; clock += 60_000) {
    if ((await tick()).includes('broken')) attemptsAt.push(clock / 60_000)
  }
  expect(attemptsAt).toEqual([2, 6, 14, 29])
  expect(WARMUP_RETRY_MAX_MS).toBe(15 * 60_000)
  // The healthy member was never held back.
  expect(await tick()).toContain('fine')

  // One success clears the backoff.
  brokenFails = false
  clock += WARMUP_RETRY_MAX_MS
  expect(await tick()).toContain('broken')
  clock += 60_000
  expect(await tick()).toContain('broken')
})

test('WarmupBackoff waits from the base delay and caps it', () => {
  const backoff = new WarmupBackoff()
  expect(backoff.recordFailure('a', 0)).toBe(WARMUP_RETRY_BASE_MS)
  expect(backoff.isWaiting('a', WARMUP_RETRY_BASE_MS - 1)).toBe(true)
  expect(backoff.isWaiting('a', WARMUP_RETRY_BASE_MS)).toBe(false)
  for (let i = 0; i < 10; i++) backoff.recordFailure('a', 0)
  expect(backoff.recordFailure('a', 0)).toBe(WARMUP_RETRY_MAX_MS)
  backoff.recordSuccess('a')
  expect(backoff.isWaiting('a', 0)).toBe(false)
})
