import type { IntegrationProvider, ProviderValidation } from '../types'
import { BigbrainClient, type BigbrainClientOptions } from './client'
import { BigbrainError } from './errors'
import { BigbrainConfigSchema, type BigbrainConfigV2 } from './local-bindings'
export type { BigbrainConfigV2 } from './local-bindings'

export class BigbrainProvider implements IntegrationProvider<BigbrainConfigV2> {
  readonly key = 'bigbrain'
  readonly adapterVersion = 2
  readonly capabilities = {}
  readonly #client: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'>
  constructor(options: { client?: (options: BigbrainClientOptions) => Pick<BigbrainClient, 'validate'> } = {}) {
    this.#client = options.client ?? ((options) => new BigbrainClient(options))
  }
  parseConfig(value: unknown): BigbrainConfigV2 {
    return BigbrainConfigSchema.parse(value)
  }
  async validate(
    context: Parameters<IntegrationProvider<BigbrainConfigV2>['validate']>[0]
  ): Promise<ProviderValidation> {
    try {
      const grantedScopes = await this.#client({
        configuration: context.connection.configuration,
        clientId: context.credential,
      }).validate({ signal: context.signal })
      return { ok: true, grantedScopes }
    } catch (error) {
      return { ok: false, code: error instanceof BigbrainError ? error.code : 'provider_error' }
    }
  }
}
