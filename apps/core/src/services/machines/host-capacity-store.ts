import { vmSetupLeaseIsHeld } from '../sandbox/vm/setup-lock'
import { WORK_STREAM_ADMITTED_STATUSES } from '@ficus/shared'
import { and, eq, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { executions, machineCapacityClaims, machines, vmBoxProvisionAttempts, workStreams } from '../../db/schema'
import type { DbTransaction } from './queries'
import { evaluateHostBoxCounts, withHostStartupCapacity, type HostCapacityDecision } from './host-capacity-policy'

export type HostCapacityOwner =
  | { kind: 'stream'; workStreamId: string }
  | { kind: 'execution'; executionId: string; workStreamId?: string }
  /** `background`: no execution waits on this box, so it may not take the last free startup slot. */
  | { kind: 'provision'; provisionAttemptId: number; workStreamId?: string; background?: boolean }
export interface HostResource {
  machineId: string
  sandboxId: string
}
type Claim = typeof machineCapacityClaims.$inferInsert & { startupActive?: boolean }

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

/** Match pickup's queued-owner lifecycle guards. A live running turn remains
 * tracked until it settles; a queued turn that cannot resume holds no claim. */
function queuedOwnerCanResume(agentId: SQL, wakeEligible: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM agents queued_owner WHERE queued_owner.id = ${agentId}
    AND queued_owner.status <> 'terminated' AND queued_owner.pending_dormancy_at IS NULL
    AND (queued_owner.status <> 'dormant' OR ${wakeEligible})
    AND NOT EXISTS (SELECT 1 FROM work_streams paused
      WHERE paused.status IN ('active', 'queued') AND paused.pause IS NOT NULL
        AND (paused.assignee_agent_id = queued_owner.id OR queued_owner.id = ANY(paused.agent_ids))))`
}

/** Ignore settled owners immediately, even before opportunistic row cleanup. */
async function validClaims(tx: DbTransaction, incomingProvisionId = 0): Promise<Claim[]> {
  const rows = await tx
    .select({ claim: machineCapacityClaims, provisionStatus: vmBoxProvisionAttempts.status })
    .from(machineCapacityClaims)
    .leftJoin(workStreams, eq(machineCapacityClaims.streamId, workStreams.id))
    .leftJoin(executions, eq(machineCapacityClaims.executionId, executions.id))
    .leftJoin(vmBoxProvisionAttempts, eq(machineCapacityClaims.provisionAttemptId, vmBoxProvisionAttempts.id))
    .where(
      or(
        and(eq(machineCapacityClaims.kind, 'stream'), inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES)),
        and(
          eq(machineCapacityClaims.kind, 'execution'),
          or(
            inArray(executions.status, ['running', 'waiting-sandbox', 'stopping']),
            and(
              eq(executions.status, 'queued'),
              queuedOwnerCanResume(sql`${executions.agentId}`, sql`${executions.wakeEligible}`)
            )
          )
        ),
        and(
          eq(machineCapacityClaims.kind, 'provision'),
          or(
            and(
              eq(vmBoxProvisionAttempts.status, 'running'),
              vmSetupLeaseIsHeld(sql`${vmBoxProvisionAttempts.sandboxId}`)
            ),
            and(
              eq(vmBoxProvisionAttempts.status, 'failed'),
              inArray(vmBoxProvisionAttempts.failureClass, ['abandoned', 'interrupted']),
              // Normal removal deletes the binding only after remote teardown;
              // no binding also means a pre-bind interrupted claim did no work.
              sql`EXISTS (SELECT 1 FROM machine_boxes bound
                WHERE bound.sandbox_id = ${machineCapacityClaims.sandboxId}
                  AND bound.machine_id = ${machineCapacityClaims.machineId})`,
              sql`NOT EXISTS (SELECT 1 FROM vm_box_provision_attempts newer
              WHERE newer.sandbox_id = ${vmBoxProvisionAttempts.sandboxId}
                AND newer.id > ${vmBoxProvisionAttempts.id} AND newer.status = 'succeeded')`,
              sql`NOT EXISTS (SELECT 1 FROM machine_boxes stopped
              WHERE stopped.sandbox_id = ${machineCapacityClaims.sandboxId}
                AND stopped.machine_id = ${machineCapacityClaims.machineId} AND stopped.status = 'stopped'
                AND stopped.updated_at >= ${vmBoxProvisionAttempts.createdAt})`
            )
          )
        )
      )
    )
  // Adopt pre-upgrade activity and non-execution activity conservatively. An
  // idle socket-activated server is NOT itself demand; a recent command or
  // terminal touch has a short cooldown, while running turns/generations stay
  // tracked for their entire lifetime. Descendants share their root's box.
  // A bind can remain labelled ensuring after an ordinary, awaited failure.
  // Prefer the latest physical outcome; pre-start admission/placement refusals
  // cannot prove earlier remote work stopped. Unowned observations track activity,
  // never the startup lane: simultaneous unadmitted generations must not mutually
  // block each other. Only a live persisted physical claim owns that lane.
  const ensuringWithoutOutcome = sql`(b.status = 'ensuring' AND NOT COALESCE((
    SELECT p.status IN ('succeeded', 'failed')
      AND COALESCE(p.failure_class, '') NOT IN ('abandoned', 'interrupted')
    FROM vm_box_provision_attempts p
    WHERE p.sandbox_id = b.sandbox_id AND p.id <> ${incomingProvisionId}
      AND COALESCE(p.failure_class, '') NOT LIKE 'capacity:%'
      AND COALESCE(p.failure_class, '') NOT LIKE 'placement%'
      AND COALESCE(p.failure_class, '') NOT IN ('retry:machine_capacity', 'retry:box_stop_unverified')
    ORDER BY p.id DESC LIMIT 1
  ), false))`
  const observed = (await tx.execute(sql`
    WITH RECURSIVE owners AS (
      SELECT a.id, a.parent_agent_id, a.agent_type_id, a.owner_user_id, a.squad_id,
             a.squad_id AS origin_squad_id, ARRAY[a.id] AS path
      FROM agents a JOIN executions e ON e.agent_id = a.id
      WHERE (e.status IN ('running', 'waiting-sandbox', 'stopping')
        OR (e.status = 'queued' AND e.run_started_at IS NOT NULL
          AND ${queuedOwnerCanResume(sql`e.agent_id`, sql`e.wake_eligible`)})) AND a.agent_type_id <> 'assistant'
      UNION ALL
      SELECT p.id, p.parent_agent_id, p.agent_type_id, p.owner_user_id, p.squad_id,
             o.origin_squad_id, o.path || p.id
      FROM owners o JOIN agents p ON p.id = o.parent_agent_id
      WHERE NOT p.id = ANY(o.path)
    )
    SELECT b.machine_id AS "machineId", b.sandbox_id AS "sandboxId",
      CASE WHEN ${ensuringWithoutOutcome} OR EXISTS (SELECT 1 FROM vm_box_provision_attempts p
        WHERE p.sandbox_id = b.sandbox_id AND p.status = 'running' AND p.id <> ${incomingProvisionId} AND ${vmSetupLeaseIsHeld(sql`p.sandbox_id`)})
        THEN 'provision' ELSE 'execution' END AS kind
    FROM machine_boxes b
    WHERE b.status IN ('ready', 'ensuring', 'stop_unverified') AND (
      b.status = 'stop_unverified' OR ${ensuringWithoutOutcome} OR b.last_activity_at > now() - interval '60 seconds'
      OR EXISTS (SELECT 1 FROM vm_box_provision_attempts p WHERE p.sandbox_id = b.sandbox_id AND p.status = 'running' AND p.id <> ${incomingProvisionId} AND ${vmSetupLeaseIsHeld(sql`p.sandbox_id`)})
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
  `)) as unknown as (HostResource & { kind: 'execution' | 'provision' })[]
  return [
    ...rows.map((row) => ({ ...row.claim, startupActive: row.provisionStatus === 'running' })),
    ...observed.map((resource) => ({
      ...resource,
      ownerKey: `observed:${resource.sandboxId}`,
      kind: resource.kind,
    })),
  ]
}

/** Resolve known participant inheritance once per snapshot. A reused agent (or
 * descendants sharing its root) must not reserve a separate box per stream. */
async function streamBoxIdentities(tx: DbTransaction): Promise<Map<string, Set<string>>> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE members AS (
      SELECT w.id AS stream_id, a.id, a.parent_agent_id, a.agent_type_id,
        a.owner_user_id, a.squad_id, ARRAY[a.id] AS path
      FROM work_streams w JOIN agents a ON (w.assignee_agent_id = a.id OR a.id = ANY(w.agent_ids))
      WHERE w.status IN (${sql.join(
        WORK_STREAM_ADMITTED_STATUSES.map((status) => sql`${status}`),
        sql`, `
      )})
        AND a.status <> 'terminated'
      UNION ALL
      SELECT m.stream_id, a.id, a.parent_agent_id, a.agent_type_id,
        a.owner_user_id, a.squad_id, m.path || a.id
      FROM members m JOIN agents a ON a.id = m.parent_agent_id
      WHERE NOT a.id = ANY(m.path) AND a.status <> 'terminated'
    )
    SELECT DISTINCT stream_id AS "streamId", CASE
      WHEN agent_type_id = 'consultant' AND squad_id IS NOT NULL THEN 'consultants_' || squad_id::text
      WHEN agent_type_id IN ('system-manager', 'assistant-worker') AND owner_user_id IS NOT NULL
        THEN 'system_manager_' || owner_user_id::text
      ELSE 'agent_' || id::text END AS "sandboxId"
    FROM members WHERE parent_agent_id IS NULL AND agent_type_id <> 'assistant'
  `)) as unknown as { streamId: string; sandboxId: string }[]
  const identities = new Map<string, Set<string>>()
  for (const row of rows) {
    let keys = identities.get(row.streamId)
    if (!keys) identities.set(row.streamId, (keys = new Set()))
    keys.add(row.sandboxId)
  }
  return identities
}

