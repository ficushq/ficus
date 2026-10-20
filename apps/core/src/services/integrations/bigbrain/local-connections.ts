import type { IntegrationConnectionService } from '../connection-service'
import type { BigbrainBindings, BigbrainBindingSummary } from './local-bindings'
import { BigbrainError } from './errors'
export type BigbrainLocalAvailability = {
  state: 'available' | 'setup_required' | 'unsupported_host' | 'invalid_configuration' | 'binding_unavailable'
  bindings: BigbrainBindingSummary[]
}
export class BigbrainLocalConnections {
  constructor(
    readonly bindings: Pick<BigbrainBindings, 'list' | 'resolve'>,
    readonly connections: Pick<IntegrationConnectionService, 'create'>
  ) {}
  async list(): Promise<BigbrainLocalAvailability> {
    try {
      const bindings = await this.bindings.list()
      return { state: bindings.length ? 'available' : 'setup_required', bindings }
    } catch (error) {
      const code = error instanceof BigbrainError ? error.code : 'invalid_configuration'
      return {
        state: code === 'unsupported_host' || code === 'binding_unavailable' ? code : 'invalid_configuration',
        bindings: [],
      }
    }
  }
  async create(input: { bindingId: string; displayName: string }, actor: string) {
    const binding = await this.bindings.resolve(input.bindingId)
    return this.connections.create({
      providerKey: 'bigbrain',
      adapterVersion: 2,
      configuration: binding.configuration,
      credential: binding.clientId,
      displayName: input.displayName,
      actor,
      clientAuthority: 'local',
      authorizationGrant: true,
    })
  }
}
