import { and, eq, sql } from 'drizzle-orm'
import { isLiveAgentStatus, SYSTEM_RECIPIENT_ID } from '@ficus/shared'
import { db, agents, squads, workStreams, recoveryEpisodes, inbox } from '../../db'
import {
  getUserIdsWithPermission,
  hasUserPermissionWithExecutor,
  hasAgentPermissionWithExecutor,
} from '../rbac/permissions'
import { listEnabledUserIds } from '../users/enabled'
import type { DbHandle } from '../work-streams/waits'
import type { RecoveryRecord } from './store'

/** One authoritative audience for delivery, visibility and decisions. Never
 * widens a private owner's audience while that owner remains eligible.
 */
export async function recoveryRecipients(record: RecoveryRecord, executor: DbHandle = db) {
  const [agent] = await executor.select().from(agents).where(eq(agents.id, record.agentId))
  const [stream] = record.workStreamId
    ? await executor.select().from(workStreams).where(eq(workStreams.id, record.workStreamId))
    : []
  const squadId = stream?.squadId ?? agent?.squadId ?? undefined
  const [squad] = squadId ? await executor.select().from(squads).where(eq(squads.id, squadId)) : []
  let managerAgentId: string | null = null
  if (squad?.managerAgentId && squad.managerAgentId !== record.agentId) {
    const [manager] = await executor.select().from(agents).where(eq(agents.id, squad.managerAgentId))
    const [held] = await executor
      .select({ id: recoveryEpisodes.id })
      .from(recoveryEpisodes)
      .where(
        and(
          eq(recoveryEpisodes.agentId, squad.managerAgentId),
          sql`${recoveryEpisodes.state}->>'state' IN ('waiting-manager', 'waiting-owner', 'stopped')`,
          sql`(${recoveryEpisodes.workStreamId} IS NULL OR EXISTS (SELECT 1 FROM work_stream_waits w WHERE w.id = ${recoveryEpisodes.waitId} AND w.closed_at IS NULL))`
        )
      )
      .limit(1)
    if (
      manager &&
      isLiveAgentStatus(manager.status) &&
      manager.status !== 'waiting-input' &&
      !manager.pendingDormancyAt &&
      !held
    ) {
      const identity = { type: 'agent' as const, agentId: manager.id, squadId: manager.squadId }
      const permission = record.workStreamId ? 'workstreams:respond' : 'agents:run'
      if (await hasAgentPermissionWithExecutor(executor, identity, permission, squadId)) managerAgentId = manager.id
    }
  }
  const eligibleOwner = async (userId: string, privateOwner = false) => {
    if (!(await listEnabledUserIds([userId], executor)).length) return false
    if (!squadId && privateOwner) return true
    const allowed = (permission: string) => hasUserPermissionWithExecutor(executor, userId, permission, squadId)
    if (!(await allowed('actions:read'))) return false
    if (record.workStreamId)
      return (
        (await allowed('workstreams:read')) &&
        ((await allowed('workstreams:respond')) || (await allowed('workstreams:update')))
      )
    return (await allowed('agents:run')) && (squadId !== undefined || (await allowed('agents:private-access')))
  }
  let ownerUserIds: string[] = []
  for (const userId of [
    ...new Set([stream?.requestingUserId, agent?.ownerUserId].filter((id): id is string => Boolean(id))),
  ]) {
    if (await eligibleOwner(userId, userId === agent?.ownerUserId)) {
      ownerUserIds = [userId]
      break
    }
  }
  if (!ownerUserIds.length) {
    // Squads have RBAC owners/operators rather than an owner column. Resolve
    // enabled management-capability holders, then recheck decision/read rights.
    const candidates = await getUserIdsWithPermission(
      squadId ? 'squads:update' : 'agents:private-access',
      squadId,
      executor
    )
    for (const candidate of candidates) if (await eligibleOwner(candidate)) ownerUserIds.push(candidate)
  }
  if (
    (!managerAgentId || record.state.ownerEscalated) &&
    !ownerUserIds.length &&
    ['waiting-manager', 'waiting-owner'].includes(record.state.state)
  ) {
    await executor
      .insert(inbox)
      .values({
        recipientType: 'system',
        recipientId: SYSTEM_RECIPIENT_ID,
        senderType: 'system',
        subject: 'Recovery has no authorized decision recipient',
        content: `Recovery ${record.id} for agent ${record.agentId} is held because no enabled, authorized manager or owner could be resolved. Restore an authorized recipient; do not bypass the recovery decision.`,
        metadata: {
          source: 'recovery-unroutable',
          recoveryId: record.id,
          agentId: record.agentId,
          workStreamId: record.workStreamId,
        },
        idempotencyKey: `recovery-unroutable:${record.id}`,
      })
      .onConflictDoNothing()
  }
  return {
    managerAgentId,
    ownerUserIds,
    squadId,
    target: record.state.ownerEscalated || !managerAgentId ? ('owner' as const) : ('manager' as const),
  }
}

export async function recoveryRecipientsById(id: string, executor: DbHandle = db) {
  const [record] = await executor.select().from(recoveryEpisodes).where(eq(recoveryEpisodes.id, id))
  return record ? recoveryRecipients(record, executor) : null
}
