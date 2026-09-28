import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { Squad, WorkStream } from '@ficus/shared'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import { QueryInvalidator } from '../QueryInvalidator'
import { SquadHomeTab } from './SquadHomeTab'
import { WorkStreamList } from './WorkStreamList'

const now = new Date('2026-08-14T12:00:00Z')
const squad = {
  id: 'squad-live',
  name: 'Live graph squad',
  purpose: '',
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
  createdAt: now,
  updatedAt: now,
} as Squad
function stream(id: string, dependsOn: string[] = []): WorkStream {
  return {
    id,
    squadId: squad.id,
    title: `Stream ${id}`,
    description: '',
    status: 'active',
    derivedState: 'in_progress',
    priority: 'normal',
    effectivePriority: 'normal',
    assigneeAgentId: null,
    ownerAgentId: null,
    creatorAgentId: null,
    requestingUserId: null,
    agentIds: [],
    dependsOn,
    handoffMessage: null,
    files: [],
    response: null,
    metadata: {},
    completionMode: 'pr-merge',
    createdAt: now,
    updatedAt: now,
  }
}

function Surfaces({ workStreams }: { workStreams: WorkStream[] }) {
  return (
    <>
      <SquadHomeTab squad={squad} workStreams={workStreams} dependencies={{ SquadAgentThreads: () => null }} />
      <WorkStreamList workStreams={workStreams} squadId={squad.id} squad={squad} />
    </>
  )
}

function LiveSurfaces({ load }: { load: () => Promise<WorkStream[]> }) {
  const { data = [] } = useQuery({ queryKey: queryKeys.squads.activeWorkStreams(squad.id), queryFn: load })
  return <Surfaces workStreams={data} />
}

describe('shared work-stream graph live rendering', () => {
  test('workStream.updated refetches and rerenders both the home list and the work graph', async () => {
    const dom = await acquireDomHarness({ url: `http://localhost/squads/${squad.id}` })
    dom.window.localStorage.setItem(`ficus.wsView.${squad.id}`, 'graph')
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    queryClient.setQueryData(queryKeys.squads.agents(squad.id), [])
    queryClient.setQueryData(queryKeys.agentTypes.list(), [])
    queryClient.setQueryData(queryKeys.squads.list(), [squad])
    const rendered = dom.createRoot()
    let rows = [stream('a')]
    const captured = new Map<string, (entry: { event: string; data: unknown }) => void>()
    const subscribe = (topic: string, callback: (entry: { event: string; data: unknown }) => void) => {
      captured.set(topic, callback)
      return () => captured.delete(topic)
    }
    try {
      await dom.act(async () =>
        rendered.root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <QueryInvalidator dependencies={{ queryClient, subscribe: subscribe as never }} />
              <LiveSurfaces load={async () => rows} />
            </MemoryRouter>
          </QueryClientProvider>
        )
      )
      await dom.act(async () => Bun.sleep(10))
      const doc = dom.window.document
      // The work tab honours the saved 'graph' preference; the compact home
      // panel has no view preference at all — it is a list inline and the
      // dependency graph only inside its dialog. So the home surface is a list
      // and the work surface is the graph. What this test guards is that ONE
      // live event reaches both surfaces, so assert each in the shape it renders.
      const homePanel = () => {
        const panel = doc.querySelector('.squad-home-work-streams')
        if (!panel) throw new Error('home work-stream panel not found')
        return panel
      }
      expect(doc.querySelectorAll('svg[aria-label^="Dependency graph"]')).toHaveLength(1)
      expect(homePanel().querySelectorAll('svg[aria-label^="Dependency graph"]')).toHaveLength(0)
      expect(homePanel().textContent).toContain('Stream a')
      expect(doc.querySelectorAll('[aria-label^="Open Stream a,"]')).toHaveLength(1)

      rows = [stream('a'), stream('b', ['a'])]
      await dom.act(async () => {
        captured.get('workstreams')!({ event: 'workStream.updated', data: { workStreamId: 'b', squadId: squad.id } })
        await Bun.sleep(20)
      })
      // The home list picked the new stream up...
      expect(homePanel().textContent).toContain('Stream b')
      // ...and so did the work graph, edge included.
      expect(doc.querySelectorAll('[aria-label^="Open Stream b,"]')).toHaveLength(1)
      expect(doc.querySelectorAll('[data-from="a"][data-to="b"]')).toHaveLength(1)
    } finally {
      await dom.cleanup()
    }
  })
})
