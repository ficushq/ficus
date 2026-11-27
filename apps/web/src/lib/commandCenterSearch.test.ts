import { expect, test } from 'bun:test'
import { commandCenterSearch, recentlyCompletedWork } from './commandCenterSearch'
import { waitAction } from './needsYouNotices.fixtures'

const data = {
  squads: [{ id: 'tau', name: 'Ficus', purpose: 'Orchestration' }],
  streams: [{ id: 'work', squadId: 'tau', title: 'Review OAuth', status: 'done' }],
  consultants: [
    {
      id: 'consultant',
      squadId: 'tau',
      agentTypeId: 'consultant',
      status: 'idle',
      metadata: { purpose: 'Review OAuth options' },
      createdAt: '2026-09-06',
    },
    {
      id: 'worker',
      squadId: 'tau',
      agentTypeId: 'engineer',
      status: 'active',
      metadata: { purpose: 'Review OAuth implementation' },
      createdAt: '2026-09-06',
    },
    {
      id: 'dormant',
      squadId: 'tau',
      agentTypeId: 'consultant',
      status: 'dormant',
      metadata: { purpose: 'Review OAuth dormant' },
      createdAt: '2026-09-06',
    },
    {
      id: 'old',
      squadId: 'tau',
      agentTypeId: 'consultant',
      status: 'terminated',
      metadata: { purpose: 'Review OAuth old' },
      createdAt: '2026-09-06',
    },
  ],
  actions: [],
  allowedSettings: new Set(['agent-types']),
} as any

test('search surfaces consultant conversations and completed work, without individual workers', () => {
  const results = commandCenterSearch('OAuth', data)
  expect(results.map((r) => r.id)).toEqual(['chat:consultant', 'work:work'])
  expect(results.every((r) => r.destination)).toBe(true)
})
test('squad scope excludes unrelated work and global pages while exact page names rank first globally', () => {
  expect(commandCenterSearch('Agents', data)[0].label).toBe('Agents')
  expect(commandCenterSearch('Agents', { ...data, squadId: 'tau' })).toEqual([])
  expect(commandCenterSearch('OAuth', { ...data, squadId: 'another' })).toEqual([])
})
test('landing shows bounded recent consultant conversations and actionable work', () => {
  const results = commandCenterSearch('', {
    ...data,
    consultants: Array.from({ length: 50 }, (_, i) => ({ ...data.consultants[0], id: `chat-${i}` })),
  })
  expect(results.filter((r) => r.kind === 'Conversation')).toHaveLength(5)
  expect(results.some((r) => r.id === 'work:work')).toBe(false)
})

test('settings retain matches from their searchable keywords', () => {
  expect(commandCenterSearch('reasoning', data).some((r) => r.id === 'settings:agent-types')).toBe(true)
})

test('recent conversations omit dormant and terminated agents too', () => {
  expect(
    commandCenterSearch('', data)
      .filter((r) => r.kind === 'Conversation')
      .map((r) => r.id)
  ).toEqual(['chat:consultant'])
})

const now = Date.parse('2026-09-06T12:00:00Z')
const datedWork = (id: string, title: string, status: string, age: number) => ({
  ...data.streams[0],
  id,
  title,
  status,
  updatedAt: new Date(now - age * 86_400_000),
  completedAt: status === 'done' ? new Date(now - age * 86_400_000) : undefined,
})
const workResults = (query: string, streams: any[]) =>
  commandCenterSearch(query, { ...data, streams }, now)
    .filter((r) => r.work)
    .map((r) => r.work!.id)

