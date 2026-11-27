// The same work streams in the Feed, a squad's Work list and the Assistant, with the real components and
// theme styles: one Needs you question, one routine approval gate and five active streams.
// `?section=feed|squad|assistant` renders one surface; `theme` and `appearance` pick the theme.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Agent, PendingAction, Squad, WorkStream } from '@ficus/shared'
import { ActionCenterContent } from '../../src/components/ActionCenterContent'
import { AssistantCommandCenter } from '../../src/components/AssistantCommandCenter'
import { WorkStreamList } from '../../src/components/WorkStreamList'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { integrationQueries, queries } from '../../src/queryOptions'
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
const section = params.get('section') ?? 'feed'

const squad = (id: string, name: string, purpose: string) =>
  ({ id, name, purpose, status: 'active', isAnonymous: false, avatarUrl: null }) as unknown as Squad
const squads = [
  squad(
    'product',
    'Product Engineering',
    'Build a product customers love. Ship thoughtful improvements to onboarding, payments, and the API.'
  ),
  squad('growth', 'Growth', 'Turn useful product improvements into stories that help more teams discover them.'),
]

const agent = (id: string, agentTypeId: string, squadId: string, name: string, purpose?: string) =>
  ({
    id,
    agentTypeId,
    squadId,
    status: 'active',
    metadata: { name, ...(purpose ? { purpose } : {}) },
    createdAt: '2026-11-19T08:00:00Z',
  }) as unknown as Agent
const agents = [
  agent('eng-1', 'engineer', 'product', 'Quartz', 'Onboarding'),
  agent('eng-3', 'engineer', 'product', 'Flint', 'Instant search'),
  agent('gp-5', 'general-purpose', 'growth', 'Wren', 'Launch story'),
  agent('gp-7', 'general-purpose', 'growth', 'Moss', 'Customer wins'),
]

const day = 86_400_000
const now = Date.now()
const work = (
  number: number,
  squadId: string,
  title: string,
  assigneeAgentId: string | null,
  extra: Partial<WorkStream> = {}
) =>
  ({
    id: `ws-${number}`,
    number,
    title,
    squadId,
    status: 'active',
    priority: 'normal',
    assigneeAgentId,
    agentIds: assigneeAgentId ? [assigneeAgentId] : [],
    createdAt: new Date(now - 7 * day).toISOString(),
    updatedAt: new Date(now - 7 * day).toISOString(),
    runtime: { totalMs: 7 * day + 2 * 3_600_000, activeCount: 0, computedAt: new Date(now).toISOString() },
    openWaits: [],
    metadata: {},
    ...extra,
  }) as unknown as WorkStream
const gate = {
  id: 'gate-2',
  workStreamId: 'ws-2',
  type: 'manual',
  workflowHumanGate: true,
  resolutionHandler: 'workflow',
  referenceId: 'flow:ws-2:gate',
  message: 'Review the retry change before it ships.',
  createdBy: 'agent',
  createdByAgentId: null,
  createdByUserId: null,
  completesOnApproval: false,
  openedAt: new Date(now - 7 * day).toISOString(),
  closedAt: null,
  resolution: null,
  resolutionNote: null,
}
const workStreams = [
  work(2, 'product', 'Make every payment retry safe', null, { derivedState: 'in_review', openWaits: [gate] as never }),
  work(1, 'product', 'Make the first five minutes effortless', 'eng-1', {
    derivedState: 'waiting_on_answer',
    openWaits: [
      {
        ...gate,
        id: 'question-1',
        workStreamId: 'ws-1',
        type: 'question',
        referenceId: 'q-1',
        workflowHumanGate: false,
        resolutionHandler: undefined,
      },
    ] as never,
  }),
  work(5, 'growth', 'Tell the story of a better first day', 'gp-5', { derivedState: 'in_progress' }),
  work(7, 'growth', 'Turn customer wins into launch stories', 'gp-7', { derivedState: 'in_progress' }),
  work(3, 'product', 'Bring instant search to every workspace', 'eng-3', { derivedState: 'in_progress' }),
]

