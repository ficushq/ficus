// Settings → Integrations → Linear with made-up workspaces, keys and squads. Every query is seeded
// here, so the checker (check-linear-integration-layout.ts) fails on any API request.
// `?state=` picks the card's state; `?appearance=dark` the dark theme.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { IntegrationDirectoryCard } from '../../src/components/settings/IntegrationsSection'
import type { IntegrationCatalogItem, IntegrationConnection, OAuthAppSettings } from '../../src/api/integrations'
import { integrationQueryKeys, queryKeys } from '../../src/queryKeys'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const state = params.get('state') ?? 'installed'

const entry: IntegrationCatalogItem = {
  key: 'linear',
  label: 'Linear',
  description:
    'Connect issue tracking, route assignments to squads, search Linear issues, and let agents read, create, update and comment on issues with the Linear CLI.',
  connectionMode: 'oauth2',
  enabled: true,
  availability: { available: true },
  capabilities: [],
  assignable: true,
  authorization: { kind: 'oauth2' },
} as IntegrationCatalogItem

const hosted: OAuthAppSettings = {
  authority: 'platform_broker',
  configured: true,
  clientId: null,
  callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback/linear',
  requiredCapabilities: [],
}
const selfHosted: OAuthAppSettings = {
  authority: 'local',
  configured: false,
  clientId: null,
  callbackUrl: 'https://ficus.example/settings/integrations/oauth/callback/linear',
  webhookUrl: 'https://ficus.example/api/webhooks/linear-app',
  requiredCapabilities: [],
}

const squads = [
  { id: 'squad-platform', name: 'Platform', status: 'active' },
  { id: 'squad-growth', name: 'Growth', status: 'active' },
  { id: 'squad-research', name: 'Research and Insights', status: 'active' },
]
const used = (...ids: string[]) => {
  const list = squads.filter((squad) => ids.includes(squad.id)).map(({ id, name }) => ({ id, name }))
  return { squadCount: list.length, squads: list }
}

const base = {
  providerKey: 'linear',
  enabled: true,
  healthState: 'healthy',
  adapterVersion: 1,
  credentialConfigured: true,
  authState: 'authenticated',
  grantedScopes: [],
  validatedAt: '2026-11-20T09:40:00.000Z',
  validationExpiresAt: null,
  lastErrorCode: null,
  usage: used(),
} as const
const app = (overrides: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  ...base,
  id: 'app-ficushq',
  displayName: 'Ficus (Ficus app)',
  configuration: {
    version: 2,
    mode: 'app',
    organizationId: 'org-ficushq',
    organizationName: 'Ficus',
    organizationUrlKey: 'ficushq',
    appUserId: 'app-user',
    appUserName: 'Ficus',
    missingScopes: [],
  },
  ...overrides,
})
const key = (overrides: Partial<IntegrationConnection> = {}): IntegrationConnection => ({
  ...base,
  id: 'key-ops',
  displayName: 'Operations key',
  configuration: { version: 1 },
  ...overrides,
})

const pools: Record<string, { app: OAuthAppSettings; pool: IntegrationConnection[] }> = {
  // Nothing connected yet: the install is the next step.
  before: { app: hosted, pool: [] },
  // Right after installing, as in the reported screenshot: no squad uses the workspace.
  installed: { app: hosted, pool: [app()] },
  // One squad uses it; the card links there for team routing.
  attached: { app: hosted, pool: [app({ usage: used('squad-platform') })] },
  // Several connections of both kinds, one needing attention and one disabled.
  several: {
    app: hosted,
    pool: [
      app({ usage: used('squad-platform', 'squad-growth') }),
      app({
        id: 'app-beta',
        displayName: 'Beta Labs (Ficus app)',
        configuration: {
          version: 2,
          mode: 'app',
          organizationId: 'org-beta',
          organizationName: 'Beta Labs',
          organizationUrlKey: 'beta-labs',
          missingScopes: ['write'],
        },
      }),
      key({ usage: used('squad-research') }),
      key({ id: 'key-old', displayName: 'Old personal key', enabled: false }),
    ],
  },
  // An API-key connection only.
  'api-key': { app: hosted, pool: [key({ usage: used('squad-research') })] },
  // A self-hosted instance before its Linear application is saved.
  'self-hosted': { app: selfHosted, pool: [] },
}
const chosen = pools[state] ?? pools.installed!

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
cache.setQueryData(integrationQueryKeys.pool('linear'), chosen.pool)
cache.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'linear'], chosen.app)
cache.setQueryData(integrationQueryKeys.linearWebhook(), {
  configured: false,
  webhookUrl: 'https://ficus.example/api/webhooks/linear',
})
cache.setQueryData(queryKeys.squads.list(), squads)
cache.setQueryData(queryKeys.auth.permissions(), { permissions: ['*'] })

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
