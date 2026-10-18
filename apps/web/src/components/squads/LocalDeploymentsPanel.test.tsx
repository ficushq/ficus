import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queryKeys } from '../../queryKeys'
import type { LocalDeployment } from '@ficus/shared'

import { getLocalDeploymentAppHost, previewLocalDeploymentAliasUrl } from './localDeploymentAppHost'

const { LocalDeploymentsPanel } = await import('./LocalDeploymentsPanel')

const now = new Date('2026-01-01T00:00:00Z')

function localDeployment(overrides: Partial<LocalDeployment> = {}): LocalDeployment {
  return {
    id: 'local-1',
    squadId: 'squad-1',
    sandboxId: 'squad_squad-1',
    name: 'web',
    port: 5173,
    targetHost: '127.0.0.1',
    urlPathOrHost: '/api/app/local-1/?_ficus_token=token',
    visibility: 'private',
    mode: 'attached',
    status: 'running',
    keepSandboxAlive: true,
    command: null,
    cwd: null,
    logPath: null,
    envSecretRefs: null,
    processId: null,
    restartPolicy: 'never',
    restartCount: 0,
    createdByAgentId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    expiresAt: null,
    ...overrides,
  }
}

function renderPanel(localDeployments: LocalDeployment[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.localDeployments('squad-1'), localDeployments)
  const permissions = {
    permissions: ['deployments:read', 'deployments:write', 'deployments:delete'],
    can: () => true,
    isLoading: false,
    isError: false,
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider usePermissions={() => permissions}>
        <MemoryRouter>
          <LocalDeploymentsPanel squadId="squad-1" />
        </MemoryRouter>
      </PermissionsProvider>
    </QueryClientProvider>
  )
}

describe('LocalDeploymentsPanel', () => {
  test('shows attached log capture state per row', () => {
    const html = renderPanel([
      localDeployment({ id: 'captured', name: 'captured-app', logPath: '/workspace/squad-1/app.log' }),
      localDeployment({ id: 'uncaptured', name: 'uncaptured-app', logPath: null }),
      localDeployment({ id: 'managed', name: 'managed-app', mode: 'managed', logPath: null }),
    ])

    expect(html).toContain('captured-app')
    expect(html).toContain('logs captured')
    expect(html).toContain('uncaptured-app')
    expect(html).toContain('logs not captured')
    expect(html).toContain('managed-app')
    // Managed rows never claim log capture state.
    expect(renderPanel([localDeployment({ id: 'managed', mode: 'managed', logPath: null })])).not.toContain(
      'logs captured'
    )
    expect(renderPanel([localDeployment({ id: 'managed', mode: 'managed', logPath: null })])).not.toContain(
      'logs not captured'
    )
  })

  test('shows the alias host the app is linked by, and offers the alias editor only with per-app hosts', () => {
    const aliased = renderPanel([
      localDeployment({
        alias: 'dashboard',
        urlPathOrHost: 'https://noah--dashboard.ficus.garden/?_ficus_token=token',
      }),
    ])
    expect(aliased).toContain('noah--dashboard.ficus.garden')
    expect(aliased).not.toContain('_ficus_token')
    expect(aliased).toContain('Change app alias (dashboard)')

    const idHost = renderPanel([
      localDeployment({ urlPathOrHost: 'https://noah--0123456789ab.ficus.garden/?_ficus_token=t' }),
    ])
    expect(idHost).toContain('noah--0123456789ab.ficus.garden')
    expect(idHost).toContain('Set app alias')

    // Path mount (no apps domain): an alias would have no effect, so no editor.
    const pathMount = renderPanel([localDeployment()])
    expect(pathMount).not.toContain('Set app alias')
  })
})

describe('alias host helpers', () => {
  test('reads the app host only from an absolute per-app URL', () => {
    expect(getLocalDeploymentAppHost('https://noah--dashboard.ficus.garden/?_ficus_token=t')).toBe(
      'noah--dashboard.ficus.garden'
    )
    expect(getLocalDeploymentAppHost('/api/app/local-1/?_ficus_token=t')).toBeNull()
  })

  test('previews the alias URL for a tenant label that itself contains --', () => {
    expect(previewLocalDeploymentAliasUrl('team--blue--0123456789ab.ficus.app', 'board')).toBe(
      'https://team--blue--board.ficus.app/'
    )
    expect(previewLocalDeploymentAliasUrl('noah--dashboard.ficus.garden', 'reports')).toBe(
      'https://noah--reports.ficus.garden/'
    )
  })
})
