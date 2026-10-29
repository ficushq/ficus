import { db } from '../../db'
import { currentVmProvisionAttemptId } from '../sandbox/vm/provision-flight'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { WORK_STREAM_ADMITTED_STATUSES } from '@ficus/shared'
import { agents, machineBoxes, machineCapacityClaims, machines, squads, workStreams } from '../../db/schema'
import { isVmRuntime } from '../sandbox/runtime'
import type { DbTransaction } from './queries'
import {
  HostCapacityUnavailableError,
  claimHostCapacity,
  pendingStreamBox,
  readHostCapacity,
  type HostClaimResult,
} from './host-capacity-store'

export { HostCapacityUnavailableError } from './host-capacity-store'

/** Reserve a pending participant and its shared box before flow dispatch creates
 * agents. Sticky/pinned squad placement is authoritative. Unbound work tries
 * existing shared machines only: saturation never provisions infrastructure.
 * With no registered ready target, normal placement/bootstrap remains the
 * authority; its physical start must acquire the same quota gate after placement.
 */
export async function reserveWorkStreamHostCapacity(
  tx: DbTransaction,
  input: { squadId: string; streamId: string }
): Promise<HostClaimResult> {
  if (!isVmRuntime()) return { allowed: true }
  const [squad] = await tx.select({ machineId: squads.machineId }).from(squads).where(eq(squads.id, input.squadId))
  const sandboxId = `squad_${input.squadId}`
  const [box] = await tx
    .select({ machineId: machineBoxes.machineId })
    .from(machineBoxes)
    .where(eq(machineBoxes.sandboxId, sandboxId))
  // A non-ready explicit pin belongs to the normal placement/readiness retry
  // path, not a silent admission refusal. Unreachable recorded placements can move.
  if (squad?.machineId && !(await machineIsReady(tx, squad.machineId))) return { allowed: true }
  const pinned = squad?.machineId ?? (box && (await machineIsReady(tx, box.machineId)) ? box.machineId : undefined)
  const candidates = pinned
    ? [{ id: pinned }]
    : await tx
        .select({ id: machines.id })
        .from(machines)
        .where(and(eq(machines.status, 'ready'), eq(machines.scope, 'shared')))
        .orderBy(asc(machines.createdAt), asc(machines.id))
  if (candidates.length === 0) return { allowed: true }
  let result: HostClaimResult = { allowed: false, reason: 'unknown' }
  for (const machine of candidates) {
    result = await claimHostCapacity(tx, { kind: 'stream', workStreamId: input.streamId }, [
      { machineId: machine.id, sandboxId },
      { machineId: machine.id, sandboxId: pendingStreamBox(input.streamId) },
    ])
    if (result.allowed || result.reason === 'busy') return result
  }
  return result
}

/** Actual accessible sandbox identities replace the pending stream agent.
 * Pickup commits this reservation with its queued -> running CAS. Placement
 * remains authoritative and rechecks capacity before any physical setup.
 */
export async function reserveExecutionHostCapacity(
  tx: DbTransaction,
  input: { executionId: string; agentId: string; sandboxIds: string[] }
): Promise<HostClaimResult> {
  if (!isVmRuntime() || !input.sandboxIds.length) return { allowed: true }
  const [stream] = await tx
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES),
        sql`(${workStreams.assigneeAgentId} = ${input.agentId} OR ${input.agentId} = ANY(${workStreams.agentIds}))`
      )
    )
    .orderBy(desc(workStreams.createdAt))
    .limit(1)
  const [reserved] = stream
    ? await tx
        .select({ id: machineCapacityClaims.machineId })
        .from(machineCapacityClaims)
        .where(
          and(
            eq(machineCapacityClaims.streamId, stream.id),
            eq(machineCapacityClaims.sandboxId, pendingStreamBox(stream.id))
          )
        )
    : []
  const planned = [] as { sandboxId: string; machineId?: string }[]
  for (const sandboxId of new Set(input.sandboxIds)) {
    const [box] = await tx
      .select({ machineId: machineBoxes.machineId })
      .from(machineBoxes)
      .where(eq(machineBoxes.sandboxId, sandboxId))
    let pin: string | null | undefined
    if (sandboxId.startsWith('squad_')) {
      const [squad] = await tx
        .select({ machineId: squads.machineId })
        .from(squads)
        .where(eq(squads.id, sandboxId.slice('squad_'.length)))
      pin = squad?.machineId
    } else {
      const ownerId = sandboxId.startsWith('agent_') ? sandboxId.slice('agent_'.length) : input.agentId
      const [owner] = await tx.select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, ownerId))
      pin = owner?.machineId
    }
    if (pin && !(await machineIsReady(tx, pin))) return { allowed: true }
    planned.push({
      sandboxId,
      machineId: pin ?? (box && (await machineIsReady(tx, box.machineId)) ? box.machineId : undefined),
    })
  }
  const candidates =
    reserved && (await machineIsReady(tx, reserved.id))
      ? [reserved]
      : await tx
          .select({ id: machines.id })
          .from(machines)
          .where(and(eq(machines.status, 'ready'), eq(machines.scope, 'shared')))
          .orderBy(asc(machines.createdAt), asc(machines.id))
  if (!candidates.length) {
    const known = planned.find((resource) => resource.machineId)
    if (!known) return { allowed: true } // normal first-host bootstrap, gated again after placement
    candidates.push({ id: known.machineId! })
  }
  let result: HostClaimResult = { allowed: false, reason: 'unknown' }
  for (const candidate of candidates) {
    result = await claimHostCapacity(
      tx,
      {
        kind: 'execution',
        executionId: input.executionId,
        workStreamId: stream?.id,
      },
      planned.map((resource) => ({ sandboxId: resource.sandboxId, machineId: resource.machineId ?? candidate.id }))
    )
    if (result.allowed || result.reason === 'busy') return result
  }
  return result
}

