import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryKeys } from '../queryKeys'
import type { AgentFederationStatus } from '../api/amtp'
import type { AmtpSignedAgentCard } from '@ficus/shared'
import { AmtpMailboxSection } from './AmtpMailboxSection'

function render(opts: { status: AgentFederationStatus; permissions?: string[] }): string {
  const qc = new QueryClient()
  qc.setQueryData(queryKeys.amtp.agentStatus('a1'), opts.status)
  qc.setQueryData(queryKeys.amtp.allowRules('a1'), [])
  qc.setQueryData(queryKeys.amtp.peers(), [])
  qc.setQueryData(queryKeys.auth.permissions('squad-1'), { permissions: opts.permissions ?? [] })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <AmtpMailboxSection agentId="a1" squadId="squad-1" />
    </QueryClientProvider>
  )
}

const readyFields = {
  address: 'amtp://inst/alice',
  federationReady: true,
  signingIdentity: { status: 'ready' as const, reason: null, message: null, identityPublicKey: 'PEM' },
  card: null,
  agentName: null,
  agentDescription: null,
}

const registered: AgentFederationStatus = {
  ...readyFields,
  handle: 'alice',
  registered: true,
  inboundOpen: true,
  allowsInbound: true,
  allowRules: [],
}

const sampleCard: AmtpSignedAgentCard = {
  v: 1,
  instanceId: 'inst-1',
  handle: 'alice',
  card: { name: 'Alice Bot', description: 'Helps with things.\nSecond line.' },
  cardSig: 'deadbeef',
}

describe('AmtpMailboxSection', () => {
  test('shows read rows + Allows inbound badge, but no operator controls without amtp:write', () => {
    const html = render({ status: registered, permissions: [] })
    expect(html).toContain('alice')
    expect(html).toContain('Inbound open')
    expect(html).toContain('Allows inbound')
    expect(html).not.toContain('>Revoke<')
    expect(html).not.toContain('>Close<')
    expect(html).toContain('Operator controls require amtp:write')
  })

  test('shows Revoke + Close for a registered open mailbox with amtp:write', () => {
    const html = render({ status: registered, permissions: ['amtp:write'] })
    expect(html).toContain('>Revoke<')
    expect(html).toContain('>Close<')
    expect(html).not.toContain('Operator controls require amtp:write')
  })

  test('shows the Register form + Open when not registered and writable', () => {
    const html = render({
      status: {
        ...readyFields,
        handle: null,
        address: null,
        registered: false,
        federationReady: false,
        inboundOpen: false,
        allowsInbound: false,
        allowRules: [],
      },
      permissions: ['amtp:write'],
    })
    expect(html).toContain('Not registered')
    expect(html).toContain('>Register<')
    expect(html).not.toContain('Allows inbound')
  })

  test('renders name + description when status.card is present', () => {
    const html = render({ status: { ...registered, card: sampleCard }, permissions: [] })
    expect(html).toContain('Alice Bot')
    expect(html).toContain('Helps with things.')
    expect(html).not.toContain('ficus remote card set')
  })

  test('renders the "ficus remote card set" hint when registered, no card, and canWrite', () => {
    const html = render({ status: registered, permissions: ['amtp:write'] })
    expect(html).toContain('ficus remote card set')
    expect(html).toContain('--name')
    expect(html).toContain('--description')
  })

  test('renders nothing card-related when unregistered', () => {
    const html = render({
      status: {
        ...readyFields,
        handle: null,
        address: null,
        federationReady: false,
        registered: false,
        inboundOpen: false,
        allowsInbound: false,
        allowRules: [],
        card: null,
        agentName: null,
        agentDescription: null,
      },
      permissions: ['amtp:write'],
    })
    expect(html).not.toContain('ficus remote card set')
    expect(html).not.toContain('Alice Bot')
  })
  test('shows historical unavailable custody without unsafe controls', () => {
    const html = render({
      status: {
        ...registered,
        federationReady: false,
        inboundOpen: false,
        allowsInbound: false,
        signingIdentity: {
          status: 'unavailable',
          reason: 'missing_public_key',
          message: 'Signing identity is unavailable.',
          identityPublicKey: null,
        },
      },
      permissions: ['amtp:write'],
    })
    expect(html).toContain('Registered, but signing identity unavailable')
    expect(html).toContain('Inbound closed')
    expect(html).not.toContain('>Open<')
    expect(html).not.toContain('ficus remote card set')
  })

  test('shows unsupported custody without registration control', () => {
    const html = render({
      status: {
        ...readyFields,
        handle: null,
        address: null,
        registered: false,
        federationReady: false,
        inboundOpen: false,
        allowsInbound: false,
        allowRules: [],
        signingIdentity: {
          status: 'unsupported',
          reason: 'shared_system_manager_custody',
          message: 'Private storage is shared.',
          identityPublicKey: null,
        },
      },
      permissions: ['amtp:write'],
    })
    expect(html).toContain('Federation unsupported')
    expect(html).toContain('shared')
    expect(html).not.toContain('>Register<')
  })
})
