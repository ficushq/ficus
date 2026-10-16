import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SshTrustTarget } from '../../api/ssh-host-keys'
import { SshHostKeysList } from './SshHostKeysList'

const now = new Date('2026-10-16T12:00:00Z').toISOString()

function target(overrides: Partial<SshTrustTarget>): SshTrustTarget {
  return {
    id: 't1',
    scope: 'machine:m1',
    kind: 'machine',
    squadId: null,
    label: 'Machine build-1',
    sshHost: '10.1.2.3',
    sshPort: 22,
    hostKeyState: 'pending',
    hostKeys: [
      {
        id: 'k1',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:machinefp',
        status: 'pending',
        origin: 'scan',
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        firstSeenAt: now,
        lastSeenAt: now,
        replacesFingerprints: [],
      },
    ],
    hostKeyCheckedAt: now,
    hostKeyCheckError: null,
    ...overrides,
  }
}

function render(targets: SshTrustTarget[], canAct: boolean) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <SshHostKeysList targets={targets} canAct={canAct} onChanged={() => {}} />
    </QueryClientProvider>
  )
}

describe('SshHostKeysList', () => {
  test('shows each endpoint with its pending key fingerprint and Trust / Reject', () => {
    const html = render([target({}), target({ id: 't2', label: 'Memory sync (github.com)', kind: 'memory-git' })], true)
    expect(html).toContain('Machine build-1')
    expect(html).toContain('10.1.2.3:22')
    expect(html).toContain('Memory sync (github.com)')
    expect(html).toContain('ssh-ed25519 SHA256:machinefp')
    expect(html).toContain('>Trust<')
    expect(html).toContain('>Reject<')
  })

  test('viewers who cannot act see fingerprints only', () => {
    const html = render([target({})], false)
    expect(html).toContain('SHA256:machinefp')
    expect(html).not.toContain('>Trust<')
  })

  test('renders nothing without endpoints', () => {
    expect(render([], true)).toBe('')
  })
})
