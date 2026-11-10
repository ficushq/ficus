// The squad Chats tab with made-up data: the squad tab bar above the real agent conversation panel, an
// agent with a long name and a running subagent (so the Subagents view is offered). The checker
// (check-squad-chat-header-layout.ts) answers every /api request with an empty list.
// ?dark switches to the dark theme; ?fullscreen=1 opens the conversation in the fullscreen view.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Agent } from '@ficus/shared'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { SquadAgentThreads } from '../../src/components/squads/SquadAgentThreads'
import { SquadNavigation } from '../../src/components/squads/SquadNavigation'
import { SQUAD_TABS } from '../../src/lib/squadNavigation'
import { queryKeys } from '../../src/queryKeys'
import '../../src/index.css'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'

const params = new URLSearchParams(location.search)
applyResolvedTheme(document.documentElement, FICUS_THEME, params.has('dark') ? 'dark' : 'light')

const createdAt = new Date('2026-11-10T12:00:00Z')
const agent = (id: string, name: string, agentTypeId: string, status: Agent['status']) =>
  ({ id, agentTypeId, status, metadata: { name }, createdAt, updatedAt: createdAt }) as unknown as Agent
const agents = [
  agent('agent-1', 'Cascade the extremely thorough release coordinator', 'manager', 'active'),
  agent('agent-2', 'Pearl', 'engineer', 'idle'),
]

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
cache.setQueryData(queryKeys.agents.children('agent-1'), [
  { ...agent('subagent-1', 'Explorer', 'subagent', 'active'), parentAgentId: 'agent-1' },
])

const transcript = (
  <div className="flex-1 space-y-3 overflow-y-auto p-4 text-sm text-secondary">
    {Array.from({ length: 12 }, (_, index) => (
      <p key={index}>Transcript line {index + 1}: the agent reports progress on the release checklist.</p>
    ))}
  </div>
)
const dependencies = {
  AgentConversation: () => transcript,
  SubagentsInlinePanel: () => <div className="p-4 text-sm">Subagents</div>,
  AgentWorkStreamsPanel: () => <div className="p-4 text-sm">Work</div>,
  AgentInboxPanel: () => <div className="p-4 text-sm">Inbox</div>,
  AgentContextPanel: () => <div className="p-4 text-sm">Context</div>,
}

const search = new URLSearchParams({ agent: 'agent-1' })
if (params.get('fullscreen')) search.set('fullscreen', '1')

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[`/squads/squad-1/agents?${search}`]}>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        {/* The app shell's content column, as Layout pads it, holding SquadDetailPage's tab bar and tab. */}
        <div className="fixed inset-0 flex flex-col bg-page p-4 text-primary md:p-6">
          <div className="squad-detail-page flex min-h-0 flex-1 flex-col" data-active-tab="agents">
            <SquadNavigation tabs={SQUAD_TABS} activeTab="agents" onChange={() => {}} />
            <div className="squad-detail-tab-content min-h-0 flex-1 overflow-hidden">
              <SquadAgentThreads agents={agents} squadId="squad-1" dependencies={dependencies} />
            </div>
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
