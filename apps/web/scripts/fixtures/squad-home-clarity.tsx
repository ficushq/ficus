// The real squad page (header chips and Home's active work) with synthetic data and no backend:
// a workspace that has not been started yet, the squad's notification level, and three streams,
// two of them waiting on a person. `?ws=<id>` opens that stream's detail modal.
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBlankWorkflow, createWorkflowRun, type Squad, type WorkStream, type WorkStreamWait } from '@ficus/shared'
import { SquadDetailPage } from '../../src/components/SquadDetailPage'
import { WebSocketContext } from '../../src/hooks/useWebSocket'
import { queries } from '../../src/queryOptions'
import { queryKeys } from '../../src/queryKeys'
import { applyResolvedTheme } from '../../src/theme/apply'
import { BUILT_IN_THEMES, FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === params.get('theme')) ?? FICUS_THEME
applyResolvedTheme(
  document.documentElement,
  theme,
  theme.kind === 'unified' ? 'constant' : params.get('appearance') === 'dark' ? 'dark' : 'light'
)

const now = Date.now()
const hour = 3_600_000
const squadId = '00000000-0000-4000-8000-000000000001'
const squad = {
  id: squadId,
  name: 'Product Engineering',
  purpose: 'Build a product customers love. Ship thoughtful improvements to onboarding, payments, and the API.',
  status: 'active',
  squadPresetId: null,
  defaultAgents: [],
  managerAgentId: null,
  context: null,
  isAnonymous: false,
  globalCollaborationEnabled: false,
  order: 0,
  metadata: {},
  sandboxStatus: 'none',
  avatarUrl: null,
  createdAt: new Date(now - 8 * 24 * hour),
  updatedAt: new Date(now - 8 * 24 * hour),
} as unknown as Squad

const created = new Date(now - (7 * 24 + 3) * hour)
const wait = (id: string, workStreamId: string, overrides: Partial<WorkStreamWait>): WorkStreamWait =>
  ({
    id,
    workStreamId,
    type: 'review',
    referenceId: null,
    message: 'Ready for review.',
    createdBy: 'agent',
    createdByAgentId: null,
    createdByUserId: null,
    completesOnApproval: true,
    openedAt: new Date(now - (7 * 24 + 2) * hour).toISOString(),
    closedAt: null,
    resolution: null,
    resolutionNote: null,
    ...overrides,
  }) as WorkStreamWait
const stream = (id: string, number: number, title: string, overrides: Partial<WorkStream>): WorkStream =>
  ({
    id,
    number,
    squadId,
    title,
    description: 'Synthetic fixture stream.',
    status: 'active',
    priority: 'normal',
    assigneeAgentId: null,
    ownerAgentId: null,
    agentIds: [],
    dependsOn: [],
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'pr-auto-merge',
    openWaits: [],
    createdAt: created,
    updatedAt: created,
    ...overrides,
  }) as WorkStream
const computedAt = new Date(now).toISOString()
const streams = [
  stream('ws-2', 2, 'Make every payment retry safe', {
    derivedState: 'in_review',
    openWaits: [wait('wait-2', 'ws-2', {})],
    runtime: { totalMs: 2 * hour + 14 * 60_000, activeCount: 0, workingCount: 0, computedAt },
  }),
  stream('ws-1', 1, 'Make the first five minutes effortless', {
    derivedState: 'waiting_on_answer',
    openWaits: [
      wait('wait-1', 'ws-1', {
        type: 'question',
        referenceId: 'question-1',
        message: 'Which sign-up step should go first?',
        openedAt: new Date(now - 26 * hour).toISOString(),
      }),
    ],
    runtime: { totalMs: 48 * 60_000, activeCount: 0, workingCount: 0, computedAt },
  }),
  stream('ws-3', 3, 'Bring instant search to every workspace', {
    derivedState: 'in_progress',
    runtime: { totalMs: 3 * hour + 5 * 60_000, activeCount: 1, workingCount: 1, computedAt },
  }),
]

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })
client.setQueryData(queryKeys.squads.list(), [squad])
client.setQueryData(queryKeys.squads.list('active'), [squad])
client.setQueryData(queryKeys.squads.detail(squadId), squad)
client.setQueryData(queryKeys.squads.basic(squadId), squad)
client.setQueryData(queryKeys.squads.agentsWithRecent(squadId), { agents: [], recentlyTerminated: [] })
client.setQueryData(queryKeys.squads.activeWorkStreams(squadId), streams)
client.setQueryData(queryKeys.squads.workStreams(squadId), streams)
for (const item of streams) client.setQueryData(queryKeys.squads.workStreamDetail(item.id), item)
client.setQueryData(queryKeys.auth.permissions(squadId), {
  permissions: ['workstreams:read', 'workstreams:respond', 'agents:run'],
  identity: { type: 'user', userId: 'fixture-user' },
})
client.setQueryData(queryKeys.squadSubscription.detail(squadId), {
  attention: { decisions: 'show', progress: 'show' },
})
// What the detail modal reads besides the stream, so its screenshot shows no loading skeletons.
const definition = createBlankWorkflow()
const usage = { tokens: 0, cost: 0, executions: 0, measuredExecutions: 0 }
for (const item of streams) {
  client.setQueryData(queryKeys.workflows.run(item.id), {
    workStreamId: item.id,
    source: { kind: 'inline', definition },
    state: createWorkflowRun(definition),
    version: 0,
    attemptAgents: {},
    usage: { total: usage, unattributed: usage, steps: {}, attempts: {} },
  })
  client.setQueryData(queryKeys.squads.workStreamMetrics(item.id), {
    cost: 1.42,
    tokens: { total: 182_000, input: 150_000, output: 32_000, cacheRead: 0, cacheWrite: 0 },
    executions: { completed: 6, total: 6, failed: 0 },
    duration: { totalMs: 0, firstStartedAt: null, lastEndedAt: null },
    byAgent: {},
  })
  client.setQueryData(queryKeys.squads.workStreamTracked(item.id), { resources: [], subscriptions: 'not-following' })
  client.setQueryData(queryKeys.workStreamSubscription.detail(item.id), {
    inherited: true,
    attention: { decisions: 'show', progress: 'show' },
  })
  client.setQueryData(queries.activity.workStreamRecent(item.id).queryKey, { items: [], hasMore: false })
}
// A VM squad whose box has never been provisioned: normal until the first agent runs.
client.setQueryData(queryKeys.sandbox.status(squadId), {
  status: 'not_found',
  runtime: 'vm',
  chain: { boxProvisioned: false, machine: 'unknown', boxServer: 'unknown' },
})

const ws = params.get('ws')
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <WebSocketContext.Provider value={{ isConnected: true, subscribe: () => () => undefined }}>
      <MemoryRouter initialEntries={[`/squads/${squadId}${ws ? `?ws=${ws}` : ''}`]}>
        <main className="min-h-screen bg-page p-6 text-primary">
          <Routes>
            <Route
              path="/squads/:squadId/:tab?"
              element={
                <SquadDetailPage
                  dependencies={{
                    useWebSocket: () => ({ isConnected: true, subscribe: () => () => undefined }),
                    SquadAgentThreads: () => null,
                    homeTabDependencies: { SquadAgentThreads: () => null },
                  }}
                />
              }
            />
          </Routes>
        </main>
      </MemoryRouter>
    </WebSocketContext.Provider>
  </QueryClientProvider>
)