/** The claim follows the entire coalesced physical generation, not the SSH
 * call or a timer. Returning from this function closes the short transaction;
 * the generation's terminal record is what releases its host startup lane.
 */
export async function reservePhysicalHostCapacity(machineId: string, sandboxId: string): Promise<void> {
  const provisionAttemptId = currentVmProvisionAttemptId()
  if (provisionAttemptId === undefined) throw new Error('Physical host admission requires a provision generation')
  const result = await db.transaction(async (tx) => {
    const workStreamId = await streamForSandbox(tx, sandboxId)
    return claimHostCapacity(tx, { kind: 'provision', provisionAttemptId, workStreamId }, [{ machineId, sandboxId }])
  })
  if (!result.allowed) throw new HostCapacityUnavailableError(result)
}

async function streamForSandbox(tx: DbTransaction, sandboxId: string): Promise<string | undefined> {
  if (!sandboxId.startsWith('agent_')) return undefined
  const [stream] = await tx
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(
      and(
        inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES),
        sql`(${workStreams.assigneeAgentId}::text = ${sandboxId.slice(6)}
        OR ${sandboxId.slice(6)} = ANY(${workStreams.agentIds}::text[]))`
      )
    )
    .orderBy(desc(workStreams.createdAt))
    .limit(1)
  return stream?.id
}

/** Placement preflight only; concurrent physical starts still claim atomically. */
export async function canHostSandbox(machineId: string, sandboxId: string): Promise<boolean> {
  if (!isVmRuntime()) return true
  return db.transaction(async (tx) => {
    const workStreamId = await streamForSandbox(tx, sandboxId)
    return (await readHostCapacity(tx, machineId, sandboxId ? [sandboxId] : [], workStreamId)).allowed
  })
}

/** Header readout uses only durable facts: no SSH/probe and no idle-box wake. */
export async function readSandboxHostCapacity(sandboxId: string, squadId?: string) {
  return db
    .transaction(async (tx) => {
      const [box] = await tx
        .select({ machineId: machineBoxes.machineId })
        .from(machineBoxes)
        .where(eq(machineBoxes.sandboxId, sandboxId))
      const [squad] = squadId
        ? await tx.select({ machineId: squads.machineId }).from(squads).where(eq(squads.id, squadId))
        : []
      const [planned] = await tx
        .select({ machineId: machineCapacityClaims.machineId })
        .from(machineCapacityClaims)
        .innerJoin(workStreams, eq(workStreams.id, machineCapacityClaims.streamId))
        .where(
          and(
            eq(machineCapacityClaims.sandboxId, sandboxId),
            inArray(workStreams.status, WORK_STREAM_ADMITTED_STATUSES)
          )
        )
        .limit(1)
      const machineId = box?.machineId ?? squad?.machineId ?? planned?.machineId
      return machineId ? readHostCapacity(tx, machineId, [sandboxId]) : undefined
    })
    .catch(() => ({ allowed: false, reason: 'unknown' as const }))
}

async function machineIsReady(tx: DbTransaction, machineId: string): Promise<boolean> {
  const [machine] = await tx.select({ status: machines.status }).from(machines).where(eq(machines.id, machineId))
  return machine?.status === 'ready'
}
