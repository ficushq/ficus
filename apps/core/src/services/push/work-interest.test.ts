import { describe, expect, test } from 'bun:test'
import {
  WATCH_ATTENTION,
  type Attention,
  type WorkStream,
  type WorkStreamDerivedState,
  type WorkStreamViewer,
} from '@ficus/shared'
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
  slotWaiting?: string[]
  activeUser?: boolean
  /** The user's permissions in every squad; by default they may act on any wait. */
  permissions?: string[]
  /** Open waits by stream, overriding the default question for `attention` streams. */
  waits?: Record<
    string,
    {
      derivedState: WorkStreamDerivedState
      openWaits: NonNullable<WorkStream['openWaits']>
      delivery?: WorkStream['delivery']
    }
  >
}) {
  const checked: string[] = []
  const viewersLoaded: string[] = []
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
    loadCandidates: async () =>
      (options.candidates ?? []).filter((stream) => stream.status === 'active' || stream.status === 'queued'),
    canReadSquad: async (_userId, squadId) => {
      checked.push(squadId)
      return !(options.deniedSquads ?? []).includes(squadId)
    },
    loadViewer: async (userId, squadId): Promise<WorkStreamViewer> => {
      viewersLoaded.push(squadId)
      return {
        can: (permission) => !options.permissions || options.permissions.includes(permission),
        identity: { type: 'user', userId },
      }
    },
    derive: async (streams) =>
      new Map(
        streams.map((stream) => [
          stream.id,
          options.waits?.[stream.id]
            ? { ...options.waits[stream.id]! }
            : (options.attention ?? []).includes(stream.id)
              ? {
                  derivedState: 'waiting_on_answer' as const,
                  openWaits: [{ type: 'question' }] as NonNullable<WorkStream['openWaits']>,
                }
              : {
                  derivedState: (options.slotWaiting?.includes(stream.id) ? 'idle' : 'in_progress') as
                    'idle' | 'in_progress',
                  hasActiveSlotWait: options.slotWaiting?.includes(stream.id),
                  openWaits: [] as NonNullable<WorkStream['openWaits']>,
                },
        ])
      ),
    now: () => now,
  })
  return { load, checked, viewersLoaded, subscriptionLoads: () => subscriptionLoads }
}

