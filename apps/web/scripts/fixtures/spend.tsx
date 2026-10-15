// Settings → Spend with made-up data. The checker (check-spend-layout.ts) answers /api/spend/* requests.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { SpendSection } from '../../src/components/settings/spend/SpendSection'
import '../../src/index.css'

if (new URLSearchParams(location.search).get('appearance') === 'dark') document.documentElement.classList.add('dark')

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({ permissions: ['*'], can: () => true, isLoading: false, isError: false })}
      >
        {/* The app shell is fixed; the settings content column scrolls, as in SettingsPage. */}
        <div className="fixed inset-0 flex flex-col bg-page text-primary md:flex-row">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6" data-fixture-scroller>
            <SpendSection />
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
