import { eq } from 'drizzle-orm'
import type { ProviderRoute } from '@ficus/shared/provider-health'
import { createLogger } from '../../lib/infra/logger'
import { parseModelSpec, splitModelPriorityList } from '../../lib/utils/model-spec'
import { db } from '../../db'
import { agentTypes, modelTiers } from '../../db/schema'
import { tryGetModelRuntime } from '../agent'
import { listAccounts, readAccountStore, type AccountStoreV1 } from '../agent/account-store'
import { providerHealth } from '../provider-health/registry'
import { getSquadDemandSnapshots } from './demand'
import { reconcileDeadFleet } from './dead-fleet'
import { FleetIncidentNotifier } from './notifier'
import { reconcileProviderHealthRecords } from './provider-health-reconciler'
import { reconcileSandboxOverload } from './sandbox-overload'
import type { ProviderHealthRecord } from '@ficus/shared/provider-health'

const log = createLogger('fleet-alert-runtime')
const DEFAULT_INTERVAL_MS = 60_000

type IntervalHandle = ReturnType<typeof setInterval> | number

interface FleetAlertRuntimeDeps {
  intervalMs?: number
  now?: () => Date
  getEnabledChains?: () => Promise<readonly (readonly ProviderRoute[])[]>
  getHealth?: () => { records: readonly ProviderHealthRecord[] }
  getDemand?: typeof getSquadDemandSnapshots
  reconcileProvider?: typeof reconcileProviderHealthRecords
  reconcileDeadFleet?: typeof reconcileDeadFleet
  reconcileSandboxOverload?: (input: { now: Date }) => Promise<void>
  drainNotifications?: (input: { now: Date }) => Promise<void>
  setIntervalFn?: (callback: () => void, intervalMs: number) => IntervalHandle
  clearIntervalFn?: (handle: IntervalHandle) => void
}

export function buildProviderChains(
  chainSpecs: readonly string[],
  accountStore: AccountStoreV1,
  hasConfiguredAuth: (provider: string) => boolean
): ProviderRoute[][] {
  return chainSpecs.map((chain) =>
    splitModelPriorityList(chain).flatMap((candidate) => {
      const provider = parseModelSpec(candidate).provider
      const accounts = listAccounts(accountStore, provider).filter(
        (account) => account.enabled && account.credential != null
      )
      if (accounts.length > 0) {
        return accounts.map((account) => ({ provider, accountId: account.id, credentialUsable: true }))
      }
      return [{ provider, credentialUsable: hasConfiguredAuth(provider) }]
    })
  )
}

async function getEnabledProviderChains(): Promise<ProviderRoute[][]> {
  const rows = await db
    .select({ model: agentTypes.model, tier: agentTypes.tier, tierChain: modelTiers.chain })
    .from(agentTypes)
    .leftJoin(modelTiers, eq(agentTypes.tier, modelTiers.slug))
    .where(eq(agentTypes.disabled, false))
  const chainSpecs = rows
    .map((row) => row.model.trim() || row.tierChain?.trim() || process.env.DEFAULT_MODEL?.trim() || '')
    .filter(Boolean)
  const runtime = tryGetModelRuntime()
  return buildProviderChains(
    chainSpecs,
    readAccountStore(),
    (provider) => runtime?.hasConfiguredAuth(provider) ?? false
  )
}

export class FleetAlertRuntime {
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly getEnabledChains: () => Promise<readonly (readonly ProviderRoute[])[]>
  private readonly getHealth: () => { records: readonly ProviderHealthRecord[] }
  private readonly getDemand: typeof getSquadDemandSnapshots
  private readonly reconcileProvider: typeof reconcileProviderHealthRecords
  private readonly reconcileDeadFleetFn: typeof reconcileDeadFleet
  private readonly reconcileSandboxOverloadFn: (input: { now: Date }) => Promise<void>
  private readonly drainNotifications: (input: { now: Date }) => Promise<void>
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => IntervalHandle
  private readonly clearIntervalFn: (handle: IntervalHandle) => void
  private readonly startedAt: Date
  private timer?: IntervalHandle
  private running?: Promise<void>

  constructor(deps: FleetAlertRuntimeDeps = {}) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
    this.now = deps.now ?? (() => new Date())
    this.getEnabledChains = deps.getEnabledChains ?? getEnabledProviderChains
    this.getHealth = deps.getHealth ?? (() => ({ records: providerHealth.snapshotRecords() }))
    this.getDemand = deps.getDemand ?? getSquadDemandSnapshots
    this.reconcileProvider = deps.reconcileProvider ?? reconcileProviderHealthRecords
    this.reconcileDeadFleetFn = deps.reconcileDeadFleet ?? reconcileDeadFleet
    this.reconcileSandboxOverloadFn = deps.reconcileSandboxOverload ?? ((input) => reconcileSandboxOverload(input))
    this.drainNotifications = deps.drainNotifications ?? ((input) => new FleetIncidentNotifier().drain(input))
    this.setIntervalFn = deps.setIntervalFn ?? setInterval
    this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval
    this.startedAt = this.now()
  }

  start(): void {
    if (this.timer !== undefined) return
    void this.tick()
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) this.clearIntervalFn(this.timer)
    this.timer = undefined
    await this.running
  }

  private tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.runOnce()
      .catch((error) => log.error('Fleet alert reconciliation failed:', error))
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }

  private async runOnce(): Promise<void> {
    const now = this.now()
    const [enabledChains, demand] = await Promise.all([this.getEnabledChains(), this.getDemand({ now })])
    const health = this.getHealth()
    await Promise.all([
      this.reconcileProvider({ ...health, enabledChains, now }),
      this.reconcileDeadFleetFn({ demand, now, coldStartAt: this.startedAt }),
      // Box probes must never hold back provider/dead-fleet alerts or delivery.
      this.reconcileSandboxOverloadFn({ now }).catch((error) =>
        log.warn('Sandbox overload reconciliation failed:', error)
      ),
    ])
    await this.drainNotifications({ now })
  }
}

export const fleetAlertRuntime = new FleetAlertRuntime()
