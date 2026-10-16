import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { queryKeys } from '../../queryKeys'

let permissions = new Set<string>()
let permissionsLoading = false
let conflicts: unknown[] = []

const { RemoteHostsSettings } = await import('./RemoteHostsSettings')

function renderRemoteHostsSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(queryKeys.squads.remoteHosts('squad-1'), [
    {
      id: 'host-1',
      name: 'staging',
      description: null,
      sshHost: '10.1.2.3',
      sshPort: 22,
      sshUser: 'deploy',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ])
  queryClient.setQueryData(queryKeys.squads.knownHostsConflicts('squad-1'), conflicts)
  if (!permissionsLoading) {
    queryClient.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: [...permissions] })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RemoteHostsSettings squadId="squad-1" />
    </QueryClientProvider>
  )
}

describe('RemoteHostsSettings RBAC gating', () => {
  beforeEach(() => {
    permissions = new Set<string>()
    permissionsLoading = false
    conflicts = []
  })

  test('hides the per-host Check control unless remote-hosts:write is allowed (the endpoint needs squad write)', () => {
    const deniedHtml = renderRemoteHostsSettings()
    expect(deniedHtml).not.toContain('>Check<')

    permissions.add('remote-hosts:write')
    const allowedHtml = renderRemoteHostsSettings()
    expect(allowedHtml).toContain('>Check<')
  })

  test('shows open known_hosts conflicts to readers; resolution actions only with ssh:write', () => {
    const base = {
      id: 'c1',
      squadId: 'squad-1',
      sandboxId: 'agent_1',
      host: 'git.example',
      keyType: 'ssh-ed25519',
      boxFingerprint: 'SHA256:boxfp',
      coreFingerprint: 'SHA256:corefp',
      boxLine: 3,
      wildcard: false,
      status: 'open',
      detectedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedByUserId: null,
    }
    conflicts = [base, { ...base, id: 'c2', host: '*.example', wildcard: true, boxFingerprint: 'SHA256:wild' }]

    const readOnly = renderRemoteHostsSettings()
    expect(readOnly).toContain('Known hosts conflicts')
    expect(readOnly).toContain('box: SHA256:boxfp')
    expect(readOnly).toContain('Ficus: SHA256:corefp')
    expect(readOnly).not.toContain('Keep box key')

    permissions.add('ssh:write')
    const html = renderRemoteHostsSettings()
    expect(html.match(/Keep box key/g)?.length).toBe(2)
    // "Use Ficus key" is never offered for the wildcard line.
    expect(html.match(/Use Ficus key/g)?.length).toBe(1)
  })
})
