import { expect, test } from 'bun:test'
import { registerOAuthProviderAdapterForTest } from '@ficus/shared/oauth-providers'
import { createFakeAdapter } from '@ficus/shared/oauth-providers/fake'
import { createLocalRevocationTransport, createOAuthRevocationTransportResolver } from './revocation-transport'

test('revocation resolver selects persisted job authority without consulting deployment mode', async () => {
  const calls: string[] = []
  const resolver = createOAuthRevocationTransportResolver({
    local: () => ({ authority: 'local', revoke: async () => void calls.push('local') }),
    broker: () => ({ authority: 'platform_broker', revoke: async () => void calls.push('broker') }),
  })

  await resolver.resolve('local').revoke({ providerKey: 'notion', credentialRef: 'local-ref', token: 'local-token' })
  await resolver
    .resolve('platform_broker')
    .revoke({ providerKey: 'notion', credentialRef: 'broker-ref', token: 'broker-token' })
  expect(calls).toEqual(['local', 'broker'])
})

test('historical local credential resolver is reachable only from revoke', async () => {
  let credentialReads = 0
  const script = { responses: [], revoked: [] as string[], calls: [] as { op: string; at: number }[] }
  const restore = registerOAuthProviderAdapterForTest(createFakeAdapter(script))
  try {
    const transport = createLocalRevocationTransport({
      resolveClientCredentials: async () => {
        credentialReads += 1
        return { clientId: 'historical-id', clientSecret: 'historical-secret' }
      },
    })
    await transport.revoke({ providerKey: 'notion', credentialRef: 'local-ref', token: 'local-token' })
    expect(credentialReads).toBe(1)
    expect(script.revoked).toEqual(['local-token'])
    expect(Object.keys(transport).sort()).toEqual(['authority', 'revoke'])
  } finally {
    restore()
  }
})
