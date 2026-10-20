// Settings → Integrations → BigBrain on Ficus Cloud (managed shared vaults) and a squad's BigBrain
// card, with made-up data. The checker (check-managed-bigbrain-layout.ts) answers the API requests.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { IntegrationDirectoryCard } from '../../src/components/settings/IntegrationsSection'
import { SquadIntegrationCard } from '../../src/components/squads/SquadIntegrationCard'
import type { IntegrationCatalogItem } from '../../src/api/integrations'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const view = params.get('view') ?? 'settings'

const entry: IntegrationCatalogItem = {
  key: 'bigbrain',
  label: 'BigBrain',
  description: 'Shared BigBrain vaults on this server: people contribute from the BigBrain app, squads read.',
  connectionMode: 'managed',
  enabled: true,
  availability: { available: true },
  capabilities: ['agent_tools'],
  assignable: true,
  authorization: { kind: 'manual' },
}
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

function Fixture() {
  const [expanded, setExpanded] = useState(true)
  return view === 'squad' ? (
    <SquadIntegrationCard entry={entry} squadId="squad-fixture" canWrite />
  ) : (
    <IntegrationDirectoryCard entry={entry} canWrite expanded={expanded} setExpanded={setExpanded} />
  )
}

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        <div className="fixed inset-0 flex flex-col bg-page text-primary md:flex-row">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6" data-fixture-scroller>
            <div className="mx-auto max-w-3xl">
              <Fixture />
            </div>
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
