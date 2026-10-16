import { describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PublicHostKey, RemoteHost } from '../../api/remote-hosts'
import { HostKeysPanel, hostKeyNeedsAttention } from './HostKeysPanel'

const now = new Date('2026-10-16T12:00:00Z').toISOString()

function key(overrides: Partial<PublicHostKey>): PublicHostKey {
  return {
    id: 'k',
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:aaaa',
    status: 'pending',
    origin: 'scan',
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    firstSeenAt: now,
    lastSeenAt: now,
    replacesFingerprints: [],
    ...overrides,
  }
}

function host(overrides: Partial<RemoteHost>): RemoteHost {
  return {
    id: 'host-1',
    name: 'staging',
    description: null,
    sshHost: '10.1.2.3',
    sshPort: 22,
    sshUser: 'deploy',
    sshPublicKey: 'ssh-ed25519 AAAA test',
    createdAt: now,
    updatedAt: now,
    hostKeyState: 'pending',
    hostKeys: [],
    ...overrides,
  }
}

function render(h: RemoteHost, canAct: boolean) {
  const client = new QueryClient()
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <HostKeysPanel host={h} canAct={canAct} scan={async () => h} decide={async () => h} onChanged={() => {}} />
    </QueryClientProvider>
  )
}

describe('HostKeysPanel', () => {
  test('a pending key shows its type and fingerprint with Trust and Reject', () => {
    const html = render(host({ hostKeys: [key({ id: 'k1', fingerprint: 'SHA256:pendingfp' })] }), true)
    expect(html).toContain('Confirm host key')
    expect(html).toContain('ssh-ed25519 SHA256:pendingfp')
    expect(html).toContain('>Trust<')
    expect(html).toContain('>Reject<')
    expect(html).toContain('Agents cannot connect until you confirm the host key')
  })

  test('a key change shows the old and new fingerprints', () => {
    const html = render(
      host({
        hostKeyState: 'changed',
        hostKeys: [
          key({
            id: 'old',
            fingerprint: 'SHA256:oldfp',
            status: 'trusted',
            decisionNote: 'trusted by a person',
            decidedAt: now,
          }),
          key({ id: 'new', fingerprint: 'SHA256:newfp', replacesFingerprints: ['SHA256:oldfp'] }),
        ],
      }),
      true
    )
    expect(html).toContain('Host key changed')
    expect(html).toContain('ssh-ed25519 SHA256:oldfp')
    expect(html).toContain('ssh-ed25519 SHA256:newfp')
    expect(html).toContain('replaces trusted SHA256:oldfp')
  })

  test('viewers who cannot act see the keys but no actions', () => {
    const html = render(host({ hostKeys: [key({ fingerprint: 'SHA256:pendingfp' })] }), false)
    expect(html).toContain('SHA256:pendingfp')
    expect(html).not.toContain('>Trust<')
    expect(html).not.toContain('Fetch host key')
  })

  test('an adopted key shows its audit note', () => {
    const html = render(
      host({
        hostKeyState: 'trusted',
        hostKeys: [
          key({
            status: 'trusted',
            origin: 'adopted',
            decisionNote: 'adopted from existing trust (box agent_1)',
            decidedAt: now,
          }),
        ],
      }),
      true
    )
    expect(html).toContain('adopted from existing trust (box agent_1)')
    expect(html).not.toContain('>Trust<')
  })

  test('hosts needing attention are the blocked and changed ones', () => {
    expect(hostKeyNeedsAttention({ hostKeyState: 'pending' })).toBe(true)
    expect(hostKeyNeedsAttention({ hostKeyState: 'changed' })).toBe(true)
    expect(hostKeyNeedsAttention({ hostKeyState: 'unverified' })).toBe(true)
    expect(hostKeyNeedsAttention({ hostKeyState: 'trusted' })).toBe(false)
    expect(hostKeyNeedsAttention({ hostKeyState: 'adopting' })).toBe(false)
  })
})
