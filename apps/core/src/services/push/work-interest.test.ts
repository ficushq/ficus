import { describe, expect, test } from 'bun:test'
import { WATCH_ATTENTION, type Attention, type WorkStream } from '@ficus/shared'
import { buildUserAttention } from '../attention/resolver'
import { createWorkInterestLoader, type WorkInterestCandidate } from './work-interest'

const now = new Date('2026-08-30T00:00:00Z')
function candidate(id: string, squadId: string, overrides: Partial<WorkInterestCandidate> = {}): WorkInterestCandidate {
  return {
    id,
    squadId,
    title: id,
    status: 'active',
    assigneeAgentId: null,
    agentIds: [],
    updatedAt: new Date(`2026-08-29T12:${id.replace(/\D/g, '').padStart(2, '0') || '00'}:00Z`),
    ...overrides,
  }
}

function loader(options: {
  watchedSquads?: string[]
  directStreams?: string[]
  squadAttention?: Record<string, Attention>
  streamAttention?: Record<string, Attention>
  candidates?: WorkInterestCandidate[]
  deniedSquads?: string[]
  attention?: string[]
  activeUser?: boolean
}) {
  const checked: string[] = []
  let subscriptionLoads = 0
  const squadRows = new Map<string, Attention>([
    ...(options.watchedSquads ?? []).map((id) => [id, WATCH_ATTENTION] as const),
    ...Object.entries(options.squadAttention ?? {}),
  ])
  const streamRows = new Map<string, Attention>([
    ...(options.directStreams ?? []).map((id) => [id, WATCH_ATTENTION] as const),
    ...Object.entries(options.streamAttention ?? {}),
  ])
  const load = createWorkInterestLoader({
    isActiveUser: async () => options.activeUser !== false,
    loadAttention: async () => {
      subscriptionLoads++
      return buildUserAttention(squadRows, streamRows)
    },
    loadCandidates: async (squadIds, streamIds) =>
      (options.candidates ?? []).filter(
        (stream) =>
          (stream.status === 'active' || stream.status === 'queued') &&
          (squadIds.includes(stream.squadId) || streamIds.includes(stream.id))
      ),
    canReadSquad: async (_userId, squadId) => {
      checked.push(squadId)
      return !(options.deniedSquads ?? []).includes(squadId)
    },
    derive: async (streams) =>
      new Map(
        streams.map((stream) => [
          stream.id,
          (options.attention ?? []).includes(stream.id)
            ? {
                derivedState: 'waiting_on_answer' as const,
                openWaits: [{ type: 'question' }] as NonNullable<WorkStream['openWaits']>,
              }
            : {
                derivedState: 'in_progress' as const,
                openWaits: [] as NonNullable<WorkStream['openWaits']>,
              },
        ])
      ),
    now: () => now,
  })
  return { load, checked, subscriptionLoads: () => subscriptionLoads }
}

