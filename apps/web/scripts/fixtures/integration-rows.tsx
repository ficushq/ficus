// Settings → Integrations → GitHub, Notion, Cloudflare (a deployment provider) and local BigBrain,
// each with made-up connections in every row state: healthy and used by squads, needing a fix, and
// disabled. Every query is seeded here, so the checker (check-integration-rows-layout.ts) fails on
// any API request. `?provider=` picks the card; `?appearance=dark` the dark theme.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PermissionsProvider } from '../../src/hooks/usePermissions'
import { IntegrationDirectoryCard } from '../../src/components/settings/IntegrationsSection'
import type {
  BigbrainLocalSetupState,
  IntegrationCatalogItem,
  IntegrationConnection,
  OAuthAppSettings,
} from '../../src/api/integrations'
import { integrationQueryKeys, queryKeys } from '../../src/queryKeys'
import '../../src/index.css'

const params = new URLSearchParams(location.search)
if (params.get('appearance') === 'dark') document.documentElement.classList.add('dark')
const provider = params.get('provider') ?? 'github'

const squads = [
  { id: 'squad-platform', name: 'Platform', status: 'active' },
  { id: 'squad-growth', name: 'Growth', status: 'active' },
  { id: 'squad-research', name: 'Research and Insights', status: 'active' },
]
const used = (...ids: string[]) => {
  const list = squads.filter((squad) => ids.includes(squad.id)).map(({ id, name }) => ({ id, name }))
  return { squadCount: list.length, squads: list }
}

const connection = (
  providerKey: string,
  id: string,
  displayName: string,
  configuration: Record<string, unknown>,
  overrides: Partial<IntegrationConnection> = {}
): IntegrationConnection =>
  ({
    id,
    providerKey,
    displayName,
    configuration: { version: 1, ...configuration },
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
    ...overrides,
  }) as IntegrationConnection

const entry = (key: string, label: string, description: string, connectionMode: string) =>
  ({
    key,
    label,
    description,
    connectionMode,
    enabled: true,
    availability: { available: true },
    capabilities: [],
    assignable: true,
    authorization: { kind: connectionMode === 'oauth2' ? 'oauth2' : 'manual' },
  }) as unknown as IntegrationCatalogItem

const hosted = (name: string): OAuthAppSettings => ({
  authority: 'platform_broker',
  configured: true,
  clientId: null,
  callbackUrl: `https://ficus.example/settings/integrations/oauth/callback/${name}`,
  requiredCapabilities: [],
})

