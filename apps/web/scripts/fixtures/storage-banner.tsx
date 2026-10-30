// Real storage banner and theme styles with synthetic, cached warnings; no backend needed.
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { StorageBanner } from '../../src/components/StorageBanner'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { queryKeys } from '../../src/queryKeys'
import { applyResolvedTheme } from '../../src/theme/apply'
import { FICUS_THEME } from '../../src/theme/registry'
import '../../src/index.css'

applyResolvedTheme(
  document.documentElement,
  FICUS_THEME,
  new URLSearchParams(location.search).get('appearance') === 'dark' ? 'dark' : 'light'
)
const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(queryKeys.system.storageStatus(), {
  supported: true,
  scanning: false,
  scannedAt: '2026-10-30T12:00:00Z',
  error: null,
  monitoring: { intervalHours: 12, alertsEnabled: true, thresholds: [80, 90, 95], nextScanAt: null },
  warnings: [
    {
      machineId: 'example',
      machineName: 'Example host',
      percent: 77,
      threshold: 80,
      measuredAt: '2026-10-30T12:00:00Z',
      stale: false,
    },
  ],
})
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={client}>
      <PermissionsProvider
        usePermissions={() => ({ can: () => true, permissions: [], isLoading: false, isError: false })}
      >
        <main aria-label="Storage banner preview">
          <StorageBanner />
          <Routes>
            <Route path="/" element={null} />
            <Route path="/settings" element={<h1>Storage settings destination</h1>} />
          </Routes>
        </main>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
