// Live changes in the Feed (Needs you and Active work), a squad's Work list and Activity, with the real
// components and theme styles. `window.liveStep()` applies one live update: a stream moves to the top, a
// stream arrives, a status changes, a card arrives in Needs you and a row streams into Activity.
// `?section=feed|squad|activity` picks the surface, `rows=N` the number of active streams (default 5),
// `collapsed=1` starts the Feed's Needs you collapsed, `theme` and `appearance` the theme.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Agent, PendingAction, Squad, SquadActivityItem, WorkStream } from '@ficus/shared'
import { ActionCenterContent } from '../../src/components/ActionCenterContent'
import { WorkStreamList } from '../../src/components/WorkStreamList'
import { ActivityFeedView } from '../../src/components/squads/ActivityFeedView'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { queries } from '../../src/queryOptions'
import { applyResolvedTheme } from '../../src/theme/apply'
import { BUILT_IN_THEMES, FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

declare global {
  interface Window {
    liveStep: () => void
    /** Milliseconds spent in LiveListMotion's measuring and planning, per method (absent without it). */
    liveMotionMs?: Record<string, number>
  }
}

// Time LiveListMotion's own work. A glob, so this fixture also runs on a branch without the component.
type Timed = Record<string, (...args: unknown[]) => unknown>
for (const module of Object.values(
  import.meta.glob<{ LiveListMotion: { prototype: Timed } }>('../../src/components/LiveListMotion.tsx', {
    eager: true,
  })
)) {
  window.liveMotionMs = {}
  const prototype = module.LiveListMotion.prototype
  for (const method of ['getSnapshotBeforeUpdate', 'componentDidUpdate', 'playMotion']) {
    const original = prototype[method]!
    prototype[method] = function (this: unknown, ...args: unknown[]) {
      const start = performance.now()
      try {
        return original.apply(this, args)
      } finally {
        window.liveMotionMs![method] = (window.liveMotionMs![method] ?? 0) + performance.now() - start
      }
    }
  }
}

const params = new URLSearchParams(location.search)
const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === params.get('theme')) ?? FICUS_THEME
applyResolvedTheme(
  document.documentElement,
  theme,
  theme.kind === 'unified' ? 'constant' : params.get('appearance') === 'dark' ? 'dark' : 'light'
)
const section = params.get('section') ?? 'feed'
const rowCount = Number(params.get('rows') ?? 5)
const needsYouCollapsed = params.get('collapsed') === '1'

const squads = [
  { id: 'product', name: 'Product Engineering', purpose: 'Build a product customers love.' },
  { id: 'growth', name: 'Growth', purpose: 'Help more teams discover Ficus.' },
] as unknown as Squad[]
const agents = [
  { id: 'eng-1', agentTypeId: 'engineer', squadId: 'product', status: 'active', metadata: {} },
  { id: 'gp-1', agentTypeId: 'general-purpose', squadId: 'growth', status: 'active', metadata: {} },
] as unknown as Agent[]

const TITLES = [
  'Make the first five minutes effortless',
  'Make every payment retry safe',
  'Bring instant search to every workspace',
  'Tell the story of a better first day',
  'Turn customer wins into launch stories',
  'Speed up the squad home page',
  'Let reviewers approve from the Feed',
]
const STATES = ['in_progress', 'in_review', 'waiting_on_answer', 'queued', 'in_progress', 'waiting_on_dependency']

const now = Date.now()
function work(number: number, derivedState = STATES[number % STATES.length]!): WorkStream {
  const squadId = number % 2 ? 'product' : 'growth'
  return {
    id: `ws-${number}`,
    number,
    title: number === 99_999 ? 'Show live changes with motion' : TITLES[number % TITLES.length]!,
    squadId,
    status: derivedState === 'queued' ? 'queued' : 'active',
    derivedState,
    priority: 'normal',
    assigneeAgentId: squadId === 'product' ? 'eng-1' : 'gp-1',
    agentIds: [],
    createdAt: new Date(now - 3_600_000).toISOString(),
    updatedAt: new Date(now - 3_600_000).toISOString(),
    openWaits: [],
    metadata: {},
  } as unknown as WorkStream
}

function action(id: string, question: string, minutesAgo: number): PendingAction {
  return {
    id: `agent-question:${id}`,
    type: 'agent-question',
    priority: 1,
    createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    canRespond: true,
    squadId: 'product',
    squadName: 'Product Engineering',
    data: {
      questionId: id,
      agentId: 'eng-1',
      agentName: null,
      agentTypeId: 'engineer',
      squadId: 'product',
      squadName: 'Product Engineering',
      ownerUserId: 'viewer',
      questionData: { questions: [{ id: 'q', type: 'text', question }] },
    },
  } as unknown as PendingAction
}

