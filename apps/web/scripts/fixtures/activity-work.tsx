// Synthetic data only: every query is seeded or disabled, so this fixture never contacts a backend.
// The Activity feed body with its Active work pill: ?select=1394 filters to that stream (details
// panel), &dark for the dark appearance.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActivityWorkStreamCard, SquadActivityItem, SquadActivityKind } from '@ficus/shared'
import { ActivityFeedView } from '../../src/components/squads/ActivityFeedView'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'

const params = new URLSearchParams(location.search)
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const id = (number: number) => `00000000-0000-4000-8000-00000000${number}`
function card(number: number, title: string, overrides: Partial<ActivityWorkStreamCard> = {}): ActivityWorkStreamCard {
  return {
    id: id(number),
    number,
    squadId: 'squad-1',
    title,
    status: 'active',
    step: 'Implement',
    waits: [],
    needsYou: false,
    pullRequest: null,
    ci: null,
    deliveryLabel: null,
    workingAgentIds: [],
    lastEventAt: minutesAgo(10),
    ...overrides,
  }
}

const cards: ActivityWorkStreamCard[] = [
  card(
    1394,
    'Deliver human PR comments when the commenter is the GitHub connection account, and record skipped deliveries',
    {
      workingAgentIds: ['eng-1'],
      lastEventAt: minutesAgo(1),
      summary: "Writing tests for holding human PR comments from the GitHub connection account's author filter.",
      summaryGeneratedAt: minutesAgo(4),
      derivedState: 'in_progress',
    }
  ),
  card(1395, 'Spend: offer three ChatGPT Pro tiers ($100, $200, $500)', {
    step: 'implement',
    workingAgentIds: ['eng-2'],
    lastEventAt: minutesAgo(1),
    summary:
      'Adding the ChatGPT Pro $100 and $500 tiers: the shared plan table, detection tests, Settings picker, and docs.',
    summaryGeneratedAt: minutesAgo(6),
  }),
  card(1391, 'Linear: never silently drop sessions without a creator', {
    lastEventAt: minutesAgo(12),
    pullRequest: {
      number: 1026,
      repository: 'ficushq/ficus',
      url: 'https://github.com/ficushq/ficus/pull/1026',
      state: 'open',
    },
    ci: 'pending',
    summary:
      'The engineer merged main, with the PR 1027 fix, into the PR 1026 branch, but it is not yet tested or pushed.',
    summaryGeneratedAt: minutesAgo(15),
    derivedState: 'idle',
  }),
  card(1382, 'Port Argus listener RPC retry and resume fix to the desktop app', {
    lastEventAt: minutesAgo(13),
    summary: "The listener's connect test is paused while the engineer waits for the shared test slot.",
    summaryGeneratedAt: minutesAgo(20),
  }),
  card(1392, 'Linear integration: third live verification after the 1386-1391 fixes', {
    step: 'Verify',
    waits: [{ type: 'dependency', needsYou: false }],
    lastEventAt: minutesAgo(41),
    derivedState: 'paused',
  }),
  card(1390, 'Work stream dependency graph: show blocked edges', {
    step: 'Review',
    waits: [{ type: 'review', needsYou: false }],
    lastEventAt: minutesAgo(55),
    derivedState: 'in_review',
  }),
  card(1388, 'Queue: priority lanes for scheduled work', { status: 'queued', step: null, lastEventAt: minutesAgo(80) }),
]

const item = (minutes: number, overrides: Partial<SquadActivityItem>): SquadActivityItem => ({
  id: `10:${crypto.randomUUID()}`,
  at: minutesAgo(minutes),
  agentId: 'eng-1',
  agentTypeId: 'engineer',
  kind: 'message',
  summary: '',
  preview: [],
  ref: { type: 'agent', agentId: 'eng-1', view: 'chat' },
  ...overrides,
})
const stream1394 = {
  id: id(1394),
  number: 1394,
  title: cards[0].title,
  squadId: 'squad-1',
  status: 'active' as const,
  step: 'Implement',
}
const clipped =
  'One failure: an existing test asserting own comments create no delivery row at all, which this change intentionally replaces with a skipped row. Renewing the c'
const items: SquadActivityItem[] = [
  item(1, {
    summary: `${clipped}…`,
    preview: [{ text: clipped }, { text: '…' }],
    ref: { type: 'agent', agentId: 'eng-1', view: 'chat', messageId: 'm-1' },
    context: { workStream: stream1394 },
  }),
  item(25, {
    summary: 'Received system notification: Flow step: implement',
    preview: [{ text: 'Received system notification: Flow step: implement' }],
    ref: { type: 'agent', agentId: 'eng-1', view: 'inbox' },
    context: { workStream: stream1394 },
  }),
  item(26, {
    agentId: 'manager-1',
    agentTypeId: 'manager',
    kind: 'workstream',
    summary: '[#1394 created] Deliver human PR comments',
    preview: [{ text: `[#1394 created] ${cards[0].title}` }],
    ref: { type: 'workstream', workStreamId: id(1394), workStreamNumber: 1394 },
  }),
]

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } })
cache.setQueryData(['agents', 'message', 'eng-1', 'm-1'], {
  id: 'm-1',
  agentId: 'eng-1',
  role: 'assistant',
  content: `${clipped}laim and running the **focused** test file again before pushing.`,
  createdAt: items[0].at,
})

function App() {
  const [kinds, setKinds] = useState<SquadActivityKind[]>([])
  const selected = params.get('select')
  const [filter, setFilter] = useState<string | null>(selected ? id(Number(selected)) : null)
  const shown = filter
    ? items.filter((row) => row.context?.workStream?.id === filter || row.ref.type === 'workstream')
    : items
  return (
    <MemoryRouter>
      <QueryClientProvider client={cache}>
        <div className="mx-auto flex h-screen max-w-6xl flex-col p-4 sm:p-6">
          <h1 className="ficus-page-title mb-4 shrink-0">Activity</h1>
          <ActivityFeedView
            kinds={kinds}
            onKindsChange={setKinds}
            presence={{ workingCount: 3, needsYouCount: 0, streamCount: 7, streams: cards }}
            workStreamFilter={filter}
            onWorkStreamFilterChange={setFilter}
            workListHref="/"
            agentLabelFor={(agentId) => (agentId.startsWith('eng') ? 'Engineer' : undefined)}
            showEverything={false}
            onShowEverythingChange={() => undefined}
            isLoading={false}
            isError={false}
            items={shown}
            loadingShapeKey="activity:fixture"
            workingAgentIds={new Set(['eng-1', 'eng-2', 'manager-1'])}
            agentDetailFor={() => undefined}
            hrefFor={(row) =>
              row.ref.type === 'workstream'
                ? `/squads/ficus/work?ws=${row.ref.workStreamNumber}`
                : '/squads/ficus?agent=eng-1'
            }
            onOpen={() => undefined}
            onOpenAgentReference={() => undefined}
            hasNextPage={false}
            isFetchingNextPage={false}
            onLoadMore={() => undefined}
          />
        </div>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
