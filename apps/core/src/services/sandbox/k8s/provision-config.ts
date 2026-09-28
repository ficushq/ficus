export interface ProvisionConfig {
  maxConcurrent: number
  maxWaiters: number
  failureThreshold: number
  failureWindowMs: number
  cooldownMs: number
}

export const DEFAULT_PROVISION_CONFIG: Readonly<ProvisionConfig> = {
  maxConcurrent: 4,
  maxWaiters: 32,
  failureThreshold: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
}

type Environment = Partial<Record<string, string | undefined>>

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function parseProvisionConfig(env: Environment = process.env): ProvisionConfig {
  return {
    maxConcurrent: positiveInteger(env.FICUS_K8S_PROVISION_MAX_CONCURRENT, DEFAULT_PROVISION_CONFIG.maxConcurrent),
    maxWaiters: positiveInteger(env.FICUS_K8S_PROVISION_MAX_WAITERS, DEFAULT_PROVISION_CONFIG.maxWaiters),
    failureThreshold: positiveInteger(
      env.FICUS_K8S_PROVISION_FAILURE_THRESHOLD,
      DEFAULT_PROVISION_CONFIG.failureThreshold
    ),
    failureWindowMs: positiveInteger(
      env.FICUS_K8S_PROVISION_FAILURE_WINDOW_MS,
      DEFAULT_PROVISION_CONFIG.failureWindowMs
    ),
    cooldownMs: positiveInteger(env.FICUS_K8S_PROVISION_COOLDOWN_MS, DEFAULT_PROVISION_CONFIG.cooldownMs),
  }
}

export const provisionConfig = parseProvisionConfig()
