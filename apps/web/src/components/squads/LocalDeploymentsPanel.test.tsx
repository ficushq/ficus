import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../api/client'
import * as workspaceApi from '../../api/workspace'
import { PermissionsProvider } from '../../hooks/usePermissions'
import { queryKeys } from '../../queryKeys'
import { acquireDomHarness } from '../../test/domHarness'
import type { LocalDeployment } from '@ficus/shared'

import { localDeploymentActionErrorMessage } from '../../lib/localDeploymentActionError'

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

const permissions = {
  permissions: ['deployments:read', 'deployments:write', 'deployments:delete'],
  can: () => true,
  isLoading: false,
  isError: false,
}

function seededQueryClient(localDeployments: LocalDeployment[]): QueryClient {
  // staleTime keeps the seeded rows: the panel never refetches the list in these tests.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  })
  queryClient.setQueryData(queryKeys.squads.localDeployments('squad-1'), localDeployments)
  return queryClient
}

function renderPanel(localDeployments: LocalDeployment[]): string {
  const queryClient = seededQueryClient(localDeployments)

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
})

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function apiError(status: number, error: string): ApiError {
  return new ApiError(status, `API error: ${status}: ${error}`, { error })
}

async function mountPanel(localDeployments: LocalDeployment[]) {
  // A successful action invalidates the list; serve the same rows instead of hitting the network.
  spies.push(spyOn(workspaceApi, 'listLocalDeployments').mockResolvedValue(localDeployments))
  const dom = await acquireDomHarness({ url: 'http://localhost/squads/squad-1' })
  const queryClient = seededQueryClient(localDeployments)
  const root = dom.createRoot()
  await dom.act(async () =>
    root.root.render(
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider usePermissions={() => permissions}>
          <MemoryRouter>
            <LocalDeploymentsPanel squadId="squad-1" />
          </MemoryRouter>
        </PermissionsProvider>
      </QueryClientProvider>
    )
  )
  const click = async (title: string) => {
    const button = dom.window.document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
    if (!button) throw new Error(`No button titled ${title}`)
    await dom.act(async () => button.click())
    await dom.act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }
  const alert = () => dom.window.document.querySelector('[role="alert"]')?.textContent ?? null
  return {
    click,
    alert,
    async cleanup() {
      await dom.cleanup()
      queryClient.clear()
    },
  }
}

describe('LocalDeploymentsPanel action errors', () => {
  test('a refused restart (409) shows the server reason', async () => {
    const restart = spyOn(workspaceApi, 'restartLocalDeployment').mockRejectedValue(
      apiError(409, 'Local app is still launching; try again once it finishes.')
    )
    spies.push(restart)
    const panel = await mountPanel([localDeployment({ mode: 'managed' })])
    try {
      expect(panel.alert()).toBeNull()
      await panel.click('Restart local app')
      expect(restart).toHaveBeenCalledWith('local-1', expect.anything())
      expect(panel.alert()).toBe("Couldn't restart web: Local app is still launching; try again once it finishes.")
    } finally {
      await panel.cleanup()
    }
  })

  test('a failed launch (400) shows the message, and the next successful action clears it', async () => {
    const restart = spyOn(workspaceApi, 'restartLocalDeployment')
      .mockRejectedValueOnce(apiError(400, 'Command exited before the port opened'))
      .mockResolvedValueOnce(localDeployment({ mode: 'managed' }))
    spies.push(restart)
    const panel = await mountPanel([localDeployment({ mode: 'managed' })])
    try {
      await panel.click('Restart local app')
      expect(panel.alert()).toBe("Couldn't restart web: Command exited before the port opened")
      await panel.click('Restart local app')
      expect(restart).toHaveBeenCalledTimes(2)
      expect(panel.alert()).toBeNull()
    } finally {
      await panel.cleanup()
    }
  })

  test('a failed stop shows a message', async () => {
    const stop = spyOn(workspaceApi, 'stopLocalDeployment').mockRejectedValue(
      apiError(409, 'The sandbox is migrating; try again shortly.')
    )
    spies.push(stop)
    const panel = await mountPanel([localDeployment()])
    try {
      await panel.click('Stop local app')
      expect(panel.alert()).toBe("Couldn't stop web: The sandbox is migrating; try again shortly.")
    } finally {
      await panel.cleanup()
    }
  })

  test('a failed archive shows a message and drops the pending confirmation', async () => {
    const archive = spyOn(workspaceApi, 'archiveLocalDeployment').mockRejectedValue(
      apiError(404, 'Local deployment not found')
    )
    spies.push(archive)
    const panel = await mountPanel([localDeployment()])
    try {
      await panel.click('Archive local app')
      expect(archive).not.toHaveBeenCalled()
      await panel.click('Click again to archive local app')
      expect(archive).toHaveBeenCalledTimes(1)
      expect(panel.alert()).toBe("Couldn't archive web: Local deployment not found")
      // The row is back to its plain archive button, not stuck on "Confirm".
      await panel.click('Archive local app')
    } finally {
      await panel.cleanup()
    }
  })

  test('successful actions show no error', async () => {
    const stop = spyOn(workspaceApi, 'stopLocalDeployment').mockResolvedValue(undefined)
    const restart = spyOn(workspaceApi, 'restartLocalDeployment').mockResolvedValue(
      localDeployment({ mode: 'managed' })
    )
    spies.push(stop, restart)
    const panel = await mountPanel([localDeployment({ mode: 'managed' })])
    try {
      await panel.click('Restart local app')
      await panel.click('Stop local app')
      expect(restart).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(panel.alert()).toBeNull()
    } finally {
      await panel.cleanup()
    }
  })

  test('never surfaces raw error text that did not come from the server', () => {
    const raw = new Error('TypeError: x is undefined\n    at restart (LocalDeploymentsPanel.tsx:1:1)')
    expect(localDeploymentActionErrorMessage(raw)).toBe('Something went wrong. Try again.')
    expect(localDeploymentActionErrorMessage(new ApiError(502, 'API error: 502'))).toBe(
      'Something went wrong. Try again.'
    )
    expect(localDeploymentActionErrorMessage(apiError(409, '  Local app is archived  '))).toBe('Local app is archived')
  })
})
