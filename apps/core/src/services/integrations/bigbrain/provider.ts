import type { IntegrationProvider, ProviderValidation } from '../types'
import { BigbrainClient, type BigbrainClientOptions } from './client'
import { BigbrainError } from './errors'
import type { BigbrainConfigV2 } from './local-bindings'
import {
  credentialMatchesConfiguration,
  isManagedSharedConfig,
  parseBigbrainConfiguration,
  type BigbrainConfiguration,
  type ManagedSharedConfig,
} from './managed/config'
export type { BigbrainConfigV2 } from './local-bindings'

/** Authenticate a managed read token as exactly the read-only reader of its vault. */
export type ManagedBigbrainValidate = (
  configuration: ManagedSharedConfig,
  token: string,
  connectionId: string,
  signal?: AbortSignal
) => Promise<void>

export class BigbrainProvider implements IntegrationProvider<BigbrainConfiguration> {
  readonly key = 'bigbrain'
  readonly adapterVersion = 2
  readonly capabilities = {}
  readonly #client: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'>
  readonly #managedValidate: ManagedBigbrainValidate
  constructor(
    options: {
      client?: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'>
      /** Managed shared read: authenticate the read token as exactly the read-only reader. */
      managedValidate?: ManagedBigbrainValidate
    } = {}
  ) {
    this.#client = options.client ?? ((options) => new BigbrainClient(options))
    this.#managedValidate =
      options.managedValidate ??
      (async (configuration, token, connectionId, signal) => {
        const { resolveManagedReadClient } = await import('./managed/read-target')
        const { client } = await resolveManagedReadClient({
          configuration,
          connectionId,
          token,
          beforeCall: async () => {},
        })
        await client.verify({ signal })
      })
  }
  parseConfig(value: unknown): BigbrainConfiguration {
    return parseBigbrainConfiguration(value)
  }
  async validate(
    context: Parameters<IntegrationProvider<BigbrainConfiguration>['validate']>[0]
  ): Promise<ProviderValidation> {
    const configuration = context.connection.configuration
    // Managed shared reads authenticate through the gateway as exactly the read-only agent
    // reader of the synchronized vault; never as a local binding.
    if (isManagedSharedConfig(configuration)) {
      try {
        if (!credentialMatchesConfiguration(configuration, context.credential))
          return { ok: false, code: 'invalid_configuration' }
        await this.#managedValidate(configuration, context.credential, context.connection.id, context.signal)
        return { ok: true, grantedScopes: ['read'] }
      } catch (error) {
        return { ok: false, code: error instanceof BigbrainError ? error.code : 'provider_error' }
      }
    }
    try {
      const grantedScopes = await this.#client({
        configuration: configuration satisfies BigbrainConfigV2,
        clientId: context.credential,
      }).validate({ signal: context.signal })
      return { ok: true, grantedScopes }
    } catch (error) {
      return { ok: false, code: error instanceof BigbrainError ? error.code : 'provider_error' }
    }
  }
}
