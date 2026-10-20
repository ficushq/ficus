// Settings → Integrations → BigBrain on a Desktop-local/self-hosted Core (one-click local setup),
// with made-up data. The checker (check-local-bigbrain-layout.ts) answers the API requests.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { IntegrationDirectoryCard } from '../../src/components/settings/IntegrationsSection'
import type { IntegrationCatalogItem } from '../../src/api/integrations'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')

const entry: IntegrationCatalogItem = {
  key: 'bigbrain',
  label: 'BigBrain',
  description: 'Connect BigBrain on the Core host in one click: Ficus finds BigBrain and its vault.',
  connectionMode: 'local',
  enabled: true,
  availability: { available: true },
  capabilities: ['agent_tools'],
  assignable: true,
  authorization: { kind: 'manual' },
}
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

function Fixture() {
  const [expanded, setExpanded] = useState(true)
  return <IntegrationDirectoryCard entry={entry} canWrite expanded={expanded} setExpanded={setExpanded} />
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