function resourcesByMachine(claims: Claim[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const claim of claims) {
    let keys = result.get(claim.machineId)
    if (!keys) result.set(claim.machineId, (keys = new Set()))
    keys.add(claim.sandboxId)
  }
  return result
}

/** Canonicalize planned identities only as part of the atomic claim. Deriving
 * reservations dynamically from mutable stream membership would grandfather a
 * newly assigned agent without ever admitting its additional demand. */
function reconcileReservations(key: string, before: Claim[], requested: Claim[], identities: Map<string, Set<string>>) {
  const incoming = requested.map((claim) => {
    const known =
      claim.kind === 'stream' && claim.streamId && claim.sandboxId === pendingStreamBox(claim.streamId)
        ? identities.get(claim.streamId)
        : undefined
    return known?.size === 1 ? { ...claim, sandboxId: [...known][0]! } : claim
  })
  const materialized = new Map<string, HostResource>()
  for (const claim of incoming) {
    if (claim.kind === 'stream' || claim.sandboxId.startsWith('squad_')) continue
    if (claim.workStreamId) materialized.set(claim.workStreamId, claim)
    for (const [streamId, boxes] of identities) if (boxes.has(claim.sandboxId)) materialized.set(streamId, claim)
  }
  const replaced: { previous: Claim; next: Claim }[] = []
  const retained = before
    .filter((claim) => claim.ownerKey !== key)
    .map((claim) => {
      const target =
        claim.kind === 'stream' && claim.streamId && !claim.sandboxId.startsWith('squad_')
          ? materialized.get(claim.streamId)
          : undefined
      if (!target || (target.sandboxId === claim.sandboxId && target.machineId === claim.machineId)) return claim
      const next = { ...claim, sandboxId: target.sandboxId, machineId: target.machineId }
      replaced.push({ previous: claim, next })
      return next
    })
  return { incoming, replaced, projected: [...retained, ...incoming] }
}

