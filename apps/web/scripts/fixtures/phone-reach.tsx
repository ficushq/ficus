// Settings → Administration → Server address with a made-up machine. Every query is seeded here, so the
// checker (check-phone-reach-guide.ts) fails on any API request.
// `?state=` picks the machine; `?appearance=dark` the dark theme.
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { ServerAddressSection } from '../../src/components/settings/ServerAddressSection'
import type { PhoneReachReport, PublicAppUrlStatus } from '../../src/api/publicUrl'
import { publicUrlQueryKeys } from '../../src/queryKeys'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const state = params.get('state') ?? 'local'

const status = (patch: Partial<PublicAppUrlStatus>): PublicAppUrlStatus => ({
  source: 'local-default',
  locked: false,
  url: 'http://localhost:3000',
  localUrl: 'http://localhost:3000',
  desktopManaged: false,
  version: 'v1',
  lastChange: null,
  mobileReady: false,
  basePath: '',
  ...patch,
})
const serveCommand = 'tailscale serve --bg http://127.0.0.1:3000'
const addresses = ['http://studio-mac.local:3000', 'http://192.168.1.20:3000']

const machines: Record<string, { status: PublicAppUrlStatus; reach: PhoneReachReport }> = {
  // A fresh install on a Mac: only this computer can open it, and Tailscale is not installed.
  local: {
    status: status({}),
    reach: {
      current: { url: 'http://localhost:3000', reach: 'this-computer', https: false },
      listening: { host: '127.0.0.1', port: 3000, beyondThisComputer: false },
      homeNetwork: { addresses },
      tailscale: { state: 'not-installed', cli: null, serveCommand },
    },
  },
  // Tailscale is running, but Ficus is not served on it yet.
  tailscale: {
    status: status({}),
    reach: {
      current: { url: 'http://localhost:3000', reach: 'this-computer', https: false },
      listening: { host: '127.0.0.1', port: 3000, beyondThisComputer: false },
      homeNetwork: { addresses },
      tailscale: { state: 'running', cli: 'path', address: 'https://studio-mac.tail1234.ts.net', serveCommand },
    },
  },
  // Set up for the home network and listening on it.
  home: {
    status: status({ source: 'setting', url: addresses[0], storedUrl: addresses[0] }),
    reach: {
      current: { url: addresses[0]!, reach: 'home-network', https: false },
      listening: { host: '0.0.0.0', port: 3000, beyondThisComputer: true },
      homeNetwork: { addresses },
      tailscale: { state: 'stopped', cli: 'app', serveCommand },
    },
  },
}
const chosen = machines[state] ?? machines.local!

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
cache.setQueryData(publicUrlQueryKeys.status(), chosen.status)
cache.setQueryData(publicUrlQueryKeys.reach(), chosen.reach)

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <QueryClientProvider client={cache}>
      <PermissionsProvider
        usePermissions={() => ({
          permissions: ['*'],
          identity: { type: 'user', userId: 'fixture-user' },
          can: () => true,
          isLoading: false,
          isError: false,
        })}
      >
        <div className="fixed inset-0 flex flex-col bg-page text-primary md:flex-row">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 md:p-6" data-fixture-scroller>
            <div className="mx-auto max-w-3xl">
              <ServerAddressSection />
            </div>
          </div>
        </div>
      </PermissionsProvider>
    </QueryClientProvider>
  </MemoryRouter>
)
