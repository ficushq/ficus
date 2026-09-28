import type { OAuthClientBinding } from '@ficus/shared/oauth-providers/types'
import { getOAuthProviderAdapter } from '@ficus/shared/oauth-providers'
import type { OAuthAuthority } from './authority'
import { createBrokerTransport } from './broker-transport'
import { OAuthTransportError, type OAuthTransport } from './transport'

export type OAuthRevocationTransport = Pick<OAuthTransport, 'authority' | 'revoke'>

export interface OAuthRevocationTransportResolver {
  resolve(authority: OAuthAuthority): OAuthRevocationTransport
}

export function createOAuthRevocationTransportResolver(factories: {
  local(): OAuthRevocationTransport
  broker(): OAuthRevocationTransport
}): OAuthRevocationTransportResolver {
  return {
    resolve(authority) {
      const transport = authority === 'local' ? factories.local() : factories.broker()
      if (transport.authority !== authority) throw new OAuthTransportError('client_authority_mismatch')
      return transport
    },
  }
}

/** Construct only historical local revoke capability; authorization and refresh are deliberately absent. */
export function createLocalRevocationTransport(dependencies: {
  resolveClientCredentials(
    providerKey: string,
    binding?: OAuthClientBinding
  ): Promise<{ clientId: string; clientSecret: string } | undefined>
}): OAuthRevocationTransport {
  return {
    authority: 'local',
    async revoke(input) {
      const adapter = getOAuthProviderAdapter(input.providerKey)
      if (!adapter) throw new OAuthTransportError('unsupported_provider')
      const credentials = await dependencies.resolveClientCredentials(input.providerKey, input.clientBinding)
      if (!credentials) throw new OAuthTransportError('oauth_app_unconfigured')
      await adapter.revoke({
        token: input.token,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
      })
    },
  }
}

export function createBrokerRevocationTransport(
  ...args: Parameters<typeof createBrokerTransport>
): OAuthRevocationTransport {
  const transport = createBrokerTransport(...args)
  return { authority: transport.authority, revoke: (input) => transport.revoke(input) }
}
