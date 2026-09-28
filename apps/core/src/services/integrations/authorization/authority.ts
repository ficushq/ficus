import { getSecretStore } from '../../secrets'
import { isPlatformManaged } from '../../secrets/managed'

export type OAuthAuthority = 'local' | 'platform_broker'

export class BrokerUnconfiguredError extends Error {
  readonly code = 'broker_unconfigured'

  constructor() {
    super('broker_unconfigured')
    this.name = 'BrokerUnconfiguredError'
  }
}

/** Deployment mode is the sole authority selector; configuration never changes it. */
export function resolveOAuthAuthority(): OAuthAuthority {
  return isPlatformManaged() ? 'platform_broker' : 'local'
}

/** Resolve the hosted broker configuration without ever falling back to local OAuth. */
export function requireBrokerConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.FICUS_PLATFORM_BASE_URL?.trim()
  const token =
    getSecretStore().get('FICUS_PLATFORM_INSTANCE_TOKEN')?.trim() ?? process.env.FICUS_PLATFORM_INSTANCE_TOKEN?.trim()
  if (!baseUrl || !token) throw new BrokerUnconfiguredError()
  return { baseUrl, token }
}
