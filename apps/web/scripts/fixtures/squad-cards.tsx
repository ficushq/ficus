// The real Squads page cards and theme styles, with synthetic squads, work and one Needs you action.
// The current location is printed below the cards so the check can see where a click went.
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SquadList } from '../../src/components/squads/SquadList'
import { queries } from '../../src/queryOptions'
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

const squad = (id: string, name: string, purpose: string) => ({
  id,
  name,
  purpose,
  status: 'active',
  isAnonymous: false,
  avatarUrl: null,
})
const squads = [
  squad(
    'product',
    'Product Engineering',
    'Build a product customers love. Ship thoughtful improvements to onboarding, payments, and the API.'
  ),
  squad(
    'growth',
    'Growth',
    'Turn useful product improvements into stories that help more teams discover their next favorite tool.'
  ),
  squad('research', 'Research', 'Read widely and report what matters.'),
]

let minute = 0
const work = (number: number, squadId: string, title: string, extra: Record<string, unknown> = {}) => ({
  id: `ws-${number}`,
  number,
  title,
  squadId,
  status: 'active',
  createdAt: '2026-11-26T08:00:00Z',
  updatedAt: `2026-11-26T12:${String(59 - minute++).padStart(2, '0')}:00Z`,
  openWaits: [],
  ...extra,
})
const workStreams = [
  work(1, 'product', 'Make the first five minutes effortless', { derivedState: 'in_progress' }),
  work(3, 'product', 'Bring instant search to every workspace', { derivedState: 'in_progress' }),
  work(8, 'product', 'Make every payment retry safe', {
    openWaits: [{ id: 'w-8', type: 'review', referenceId: null, workStreamId: 'ws-8' }],
  }),
  work(9, 'product', 'Give refunds the same retry protection', { status: 'queued' }),
  work(11, 'product', 'Explain failed card payments in plain words, so nobody has to ask support what happened'),
  work(12, 'product', 'Retire the old billing export', {
    openWaits: [{ id: 'w-12', type: 'question', referenceId: 'q-12', workStreamId: 'ws-12' }],
  }),
  work(5, 'growth', 'Tell the story of a better first day', { derivedState: 'in_progress' }),
  work(7, 'growth', 'Turn customer wins into launch stories', {
    openWaits: [{ id: 'w-7', type: 'manual', actor: 'human', referenceId: null, workStreamId: 'ws-7' }],
  }),
]
// The viewer is asked about #12 and reviews #8; both lead Product Engineering's rows.
const pendingActions = [
  {
    id: 'a-8',
    type: 'workstream-review',
    priority: 2,
    createdAt: '',
    canRespond: true,
    data: { workStreamId: 'ws-8' },
  },
  { id: 'a-12', type: 'agent-question', priority: 1, createdAt: '', canRespond: false, data: { questionId: 'q-12' } },
]

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(queries.squads.list('active').queryKey, squads as never)
client.setQueryData(queries.squads.list().queryKey, squads as never)
client.setQueryData(queries.agents.summaries({ live: true }).queryKey, [] as never)
client.setQueryData(queries.squads.activeWorkStreams().queryKey, workStreams as never)
client.setQueryData(queries.actions.pending().queryKey, pendingActions as never)

function CurrentLocation() {
  const { pathname, search } = useLocation()
  return <output data-testid="location">{`${pathname}${search}`}</output>
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/squads']}>
      <main className="min-h-full bg-page p-6 text-primary">
        <SquadList />
        <p className="mt-4 text-xs text-muted">
          Location: <CurrentLocation />
        </p>
      </main>
    </MemoryRouter>
  </QueryClientProvider>
)