describe('work interest selector', () => {
  test('includes active work from watched squads only', async () => {
    const { load } = loader({
      watchedSquads: ['watched'],
      candidates: [candidate('watched-stream', 'watched'), candidate('other-stream', 'other')],
    })
    expect((await load('user-1')).top.map(({ id }) => id)).toEqual(['watched-stream'])
  })

  test('includes a directly subscribed stream without its unwatched siblings', async () => {
    const { load } = loader({
      directStreams: ['direct'],
      candidates: [candidate('direct', 'unwatched'), candidate('sibling', 'unwatched')],
    })
    expect((await load('user-1')).top.map(({ id }) => id)).toEqual(['direct'])
  })

  test('unions watched and direct interest with exact-id dedupe', async () => {
    const same = candidate('same', 'watched')
    const { load } = loader({
      watchedSquads: ['watched'],
      directStreams: ['same', 'direct'],
      candidates: [same, same, candidate('direct', 'unwatched')],
    })
    const snapshot = await load('user-1')
    expect(snapshot.totalCount).toBe(2)
    expect(snapshot.top.map(({ id }) => id).sort()).toEqual(['direct', 'same'])
  })

  test('mere RBAC accessibility without explicit interest is excluded', async () => {
    const { load, checked } = loader({ candidates: [candidate('accessible-only', 'squad')] })
    expect((await load('user-1')).totalCount).toBe(0)
    expect(checked).toEqual([])
  })

  test('fails closed when current permission is revoked', async () => {
    const { load, checked } = loader({
      watchedSquads: ['allowed-squad', 'denied-squad'],
      candidates: [candidate('allowed', 'allowed-squad'), candidate('denied', 'denied-squad')],
      deniedSquads: ['denied-squad'],
    })
    const snapshot = await load('user-1')
    expect(checked.sort()).toEqual(['allowed-squad', 'denied-squad'])
    expect(snapshot.top.map(({ id }) => id)).toEqual(['allowed'])
  })

  test('unsubscribe removes otherwise readable directly subscribed work', async () => {
    const candidates = [candidate('direct', 'unwatched')]
    expect((await loader({ directStreams: ['direct'], candidates }).load('user-1')).totalCount).toBe(1)
    expect((await loader({ candidates }).load('user-1')).totalCount).toBe(0)
  })

  test('unwatch removes otherwise readable squad work', async () => {
    const candidates = [candidate('watched', 'watched')]
    expect((await loader({ watchedSquads: ['watched'], candidates }).load('user-1')).totalCount).toBe(1)
    expect((await loader({ candidates }).load('user-1')).totalCount).toBe(0)
  })

  test('terminal and deleted work are absent from current interest', async () => {
    const { load } = loader({
      watchedSquads: ['squad'],
      directStreams: ['deleted-id'],
      candidates: [
        candidate('done', 'squad', { status: 'done' }),
        candidate('canceled', 'squad', { status: 'canceled' }),
      ],
    })
    expect((await load('user-1')).totalCount).toBe(0)
  })

  test('computes complete counts past 25 and promotes a late attention item', async () => {
    const candidates = [
      ...Array.from({ length: 30 }, (_, index) => candidate(`run-${index}`, 'squad')),
      candidate('late-attention', 'squad', { updatedAt: new Date('2026-08-01T00:00:00Z') }),
    ]
    const { load } = loader({ watchedSquads: ['squad'], candidates, attention: ['late-attention'] })
    const snapshot = await load('user-1')
    expect(snapshot.totalCount).toBe(31)
    expect(snapshot.bucketCounts).toMatchObject({ running: 30, needsYou: 1 })
    expect(snapshot.top[0]?.id).toBe('late-attention')
  })

  test('foreground/native rows and APNs state share counts and attention-first order', async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(`stream-${index}`, 'squad'))
    const snapshot = await loader({
      watchedSquads: ['squad'],
      candidates,
      attention: ['stream-11'],
    }).load('user-1')
    expect(snapshot.liveActivity.activeCount).toBe(snapshot.bucketCounts.running)
    expect(snapshot.liveActivity.needsYouCount).toBe(snapshot.bucketCounts.needsYou)
    expect(snapshot.liveActivity.top).toEqual(
      snapshot.top.slice(0, 3).map(({ id, squadId, title, derivedState }) => ({
        id,
        squadId,
        title,
        bucket: derivedState === 'waiting_on_answer' ? 'needsYou' : 'running',
      }))
    )
    expect(snapshot.top[0]?.id).toBe('stream-11')
  })

  test('disabled users fail closed before loading private interest', async () => {
    const fixture = loader({
      activeUser: false,
      watchedSquads: ['private'],
      candidates: [candidate('private-stream', 'private')],
    })
    const snapshot = await fixture.load('disabled-user')
    expect(snapshot.totalCount).toBe(0)
    expect(snapshot.liveActivity).toEqual({ activeCount: 0, needsYouCount: 0, top: [] })
    expect(fixture.subscriptionLoads()).toBe(0)
    expect(fixture.checked).toEqual([])
  })

  test('checks squad authorization once for every stream in the same squad', async () => {
    const candidates = Array.from({ length: 100 }, (_, index) => candidate(`stream-${index}`, 'one-squad'))
    const fixture = loader({ watchedSquads: ['one-squad'], candidates })
    expect((await fixture.load('user-1')).totalCount).toBe(100)
    expect(fixture.checked).toEqual(['one-squad'])
  })

  test('bounds authorization work across many distinct squads', async () => {
    const squadIds = Array.from({ length: 20 }, (_, index) => `squad-${index}`)
    let active = 0
    let peak = 0
    const load = createWorkInterestLoader({
      isActiveUser: async () => true,
      loadAttention: async () => buildUserAttention(new Map(squadIds.map((id) => [id, WATCH_ATTENTION])), new Map()),
      loadCandidates: async () => squadIds.map((squadId, index) => candidate(`stream-${index}`, squadId)),
      canReadSquad: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        active--
        return true
      },
      derive: async (streams) =>
        new Map(streams.map((stream) => [stream.id, { derivedState: 'in_progress' as const, openWaits: [] }])),
      now: () => now,
    })
    expect((await load('user-1')).totalCount).toBe(20)
    expect(peak).toBeLessThanOrEqual(8)
  })

  test('a notify squad with one muted stream keeps the siblings and drops that stream', async () => {
    const { load } = loader({
      watchedSquads: ['squad'],
      streamAttention: { quiet: { decisions: 'mute', progress: 'mute' } },
      candidates: [candidate('loud', 'squad'), candidate('quiet', 'squad')],
    })
    expect((await load('user-1')).top.map(({ id }) => id)).toEqual(['loud'])
  })

  test('show-level rows are not interest: only notify puts work on the lock screen', async () => {
    const { load, checked } = loader({
      squadAttention: { squad: { decisions: 'show', progress: 'show' } },
      candidates: [candidate('shown', 'squad')],
    })
    expect((await load('user-1')).totalCount).toBe(0)
    expect(checked).toEqual([])
  })

  test('empty interest returns widget empty state and an ending APNs state', async () => {
    const snapshot = await loader({ candidates: [candidate('accessible-only', 'squad')] }).load('user-1')
    expect(snapshot.totalCount).toBe(0)
    expect(snapshot.top).toEqual([])
    expect(snapshot.liveActivity).toEqual({ activeCount: 0, needsYouCount: 0, top: [] })
  })
})