test('work ranking blends relevance with unfinished status and completion recency', () => {
  const streams = [
    datedWork('old-prefix', 'OAuth migration', 'done', 120),
    datedWork('recent-prefix', 'OAuth rollout', 'done', 0.1),
    datedWork('active-prefix', 'OAuth improvements', 'active', 10),
    datedWork('active-word', 'Review OAuth setup', 'queued', 1),
    datedWork('canceled', 'OAuth abandoned', 'canceled', 0),
  ]
  expect(workResults('OAuth', streams)).toEqual([
    'active-prefix',
    'recent-prefix',
    'active-word',
    'old-prefix',
    'canceled',
  ])
  expect(workResults('OAuth migration', streams)[0]).toBe('old-prefix')
  expect(workResults('OAuth', [...streams].reverse())).toEqual(workResults('OAuth', streams))
})

test('keyword-only active work does not bury strong completed title matches', () => {
  const rows = commandCenterSearch(
    'Ficus',
    {
      ...data,
      streams: [
        datedWork('keyword', 'Unrelated project', 'active', 0),
        datedWork('title', 'Ficus migration', 'done', 120),
      ],
    },
    now
  ).filter((r) => r.work)
  expect(rows.map((r) => r.work!.id)).toEqual(['title', 'keyword'])
})

test('landing prioritizes unfinished work then completions from the last week', () => {
  const recent = datedWork('recent', 'Recent completion', 'done', 1)
  const old = { ...datedWork('old', 'Old completion', 'done', 30), updatedAt: new Date(now) }
  expect(
    workResults('', [
      old,
      recent,
      datedWork('queued', 'Queued work', 'queued', 3),
      datedWork('active', 'Active work', 'active', 2),
      datedWork('canceled', 'Canceled work', 'canceled', 0),
    ])
  ).toEqual(['active', 'queued', 'recent'])
})

test('recently completed work filters by squad and immutable completion date, newest first', () => {
  const now = Date.parse('2026-09-06T12:00:00Z')
  const work = (id: string, age: number, extra = {}) => ({
    id,
    squadId: 'tau',
    status: 'done',
    completedAt: new Date(now - age * 86_400_000),
    updatedAt: new Date(now),
    ...extra,
  })
  const streams = [
    work('old', 31),
    work('week', 7),
    work('month', 30),
    work('yesterday', 1),
    work('canceled', 1, { status: 'canceled' }),
    work('other-squad', 1, { squadId: 'other' }),
    work('legacy', 2, { completedAt: undefined, updatedAt: new Date(now - 2 * 86_400_000) }),
  ] as any
  expect(recentlyCompletedWork(streams, 'tau', 7, now).map((w) => w.id)).toEqual(['yesterday', 'legacy', 'week'])
  expect(recentlyCompletedWork(streams, 'tau', 30, now).map((w) => w.id)).toEqual([
    'yesterday',
    'legacy',
    'week',
    'month',
  ])
})

test('Voices searches navigate to the standalone settings page only when allowed', () => {
  const allowed = { ...data, allowedSettings: new Set(['voices']) }
  expect(commandCenterSearch('Voices', allowed)[0]?.path).toBe('/settings?section=voices')
  expect(commandCenterSearch('public text', allowed)[0]?.label).toBe('Voices')
  expect(commandCenterSearch('Voices', data)).toEqual([])
})
test('lists a pending approval in the same words as the Feed, not by its action type', () => {
  const approval = waitAction('gate', {
    type: 'workstream-blocked',
    wait: { type: 'manual', workflowHumanGate: true, resolutionHandler: 'workflow' },
  })
  const [row] = commandCenterSearch('', { ...data, actions: [approval] }).filter((r) => r.kind === 'Needs you')
  expect(row!.detail).toBe('Product Engineering · Engineer · review needed')
  expect(row!.detail).not.toContain('blocked')
})
test('an untitled conversation is named by its agent type, never by the agent name alone', () => {
  const untitled = { ...data.consultants[0], id: 'untitled', metadata: { name: 'Quartz' } }
  const row = commandCenterSearch('', { ...data, consultants: [untitled] }).find((r) => r.id === 'chat:untitled')
  expect(row!.label).toBe('Consultant')
})
