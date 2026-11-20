// Synthetic data only: every query is seeded or disabled, so this fixture never contacts a backend.
// ?view=feed (Feed list, peek on hover), ?view=work (Work tab list), ?view=home (squad Home list),
// ?view=board (Work tab board), ?view=modal (detail modal);
// "Show summaries" is on by default; add &nosummaries to turn it off on every list, &dark for the dark appearance.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AgentSummary, Squad, WorkStream } from '@ficus/shared'
import { WorkStreamList } from '../../src/components/WorkStreamList'
import { WorkStreamList as SquadWorkStreamList } from '../../src/components/squads/WorkStreamList'
import { WorkStreamDetailModal } from '../../src/components/WorkStreamDetailModal'
import { workStreamSummariesStorageKey } from '../../src/components/WorkStreamSummary'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'

const params = new URLSearchParams(location.search)
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')
const view = params.get('view') ?? 'feed'
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const squad = {
  id: 'squad-1',
  name: 'Ficus',
  purpose: 'Build Ficus',
  status: 'active',
  defaultAgents: [],
  managerAgentId: null,
  metadata: {},
  createdAt: minutesAgo(9_000),
  updatedAt: minutesAgo(10),
} as unknown as Squad

const agents: AgentSummary[] = [
  { id: 'eng-1', agentTypeId: 'engineer', squadId: squad.id, parentAgentId: null, status: 'active' },
  { id: 'rev-1', agentTypeId: 'reviewer', squadId: squad.id, parentAgentId: null, status: 'idle' },
  { id: 'eng-2', agentTypeId: 'engineer', squadId: squad.id, parentAgentId: null, status: 'idle' },
  { id: 'arch-1', agentTypeId: 'architect', squadId: squad.id, parentAgentId: null, status: 'active' },
]

const wait = (id: string, workStreamId: string, type: 'question' | 'review' | 'dependency', minutes: number) => ({
  id,
  workStreamId,
  type,
  referenceId: null,
  message: null,
  createdBy: 'agent',
  createdByAgentId: null,
  openedAt: minutesAgo(minutes),
  closedAt: null,
  resolution: null,
  resolutionNote: null,
})

function stream(
  id: string,
  number: number,
  title: string,
  step: string,
  summary: string | null,
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    number,
    squadId: squad.id,
    title,
    description: 'Synthetic fixture stream.',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    assigneeAgentId: 'eng-1',
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: ['eng-1', 'rev-1'],
    dependsOn: [],
    dependedOnBy: [],
    handoffMessage: null,
    files: [],
    metadata: {},
    completionMode: 'pr-auto-merge',
    createdAt: minutesAgo(180),
    updatedAt: minutesAgo(3),
    runtime: { totalMs: 42 * 60_000, activeCount: 0, computedAt: minutesAgo(0) },
    step,
    ...(summary ? { summary: { text: summary, generatedAt: minutesAgo(4), step } } : {}),
    openWaits: [],
    ...extra,
  } as unknown as WorkStream
}

const streams: WorkStream[] = [
  stream(
    'ws-1',
    1354,
    'Work stream one-line summaries',
    'Implement',
    'Wiring the peek card into Feed, Home and Work rows',
    {
      openWaits: [wait('w-1', 'ws-1', 'question', 6)],
      derivedState: 'waiting_on_answer',
      metadata: {
        codeHost: {
          integration: 'github',
          repository: 'ficushq/ficus',
          changeRequest: { number: 996, url: 'https://github.com/ficushq/ficus/pull/996' },
        },
      },
    }
  ),
  stream(
    'ws-2',
    1352,
    'Floating agent chat windows',
    'Code review',
    'Reviewer is checking drag snapping on narrow screens',
    {
      assigneeAgentId: 'rev-1',
      agentIds: ['eng-2', 'rev-1'],
    }
  ),
  stream('ws-3', 1349, 'Importer error codes', 'Plan', 'Mapping parser failures to stable error codes for the API', {
    assigneeAgentId: 'arch-1',
    agentIds: ['arch-1'],
  }),
  stream('ws-4', 1347, 'Faster squad switcher', 'Implement', null, { agentIds: ['eng-2'], assigneeAgentId: 'eng-2' }),
]
const done = stream('ws-9', 1340, 'Activity row context', 'Done', null, {
  status: 'done',
  derivedState: 'done',
  completedAt: minutesAgo(90),
})

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })
cache.setQueryData(queryKeys.agentTypes.list(), [
  { id: 'engineer', name: 'Engineer' },
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'architect', name: 'Architect' },
])
cache.setQueryData(queryKeys.squads.agents(squad.id), agents)
cache.setQueryData(queryKeys.squads.list(), [squad])
cache.setQueryData(queryKeys.squads.basic(squad.id), squad)
cache.setQueryData(queryKeys.auth.permissions(squad.id), {
  permissions: ['workstreams:update', 'workstreams:respond'],
  identity: { type: 'user', userId: 'fixture' },
})
for (const item of [...streams, done]) {
  cache.setQueryData(queryKeys.squads.workStreamDetail(item.id), item)
  cache.setQueryData(queryKeys.squads.workStreamTracked(item.id), { resources: [], subscriptions: 'not-following' })
  cache.setQueryData(queryKeys.workStreamSubscription.detail(item.id), {
    inherited: true,
    attention: { decisions: 'notify', progress: 'notify' },
  })
}
localStorage.clear()
if (params.has('nosummaries'))
  for (const surface of ['feed', 'home', 'work'] as const)
    localStorage.setItem(workStreamSummariesStorageKey(surface), 'false')
if (view === 'board') localStorage.setItem(`ficus.wsView.${squad.id}`, 'kanban')

function Feed() {
  const [filterContainer, setFilterContainer] = useState<HTMLDivElement | null>(null)
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-primary">Feed</h1>
        <div ref={setFilterContainer} />
      </div>
      <WorkStreamList
        workStreams={streams}
        doneStreams={[done]}
        squadMap={new Map([[squad.id, squad]])}
        agentMap={new Map(agents.map((agent) => [agent.id, agent]))}
        squads={[squad]}
        feedLayout
        filterContainer={filterContainer}
        summarySurface="feed"
      />
    </div>
  )
}

function App() {
  return (
    <MemoryRouter>
      <QueryClientProvider client={cache}>
        {view === 'feed' && <Feed />}
        {(view === 'work' || view === 'home') && (
          <div className="mx-auto max-w-4xl p-6">
            <SquadWorkStreamList
              workStreams={streams}
              squadId={squad.id}
              squad={squad}
              compact={view === 'home'}
              activeOnly={view === 'home'}
              activeCollapsible={view === 'home'}
            />
          </div>
        )}
        {view === 'board' && (
          <div className="h-screen p-6">
            <SquadWorkStreamList workStreams={streams} squadId={squad.id} squad={squad} />
          </div>
        )}
        {view === 'modal' && (
          <WorkStreamDetailModal
            workStream={streams[0]!}
            squadMap={new Map([[squad.id, squad]])}
            agentMap={new Map()}
            onClose={() => undefined}
          />
        )}
      </QueryClientProvider>
    </MemoryRouter>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
