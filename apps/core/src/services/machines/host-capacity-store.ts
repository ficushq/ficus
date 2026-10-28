import { WORK_STREAM_ADMITTED_STATUSES } from '@ficus/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { executions, machineCapacityClaims, machines, vmBoxProvisionAttempts, workStreams } from '../../db/schema'
import type { DbTransaction } from './queries'
import { evaluateHostQuotaCounts, type HostCapacityDecision } from './host-capacity-policy'

export type HostCapacityOwner =
  | { kind: 'stream'; workStreamId: string }
  | { kind: 'execution'; executionId: string; workStreamId?: string }
  | { kind: 'provision'; provisionAttemptId: number; workStreamId?: string }
export interface HostResource {
  machineId: string
  sandboxId: string
}
type Claim = typeof machineCapacityClaims.$inferInsert

export function pendingStreamBox(streamId: string): string {
  return `pending-agent:${streamId}`
}

function ownerKey(owner: HostCapacityOwner): string {
  switch (owner.kind) {
    case 'stream':
      return `stream:${owner.workStreamId}`
    case 'execution':
      return `execution:${owner.executionId}`
    case 'provision':
      return `provision:${owner.provisionAttemptId}`
  }
}

/** Ignore settled owners immediately, even before opportunistic row cleanup. */
async function validClaims(tx: DbTransaction): Promise<Claim[]> {
  const rows = await tx
    .select({ claim: machineCapacityClaims })
    .from(machineCapacityClaims)
    .leftJoin(workStreams, eq(machineCapacityClaims.streamId, workStreams.id))
    .leftJoin(executions, eq(machineCapacityClaims.executionId, executions.id))
    .leftJoin(vmBoxProvisionAttempts, eq(machineCapacityClaims.provisionAttemptId, vmBoxProvisionAttempts.id))
    .where(
      or(
        and(eq(machineCapacityClaims.kind, 'stream'), inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES)),
        and(
          eq(machineCapacityClaims.kind, 'execution'),
          inArray(executions.status, ['running', 'waiting-sandbox', 'stopping'])
        ),
        and(eq(machineCapacityClaims.kind, 'provision'), eq(vmBoxProvisionAttempts.status, 'running'))
      )
    )
  // Adopt pre-upgrade activity and non-execution activity conservatively. An
  // idle socket-activated server is NOT itself demand; a recent command or
  // terminal touch has a short cooldown, while running turns/generations stay
  // charged for their entire lifetime. Descendants share their root's box.
  const observed = (await tx.execute(sql`
    WITH RECURSIVE owners AS (
      SELECT a.id, a.parent_agent_id, a.agent_type_id, a.owner_user_id, a.squad_id,
             a.squad_id AS origin_squad_id, ARRAY[a.id] AS path
      FROM agents a JOIN executions e ON e.agent_id = a.id
      WHERE e.status IN ('running', 'waiting-sandbox', 'stopping') AND a.agent_type_id <> 'assistant'
      UNION ALL
      SELECT p.id, p.parent_agent_id, p.agent_type_id, p.owner_user_id, p.squad_id,
             o.origin_squad_id, o.path || p.id
      FROM owners o JOIN agents p ON p.id = o.parent_agent_id
      WHERE NOT p.id = ANY(o.path)
    )
    SELECT b.machine_id AS "machineId", b.sandbox_id AS "sandboxId"
    FROM machine_boxes b
    WHERE b.status IN ('ready', 'ensuring', 'stop_unverified') AND (
      b.last_activity_at > now() - interval '60 seconds'
      OR EXISTS (SELECT 1 FROM vm_box_provision_attempts p WHERE p.sandbox_id = b.sandbox_id AND p.status = 'running')
      OR EXISTS (
        SELECT 1 FROM owners o WHERE
          b.sandbox_id = 'squad_' || o.origin_squad_id::text
          OR (o.parent_agent_id IS NULL AND b.sandbox_id = CASE
            WHEN o.agent_type_id = 'consultant' AND o.squad_id IS NOT NULL THEN 'consultants_' || o.squad_id::text
            WHEN o.agent_type_id IN ('system-manager', 'assistant-worker') AND o.owner_user_id IS NOT NULL
              THEN 'system_manager_' || o.owner_user_id::text
            ELSE 'agent_' || o.id::text END)
      )
    )
  `)) as unknown as HostResource[]
  return [
    ...rows.map((row) => row.claim),
    ...observed.map((resource) => ({
      ...resource,
      ownerKey: `observed:${resource.sandboxId}`,
      kind: 'execution' as const,
    })),
  ]
}

