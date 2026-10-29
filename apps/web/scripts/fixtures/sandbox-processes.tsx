// Real panel/header components; the browser checker serves synthetic API responses.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SandboxProcesses } from '../../src/components/sandbox/SandboxProcesses'
import { SandboxStatusIndicator } from '../../src/components/squads/SandboxStatusIndicator'
import '../../src/index.css'

if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark')
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={client}>
      <main className="min-h-screen bg-page p-4 text-primary md:p-8">
        <header className="mb-6 flex items-center gap-4">
          <h1>Shared sandbox</h1>
          <SandboxStatusIndicator squadId="synthetic" />
        </header>
        <SandboxProcesses target={{ kind: 'squad', squadId: 'synthetic' }} />
      </main>
    </QueryClientProvider>
  </MemoryRouter>
)
