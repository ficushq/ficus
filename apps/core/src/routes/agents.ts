import { isUserAssistantAgentType } from '@ficus/shared'
import { listActiveSlotWaits } from '../services/slots/active-waits'
import { chatPagePathSchema } from '@ficus/shared'
import { getModelCatalog } from '../services/model-selection/model-catalog'
import { withChatQueueState } from '../services/chat/queued-messages'
import { withDeviceStreamRevocation } from '../services/streaming/device-revocation'
import { Hono, type Context } from 'hono'
import { parseOptionalJsonObjectBody } from '../middleware/json-body-errors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { join } from 'path'
import { Execution } from '../entities/Execution'
import { isSessionActive, isSessionCompacting, removeSession } from '../services/execution'
import { getProxyWorkerSSE } from '../services/streaming/sse-proxy'
import { Agent, AgentTargetUnavailableError, ListMessagesOptions } from '../entities/Agent'
import { ARTIFACT_BUILDER_AGENT_TYPE_ID } from '../entities/agent-runners/constants'
import { and, eq } from 'drizzle-orm'
import { db, agentExtraScopes, sandboxProvisionRecoveries } from '../db'
import { AmbiguousPrefixError } from '../db/prefix-match'
import { InvalidMessageCursorError } from '../services/agent/message-cursor'
import {
  getSandboxManager,
  isHostRuntime,
  isK8sRuntime,
  isRemoteSandboxRuntime,
  isVmRuntime,
} from '../services/sandbox'
import type { K8sSandboxManager } from '../services/sandbox/k8s'
import { hostRuntimeGuard } from './host-runtime-guard'
import { ensureAgentSandbox } from '../services/sandbox/agent-warmup'
import { assertMachinePinReady, MachinePinError } from '../services/machines/pin'
import { markLocalDeploymentsStoppedForSandbox } from '../services/deploy/local-deployment-service'
import { ensureSquadMemoryPath } from '../services/memory/paths'
import { parseTodoMarkdown, createFileTodoStorage } from '../tools/todo'
import { createLogger } from '../lib/infra/logger'
import { getSandboxProvisionErrorResponse } from './sandbox-provision-error'
import { PROVISION_RECOVERY_MAX_ATTEMPTS } from '../services/sandbox/k8s/provision-recovery-store'
import { requireEntityPermission } from '../middleware/require-entity-permission'
import { requireAgentResourcePermission } from '../middleware/require-agent-resource-permission'
import { requirePermission } from '../middleware/require-permission'
import {
  getAccessibleSquadIds,
  hasPermission,
  hasAnyPermission,
  permissionMatches,
  resolvePermissions,
  identityUserId,
  type Identity,
} from '../services/rbac'
import { resumeHaltedAgentAuthoritatively, listErrorHaltedAgents } from '../services/agents/resume'
import { listPendingActionsForIdentity } from '../services/agents/actions'
import { User } from '../entities/User'
import { Squad } from '../entities/Squad'
import { mergeSandboxStatus, resolveToolchainStatus } from '../services/sandbox/status'
import { openSandboxOverloadPressure } from '../services/fleet-alerts/store'
import {
  listSandboxProcesses,
  parseContainerId,
  parseProcessId,
  parseProcessSignal,
  sandboxProcessesErrorResponse,
  signalSandboxProcess,
  stopSandboxContainer,
} from '../services/sandbox/processes'
import { InvalidAttachmentError } from '../services/attachments/agent-scope'
import { ChatIdempotencyConflictError } from '../services/chat/consultant-idempotency'

import { isGrantablePermission } from '../services/rbac/grantable'
import { wsManager } from '../services/ws/manager'

const log = createLogger('routes:agents')
const IMAGE_UNSUPPORTED_ERROR = 'This model does not support image input. Use a vision-capable model.'

class ImageInputUnsupportedError extends Error {}

function validateAgentImageInput(agent: Agent, imageIds?: string[]): string | null {
  if (!imageIds?.length) return null
  return agent.supportsSelectedModelImages() === false ? IMAGE_UNSUPPORTED_ERROR : null
}

/** Resolve an agent's squadId for entity-permission checks. Returns null for squad-less agents (fail closed). */
async function agentSquadId(agentId: string): Promise<string | null> {
  return (await Agent.find(agentId))?.squadId ?? null
}

async function agentOwnerUserId(agentId: string): Promise<string | null> {
  return (await Agent.find(agentId))?.ownerUserId ?? null
}

/**
 * After tearing down an agent's sandbox, drop any live session and fail its
 * in-flight execution so the agent doesn't keep streaming against a box that no
 * longer exists. Mirrors the cleanup in the sandbox-status endpoint.
 */
/**
 * Run a process-management call against an agent's OWN box. A squad member
 * shares the squad box, whose processes are managed through the squad.
 */
async function ownAgentSandbox(c: Context, run: (sandboxId: string) => Promise<unknown>): Promise<Response> {
  const agent = await Agent.find(c.req.param('id'))
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  const sandboxId = await agent.getSandboxId()
  if (sandboxId !== agent.getAgentWorkspaceSandboxId()) {
    return c.json({ error: "This agent shares its squad's sandbox; manage its processes through the squad" }, 403)
  }
  try {
    return c.json(await run(sandboxId))
  } catch (err) {
    const failure = sandboxProcessesErrorResponse(err)
    if (failure) return c.json(failure.body, failure.status)
    throw err
  }
}

