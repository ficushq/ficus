import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { createPeriodicRunner, type PeriodicRunner } from '../../lib/infra/PeriodicRunner'
import { createLogger } from '../../lib/infra/logger'
import { getModelRuntime } from '../agent'
import { readAccountStore, listAccounts, type Account } from '../agent/account-store'
import { providerHealth } from './registry'
import { getProbe, registeredProbeProviders, type HealthProbe } from './probes'

const log = createLogger('provider-health-probes')

const PROBE_INTERVAL_MS = Number(process.env.PROVIDER_HEALTH_PROBE_INTERVAL_MS) || 60_000

export interface ProbeSweepDeps {
  /** Resolve the API key for a provider/account; `undefined` means skip. */
  getApiKey?: (provider: string, account?: Account) => Promise<string | undefined>
  /** List enabled accounts for a provider. Omit for legacy provider-level probing. */
  getAccounts?: (provider: string) => Account[]
  /** List providers that have a probe registered. */
  getProviders?: () => string[]
  /** Get the probe for a provider; `undefined` means skip. */
  getProbe?: (provider: string) => HealthProbe | undefined
}

const defaultDeps: Required<ProbeSweepDeps> = {
  getApiKey: async (provider, account) => {
    if (account) return resolveAccountApiKey(provider, account)
    const runtime = await getModelRuntime()
    const auth = await runtime.getAuth(provider)
    return auth?.auth.apiKey
  },
  getAccounts: (provider) => listAccounts(readAccountStore(), provider).filter((account) => account.enabled),
  getProviders: () => registeredProbeProviders(),
  getProbe: (provider) => getProbe(provider),
}

/**
 * Run one probe sweep: for each registered probe provider, resolve credentials,
 * call the probe, and write the result through the provider-health registry so
 * probes and the reactive path share one reason taxonomy. Each probe is wrapped
 * in try/catch so a single failing fetch can never abort the sweep.
 */
export async function runProbeSweepOnce(deps: ProbeSweepDeps = {}): Promise<void> {
  const getApiKey = deps.getApiKey ?? defaultDeps.getApiKey
  const getAccounts = deps.getAccounts ?? defaultDeps.getAccounts
  const getProviders = deps.getProviders ?? defaultDeps.getProviders
  const resolveProbe = deps.getProbe ?? defaultDeps.getProbe

  const providers = getProviders()
  for (const provider of providers) {
    try {
      const probe = resolveProbe(provider)
      if (!probe) continue // no probe registered for this provider

      const accounts = getAccounts(provider).filter((a) => a.enabled)
      if (accounts.length > 0) {
        for (const account of accounts) {
          try {
            const apiKey = await getApiKey(provider, account)
            if (!apiKey) continue
            const attempt = providerHealth.captureAttempt(provider, account.id)
            const result = await probe.probe({ apiKey })
            markProbeResult(attempt, result)
          } catch (error) {
            log.warn(`Probe for ${provider} account ${account.id} was inconclusive:`, error)
          }
        }
        continue
      }

      // Legacy/env-only fallback: no stored accounts, so probe the provider-level key.
      const apiKey = await getApiKey(provider)
      if (!apiKey) continue // no auth configured — skip (don't flap)

      const attempt = providerHealth.captureAttempt(provider)
      const result = await probe.probe({ apiKey })
      markProbeResult(attempt, result)
    } catch (err) {
      log.warn(`Probe for ${provider} failed:`, err)
    }
  }
}

function markProbeResult(
  attempt: ReturnType<typeof providerHealth.captureAttempt>,
  result: Awaited<ReturnType<HealthProbe['probe']>>
): void {
  if (result.state === 'healthy') providerHealth.recordSuccess(attempt, result.recoveryKinds)
  else if (result.state === 'unhealthy') providerHealth.recordFailure(attempt, result)
}

async function resolveAccountApiKey(provider: string, account: Account): Promise<string | undefined> {
  if (account.credential.type === 'api_key') return account.credential.key
  // OAuth: build a transient runtime seeded with this account's credential
  // so getAuth can resolve (and refresh if needed) the access token.
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(provider, async () => account.credential)
  const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false })
  const auth = await runtime.getAuth(provider)
  return auth?.auth.apiKey
}

let runner: PeriodicRunner | null = null

/** Start the periodic probe sweep. No-op if already running. */
export function startProbeScheduler(): void {
  if (runner) return
  runner = createPeriodicRunner({
    name: 'provider-health-probes',
    intervalMs: PROBE_INTERVAL_MS,
    runImmediately: false,
    task: () => runProbeSweepOnce(),
  })
  runner.start()
  log.info(`Probe scheduler started (interval ${PROBE_INTERVAL_MS}ms)`)
}

/** Stop the periodic probe sweep. */
export async function stopProbeScheduler(): Promise<void> {
  if (!runner) return
  await runner.stop()
  runner = null
}
