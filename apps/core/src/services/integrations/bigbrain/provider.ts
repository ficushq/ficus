import type { IntegrationProvider, ProviderValidation } from '../types'
import { BigbrainClient, type BigbrainClientOptions } from './client'
import { BigbrainError } from './errors'
import type { BigbrainConfigV2 } from './local-bindings'
import { isManagedSharedConfig, parseBigbrainConfiguration, type BigbrainConfiguration } from './managed/config'
export type { BigbrainConfigV2 } from './local-bindings'

export class BigbrainProvider implements IntegrationProvider<BigbrainConfiguration> {
  readonly key = 'bigbrain'
  readonly adapterVersion = 2
  readonly capabilities = {}
  readonly #client: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'>
  constructor(options: { client?: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'> } = {}) {
    this.#client = options.client ?? ((options) => new BigbrainClient(options))
  }
  parseConfig(value: unknown): BigbrainConfiguration {
    return parseBigbrainConfiguration(value)
  }
  async validate(
    context: Parameters<IntegrationProvider<BigbrainConfiguration>['validate']>[0]
  ): Promise<ProviderValidation> {
    const configuration = context.connection.configuration
    // Managed shared reads are validated only by the managed lifecycle (host receipt + upstream
    // whoami); generic validation never treats them as a local binding.
    if (isManagedSharedConfig(configuration)) return { ok: false, code: 'binding_unavailable' }
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