async function failActiveSessionForStoppedSandbox(agent: Agent, sandboxId: string): Promise<void> {
  if (!isSessionActive(agent.id)) return
  removeSession(agent.id)
  const activeExecution = await agent.getActiveExecution()
  if (activeExecution?.status === 'running') {
    await activeExecution.fail(`Sandbox ${sandboxId} was stopped`)
  }
}

/**
 * Filter an agent list to those the caller may see:
 * - Private owned agents (system-managers) are owner-only — even admins do not
 *   see another user's private agents.
 * - Squad agents are visible if their squad is accessible to the caller.
 */
async function filterVisibleAgents(identity: Identity, agentList: Agent[]): Promise<Agent[]> {
  const accessible = await getAccessibleSquadIds(identity)
  const callerUserId =
    identity.type === 'user' ? identity.userId : identity.type === 'agent' ? identity.userId : undefined
  return agentList.filter((a) => {
    if (a.ownerUserId) return a.ownerUserId === callerUserId
    if (accessible === 'all') return true
    return a.squadId != null && accessible.includes(a.squadId)
  })
}

const requireAgentReadPermission = requireEntityPermission(
  'agents:read',
  async (c) => agentSquadId(c.req.param('id')),
  { loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')) }
)

const grantScopeSchema = z.object({
  permission: z.string().min(1).refine(isGrantablePermission, {
    message: 'permission is not grantable (global "*" and unknown permissions are rejected)',
  }),
})

/**
 * Parse a duration string like "7d", "24h", "30m" into a Date representing
 * the cutoff time (now - duration).
 */
function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)([dhm])$/)
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Expected format like "7d", "24h", "30m"`)
  }
  const value = parseInt(match[1], 10)
  const unit = match[2]

  const now = Date.now()
  let ms: number
  switch (unit) {
    case 'd':
      ms = value * 24 * 60 * 60 * 1000
      break
    case 'h':
      ms = value * 60 * 60 * 1000
      break
    case 'm':
      ms = value * 60 * 1000
      break
    default:
      throw new Error(`Unknown duration unit: ${unit}`)
  }

  return new Date(now - ms)
}

function isAllowedMessageTarget(agent: Agent): boolean {
  if (agent.agentTypeId === ARTIFACT_BUILDER_AGENT_TYPE_ID) return agent.status === 'waiting-input'
  if (isUserAssistantAgentType(agent.agentTypeId)) return true
  if (agent.squadId) return true
  return false
}

export const agentsRouter = new Hono()
  // GET /api/agents — list agents (filter by agentTypeId, status, orphaned)
  // filtered-list: results filtered to squads accessible by the caller; squad-less agents admin/legacy only
  .get('/', async (c) => {
    const identity: Identity | undefined = c.get('identity')
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)

    const agentTypeId = c.req.query('agentTypeId')
    const status = c.req.query('status') as any
    const scopeType = c.req.query('scopeType')
    const scopeId = c.req.query('scopeId')
    const taskId = c.req.query('taskId')
    const orphaned = c.req.query('orphaned')
    const parentAgentId = c.req.query('parentAgentId')
    const olderThan = c.req.query('olderThan')

    // If orphaned=true, use the orphaned agents list
    if (orphaned === 'true') {
      let olderThanDate: Date | undefined
      if (olderThan) {
        olderThanDate = parseDuration(olderThan)
      }
      const result = await Agent.list({ agentTypeId, olderThan: olderThanDate }, 'recentlyCreated')
      const filtered = await filterVisibleAgents(identity, result)
      c.set('authzChecked', true)
      return c.json(filtered.map((agent) => agent.toJson()))
    }

    const result = await Agent.list(
      {
        agentTypeId,
        status,
        scopeType,
        scopeId,
        taskId,
        ...(parentAgentId ? { parentAgentId } : { topLevelOnly: true }),
      },
      'latestMessage'
    )
    const filtered = await filterVisibleAgents(identity, result)
    c.set('authzChecked', true)
    return c.json(filtered.map((agent) => agent.toJson()))
  })
  // POST /api/agents/continue-halted — an exact visible-action operation for Action Center callers.
  // The zero-byte body remains the explicitly global CLI compatibility path.
  // Registered before '/:id/*' so the static path isn't shadowed.
  .post('/continue-halted', async (c) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) return c.json({ error: 'Unauthorized' }, 401)
    c.set('authzChecked', true)

    const text = await c.req.text()
    if (text.length > 0) {
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      const parsed = z
        .object({ actionIds: z.array(z.string().min(1)).min(1).max(100) })
        .strict()
        .safeParse(raw)
      if (!parsed.success) return c.json({ error: 'actionIds must be a non-empty array of at most 100 IDs' }, 400)

      const requestedIds = [...new Set(parsed.data.actionIds)]
      const visible = await listPendingActionsForIdentity(identity)
      const byId = new Map(
        visible.filter((action) => action.type === 'agent-error').map((action) => [action.id, action] as const)
      )
      for (const actionId of requestedIds) {
        const action = byId.get(actionId)
        if (!action) return c.json({ error: 'Action not found', code: 'action_not_found' }, 404)
        if (!action.canRespond) return c.json({ error: 'Forbidden', code: 'action_forbidden' }, 403)
      }

      const authorizeCurrentTarget = (target: { ownerUserId: string | null; squadId: string | null }) =>
        identity.type === 'user' && target.ownerUserId === identity.userId
          ? Promise.resolve(true)
          : hasPermission(identity, 'agents:run', target.squadId ?? undefined)
      const resumedActionIds: string[] = []
      const staleActionIds: string[] = []
      for (const actionId of requestedIds) {
        const action = byId.get(actionId)!
        const outcome = await resumeHaltedAgentAuthoritatively(
          (action.data as { agentId: string }).agentId,
          authorizeCurrentTarget
        )
        if (outcome === 'forbidden') return c.json({ error: 'Forbidden', code: 'action_forbidden' }, 403)
        if (outcome === 'resumed') resumedActionIds.push(actionId)
        else staleActionIds.push(actionId)
      }
      return c.json({ resumed: resumedActionIds.length, resumedActionIds, staleActionIds })
    }

    const halted = await listErrorHaltedAgents()
    let resumed = 0
    for (const agent of halted) {
      const outcome = await resumeHaltedAgentAuthoritatively(agent.id, (target) =>
        identity.type === 'user' && target.ownerUserId === identity.userId
          ? Promise.resolve(true)
          : hasPermission(identity, 'agents:run', target.squadId ?? undefined)
      )
      if (outcome === 'resumed') resumed++
    }
    return c.json({ resumed })
  })
  // GET /api/agents/:id/scopes — list additive permission scopes granted to this agent
  .get('/:id/scopes', requirePermission('agents:scopes:read'), async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    const scopes = await db
      .select({
        id: agentExtraScopes.id,
        agentId: agentExtraScopes.agentId,
        permission: agentExtraScopes.permission,
        grantedBy: agentExtraScopes.grantedBy,
        createdAt: agentExtraScopes.createdAt,
      })
      .from(agentExtraScopes)
      .where(eq(agentExtraScopes.agentId, agent.id))

    return c.json({ scopes })
  })
  // POST /api/agents/:id/scopes — grant an additive permission scope to this agent
  .post('/:id/scopes', requirePermission('agents:scopes:manage'), async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    if (agent.ownerUserId) {
      return c.json({ error: 'Extra scopes do not apply to system-manager agents' }, 400)
    }

    const body = await c.req.json()
    const parsed = grantScopeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid permission' }, 400)
    }

    const { permission } = parsed.data
    const callerIdentity = c.get('identity') as Identity
    const callerPermissions = await resolvePermissions(callerIdentity)
    if (!callerPermissions.some((held) => permissionMatches(held, permission))) {
      return c.json({ error: `Cannot grant a permission you do not hold: ${permission}` }, 403)
    }

    const existing = await db
      .select({ id: agentExtraScopes.id })
      .from(agentExtraScopes)
      .where(and(eq(agentExtraScopes.agentId, agent.id), eq(agentExtraScopes.permission, permission)))
      .limit(1)
    if (existing.length > 0) {
      return c.json({ error: 'Scope already granted to this agent' }, 409)
    }

    const callerUserId = callerIdentity.type === 'user' ? callerIdentity.userId : null
    try {
      const [row] = await db
        .insert(agentExtraScopes)
        .values({ agentId: agent.id, permission, grantedBy: callerUserId })
        .returning()
      wsManager.invalidateAccessCache()
      return c.json(row, 201)
    } catch (err: any) {
      if (err?.code === '23505') {
        return c.json({ error: 'Scope already granted to this agent' }, 409)
      }
      throw err
    }
  })
  // DELETE /api/agents/:id/scopes/:permission — revoke an additive permission scope from this agent
  .delete('/:id/scopes/:permission', requirePermission('agents:scopes:manage'), async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    const permission = decodeURIComponent(c.req.param('permission'))

    const [deleted] = await db
      .delete(agentExtraScopes)
      .where(and(eq(agentExtraScopes.agentId, agent.id), eq(agentExtraScopes.permission, permission)))
      .returning()
    if (!deleted) return c.json({ error: 'Scope not found for this agent' }, 404)

    wsManager.invalidateAccessCache()
    return c.json({ success: true })
  })
  .get('/:id/slot-waits', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    if (!agent.squadId) return c.json([])
    if (!(await hasAnyPermission(c.get('identity'), ['slots:use', 'slots:write'], agent.squadId))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const waits = await listActiveSlotWaits(db, [agent.id])
    // Never expose another agent's queue entries, claim IDs, rank or capacity.
    return c.json(waits.map(({ waiterId, poolKey, queuedAt }) => ({ waiterId, poolKey, queuedAt })))
  })
  .get('/:id/model-catalog', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    return c.json(await getModelCatalog())
  })
  // GET /api/agents/:id — get agent details
  .get('/:id', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    return c.json(agent.toJson())
  })
  // PATCH /api/agents/:id — update agent
  .patch(
    '/:id',
    requireEntityPermission('agents:update', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const body = await c.req.json<{
        name?: string
        persist?: boolean
        modelOverride?: string | null
        machineId?: string | null
      }>()
      // `machineId` present (even null) means the caller intends to (un)pin. This
      // PATCH writes the pin attribute only (agents:update scope); it does NOT
      // migrate a live box — the box moves on its next ensure via box-manager's
      // migrate-with-teardown, or immediately via POST /:id/machine (machines:write).
      const setsMachineId = Object.prototype.hasOwnProperty.call(body, 'machineId')

      try {
        if (setsMachineId) await assertMachinePinReady(body.machineId ?? null)

        if (
          body.name !== undefined ||
          body.persist !== undefined ||
          body.modelOverride !== undefined ||
          setsMachineId
        ) {
          await agent.update({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.persist !== undefined ? { persist: body.persist } : {}),
            ...(body.modelOverride !== undefined ? { modelOverride: body.modelOverride } : {}),
            ...(setsMachineId ? { machineId: body.machineId ?? null } : {}),
          })
        }

        return c.json(agent.toJson())
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400)
      }
    }
  )
  // POST /api/agents/:id/machine — pin the agent's box to a machine (or unpin with
  // null) AND drive the migration now. Gated on `machines:write`: a machine pin is
  // an infra action, distinct from the `agents:update` attribute write above.
  .post('/:id/machine', requirePermission('machines:write'), async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    // Require the `machineId` key to be PRESENT: an explicit null is a valid
    // unpin, but an absent key or an unparseable body is an ERROR, not an implicit
    // unpin (a typo'd field name would otherwise silently migrate the box off its
    // pinned machine).
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Request body must be JSON with a machineId field (string to pin, null to unpin)' }, 400)
    }
    if (typeof body !== 'object' || body === null || !Object.prototype.hasOwnProperty.call(body, 'machineId')) {
      return c.json({ error: 'machineId is required (string to pin, null to unpin)' }, 400)
    }
    const rawMachineId = (body as { machineId?: unknown }).machineId
    if (rawMachineId !== null && typeof rawMachineId !== 'string') {
      return c.json({ error: 'machineId must be a string or null' }, 400)
    }
    const machineId = rawMachineId ?? null

    try {
      await assertMachinePinReady(machineId)
    } catch (error) {
      if (error instanceof MachinePinError) return c.json({ error: error.message }, 400)
      throw error
    }

    await agent.update({ machineId })

    // Drive the migration now for a LIVE box: re-ensuring moves it onto the new
    // pin and box-manager's migrate-with-teardown reclaims the old box first. A
    // box that isn't running is simply repinned and lands on the pin at its next
    // ensure. Best-effort: a migration failure never rolls back the persisted pin
    // (the box-manager fix still corrects placement on the next ensure).
    try {
      const sandboxId = await agent.getSandboxId()
      const manager = getSandboxManager()
      const live = isRemoteSandboxRuntime()
        ? (await (manager as K8sSandboxManager).getSandboxStatus(sandboxId)).status !== 'not_found'
        : manager.hasSandbox(sandboxId)
      if (live) await ensureAgentSandbox(agent)
    } catch (err) {
      log.error(`Pin set for agent ${agent.id} but live migration failed (will migrate on next ensure):`, err)
    }

    return c.json(agent.toJson())
  })
  // DELETE /api/agents/:id — delete agent (with safety checks)
  .delete(
    '/:id',
    requireAgentResourcePermission('agents:delete', (c) => Agent.find(c.req.param('id'))),
    async (c) => {
      const agentId = c.req.param('id')
      const agent = await Agent.find(agentId)
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      // Check safety rules
      const check = await agent.canDelete()
      if (!check.canDelete) {
        return c.json({ error: check.reason }, 400)
      }

      await agent.delete()
      return c.json({ success: true, deleted: agent.id })
    }
  )
  // GET /api/agents/:id/active — get active execution for agent
  .get('/:id/active', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    const { execution, activeRowCount, invariantViolation } = await agent.getActiveExecutionState()
    if (!execution) {
      return c.json({ active: false, activeRowCount, invariantViolation })
    }

    const [recovery] =
      execution.status === 'waiting-sandbox'
        ? await db
            .select({
              errorCode: sandboxProvisionRecoveries.errorCode,
              reasonCode: sandboxProvisionRecoveries.reasonCode,
              nextAttemptAt: sandboxProvisionRecoveries.nextAttemptAt,
              deadlineAt: sandboxProvisionRecoveries.deadlineAt,
              attemptCount: sandboxProvisionRecoveries.attemptCount,
            })
            .from(sandboxProvisionRecoveries)
            .where(eq(sandboxProvisionRecoveries.executionId, execution.id))
            .limit(1)
        : []
    const capacityReasons = new Set(['unschedulable_capacity', 'storage_substrate'])

    return c.json({
      active: true,
      executionId: execution.id,
      status: execution.status,
      activeRowCount,
      invariantViolation,
      compacting: isSessionCompacting(agent.id),
      ...(recovery
        ? {
            sandboxRecovery: {
              reason:
                recovery.errorCode === 'SANDBOX_PROVISION_BUSY' ||
                (recovery.reasonCode && capacityReasons.has(recovery.reasonCode))
                  ? ('capacity' as const)
                  : ('unavailable' as const),
              nextAttemptAt: recovery.nextAttemptAt.toISOString(),
              deadlineAt: recovery.deadlineAt.toISOString(),
              attemptCount: recovery.attemptCount,
              maxAttempts: PROVISION_RECOVERY_MAX_ATTEMPTS,
            },
          }
        : {}),
    })
  })
  // GET /api/agents/:id/executions — list executions for agent
  .get('/:id/executions', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    const result = await Execution.list({ agentId: agent.id })
    return c.json(result.map((e) => e.toJson()))
  })
  .get('/:id/executions/:executionId', requireAgentReadPermission, async (c) => {
    const execution = await Execution.find(c.req.param('executionId'))
    if (!execution || execution.agentId !== c.req.param('id')) return c.json({ error: 'Execution not found' }, 404)
    return c.json({
      executionId: execution.id,
      agentId: execution.agentId,
      status: execution.status,
      executionVersion: execution.executionVersion,
      active: execution.isActive,
    })
  })
  .get('/:id/executions/:executionId/stream', requireAgentReadPermission, async (c) => {
    const execution = await Execution.find(c.req.param('executionId'))
    if (!execution || execution.agentId !== c.req.param('id')) return c.json({ error: 'Execution not found' }, 404)
    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache, no-transform')
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'execution_snapshot',
        data: JSON.stringify({
          type: 'execution_snapshot',
          executionId: execution.id,
          status: execution.status,
          executionVersion: execution.executionVersion,
        }),
      })
      if (execution.status === 'waiting-maintenance') {
        await stream.writeSSE({
          event: 'execution_phase',
          data: JSON.stringify({ type: 'execution_phase', phase: 'maintenance_queue' }),
        })
        return
      }
      if (!execution.isTerminal) {
        await getProxyWorkerSSE(c)(stream, { workerPath: `/stream/${execution.id}`, signal: c.req.raw.signal })
      }
    })
  })
  // GET /api/agents/:id/stream — SSE stream (proxy from worker)
  .get('/:id/stream', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    const execution = await agent.getActiveExecution()
    if (!execution) return c.json({ error: 'No active execution' }, 404)

    if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'stopped') {
      return c.json({ error: 'Execution already finished' }, 400)
    }

    // Disable reverse-proxy buffering (nginx & friends) so SSE tokens reach the client
    // in real time instead of arriving in one burst when the stream closes. (Matches the
    // chat-create SSE endpoint; without this the agent stream — the path for every existing
    // agent and follow-up turn — renders thinking/tool/text blocks all at once at turn end.)
    c.header('X-Accel-Buffering', 'no')
    c.header('Cache-Control', 'no-cache, no-transform')
    return streamSSE(c, async (stream) =>
      withDeviceStreamRevocation(c.get('authContext'), stream, async (signal) => {
        if (execution.status === 'waiting-maintenance') {
          await stream.writeSSE({
            event: 'execution_phase',
            data: JSON.stringify({ type: 'execution_phase', phase: 'maintenance_queue' }),
          })
          return
        }
        await getProxyWorkerSSE(c)(stream, { workerPath: `/stream/${execution.id}`, signal })
      })
    )
  })
  // POST /api/agents/:id/message — send message to agent
  .post(
    '/:id/message',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const body = await c.req.json<{
        content: string
        pagePath?: string
        pauseAfter?: boolean
        imageIds?: string[]
        deliveryMode?: 'steer' | 'follow-up'
        clientId?: string
      }>()
      const pagePathResult = chatPagePathSchema.optional().safeParse(body.pagePath)
      if (!pagePathResult.success) return c.json({ error: 'Invalid page path' }, 400)
      if (!body.content.trim() && !body.imageIds?.length) {
        return c.json({ error: 'Message content or an image attachment is required' }, 400)
      }
      if (!isAllowedMessageTarget(agent)) {
        return c.json(
          {
            error:
              'Messages can only target system managers, squad managers, squad workers, or waiting-input artifact builders. Use request_artifact for normal artifact builders.',
          },
          400
        )
      }

      try {
        if ('pauseAfter' in body) {
          log.warn('Deprecation: pauseAfter is ignored — pause/resume has been removed')
        }
        // Attribute the message to the sending user so the agent knows who it's talking to
        // (shared multi-user agents). Surfaced when the pending row is claimed for delivery.
        const identity = c.get('identity') as Identity | undefined
        let sender: { userId: string; name: string } | undefined
        if (identity?.type === 'user') {
          const user = await User.findById(identity.userId).catch(() => null)
          sender = { userId: identity.userId, name: user?.displayName || user?.email || 'a user' }
        }
        const result = await agent.sendMessage(body.content, {
          imageIds: body.imageIds,
          deliveryMode: body.deliveryMode,
          attachmentActorUserId: identity ? (identityUserId(identity) ?? undefined) : undefined,
          validateNewAcceptance: () => {
            const validationError = validateAgentImageInput(agent, body.imageIds)
            if (validationError) throw new ImageInputUnsupportedError(validationError)
          },
          metadata: sender
            ? {
                source: 'user_chat',
                sender,
                ...(body.clientId ? { clientId: body.clientId } : {}),
                ...(body.pagePath ? { pagePath: body.pagePath } : {}),
              }
            : body.clientId || body.pagePath
              ? {
                  ...(body.clientId ? { clientId: body.clientId } : {}),
                  ...(body.pagePath ? { pagePath: body.pagePath } : {}),
                }
              : undefined,
        })
        return c.json(result)
      } catch (error) {
        if (error instanceof InvalidAttachmentError) return c.json({ error: 'Invalid attachment' }, 400)
        if (error instanceof ImageInputUnsupportedError) return c.json({ error: error.message }, 400)
        if (error instanceof ChatIdempotencyConflictError) return c.json({ error: error.message }, 409)
        if (error instanceof AgentTargetUnavailableError) return c.json({ error: error.message, code: error.code }, 409)
        return c.json(
          { error: `Failed to send message: ${error instanceof Error ? error.message : String(error)}` },
          500
        )
      }
    }
  )
  // POST /api/agents/:id/continue — resume a single agent halted by a provider/rate-limit error.
  .post(
    '/:id/continue',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      const identity = c.get('identity') as Identity | undefined
      if (!identity) return c.json({ error: 'Unauthorized' }, 401)
      const outcome = await resumeHaltedAgentAuthoritatively(agent.id, (target) =>
        identity.type === 'user' && target.ownerUserId === identity.userId
          ? Promise.resolve(true)
          : hasPermission(identity, 'agents:run', target.squadId ?? undefined)
      )
      if (outcome === 'forbidden') return c.json({ error: 'Forbidden', code: 'action_forbidden' }, 403)
      return c.json({ resumed: outcome === 'resumed' })
    }
  )
  // POST /api/agents/:id/pause — removed; compatibility shim for one release (still guarded)
  .post(
    '/:id/pause',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    (c) => c.json({ error: 'pause is no longer supported; use stop and follow up with a normal message' }, 410)
  )
  // POST /api/agents/:id/resume — removed; compatibility shim for one release (still guarded)
  .post(
    '/:id/resume',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    (c) => c.json({ error: 'resume is no longer supported; send a normal message to continue' }, 410)
  )
  // POST /api/agents/:id/stop — stop active execution
  .post(
    '/:id/stop',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const execution = await agent.getActiveExecution()
      if (!execution) return c.json({ error: 'No active execution' }, 404)

      const success = await execution.requestStopWithSignal()
      if (!success) return c.json({ error: 'Failed to stop execution' }, 400)

      return c.json({ success: true })
    }
  )
  // POST /api/agents/:id/force-stop — forcibly terminate stuck execution
  .post(
    '/:id/force-stop',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const execution = await agent.getActiveExecution()
      if (!execution) return c.json({ error: 'No active execution' }, 404)

      // Force-stop works on any non-terminal state
      if (execution.isTerminal) {
        return c.json({ error: 'Execution already finished' }, 400)
      }

      const body = await parseOptionalJsonObjectBody(c, {} as { reason?: string })
      await execution.forceStop(body.reason)

      return c.json({ success: true, executionId: execution.id, status: 'failed' })
    }
  )
  // GET /api/agents/:id/messages — get messages for agent
  // Supports pagination with ?beforeId=<cursor>&limit=50
  .get('/:id/messages', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)
    const options: ListMessagesOptions = {}
    const limit = c.req.query('limit')
    const offset = c.req.query('offset')
    const before = c.req.query('before')
    const cursor = c.req.query('cursor')
    const beforeId = c.req.query('beforeId')
    const after = c.req.query('after')
    const search = c.req.query('search')
    const role = c.req.query('role')

    if (limit) options.limit = parseInt(limit)
    if (offset) options.offset = parseInt(offset)
    if (before) options.before = before
    if (cursor) options.cursor = cursor
    else if (beforeId) options.beforeId = beforeId
    if (after) options.after = after
    if (search) options.search = search
    if (role === 'human' || role === 'assistant') options.role = role

    try {
      const result = await agent.listMessages(options)
      return c.json({ ...result, messages: await withChatQueueState(agent.id, result.messages) })
    } catch (error) {
      if (error instanceof InvalidMessageCursorError)
        return c.json({ error: 'Invalid cursor', code: 'MESSAGES_CURSOR_INVALID' }, 400)
      throw error
    }
  })
  // GET /api/agents/:id/messages/:messageId — get a single message by ID (supports UUID prefix)
  .get('/:id/messages/:messageId', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    try {
      const message = await Agent.findMessage(c.req.param('messageId'))
      if (!message || message.agentId !== agent.id) return c.json({ error: 'Message not found' }, 404)
      return c.json((await withChatQueueState(agent.id, [message]))[0])
    } catch (err) {
      if (err instanceof AmbiguousPrefixError) return c.json({ error: err.message }, 400)
      throw err
    }
  })
  // POST /api/agents/:id/clear-queue — clear all pending steer/follow-up messages
  .post(
    '/:id/clear-queue',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const result = await agent.clearQueue()

      // The queue could not be proven empty: the worker failed, or nothing
      // acked at all. Say so. Reporting success here is what left users
      // watching an agent answer messages they had just cleared.
      if (!result.ok) {
        return c.json(
          {
            error:
              'Could not confirm the queue was cleared — the agent may still process queued messages. Try again in a moment.',
            code: result.code,
            cleared: result.cleared,
            deleted: result.deleted,
          },
          503
        )
      }
      if (result.cleared === 0 && result.deleted === 0) {
        return c.json({ error: 'No pending messages to clear' }, 400)
      }

      return c.json({ success: true, cleared: result.cleared, deleted: result.deleted })
    }
  )
  // POST /api/agents/:id/compact — trigger manual compaction (idle agents only)
  .post(
    '/:id/compact',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const body = await parseOptionalJsonObjectBody(c, {} as { instructions?: string })

      try {
        await agent.startCompaction(body.instructions)
        return c.json({ success: true })
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400)
      }
    }
  )
  // POST /api/agents/:id/reset — reset session history (idle agents only)
  .post(
    '/:id/reset',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      try {
        await agent.startReset()
        return c.json({ success: true })
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400)
      }
    }
  )
  // POST /api/agents/:id/abort-tool — abort currently running bash command
  .post(
    '/:id/abort-tool',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const execution = await agent.getActiveExecution()
      if (!execution) return c.json({ error: 'No active execution' }, 404)

      const success = await execution.abortToolWithSignal()
      if (!success) return c.json({ error: 'Execution is not running' }, 400)

      return c.json({ success: true })
    }
  )
  /** @deprecated POST /api/agents/:id/steer — use /message with deliveryMode: 'steer'. */
  .post(
    '/:id/steer',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const body = await c.req.json<{ message: string; imageIds?: string[] }>()
      if (!body.message) return c.json({ error: 'Message is required' }, 400)
      const imageValidationError = validateAgentImageInput(agent, body.imageIds)
      if (imageValidationError) return c.json({ error: imageValidationError }, 400)

      const identity = c.get('identity') as Identity | undefined
      let sender: { userId: string; name: string } | undefined
      if (identity?.type === 'user') {
        const user = await User.findById(identity.userId).catch(() => null)
        sender = { userId: identity.userId, name: user?.displayName || user?.email || 'a user' }
      }

      try {
        const result = await agent.sendMessage(body.message, {
          imageIds: body.imageIds,
          deliveryMode: 'steer',
          attachmentActorUserId: identity ? (identityUserId(identity) ?? undefined) : undefined,
          ...(sender ? { metadata: { source: 'user_chat', sender } } : {}),
        })
        return c.json(result)
      } catch (error) {
        if (error instanceof InvalidAttachmentError) return c.json({ error: 'Invalid attachment' }, 400)
        throw error
      }
    }
  )
  /** @deprecated POST /api/agents/:id/follow-up — use /message with deliveryMode: 'follow-up'. */
  .post(
    '/:id/follow-up',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)

      const body = await c.req.json<{ message: string; imageIds?: string[] }>()
      if (!body.message) return c.json({ error: 'Message is required' }, 400)
      const imageValidationError = validateAgentImageInput(agent, body.imageIds)
      if (imageValidationError) return c.json({ error: imageValidationError }, 400)

      const identity = c.get('identity') as Identity | undefined
      let sender: { userId: string; name: string } | undefined
      if (identity?.type === 'user') {
        const user = await User.findById(identity.userId).catch(() => null)
        sender = { userId: identity.userId, name: user?.displayName || user?.email || 'a user' }
      }

      try {
        const result = await agent.sendMessage(body.message, {
          imageIds: body.imageIds,
          deliveryMode: 'follow-up',
          attachmentActorUserId: identity ? (identityUserId(identity) ?? undefined) : undefined,
          ...(sender ? { metadata: { source: 'user_chat', sender } } : {}),
        })
        return c.json(result)
      } catch (error) {
        if (error instanceof InvalidAttachmentError) return c.json({ error: 'Invalid attachment' }, 400)
        throw error
      }
    }
  )
  // GET /api/agents/:id/context — get agent's working context (short-term memory + todos)
  .get('/:id/context', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    // Get short-term memory from agent context
    const ctx = (agent.context as Record<string, unknown>) ?? {}
    const shortTermMemory = (ctx.shortTermMemory as string) ?? ''

    // Get todos from squad memory file (if squad agent), matching createSquadTodoTools storage.
    let todos: { text: string; completed: boolean; depends: number[] }[] = []
    if (agent.squadId) {
      const memoryPath = ensureSquadMemoryPath(agent.squadId)
      const todoFilePath = join(memoryPath, '.todos', `${agent.id}.md`)
      const storage = createFileTodoStorage(todoFilePath)
      const todoContent = await storage.read()
      if (todoContent) {
        todos = parseTodoMarkdown(todoContent)
      }
    }

    return c.json({
      shortTermMemory,
      todos,
    })
  })
  // GET /api/agents/:id/sandbox/status - Live sandbox pod status for any agent
  .get('/:id/sandbox/status', requireAgentReadPermission, async (c) => {
    const agent = await Agent.find(c.req.param('id'))
    if (!agent) return c.json({ error: 'Agent not found' }, 404)

    const sandboxId = await agent.getSandboxId()
    // Stop/restart only make sense when the box belongs to this agent alone.
    // A subagent inherits its parent's box, so controlling it from the
    // subagent's panel would tear it out from under the parent — such a box is
    // surfaced read-only. Every other agent owns its box and is controllable.
    const controllable = sandboxId === agent.getAgentWorkspaceSandboxId()
    const squad = agent.squadId ? await Squad.find(agent.squadId) : null
    // Host has no devbox, so a declared toolchain has nowhere to be applied:
    // resolving it would decorate the payload with the status of a thing that
    // cannot exist (and flip devboxReady off) for a wasted DB round-trip.
    const toolchain = isHostRuntime() ? undefined : await resolveToolchainStatus(sandboxId, squad)

    // Docker sandboxes have no live status surface — they're "running" if tracked.
    // Both remote runtimes (k8s + vm) expose getSandboxStatus, so query it.
    if (!isRemoteSandboxRuntime()) {
      const manager = getSandboxManager()
      const hasIt = manager.hasSandbox(sandboxId)
      return c.json(
        mergeSandboxStatus(
          {
            status: hasIt ? 'running' : 'not_found',
            devboxReady: true,
            controllable,
            runtime: isHostRuntime() ? ('host' as const) : ('docker' as const),
          },
          toolchain
        )
      )
    }

    const manager = getSandboxManager() as import('../services/sandbox/k8s/manager').K8sSandboxManager
    const status = await manager.getSandboxStatus(sandboxId)

    if (isSessionActive(agent.id) && !['running', 'starting', 'pending'].includes(status.status)) {
      removeSession(agent.id)
      const activeExecution = await agent.getActiveExecution()
      if (activeExecution?.status === 'running') {
        await activeExecution.fail(`Sandbox ${sandboxId} is no longer running (${status.status})`)
      }
    }

    // `runtime` is server-driven config (FICUS_SANDBOX_RUNTIME), never client-guessed.
    const provisioning = isK8sRuntime() ? await manager.getProvisionDiagnostics() : undefined
    return c.json(
      mergeSandboxStatus(
        {
          ...status,
          // The overload detector's reading when status did not probe the box itself.
          ...(isVmRuntime() && !('pressure' in status && status.pressure)
            ? await openSandboxOverloadPressure(sandboxId).then((pressure) => (pressure ? { pressure } : {}))
            : {}),
          controllable,
          runtime: isVmRuntime() ? ('vm' as const) : ('k8s' as const),
          ...(provisioning ? { provisioning } : {}),
        },
        toolchain
      )
    )
  })
  // POST /api/agents/:id/sandbox/stop - Stop this agent's individual sandbox
  .post(
    '/:id/sandbox/stop',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      const host = hostRuntimeGuard(c)
      if (host) return host

      const sandboxId = await agent.getSandboxId()
      if (sandboxId !== agent.getAgentWorkspaceSandboxId()) {
        return c.json({ error: 'This agent shares a sandbox and cannot be controlled individually' }, 403)
      }

      try {
        const manager = getSandboxManager()
        await manager.removeSandbox(sandboxId)
        await markLocalDeploymentsStoppedForSandbox(sandboxId)
        await failActiveSessionForStoppedSandbox(agent, sandboxId)
        return c.json({ ok: true })
      } catch (err) {
        log.error(`Failed to stop sandbox for agent ${agent.id}:`, err)
        return c.json({ error: 'Failed to stop sandbox' }, 500)
      }
    }
  )
  // GET/POST /api/agents/:id/sandbox/processes... - What this agent's own box is
  // running, and stopping it. A squad member shares the squad box, whose
  // processes are managed through the squad.
  .get(
    '/:id/sandbox/processes',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => ownAgentSandbox(c, (sandboxId) => listSandboxProcesses(sandboxId))
  )
  .post(
    '/:id/sandbox/processes/:pid/signal',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) =>
      ownAgentSandbox(c, async (sandboxId) => {
        const body = await parseOptionalJsonObjectBody(c, {} as { signal?: unknown })
        const pid = parseProcessId(c.req.param('pid'))
        return signalSandboxProcess(sandboxId, pid, parseProcessSignal(body.signal), c.get('identity')!)
      })
  )
  .post(
    '/:id/sandbox/containers/:containerId/stop',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) =>
      ownAgentSandbox(c, (sandboxId) =>
        stopSandboxContainer(sandboxId, parseContainerId(c.req.param('containerId')), c.get('identity')!)
      )
  )
  // POST /api/agents/:id/sandbox/restart - Stop and re-provision this agent's sandbox
  .post(
    '/:id/sandbox/restart',
    requireEntityPermission('agents:run', async (c) => agentSquadId(c.req.param('id')), {
      loadOwnerUserId: async (c) => agentOwnerUserId(c.req.param('id')),
    }),
    async (c) => {
      const agent = await Agent.find(c.req.param('id'))
      if (!agent) return c.json({ error: 'Agent not found' }, 404)
      const host = hostRuntimeGuard(c)
      if (host) return host

      const sandboxId = await agent.getSandboxId()
      if (sandboxId !== agent.getAgentWorkspaceSandboxId()) {
        return c.json({ error: 'This agent shares a sandbox and cannot be controlled individually' }, 403)
      }

      try {
        const manager = getSandboxManager()
        if (isK8sRuntime()) {
          ;(manager as K8sSandboxManager).requestRecreateOnNextEnsure(sandboxId)
        } else {
          await manager.removeSandbox(sandboxId)
        }
        // Bring a fresh box up now via the single source of truth for "warm this
        // agent's box" — the SAME squad-vs-solo mounts + skills the runners use.
        // A bare ensureWorkspaceSandbox({ sandboxId }) omits squadId, so a squad
        // member's box comes back SOLO, missing /workspace/<squadId> and
        // /memory/<squadId> (the squad workspace shows up empty in its bash).
        await ensureAgentSandbox(agent)
        await markLocalDeploymentsStoppedForSandbox(sandboxId)
        await failActiveSessionForStoppedSandbox(agent, sandboxId)
        return c.json({ ok: true })
      } catch (err) {
        const provisioning = getSandboxProvisionErrorResponse(err)
        if (provisioning) {
          if (provisioning.retryAfter) c.header('Retry-After', provisioning.retryAfter)
          return c.json(provisioning.body, provisioning.status)
        }
        log.error(`Failed to restart sandbox for agent ${agent.id}:`, err)
        return c.json({ error: 'Failed to restart sandbox' }, 500)
      }
    }
  )