/** Readout only; authoritative claims must hold the transaction admission lock. */
export async function readHostCapacity(
  tx: DbTransaction,
  machineId: string,
  incomingSandboxIds: string[] = [],
  workStreamId?: string
): Promise<HostCapacityDecision> {
  const [machine] = await tx
    .select({ capabilities: machines.capabilities })
    .from(machines)
    .where(eq(machines.id, machineId))
  const claims = await validClaims(tx)
  const current = resourcesByMachine(claims).get(machineId)?.size ?? 0
  const planned = incomingSandboxIds.length
    ? reconcileReservations(
        'preview',
        claims,
        incomingSandboxIds.map((sandboxId) => ({
          ownerKey: 'preview',
          kind: 'provision',
          machineId,
          sandboxId,
          workStreamId,
        })),
        await streamBoxIdentities(tx)
      ).projected
    : claims
  const projected = resourcesByMachine(planned).get(machineId)?.size ?? 0
  const capacity = evaluateHostBoxCounts(machine?.capabilities.cpus, current, projected)
  return {
    ...capacity,
    startingBoxes: new Set(
      claims.filter((claim) => claim.startupActive && claim.machineId === machineId).map((claim) => claim.sandboxId)
    ).size,
  }
}

export interface HostClaimResult {
  allowed: boolean
  reason?: 'busy' | 'unknown' | 'quota' | 'starting'
  machineId?: string
  capacity?: HostCapacityDecision
}

