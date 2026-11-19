import type { ProviderHealthRecord, ProviderRoute } from '@ficus/shared/provider-health'
import { getDemandProviderChains, blockedDemandProvider } from './provider-attribution'
import { sql } from 'drizzle-orm'
import { db } from '../../db'
import type { SquadDemandSnapshot } from './demand'
import { observeDeadFleet, type DeadFleetIncidentStoreAdapter } from './store'

interface LastRunRow extends Record<string, unknown> {
  squadId: string
  lastRunStartedAt: Date | string | null
}

export interface DeadFleetReconciliationInput {
  now: Date
  demand: ReadonlyMap<string, SquadDemandSnapshot>
  coldStartAt?: Date
  /** Same-tick routing health, not the independently persisted incident table. */
  records?: readonly ProviderHealthRecord[]
}

export interface DeadFleetReconciliationAdapter extends DeadFleetIncidentStoreAdapter {
  getDemandChains?: (snapshot: SquadDemandSnapshot) => Promise<readonly (readonly ProviderRoute[])[]>
}

/**
 * Demand snapshots from the dispatcher gates already account for scoped,
 * bounded foreground progress. Never let an unrelated run reset those clocks.
 * Aggregate-only snapshots retain the run-start fallback; execution.started_at
 * is queue creation, not evidence that the worker claimed anything.
 */
export async function reconcileDeadFleet(
  input: DeadFleetReconciliationInput,
  adapter: DeadFleetReconciliationAdapter = {}
): Promise<void> {
  if (input.demand.size === 0) return
  const squadIds = [...input.demand].filter(([, snapshot]) => snapshot.unservedSince === undefined).map(([id]) => id)
  const now = input.now.toISOString()

  const rows = squadIds.length
    ? await db.execute<LastRunRow>(sql`
    SELECT
      agent.squad_id AS "squadId",
      MAX(execution.run_started_at) AS "lastRunStartedAt"
    FROM agents AS agent
    JOIN squads AS squad ON squad.id = agent.squad_id
    JOIN executions AS execution ON execution.agent_id = agent.id
    WHERE agent.squad_id IN (${sql.join(
      squadIds.map((squadId) => sql`${squadId}::uuid`),
      sql`, `
    )})
      AND agent.id IS DISTINCT FROM squad.manager_agent_id
      AND execution.run_started_at IS NOT NULL
      AND execution.run_started_at <= ${now}::timestamptz
    GROUP BY agent.squad_id
  `)
    : []
  const lastRunBySquad = new Map(
    rows.map((row) => [
      row.squadId,
      row.lastRunStartedAt == null
        ? undefined
        : row.lastRunStartedAt instanceof Date
          ? row.lastRunStartedAt
          : new Date(row.lastRunStartedAt),
    ])
  )

  await Promise.all(
    [...input.demand].map(async ([squadId, snapshot]) => {
      const lastRunStartedAt = lastRunBySquad.get(squadId)
      if (snapshot.count === 0 || snapshot.firstDemandAt == null) {
        return observeDeadFleet({ status: 'quiet', squadId, lastRunStartedAt, now: input.now }, adapter)
      }
      const unservedSince = snapshot.unservedSince ?? snapshot.firstDemandAt
      const records = input.records ?? []
      const chains =
        snapshot.agentIds?.length && records.length
          ? await (adapter.getDemandChains ?? getDemandProviderChains)(snapshot)
          : []
      const providerCause = blockedDemandProvider(chains, records, input.now.getTime())
      return observeDeadFleet(
        {
          status: 'stalled',
          squadId,
          demandCount: snapshot.count,
          providerCause,
          firstDemandAt:
            lastRunStartedAt == null && input.coldStartAt && unservedSince < input.coldStartAt
              ? input.coldStartAt
              : unservedSince,
          lastRunStartedAt,
          now: input.now,
        },
        adapter
      )
    })
  )
}