/** A tiny synthetic workspace icon, so no image is fetched. */
const icon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#3f6b4f"/><text x="12" y="17" font-size="13" text-anchor="middle" fill="#fff" font-family="sans-serif">A</text></svg>'
)}`

const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
cache.setQueryData(queryKeys.squads.list(), squads)
cache.setQueryData(queryKeys.auth.permissions(), { permissions: ['*'] })

const cards: Record<string, () => IntegrationCatalogItem> = {
  github: () => {
    const bot = connection(
      'github',
      'gh-bot',
      'Ficus Bot',
      { login: 'ficus-bot' },
      { isGlobalDefault: true, usage: used('squad-platform', 'squad-growth') }
    )
    cache.setQueryData(integrationQueryKeys.pool('github'), [
      bot,
      connection(
        'github',
        'gh-ada',
        'Ada Lovelace',
        { login: 'ada-lovelace' },
        { authState: 'reauthorization_required', usage: used('squad-research') }
      ),
      connection('github', 'gh-old', 'Old automation account', { login: 'old-automation' }, { enabled: false }),
    ])
    cache.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'github'], hosted('github'))
    cache.setQueryData(integrationQueryKeys.githubWebhook(), {
      configured: false,
      webhookUrl: 'https://ficus.example/api/webhooks/github',
    })
    cache.setQueryData(integrationQueryKeys.githubRepositoryAccess(bot.id), {
      status: 'verified',
      personalAccountInstalled: true,
      complete: true,
      installations: [
        { account: 'ficushq', repositoryCount: 12, contentsWrite: true, workflowsWrite: true, suspended: false },
      ],
    })
    cache.setQueryData(integrationQueryKeys.githubCommitSigning(bot.id), { state: 'off' })
    return entry('github', 'GitHub', 'Connect GitHub accounts so agents can open pull requests.', 'oauth2')
  },
  notion: () => {
    cache.setQueryData(integrationQueryKeys.pool('notion'), [
      connection(
        'notion',
        'notion-acme',
        'Acme Wiki',
        { workspaceName: 'Acme Wiki', workspaceIcon: icon },
        { refreshAvailable: true, usage: used('squad-platform') }
      ),
      connection(
        'notion',
        'notion-design',
        'Design Notes',
        { workspaceName: 'Design Notes' },
        { authState: 'reauthorization_required', usage: used('squad-growth', 'squad-research') }
      ),
      connection('notion', 'notion-archive', 'Archive', { workspaceName: 'Archive' }, { enabled: false }),
    ])
    cache.setQueryData([...integrationQueryKeys.all, 'oauth-app', 'notion'], hosted('notion'))
    return entry('notion', 'Notion', 'Let agents read and update pages in a Notion workspace.', 'oauth2')
  },
  cloudflare: () => {
    cache.setQueryData(integrationQueryKeys.pool('cloudflare'), [
      connection(
        'cloudflare',
        'cf-prod',
        'Production account',
        { accountId: '0123456789abcdef0123456789abcdef' },
        { isGlobalDefault: true, usage: used('squad-platform', 'squad-growth') }
      ),
      connection(
        'cloudflare',
        'cf-staging',
        'Staging account',
        {},
        { authState: 'invalid', healthState: 'unknown', usage: used('squad-research') }
      ),
      connection('cloudflare', 'cf-preview', 'Preview account', {}, { usage: used('squad-growth') }),
      connection('cloudflare', 'cf-old', 'Old marketing account', {}, { enabled: false }),
    ])
    return entry('cloudflare', 'Cloudflare', 'Deploy apps to Cloudflare Pages and Workers.', 'api_key')
  },
  bigbrain: () => {
    const vault = (name: string) => `/Users/ada/Library/Mobile Documents/BigBrain/${name}`
    const executablePath = '/Users/ada/.local/bin/bigbrain'
    const setup: BigbrainLocalSetupState = {
      state: 'ready',
      hostPlatform: 'darwin',
      executablePath,
      vaults: [],
      bindingsFile: 'managed',
      connectionName: 'Local MCP configuration',
      access: ['vault:read', 'inbox:write'],
    }
    cache.setQueryData(integrationQueryKeys.localSetup(), setup)
    cache.setQueryData(integrationQueryKeys.pool('bigbrain'), [
      connection(
        'bigbrain',
        'bb-research',
        'BigBrain · Research and Personal Notes Vault',
        { version: 2, vaultPath: vault('Research and Personal Notes Vault'), executablePath },
        { validationExpiresAt: '2026-11-20T09:55:00.000Z', usage: used('squad-research') }
      ),
      connection(
        'bigbrain',
        'bb-team',
        'BigBrain · Team Vault',
        { version: 2, vaultPath: vault('Team Vault'), executablePath },
        { authState: 'invalid', lastErrorCode: 'executable_missing', usage: used('squad-platform') }
      ),
      connection(
        'bigbrain',
        'bb-old',
        'BigBrain · Old Vault',
        { version: 2, vaultPath: vault('Old Vault'), executablePath },
        { enabled: false }
      ),
    ])
    return entry('bigbrain', 'BigBrain', 'Connect BigBrain on the Core host in one click.', 'local')
  },
}
const card = (cards[provider] ?? cards.github!)()

function Fixture() {
  const [expanded, setExpanded] = useState(true)
  return <IntegrationDirectoryCard entry={card} canWrite expanded={expanded} setExpanded={setExpanded} />
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