function activity(id: number, summary: string, secondsAgo: number): SquadActivityItem {
  return {
    id: `act-${id}`,
    at: new Date(now - secondsAgo * 1000).toISOString(),
    agentId: 'eng-1',
    agentTypeId: 'engineer',
    kind: 'message',
    summary,
    preview: [{ text: summary }],
    ref: { type: 'agent', agentId: 'eng-1', view: 'chat' },
  } as unknown as SquadActivityItem
}

const initialStreams = Array.from({ length: rowCount }, (_, index) => work(index + 1))
const initialActions = [action('q-1', 'Which payment provider should retries use first?', 30)]
const initialActivity = [
  activity(3, 'Opened a pull request for the retry change', 120),
  activity(2, 'Finished the payment retry tests', 300),
  activity(1, 'Started on the payment retry change', 900),
]

/** One live update: the last stream moves to the top, a new one arrives second, the first changes state (review needed to in progress). */
function liveStreams(streams: WorkStream[]): WorkStream[] {
  const last = streams[streams.length - 1]!
  const [first, ...rest] = streams.slice(0, -1)
  return [last, work(99_999, 'in_progress'), { ...first!, derivedState: 'in_progress' }, ...rest]
}

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(
  queries.agentTypes.list().queryKey as never,
  [
    { id: 'engineer', name: 'Engineer' },
    { id: 'general-purpose', name: 'General Purpose' },
  ] as never
)
const squadMap = new Map(squads.map((item) => [item.id, item]))
const agentMap = new Map(agents.map((item) => [item.id, item]))

function Surface() {
  const [step, setStep] = useState(0)
  useEffect(() => {
    window.liveStep = () => setStep((current) => current + 1)
  }, [])
  const streams = step === 0 ? initialStreams : liveStreams(initialStreams)
  const actions =
    step === 0 ? initialActions : [...initialActions, action('q-2', 'Can the retry change ship today?', 0)]
  const items =
    step === 0 ? initialActivity : [activity(4, 'Asked whether the retry change can ship today', 0), ...initialActivity]

  if (section === 'activity')
    return (
      <section data-testid="activity-surface" className="mx-auto flex h-[600px] max-w-5xl flex-col">
        <ActivityFeedView
          kinds={[]}
          onKindsChange={() => {}}
          isLoading={false}
          isError={false}
          items={items}
          loadingShapeKey="activity:squad:product"
          workingAgentIds={new Set(['eng-1'])}
          agentDetailFor={() => undefined}
          hrefFor={() => '/activity'}
          onOpen={() => {}}
          onOpenAgentReference={() => {}}
          hasNextPage={false}
          isFetchingNextPage={false}
          onLoadMore={() => {}}
        />
      </section>
    )
  if (section === 'squad')
    return (
      <section data-testid="squad-surface" className="mx-auto max-w-5xl">
        <WorkStreamList
          workStreams={streams}
          squadMap={squadMap}
          agentMap={agentMap}
          showSquadFilter={false}
          hideFilters
          activeOnly
          loadingShapeKey="work-streams:squad:product"
        />
      </section>
    )
  return (
    <section data-testid="feed-surface" className="mx-auto max-w-5xl space-y-6">
      {/* Like the Feed's Needs you: a disclosure the viewer can collapse. */}
      <details open={!needsYouCollapsed} data-testid="needs-you">
        <summary>Needs you</summary>
        <ActionCenterContent actions={actions} isLoading={false} showSectionCounts={false} liveMotionKey="[]" />
      </details>
      <WorkStreamList
        workStreams={streams}
        squadMap={squadMap}
        agentMap={agentMap}
        squads={squads}
        showSquadFilter
        feedLayout
        hideFilters
        activeOnly
      />
    </section>
  )
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <PermissionsProvider
      usePermissions={() => ({
        permissions: ['chat:send'],
        identity: { type: 'user', userId: 'viewer' },
        can: (permission: string) => permission === 'chat:send',
        isLoading: false,
        isError: false,
      })}
    >
      <MemoryRouter initialEntries={['/feed']}>
        <main className="min-h-screen bg-page p-6 text-primary">
          <Surface />
        </main>
      </MemoryRouter>
    </PermissionsProvider>
  </QueryClientProvider>
)
