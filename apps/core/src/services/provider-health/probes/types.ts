import type { ProviderHealthKind } from '@ficus/shared/provider-health'

export type ProbeResult =
  | {
      state: 'healthy'
      status?: number
      /** Failure kinds this endpoint can prove recovered; omitted preserves unrestricted recovery. */
      recoveryKinds?: readonly ProviderHealthKind[]
    }
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
