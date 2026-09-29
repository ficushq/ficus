import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MachineRow } from './MachinesSection'
import type { Machine } from '../../api/machines'

function makeMachine(overrides: Partial<Machine> = {}): Machine {
  return {
    id: 'm-1',
    name: 'box-1',
    provider: 'ssh',
    providerRef: null,
    sshHost: '10.0.0.9',
    sshPort: 22,
    sshUser: 'ficus',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    status: 'ready',
    capabilities: {},
    scope: 'shared',
    purpose: 'shared',
    squadId: null,
    egressPolicy: false,
    bootstrapVersion: 'v1',
    lastError: null,
    artifactVersions: {},
    utilization: { unitsUsed: 0, unitCapacity: 10 },
    lastSeenAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function renderRow(machine: Machine, canWrite = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MachineRow machine={machine} allMachines={[machine]} canWrite={canWrite} />
    </QueryClientProvider>
  )
}

describe('MachineRow lastError display', () => {
  test('shows the persisted lastError as a muted line when unreachable', () => {
    const html = renderRow(makeMachine({ status: 'unreachable', lastError: 'bootstrap.sh failed on x: apt-get boom' }))
    expect(html).toContain('bootstrap.sh failed on x: apt-get boom')
  })

  test('does not show any error line when the machine is unreachable but lastError is null', () => {
    const html = renderRow(makeMachine({ status: 'unreachable', lastError: null }))
    expect(html).not.toContain('bootstrap.sh failed')
  })

  test('does not show lastError when the machine is ready, even if a stale value existed', () => {
    // Defensive: a 'ready' row should never carry a non-null lastError once
    // bootstrapMachine clears it on success, but the row must not render it
    // even if the server sent stale data.
    const html = renderRow(makeMachine({ status: 'ready', lastError: 'stale error text' }))
    expect(html).not.toContain('stale error text')
  })
})
