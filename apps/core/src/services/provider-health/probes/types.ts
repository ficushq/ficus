import type { ProviderHealthKind } from '@ficus/shared/provider-health'

export type ProbeResult =
  | { state: 'healthy'; status?: number }
  | { state: 'unhealthy'; kind: ProviderHealthKind; retryAt?: number; status?: number }
  | { state: 'inconclusive'; status?: number }

export interface ProbeContext {
  apiKey?: string
  baseUrl?: string
}

/** A registered endpoint probe; unregistered providers are never swept. */
export interface HealthProbe {
  provider: string
  probe(ctx: ProbeContext): Promise<ProbeResult>
}