/** One pending agent per admitted stream; actual private-box demand replaces
 * that placeholder, while every additional fork participant adds its quota. */
function resourcesByMachine(claims: Claim[]): Map<string, Set<string>> {
  const materialized = new Set(
    claims
      .filter(
        (c) =>
          c.kind !== 'stream' &&
          c.workStreamId &&
          !c.sandboxId.startsWith('squad_') &&
          !c.sandboxId.startsWith('pending-agent:')
      )
      .map((c) => c.workStreamId!)
  )
  const result = new Map<string, Set<string>>()
  for (const claim of claims) {
    if (
      claim.kind === 'stream' &&
      claim.streamId &&
      materialized.has(claim.streamId) &&
      claim.sandboxId === pendingStreamBox(claim.streamId)
    )
      continue
    let keys = result.get(claim.machineId)
    if (!keys) result.set(claim.machineId, (keys = new Set()))
    keys.add(claim.sandboxId)
  }
  return result
}

/** Readout only; authoritative claims must hold the transaction admission lock. */
export async function readHostCapacity(tx: DbTransaction, machineId: string): Promise<HostCapacityDecision> {
  const [machine] = await tx
    .select({ capabilities: machines.capabilities })
    .from(machines)
    .where(eq(machines.id, machineId))
  const count = resourcesByMachine(await validClaims(tx)).get(machineId)?.size ?? 0
  return evaluateHostQuotaCounts(machine?.capabilities.cpus, count, count)
}

export interface HostClaimResult {
  allowed: boolean
  reason?: 'busy' | 'unknown' | 'quota'
  machineId?: string
  capacity?: HostCapacityDecision
}

/**
 * Atomic all-or-nothing replacement of one owner's resource set. Callers commit
 * it with their lifecycle transition. A try-lock defers contention without
 * holding a long transaction, taking a dedicated session permit, or creating
 * lock-order cycles with existing squad/agent/machine lifecycle locks.
 */
export async function claimHostCapacity(
  tx: DbTransaction,
  owner: HostCapacityOwner,
  resources: HostResource[]
): Promise<HostClaimResult> {
  const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(421109, 1) as acquired`)) as unknown as {
    acquired: boolean
  }[]
  if (!lock?.acquired) return { allowed: false, reason: 'busy' }
  const key = ownerKey(owner)
  const before = await validClaims(tx)
  const incoming: Claim[] = [
    ...new Map(resources.map((resource) => [`${resource.machineId}:${resource.sandboxId}`, resource])).values(),
  ].map((resource) => ({
    ...resource,
    ownerKey: key,
    kind: owner.kind,
    streamId: owner.kind === 'stream' ? owner.workStreamId : null,
    workStreamId: owner.workStreamId ?? null,
    executionId: owner.kind === 'execution' ? owner.executionId : null,
    provisionAttemptId: owner.kind === 'provision' ? owner.provisionAttemptId : null,
  }))
  const after = [...before.filter((c) => c.ownerKey !== key), ...incoming]
  const current = resourcesByMachine(before),
    projected = resourcesByMachine(after)
  for (const machineId of new Set(resources.map((r) => r.machineId))) {
    const [machine] = await tx
      .select({ capabilities: machines.capabilities, status: machines.status })
      .from(machines)
      .where(eq(machines.id, machineId))
    const capacity = evaluateHostQuotaCounts(
      machine?.status === 'ready' ? machine.capabilities.cpus : undefined,
      current.get(machineId)?.size ?? 0,
      projected.get(machineId)?.size ?? 0
    )
    if (!capacity.allowed)
      return { allowed: false, reason: capacity.reason === 'unknown' ? 'unknown' : 'quota', machineId, capacity }
  }
  await tx.delete(machineCapacityClaims).where(eq(machineCapacityClaims.ownerKey, key))
  if (incoming.length) await tx.insert(machineCapacityClaims).values(incoming)
  return { allowed: true }
}