describe('work interest selector', () => {
  test('includes watched and default-Show active work', async () => {
    const { load } = loader({
      watchedSquads: ['watched'],
      candidates: [candidate('watched-stream', 'watched'), candidate('other-stream', 'other')],
    })
    expect((await load('user-1')).top.map(({ id }) => id)).toEqual(['other-stream', 'watched-stream'])
  })

  test('includes directly subscribed work and default-Show siblings', async () => {
    const { load } = loader({
      directStreams: ['direct'],
      candidates: [candidate('direct', 'unwatched'), candidate('sibling', 'unwatched')],
    })
    expect((await load('user-1')).top.map(({ id }) => id)).toEqual(['direct', 'sibling'])
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

  test('default Show includes readable work without explicit subscriptions', async () => {
    const { load, checked } = loader({ candidates: [candidate('accessible-only', 'squad')] })
    expect((await load('user-1')).totalCount).toBe(1)
    expect(checked).toEqual(['squad'])
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

  test('unsubscribe restores default Show for readable directly subscribed work', async () => {
    const candidates = [candidate('direct', 'unwatched')]
    expect((await loader({ directStreams: ['direct'], candidates }).load('user-1')).totalCount).toBe(1)
    expect((await loader({ candidates }).load('user-1')).totalCount).toBe(1)
  })

  test('unwatch restores default Show for readable squad work', async () => {
    const candidates = [candidate('watched', 'watched')]
    expect((await loader({ watchedSquads: ['watched'], candidates }).load('user-1')).totalCount).toBe(1)
    expect((await loader({ candidates }).load('user-1')).totalCount).toBe(1)
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
        needsYou: derivedState === 'waiting_on_answer',
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
      loadViewer: async () => ({ can: () => true }),
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

  test('explicit Show includes widget and Live Activity content without Notify', async () => {
    const { load, checked } = loader({
      squadAttention: { squad: { decisions: 'show', progress: 'show' } },
      candidates: [candidate('shown', 'squad')],
    })
    const snapshot = await load('user-1')
    expect(snapshot.totalCount).toBe(1)
    expect(snapshot.liveActivity.top.map((row) => row.id)).toEqual(['shown'])
    expect(checked).toEqual(['squad'])
  })

  test('"waiting on you" counts only streams this user can act on, as Activity counts them', async () => {
    const gate = {
      id: 'gate',
      type: 'manual',
      workflowHumanGate: true,
      flowAttemptId: 2,
      resolutionHandler: 'workflow',
      workflowGateApprover: 'assigned-reviewers',
    } as NonNullable<WorkStream['openWaits']>[number]
    const fixture = (permissions: string[]) =>
      loader({
        permissions,
        candidates: [
          candidate('gated', 'squad', { assignedReviewerIds: ['reviewer'] }),
          candidate('running', 'squad'),
          candidate('idle', 'quiet-squad'),
        ],
        waits: { gated: { derivedState: 'in_review', openWaits: [gate] } },
      })
    // A reviewer outside the assigned reviewers cannot decide the gate: nothing waits on them.
    const outsider = await fixture(['workstreams:review']).load('someone-else')
    expect(outsider.liveActivity).toMatchObject({ activeCount: 2, needsYouCount: 0 })
    // The assigned reviewer can.
    const reviewer = fixture(['workstreams:review'])
    expect((await reviewer.load('reviewer')).liveActivity).toMatchObject({ activeCount: 2, needsYouCount: 1 })
    // Only the squad with a stream needing a person resolves the viewer.
    expect(reviewer.viewersLoaded).toEqual(['squad'])
  })

  test('each row says whether it waits on this user; buckets stay viewer-independent', async () => {
    const gate = {
      id: 'gate',
      type: 'manual',
      workflowHumanGate: true,
      flowAttemptId: 2,
      resolutionHandler: 'workflow',
      workflowGateApprover: 'assigned-reviewers',
    } as NonNullable<WorkStream['openWaits']>[number]
    const load = (userId: string) =>
      loader({
        permissions: ['workstreams:review'],
        candidates: [
          candidate('gated', 'squad', { assignedReviewerIds: ['reviewer'] }),
          candidate('pr', 'other-squad'),
          candidate('running', 'squad'),
        ],
        waits: {
          gated: { derivedState: 'in_review', openWaits: [gate] },
          // A pull request awaiting review at the code host: nobody in Ficus can be told apart.
          pr: { derivedState: 'in_review', openWaits: [], delivery: { kind: 'review' } },
        },
      }).load(userId)
    const rows = (snapshot: Awaited<ReturnType<typeof load>>) => ({
      widget: Object.fromEntries(snapshot.top.map((row) => [row.id, [row.needsYou, row.bucket]])),
      live: Object.fromEntries(snapshot.liveActivity.top.map((row) => [row.id, [row.needsYou, row.bucket]])),
    })
    const outsider = rows(await load('someone-else'))
    const reviewer = rows(await load('reviewer'))
    for (const view of [outsider.widget, outsider.live])
      expect(view).toEqual({
        gated: [false, 'needsYou'],
        pr: [true, 'needsYou'],
        running: [false, 'running'],
      })
    for (const view of [reviewer.widget, reviewer.live])
      expect(view).toEqual({
        gated: [true, 'needsYou'],
        pr: [true, 'needsYou'],
        running: [false, 'running'],
      })
  })

  test('a stream whose decisions are muted never waits on the user, as on Activity', async () => {
    const { load, viewersLoaded } = loader({
      streamAttention: { asking: { decisions: 'mute', progress: 'show' } },
      candidates: [candidate('asking', 'squad')],
      attention: ['asking'],
    })
    const snapshot = await load('user-1')
    expect(snapshot.top.map(({ id }) => id)).toEqual(['asking'])
    expect(snapshot.liveActivity.needsYouCount).toBe(0)
    expect(snapshot.top[0]).toMatchObject({ bucket: 'needsYou', needsYou: false })
    expect(snapshot.liveActivity.top[0]).toMatchObject({ bucket: 'needsYou', needsYou: false })
    expect(viewersLoaded).toEqual([])
  })

  test('empty interest returns widget empty state and an ending APNs state', async () => {
    const snapshot = await loader({
      squadAttention: { squad: { decisions: 'mute', progress: 'mute' } },
      candidates: [candidate('muted', 'squad')],
    }).load('user-1')
    expect(snapshot.totalCount).toBe(0)
    expect(snapshot.top).toEqual([])
    expect(snapshot.liveActivity).toEqual({ activeCount: 0, needsYouCount: 0, top: [] })
  })
})

test('authorized widget snapshots carry current slot facts for direct and squad interest, including default Show but not forbidden work', async () => {
  const { load } = loader({
    watchedSquads: ['watched'],
    directStreams: ['direct', 'forbidden'],
    candidates: [
      candidate('direct', 'other'),
      candidate('squad', 'watched'),
      candidate('unrelated', 'other'),
      candidate('forbidden', 'denied'),
    ],
    deniedSquads: ['denied'],
    slotWaiting: ['direct', 'squad', 'unrelated', 'forbidden'],
  })
  const snapshot = await load('user-1')
  expect(snapshot.top.map((row) => row.id).sort()).toEqual(['direct', 'squad', 'unrelated'])
  expect(snapshot.top.every((row) => row.hasActiveSlotWait === true)).toBe(true)
  expect(snapshot.bucketCounts.externalWait).toBe(3)
  expect(snapshot.totalCount).toBe(3)
})