const pendingActions = [
  {
    id: 'agent-question:q-1',
    type: 'agent-question',
    priority: 1,
    createdAt: new Date(now - day).toISOString(),
    canRespond: true,
    squadId: 'product',
    squadName: 'Product Engineering',
    data: {
      questionId: 'q-1',
      agentId: 'eng-1',
      agentName: 'Quartz',
      agentTypeId: 'engineer',
      squadId: 'product',
      squadName: 'Product Engineering',
      ownerUserId: 'viewer',
      questionData: {
        questions: [{ id: 'q', type: 'text', question: 'How should we welcome a team to its first workspace?' }],
      },
      workStream: { id: 'ws-1', number: 1, title: 'Make the first five minutes effortless' },
    },
  },
  {
    id: 'workstream-blocked:ws-2:gate-2',
    type: 'workstream-blocked',
    priority: 3,
    createdAt: new Date(now - 7 * day).toISOString(),
    canRespond: true,
    squadId: 'product',
    squadName: 'Product Engineering',
    data: {
      workStreamId: 'ws-2',
      workStreamNumber: 2,
      workStreamTitle: '#2 · Make every payment retry safe',
      squadId: 'product',
      squadName: 'Product Engineering',
      waitId: 'gate-2',
      wait: gate,
      focus: { kind: 'workstream-wait', workStreamId: 'ws-2', waitId: 'gate-2' },
      assigneeAgentId: 'eng-2',
      assigneeName: 'Pyrite',
      assigneeAgentTypeId: 'engineer',
      completionMode: 'review-approval',
      prompt: { type: 'text', message: 'Review the retry change before it ships.' },
    },
  },
] as unknown as PendingAction[]

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
for (const [key, value] of [
  [queries.squads.list().queryKey, squads],
  [queries.squads.list('active').queryKey, squads],
  [queries.squads.allWorkStreams().queryKey, workStreams],
  [queries.squads.activeWorkStreams().queryKey, workStreams],
  [queries.agents.summaries({ live: true }).queryKey, agents],
  [queries.agents.list({ agentTypeId: 'consultant' }).queryKey, []],
  [
    queries.agentTypes.list().queryKey,
    [
      { id: 'engineer', name: 'Engineer' },
      { id: 'general-purpose', name: 'General Purpose' },
      { id: 'consultant', name: 'Consultant' },
    ],
  ],
  [queries.actions.pending().queryKey, pendingActions],
  [integrationQueries.catalog().queryKey, { integrations: [] }],
] as const)
  client.setQueryData(key as never, value as never)

const squadMap = new Map(squads.map((item) => [item.id, item]))
const agentMap = new Map(agents.map((item) => [item.id, item]))

function Surface() {
  if (section === 'assistant')
    return (
      <div className="mx-auto flex h-[640px] max-w-2xl flex-col overflow-hidden rounded-2xl border border-th-border bg-surface">
        <AssistantCommandCenter
          active
          stack={[]}
          onPush={() => {}}
          onBack={() => {}}
          onAsk={() => {}}
          canAsk
          onNavigate={() => {}}
          onBrowseAssistant={() => {}}
        />
      </div>
    )
  if (section === 'squad')
    return (
      <section data-testid="squad-surface" className="mx-auto max-w-5xl">
        <WorkStreamList
          workStreams={workStreams.filter((stream) => stream.squadId === 'product')}
          squadMap={squadMap}
          agentMap={agentMap}
          showSquadFilter={false}
          hideFilters
          activeOnly
        />
      </section>
    )
  return (
    <section data-testid="feed-surface" className="mx-auto max-w-5xl space-y-6">
      <ActionCenterContent actions={pendingActions} isLoading={false} />
      <WorkStreamList
        workStreams={workStreams}
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
