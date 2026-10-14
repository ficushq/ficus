// Synthetic data only; queries are disabled so this fixture never contacts a backend.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBlankWorkflow, createWorkflowRun, type WorkStream } from '@ficus/shared'
import { WorkStreamDetailModal } from '../../src/components/WorkStreamDetailModal'
import { WorkStreamGraph } from '../../src/components/WorkStreamGraph'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
const token = 'unbrokentoken'.repeat(35)
const path = 'apps/mobile/src/components/ConversationListPopup.tsx'
const stream = {
  id: 'fixture',
  number: 442,
  squadId: 'squad',
  title: 'Workflow and description verification',
  status: 'active',
  priority: 'normal',
  completionMode: 'deliverable',
  agentIds: [],
  dependsOn: [],
  metadata: {},
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  description: `${path}\n\n${token}\n\nhttps://example.com/${token}\n\n[${token}](https://example.com/)\n\n\`${path}/${token}\`\n\nNormal **markdown** remains readable.\n\n\`\`\`ts\nconst value = '${token}'\n\`\`\`\n\n| File | Value |\n| --- | --- |\n| ${path} | ${token} |`,
}
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })
const definition = createBlankWorkflow()
definition.name = 'Focused mobile picker visual follow-up'
const usage = { tokens: 1234, cost: 0.25, executions: 1, measuredExecutions: 1 }
const run = {
  workStreamId: stream.id,
  source: { kind: 'inline', definition },
  state: createWorkflowRun(definition),
  version: 0,
  attemptAgents: { '1': 'builder-agent' },
  usage: { total: usage, unattributed: usage, steps: { execute: usage }, attempts: { '1': usage } },
}
if (new URLSearchParams(location.search).has('delivery')) {
  stream.completionMode = 'pr-auto-merge'
  run.state.definition.completion.mode = 'pr-auto-merge'
  run.state.status = 'completion-ready'
  run.state.attempts[0]!.status = 'completed'
  run.state.completedStepIds = ['execute']
}
if (new URLSearchParams(location.search).has('paused')) {
  Object.assign(stream, {
    pause: {
      id: 'p',
      reason: 'Waiting for the maintenance window',
      pausedAt: new Date().toISOString(),
      parkAt: null,
      agentIds: [],
    },
  })
}
/** A made-up neighbor stream for the dependency fixtures. */
const neighbor = (id: string, number: number, title: string, extra: Record<string, unknown> = {}) => ({
  ...stream,
  id,
  number,
  title,
  description: '',
  dependsOn: [] as string[],
  ...extra,
})
const dependencyStreams = [
  neighbor('dep-ready', 438, 'Shared parser for import files'),
  neighbor('dep-waiting', 440, 'Rate limit settings page', { status: 'active' }),
  neighbor('dep-done', 431, 'Importer error codes', { status: 'done' }),
]
const dependencyEdges = [
  {
    workStreamId: 'dep-ready',
    condition: 'ready',
    satisfied: true,
    unlockedAt: new Date().toISOString(),
    stack: { mode: 'stacked', branch: 'work/shared-parser', headSha: 'a'.repeat(40) },
    holdsDelivery: true,
  },
  { workStreamId: 'dep-waiting', condition: 'ready', satisfied: false },
  { workStreamId: 'dep-done', condition: 'done', satisfied: true },
]
if (new URLSearchParams(location.search).has('dependencies')) {
  Object.assign(stream, {
    title: 'Import preview built on the shared parser',
    description: 'Shows the first rows of an import file before it is committed.',
    dependsOn: dependencyEdges.map((edge) => edge.workStreamId),
    dependencies: dependencyEdges,
    openWaits: [
      {
        id: 'wait-1',
        workStreamId: stream.id,
        type: 'dependency',
        referenceId: 'dep-waiting',
        message: null,
        openedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        closedAt: null,
      },
    ],
  })
  for (const dependency of dependencyStreams)
    cache.setQueryData(queryKeys.squads.workStreamDetail(dependency.id), dependency)
}
cache.setQueryData(queryKeys.squads.workStreamDetail(stream.id), stream)
cache.setQueryData(queryKeys.workflows.run(stream.id), run)
cache.setQueryData(queryKeys.squads.list(), [])
cache.setQueryData(queryKeys.workStreamSubscription.detail(stream.id), {
  inherited: true,
  attention: { decisions: 'notify', progress: 'mute' },
})
cache.setQueryData(queryKeys.auth.permissions(stream.squadId), {
  permissions: ['workstreams:update', 'workstreams:respond', 'workstreams:revise-flow', 'workflows:create'],
  identity: { type: 'user', userId: 'fixture' },
})
cache.setQueryData(queryKeys.squads.workStreamMetrics(stream.id), {
  cost: 0.25,
  tokens: { total: 1234, input: 1000, output: 234, cacheRead: 0, cacheWrite: 0 },
  executions: { completed: 1, total: 1 },
  byAgent: {},
})
cache.setQueryData(queryKeys.squads.workStreamTracked(stream.id), { resources: [], subscriptions: 'not-following' })
function GraphFixture() {
  const streams = [
    ...dependencyStreams.filter((dependency) => dependency.status !== 'done'),
    neighbor('fixture', 442, 'Import preview built on the shared parser', {
      dependsOn: ['dep-ready', 'dep-waiting'],
      dependencies: dependencyEdges.slice(0, 2),
    }),
    neighbor('plain', 444, 'Importer documentation', {
      status: 'queued',
      dependsOn: ['dep-ready'],
      dependencies: [{ workStreamId: 'dep-ready', condition: 'done', satisfied: false }],
    }),
  ]
  return (
    <div className="p-6">
      <WorkStreamGraph
        workStreams={streams as unknown as WorkStream[]}
        agentMap={new Map()}
        onSelectWorkStream={() => undefined}
      />
    </div>
  )
}
function App() {
  const [open, setOpen] = React.useState(true)
  if (new URLSearchParams(location.search).has('graph')) return <GraphFixture />
  return (
    <MemoryRouter>
      <QueryClientProvider client={cache}>
        <button onClick={() => setOpen(true)}>Reopen</button>
        {open && (
          <WorkStreamDetailModal
            workStream={stream as unknown as WorkStream}
            squadMap={new Map()}
            agentMap={new Map()}
            onClose={() => setOpen(false)}
          />
        )}
      </QueryClientProvider>
    </MemoryRouter>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