export class HostCapacityUnavailableError extends Error {
  constructor(readonly result: HostClaimResult) {
    super('The machine is busy starting sandboxes; work waits for a host capacity startup slot.')
    this.name = 'HostCapacityUnavailableError'
  }
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
  if (!(await lockHostCapacity(tx))) return { allowed: false, reason: 'busy' }
  const key = ownerKey(owner)
  const before = await validClaims(tx, owner.kind === 'provision' ? owner.provisionAttemptId : 0)
  // Reclaim settled ownership without a TTL. Uncertain remote work stays in
  // validClaims until same-box recovery or affirmative stop proof.
  const liveKeys = [...new Set(before.map((claim) => claim.ownerKey))]
  if (liveKeys.length)
    await tx.delete(machineCapacityClaims).where(notInArray(machineCapacityClaims.ownerKey, liveKeys))
  else await tx.delete(machineCapacityClaims)
  const requested: Claim[] = [
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
  const plan = reconcileReservations(key, before, requested, await streamBoxIdentities(tx))
  const current = resourcesByMachine(before),
    projected = resourcesByMachine(plan.projected)
  for (const machineId of new Set(plan.incoming.map((resource) => resource.machineId))) {
    const [machine] = await tx
      .select({ capabilities: machines.capabilities, status: machines.status })
      .from(machines)
      .where(eq(machines.id, machineId))
    const capacity = evaluateHostBoxCounts(
      machine?.status === 'ready' ? machine.capabilities.cpus : undefined,
      current.get(machineId)?.size ?? 0,
      projected.get(machineId)?.size ?? 0
    )
    if (owner.kind === 'provision') {
      const startup = withHostStartupCapacity(
        capacity,
        before.filter((claim) => claim.startupActive && claim.machineId === machineId).map((claim) => claim.sandboxId),
        resources.filter((resource) => resource.machineId === machineId).map((resource) => resource.sandboxId),
        { background: owner.background === true }
      )
      if (!startup.allowed) return { allowed: false, reason: 'starting', machineId, capacity: startup }
    }
  }
  for (const { previous, next } of plan.replaced) {
    await tx
      .delete(machineCapacityClaims)
      .where(
        and(
          eq(machineCapacityClaims.ownerKey, previous.ownerKey),
          eq(machineCapacityClaims.machineId, previous.machineId),
          eq(machineCapacityClaims.sandboxId, previous.sandboxId)
        )
      )
    const { startupActive: _startupActive, ...row } = next
    await tx.insert(machineCapacityClaims).values(row).onConflictDoNothing()
  }
  await tx.delete(machineCapacityClaims).where(eq(machineCapacityClaims.ownerKey, key))
  if (plan.incoming.length) await tx.insert(machineCapacityClaims).values(plan.incoming)
  return { allowed: true }
}

async function lockHostCapacity(tx: DbTransaction): Promise<boolean> {
  // Retry brief transaction contention without a failure/backoff penalty.
  // Do not block indefinitely here: callers may hold squad/agent/box rows,
  // while the current holder's FK checks may need those same lifecycle rows.
  let acquired = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(421109, 1) as acquired`)) as unknown as {
      acquired: boolean
    }[]
    if (lock?.acquired) {
      acquired = true
      break
    }
    if (attempt < 2) await Bun.sleep([25, 100][attempt]! + Math.floor(Math.random() * 10))
  }
  return acquired
}

/** Bind is the authoritative placement fact. Move all reservations for this
 * identity with the bind transaction, removing phantom charges on prior hosts.
 * Call BEFORE inserting the binding so it cannot grandfather its own demand. */
export async function moveHostResourceClaims(tx: DbTransaction, sandboxId: string, machineId: string): Promise<void> {
  const existing = await tx
    .select({ ownerKey: machineCapacityClaims.ownerKey })
    .from(machineCapacityClaims)
    .where(and(eq(machineCapacityClaims.sandboxId, sandboxId), ne(machineCapacityClaims.machineId, machineId)))
    .limit(1)
  if (!existing.length) return
  if (!(await lockHostCapacity(tx)))
    throw new HostCapacityUnavailableError({ allowed: false, reason: 'busy', machineId })
  const before = await validClaims(tx)
  const moving = before.filter(
    (claim) => !claim.ownerKey.startsWith('observed:') && claim.sandboxId === sandboxId && claim.machineId !== machineId
  )
  if (!moving.length) return
  const after = before.map((claim) => (moving.includes(claim) ? { ...claim, machineId } : claim))
  const [machine] = await tx
    .select({ capabilities: machines.capabilities })
    .from(machines)
    .where(eq(machines.id, machineId))
  const capacity = evaluateHostBoxCounts(
    machine?.capabilities.cpus,
    resourcesByMachine(before).get(machineId)?.size ?? 0,
    resourcesByMachine(after).get(machineId)?.size ?? 0
  )
  const startup = withHostStartupCapacity(
    capacity,
    before.filter((claim) => claim.startupActive && claim.machineId === machineId).map((claim) => claim.sandboxId),
    moving.filter((claim) => claim.startupActive).map((claim) => claim.sandboxId)
  )
  if (!startup.allowed)
    throw new HostCapacityUnavailableError({ allowed: false, reason: 'starting', machineId, capacity: startup })
  for (const claim of moving) {
    await tx
      .delete(machineCapacityClaims)
      .where(
        and(
          eq(machineCapacityClaims.ownerKey, claim.ownerKey),
          eq(machineCapacityClaims.machineId, claim.machineId),
          eq(machineCapacityClaims.sandboxId, sandboxId)
        )
      )
    const { startupActive: _startupActive, ...row } = claim
    await tx
      .insert(machineCapacityClaims)
      .values({ ...row, machineId })
      .onConflictDoNothing()
  }
}
